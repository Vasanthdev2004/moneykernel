import {
  loadScenario,
  MemoryPaperVenueStore,
  type PaperExecutionAdapter,
  type Scenario,
} from "@moneykernel/integrations";
import {
  countOutstandingCommands,
  listAuditEvents,
  listCommands,
  listIncidents,
  listReservationsForProposal,
  withClient,
} from "@moneykernel/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchOnce } from "../../apps/kernel/src/dispatcher/dispatch.ts";
import { FIXTURES_DIR } from "../../apps/kernel/src/fixtures.ts";
import { computeReadiness } from "../../apps/kernel/src/readiness.ts";
import { stopAccount } from "../../apps/kernel/src/services/account-control.ts";
import { sweepProposals } from "../../apps/kernel/src/services/proposals.ts";
import {
  buyIntent,
  type Harness,
  migrateTestDatabase,
  observationFor,
  operator,
  opRequest,
  restartHarness,
  seededAgent,
  startHarness,
  stopHarness,
  submitIntent,
} from "../integration/kernel/harness.ts";

/**
 * Fault layer (prd.md 20.1, 20.5): every test names its injected crash point
 * and asserts database state, adapter call counts, reservation changes, and
 * audit linkage. The paper venue's journal is the seed that reproduces a run.
 */
const harnesses: Harness[] = [];
beforeAll(migrateTestDatabase);
afterAll(async () => {
  for (const h of harnesses) await stopHarness(h).catch(() => undefined);
});

function roomy(): Scenario {
  const s = loadScenario("scenario-a-constrained-acquisition", FIXTURES_DIR);
  s.account.balances = { USDT: "1000" };
  s.account.inventory_allocations = {};
  s.policy = {
    ...(s.policy ?? {}),
    max_order_notional_quote: "1000",
    max_symbol_share: "1",
    min_quote_cash_buffer: "0",
    valuation_buffer_quote: "0",
    max_unique_intents_per_60s: 1000,
  };
  const alpha = s.agents[0];
  if (alpha === undefined) throw new Error("fixture has no agent");
  alpha.lease.acquisition_budget_quote = "1000";
  alpha.lease.max_submission_attempts = 20;
  return s;
}

async function readyCommand(h: Harness, key: string) {
  const alpha = seededAgent(h, "agent_alpha");
  const op = await operator(h);
  const obs = await observationFor(h, alpha.token, "SOLUSDT");
  const submitted = await submitIntent(h, alpha.token, key, buyIntent(alpha.lease_id, "SOLUSDT", "20", "100", obs));
  expect(submitted.status).toBe(201);
  h.tick(800);
  await sweepProposals(h.runtime, new Date(h.clock.now));
  // The epoch advances on every stop; approvals bind to the current one, never the boot-time snapshot.
  const overview = await opRequest(h, op.token, "GET", "/v1/overview");
  const epoch = (overview.body.account as { epoch: number }).epoch;
  const approved = await opRequest(
    h,
    op.token,
    "POST",
    `/v1/proposals/${String(submitted.body.proposal_id)}/approve`,
    {
      proposal_revision: submitted.body.proposal_revision,
      proposal_hash: submitted.body.proposal_hash,
      expected_account_epoch: epoch,
      operator_confirmation: true,
    },
    { "idempotency-key": `${key}-approve` },
  );
  expect(approved.status).toBe(201);
  const pool = h.runtime.pool;
  if (pool === null) throw new Error("no pool");
  const command = (await withClient(pool, (c) => listCommands(c, h.accountId, ["READY"]))).find(
    (c) => c.proposal_id === submitted.body.proposal_id,
  );
  if (command === undefined) throw new Error("no READY command");
  return { alpha, op, pool, command, proposalId: String(submitted.body.proposal_id) };
}

describe("crash point: global stop racing dispatch (T-33, INV-06)", () => {
  it("never arms after a committed stop; an arm that won the race is reported in flight, not undone", async () => {
    const h = await startHarness(roomy(), "scenario-a-constrained-acquisition");
    harnesses.push(h);
    const pool = h.runtime.pool;
    if (pool === null) throw new Error("no pool");
    const paper = h.runtime.execution as PaperExecutionAdapter;
    let armedBeforeStop = 0;
    let blockedByStop = 0;
    for (let round = 0; round < 6; round += 1) {
      const { op, command } = await readyCommand(h, `stop-race-${round}`);
      const [dispatch, stop] = await Promise.all([
        dispatchOnce(h.runtime, new Date(h.clock.now)),
        stopAccount(h.runtime, "operator", `race ${round}`, new Date(h.clock.now)),
      ]);
      const after = await withClient(pool, (c) => listCommands(c, h.accountId));
      const row = after.find((c) => c.id === command.id);
      if (row === undefined) throw new Error("command vanished");
      const events = await withClient(pool, (c) => listAuditEvents(c, h.accountId, { limit: 5000 }));
      const stopSeq = events.filter((e) => e.type === "ACCOUNT_STOPPED").at(-1)?.account_seq ?? -1;
      const armSeq = events.find((e) => e.type === "COMMAND_ARMED" && e.payload.command_id === command.id)?.account_seq;
      if (dispatch.kind === "ARMED") {
        // The arm commit preceded the stop commit: the stop must have seen it in flight or already settled.
        armedBeforeStop += 1;
        expect(armSeq).toBeDefined();
        expect((armSeq ?? 0) < stopSeq).toBe(true);
        expect(["ACCEPTED", "ARMED", "OUTCOME_UNKNOWN"]).toContain(row.state);
      } else {
        blockedByStop += 1;
        expect(armSeq).toBeUndefined();
        expect(["READY", "ABORTED_PRE_ARM"]).toContain(row.state);
        expect(stop.in_flight_commands.map((c) => c.command_id)).not.toContain(command.id);
      }
      expect(stop.status).toBe("PAUSED");
      // Resume for the next round; outstanding commands must be settled first (the paper fill settles in dispatch).
      expect((await withClient(pool, (c) => countOutstandingCommands(c, h.accountId))).total).toBe(0);
      const resumed = await opRequest(
        h,
        op.token,
        "POST",
        "/v1/account/resume",
        {},
        { "idempotency-key": `stop-race-resume-${round}` },
      );
      expect(resumed.status).toBe(200);
    }
    expect(armedBeforeStop + blockedByStop).toBe(6);
    // Whatever the interleaving, the venue saw exactly one submission per arm and none after a stop.
    expect(paper.submitCount).toBe(armedBeforeStop);
  });
});

describe("crash point: database failure before the arm commit (T-43)", () => {
  it("makes no external request when the arm transaction cannot commit", async () => {
    const h = await startHarness(roomy(), "scenario-a-constrained-acquisition");
    harnesses.push(h);
    const { command, pool } = await readyCommand(h, "db-fail-001");
    const paper = h.runtime.execution as PaperExecutionAdapter;
    // Crash point: the writer's transaction is refused by the database before `COMMIT` (a trigger that raises
    // on the command's state change stands in for a lost connection at that instant).
    await pool.query(`
      CREATE OR REPLACE FUNCTION mk_fault_refuse_arm() RETURNS trigger AS $$
      BEGIN
        IF NEW.state = 'ARMED' THEN RAISE EXCEPTION 'injected fault: database unavailable before arm' USING ERRCODE = 'restrict_violation'; END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER mk_fault_refuse_arm BEFORE UPDATE ON commands FOR EACH ROW EXECUTE FUNCTION mk_fault_refuse_arm();
    `);
    try {
      await expect(dispatchOnce(h.runtime, new Date(h.clock.now))).rejects.toThrow(/injected fault/);
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS mk_fault_refuse_arm ON commands; DROP FUNCTION IF EXISTS mk_fault_refuse_arm();",
      );
    }
    expect(paper.submitCount).toBe(0);
    const row = (await withClient(pool, (c) => listCommands(c, h.accountId))).find((c) => c.id === command.id);
    expect(row?.state).toBe("READY");
    expect(row?.armed_at).toBeNull();
    const holds = await withClient(pool, (c) => listReservationsForProposal(c, command.proposal_id));
    expect(holds.map((r) => r.state)).toEqual(["HELD", "HELD"]);
    // Recovery: the database is back; the same command arms once and settles.
    const report = await dispatchOnce(h.runtime, new Date(h.clock.now));
    expect(report.kind).toBe("ARMED");
    expect(paper.submitCount).toBe(1);
  });
});

describe("crash point: writer connection lost (T-44)", () => {
  it("stops arming and readiness once the advisory lock is gone; no automatic hot failover", async () => {
    const h = await startHarness(roomy(), "scenario-a-constrained-acquisition");
    harnesses.push(h);
    const { pool } = await readyCommand(h, "writer-lost-001");
    const paper = h.runtime.execution as PaperExecutionAdapter;
    const writer = h.runtime.writer;
    if (writer === null) throw new Error("no writer");
    // Crash point: the writer session loses its lock (connection reset at the database) after the command is READY.
    await writer.client.query("SELECT pg_advisory_unlock(hashtext($1))", [writer.key]);
    const report = await dispatchOnce(h.runtime, new Date(h.clock.now));
    expect(report.kind).toBe("IDLE");
    expect(paper.submitCount).toBe(0);
    const readiness = await computeReadiness(h.runtime);
    expect(readiness.ready).toBe(false);
    const ready = (await withClient(pool, (c) => listCommands(c, h.accountId, ["READY"]))).length;
    expect(ready).toBe(1);
  });
});

describe("crash point: unsupported fee asset on a settled fill (T-45)", () => {
  it("keeps the hold, raises a CRITICAL incident, blocks resume, and never drops the fee", async () => {
    const faults = { commissionAssetFor: new Map<string, string>() };
    const h = await startHarness(roomy(), "scenario-a-constrained-acquisition", { paperFaults: faults });
    harnesses.push(h);
    const { op, pool, command, proposalId } = await readyCommand(h, "fee-asset-001");
    faults.commissionAssetFor.set(command.client_order_id, "BNB");
    const report = await dispatchOnce(h.runtime, new Date(h.clock.now));
    if (report.kind !== "ARMED") throw new Error("not armed");
    expect(report.outcome).toBe("ACCEPTED");
    expect(report.reconciliation?.reconciled).toBe(false);
    expect(report.reconciliation?.skipped_fills).toBe(1);
    const row = (await withClient(pool, (c) => listCommands(c, h.accountId))).find((c) => c.id === command.id);
    expect(row?.state).toBe("ACCEPTED");
    expect(row?.reconciled_at).toBeNull();
    const holds = await withClient(pool, (c) => listReservationsForProposal(c, proposalId));
    expect(holds.filter((r) => r.kind === "QUOTE").map((r) => r.state)).toEqual(["ARMED"]);
    // Two facts, two incidents: the fee asset is unsupported (CRITICAL) and, because that fill was not applied,
    // the venue totals exceed the recorded fills (WARNING). Neither is dropped to make the account look clean.
    const incidents = await withClient(pool, (c) => listIncidents(c, h.accountId, "OPEN"));
    const feeIncident = incidents.find((i) => i.type === "UNSUPPORTED_FEE_ASSET");
    expect(feeIncident?.severity).toBe("CRITICAL");
    const evidence = (feeIncident?.evidence_refs ?? {}) as { commission_asset?: string };
    expect(evidence.commission_asset).toBe("BNB");
    expect(incidents.map((i) => i.type).sort()).toEqual(["FILL_DETAIL_INCOMPLETE", "UNSUPPORTED_FEE_ASSET"]);
    expect((await computeReadiness(h.runtime)).ready).toBe(false);
    const stopped = await opRequest(
      h,
      op.token,
      "POST",
      "/v1/account/stop",
      {},
      { "idempotency-key": "fee-asset-stop" },
    );
    expect(stopped.status).toBe(200);
    const resumed = await opRequest(
      h,
      op.token,
      "POST",
      "/v1/account/resume",
      {},
      { "idempotency-key": "fee-asset-resume" },
    );
    expect(resumed.status).toBe(409);
    // The venue still holds the fill with its fee; nothing was invented or discarded.
    const paper = h.runtime.execution as PaperExecutionAdapter;
    const venueOrder = paper.venueState().orders[command.client_order_id];
    expect(venueOrder?.fills[0]?.commission_asset).toBe("BNB");
  });
});

describe("crash point: restart with a venue that lost the order and later remembers it (T-36, T-37, T-38)", () => {
  it("keeps the unknown command unknown across two restarts and settles it only from venue evidence", async () => {
    const store = new MemoryPaperVenueStore();
    const faults = { dropResponseFor: new Set<string>() };
    let h = await startHarness(roomy(), "scenario-a-constrained-acquisition", {
      paperVenueStore: store,
      paperFaults: faults,
    });
    harnesses.push(h);
    const { command } = await readyCommand(h, "amnesia-001");
    faults.dropResponseFor.add(command.client_order_id);
    const report = await dispatchOnce(h.runtime, new Date(h.clock.now));
    if (report.kind !== "ARMED") throw new Error("not armed");
    expect(report.outcome).toBe("OUTCOME_UNKNOWN");
    // Crash point 1: restart against an amnesiac venue (empty journal): absence is not a rejection.
    h = await restartHarness(h, roomy(), { paperVenueStore: new MemoryPaperVenueStore() });
    harnesses.push(h);
    expect(h.runtime.recovery?.unknown).toEqual([command.id]);
    // Crash point 2: restart again, still amnesiac: still unknown, still no resend.
    h = await restartHarness(h, roomy(), { paperVenueStore: new MemoryPaperVenueStore() });
    harnesses.push(h);
    expect(h.runtime.recovery?.unknown).toEqual([command.id]);
    expect((h.runtime.execution as PaperExecutionAdapter).submitCount).toBe(0);
    // The real venue memory returns: recovery settles the same identity.
    h = await restartHarness(h, roomy(), { paperVenueStore: store });
    harnesses.push(h);
    expect(h.runtime.recovery?.reconciled).toEqual([command.id]);
    expect((h.runtime.execution as PaperExecutionAdapter).submitCount).toBe(1);
    expect((await computeReadiness(h.runtime)).ready).toBe(true);
  });
});
