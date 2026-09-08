import { canonicalizeDecimal, type NormalizedOrder } from "@moneykernel/contracts";
import { loadScenario, MemoryPaperVenueStore, type Scenario } from "@moneykernel/integrations";
import {
  countOutstandingCommands,
  getLeaseById,
  getOrderForCommand,
  listAuditEvents,
  listCommands,
  listIncidents,
  listReservationsForProposal,
  releaseWriterLock,
  withClient,
} from "@moneykernel/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchOnce } from "../../../apps/kernel/src/dispatcher/dispatch.ts";
import { FIXTURES_DIR } from "../../../apps/kernel/src/fixtures.ts";
import { computeReadiness } from "../../../apps/kernel/src/readiness.ts";
import { sweepProposals } from "../../../apps/kernel/src/services/proposals.ts";
import { reconcileCommand, reconcileOutstanding } from "../../../apps/kernel/src/services/reconciliation.ts";
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
} from "./harness.ts";

const harnesses: Harness[] = [];
beforeAll(migrateTestDatabase);
afterAll(async () => {
  for (const h of harnesses) await stopHarness(h).catch(() => undefined);
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("required test fixture is missing");
  return value;
}

function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

function roomy(): Scenario {
  const scenario = loadScenario("scenario-a-constrained-acquisition", FIXTURES_DIR);
  scenario.account.balances = { USDT: "1000" };
  scenario.account.inventory_allocations = {};
  scenario.policy = {
    ...(scenario.policy ?? {}),
    max_order_notional_quote: "1000",
    max_symbol_share: "1",
    min_quote_cash_buffer: "0",
    valuation_buffer_quote: "0",
    max_unique_intents_per_60s: 1000,
  };
  return scenario;
}

async function readyBuy(h: Harness, key: string) {
  const alpha = seededAgent(h, "agent_alpha");
  const op = await operator(h);
  const observation = await observationFor(h, alpha.token, "SOLUSDT");
  const proposal = await submitIntent(
    h,
    alpha.token,
    key,
    buyIntent(alpha.lease_id, "SOLUSDT", "20", "100", observation),
  );
  expect(proposal.status).toBe(201);
  h.tick(800);
  await sweepProposals(h.runtime, h.runtime.clock());
  const approved = await opRequest(
    h,
    op.token,
    "POST",
    `/v1/proposals/${proposal.body.proposal_id}/approve`,
    {
      proposal_revision: proposal.body.proposal_revision,
      proposal_hash: proposal.body.proposal_hash,
      expected_account_epoch: h.runtime.account?.epoch,
      operator_confirmation: true,
    },
    { "idempotency-key": `${key}-approval` },
  );
  expect(approved.status).toBe(201);
  const commands = await withClient(required(h.runtime.pool), (client) => listCommands(client, h.accountId));
  const command = commands.find((row) => row.proposal_id === proposal.body.proposal_id);
  if (!command) throw new Error("approved command missing");
  return command;
}

describe("recovery and writer safety review regressions", () => {
  it("becomes ready after an initially unknown boot command is reconciled without another restart", async () => {
    const faults = { dropResponseFor: new Set<string>() };
    let h = await startHarness(roomy(), "scenario-a-constrained-acquisition", { paperFaults: faults });
    harnesses.push(h);
    const command = await readyBuy(h, "recovery-live-001");
    faults.dropResponseFor.add(command.client_order_id);
    const result = await dispatchOnce(h.runtime, h.runtime.clock());
    expect(result).toMatchObject({ kind: "ARMED", outcome: "OUTCOME_UNKNOWN" });
    const venue = h.runtime.execution;

    h = await restartHarness(h, roomy(), { paperVenueStore: new MemoryPaperVenueStore() });
    harnesses.push(h);
    expect(h.runtime.bootChecks.find((check) => check.name === "recovery")?.ok).toBe(false);
    expect((await computeReadiness(h.runtime)).ready).toBe(false);

    // The real venue becomes reachable again in this process; no second boot is needed to query it.
    h.runtime.execution = venue;
    const op = await operator(h);
    const reconciled = await opRequest(
      h,
      op.token,
      "POST",
      `/v1/commands/${command.id}/reconcile`,
      {},
      {
        "idempotency-key": "recovery-live-reconcile",
      },
    );
    expect(reconciled.status).toBe(200);
    expect(reconciled.body.result).toBe("RECONCILED");
    expect(
      (await withClient(required(h.runtime.pool), (client) => countOutstandingCommands(client, h.accountId))).total,
    ).toBe(0);
    const resumed = await opRequest(
      h,
      op.token,
      "POST",
      "/v1/account/resume",
      {},
      {
        "idempotency-key": "recovery-live-resume",
      },
    );
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe("READY");
    expect((await computeReadiness(h.runtime)).checks.filter((check) => !check.ok)).toEqual([]);
  });

  it("reports not ready after advisory writer ownership is lost while the session still answers queries", async () => {
    const h = await startHarness(roomy(), "scenario-a-constrained-acquisition");
    harnesses.push(h);
    const writer = required(h.runtime.writer);
    await releaseWriterLock(writer.client, writer.key);
    expect((await computeReadiness(h.runtime)).ready).toBe(false);
  });

  it("does not admit a new reservation after advisory writer ownership is lost", async () => {
    const h = await startHarness(roomy(), "scenario-a-constrained-acquisition");
    harnesses.push(h);
    const alpha = seededAgent(h, "agent_alpha");
    const observation = await observationFor(h, alpha.token, "SOLUSDT");
    const body = buyIntent(alpha.lease_id, "SOLUSDT", "20", "100", observation);
    const original = await submitIntent(h, alpha.token, "writer-historical", body);
    expect(original.status).toBe(201);
    const writer = required(h.runtime.writer);
    await releaseWriterLock(writer.client, writer.key);
    const admitted = await submitIntent(h, alpha.token, "lost-writer-admission", body);
    expect(admitted.status).toBe(503);
    expect(admitted.body.error).toMatchObject({ code: "NOT_READY" });
    const replay = await submitIntent(h, alpha.token, "writer-historical", body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(original.body);
    const missingLease = await submitIntent(h, alpha.token, "lost-writer-missing-lease", {
      ...body,
      lease_id: "nonexistent-lease",
    });
    expect(missingLease.status).toBe(503);
    expect((await withClient(required(h.runtime.pool), (client) => listIncidents(client, h.accountId))).length).toBe(0);
    expect(
      (await required(h.runtime.pool).query("SELECT id FROM intents WHERE account_id = $1", [h.accountId])).rowCount,
    ).toBe(1);
  });

  it.each([
    { outcome: "OUTCOME_UNKNOWN" as const, incomplete: false },
    { outcome: "OUTCOME_UNKNOWN" as const, incomplete: true },
    { outcome: "REJECTED_CONFIRMED" as const, incomplete: false },
    { outcome: "REJECTED_CONFIRMED" as const, incomplete: true },
  ])(
    "retains known acceptance when a delayed $outcome arrives (incomplete=$incomplete)",
    async ({ outcome, incomplete }) => {
      const faults = { overstateExecutedFor: new Set<string>() };
      const h = await startHarness(roomy(), "scenario-a-constrained-acquisition", { paperFaults: faults });
      harnesses.push(h);
      const command = await readyBuy(h, `late-${outcome}-${incomplete}`);
      if (incomplete) faults.overstateExecutedFor.add(command.client_order_id);
      const execution = required(h.runtime.execution);
      const originalSubmit = execution.submitOnce.bind(execution);
      const recorded = signal();
      const releaseResponse = signal();
      execution.submitOnce = async (payload) => {
        await originalSubmit(payload);
        recorded.resolve();
        await releaseResponse.promise;
        return outcome === "OUTCOME_UNKNOWN"
          ? { kind: "OUTCOME_UNKNOWN", clientOrderId: payload.client_order_id, detail: "late response timeout" }
          : { kind: "REJECTED_CONFIRMED", code: "DUPLICATE", detail: "late duplicate response" };
      };
      const pendingDispatch = dispatchOnce(h.runtime, h.runtime.clock());
      await recorded.promise;
      let holdsAfterQuery: Array<[string, string, string]> = [];
      try {
        // Background investigation can settle an order while its original request is still waiting.
        const reconciled = await reconcileCommand(h.runtime, command.id, h.runtime.clock(), "BACKGROUND");
        expect(reconciled.result).toBe(incomplete ? "ACCEPTED_UNSETTLED" : "RECONCILED");
        holdsAfterQuery = (
          await withClient(required(h.runtime.pool), (client) =>
            listReservationsForProposal(client, command.proposal_id),
          )
        ).map((row) => [row.kind, row.state, row.amount]);
      } finally {
        releaseResponse.resolve();
        await pendingDispatch;
      }
      const current = required(
        (await withClient(required(h.runtime.pool), (client) => listCommands(client, h.accountId)))[0],
      );
      expect(current.state).toBe("ACCEPTED");
      expect(current.reconciled_at === null).toBe(incomplete);
      const reservations = await withClient(required(h.runtime.pool), (client) =>
        listReservationsForProposal(client, command.proposal_id),
      );
      expect(reservations.map((row) => [row.kind, row.state, row.amount])).toEqual(holdsAfterQuery);
      expect(reservations.some((row) => row.state === "ARMED")).toBe(incomplete);
      expect(
        (await withClient(required(h.runtime.pool), (client) => listIncidents(client, h.accountId, "OPEN"))).filter(
          (incident) => incident.type === "OUTCOME_UNKNOWN",
        ),
      ).toEqual([]);
    },
  );

  it("reports the persisted unknown outcome when the submission response has the wrong order identity", async () => {
    const h = await startHarness(roomy(), "scenario-a-constrained-acquisition");
    harnesses.push(h);
    const command = await readyBuy(h, "dispatch-identity-refused");
    const execution = required(h.runtime.execution);
    const originalSubmit = execution.submitOnce.bind(execution);
    execution.submitOnce = async (payload) => {
      const result = await originalSubmit(payload);
      if (result.kind !== "ACCEPTED") throw new Error("fixture order was not accepted");
      return { kind: "ACCEPTED", order: { ...result.order, side: "SELL" } };
    };
    const report = await dispatchOnce(h.runtime, h.runtime.clock());
    expect(report).toMatchObject({ kind: "ARMED", outcome: "OUTCOME_UNKNOWN", reconciliation: { order_id: null } });
    const current = required(
      (await withClient(required(h.runtime.pool), (client) => listCommands(client, h.accountId)))[0],
    );
    expect(current.state).toBe("OUTCOME_UNKNOWN");
    const reservations = await withClient(required(h.runtime.pool), (client) =>
      listReservationsForProposal(client, command.proposal_id),
    );
    expect(reservations.filter((row) => row.kind === "QUOTE").map((row) => row.state)).toEqual(["ARMED"]);
  });

  it("reports a refused order identity as still unknown and backs off further automatic queries", async () => {
    const faults = { dropResponseFor: new Set<string>() };
    const h = await startHarness(roomy(), "scenario-a-constrained-acquisition", { paperFaults: faults });
    harnesses.push(h);
    const command = await readyBuy(h, "identity-refused");
    faults.dropResponseFor.add(command.client_order_id);
    expect(await dispatchOnce(h.runtime, h.runtime.clock())).toMatchObject({
      kind: "ARMED",
      outcome: "OUTCOME_UNKNOWN",
    });
    const execution = required(h.runtime.execution);
    const originalQuery = execution.queryOrder.bind(execution);
    execution.queryOrder = async (identity) => {
      const query = await originalQuery(identity);
      if (query.kind !== "FOUND") throw new Error("fixture order missing");
      return { kind: "FOUND", order: { ...query.order, side: "SELL" } };
    };
    const report = await reconcileCommand(h.runtime, command.id, h.runtime.clock(), "OPERATOR");
    expect(report).toMatchObject({ after: "OUTCOME_UNKNOWN", result: "STILL_UNKNOWN", apply: { order_id: null } });
    const pending = await reconcileOutstanding(h.runtime, h.runtime.clock());
    expect(pending.deferred).toEqual([command.id]);
    expect(pending.reports).toEqual([]);
  });

  it("skips an older query when another query settled the same ACCEPTED command during its venue wait", async () => {
    const h = await startHarness(roomy(), "scenario-a-constrained-acquisition");
    harnesses.push(h);
    const command = await readyBuy(h, "accepted-query-race");
    const execution = required(h.runtime.execution);
    const originalSubmit = execution.submitOnce.bind(execution);
    const originalFills = execution.listRelevantFills.bind(execution);
    const originalQuery = execution.queryOrder.bind(execution);
    let partial: NormalizedOrder | undefined;
    execution.submitOnce = async (payload) => {
      const result = await originalSubmit(payload);
      if (result.kind !== "ACCEPTED") throw new Error("fixture order was not accepted");
      partial = {
        ...result.order,
        status: "PARTIALLY_FILLED",
        executed_base: canonicalizeDecimal("0.1"),
        executed_quote: canonicalizeDecimal("10"),
      };
      return { kind: "ACCEPTED", order: partial };
    };
    execution.listRelevantFills = async (cursor) => ({ ...(await originalFills(cursor)), fills: [] });
    expect(await dispatchOnce(h.runtime, h.runtime.clock())).toMatchObject({
      kind: "ARMED",
      outcome: "ACCEPTED",
      reconciliation: { reconciled: false },
    });
    execution.listRelevantFills = originalFills;
    const olderQueryStarted = signal();
    const releaseOlderQuery = signal();
    let queries = 0;
    execution.queryOrder = async (identity) => {
      if (++queries === 1) {
        olderQueryStarted.resolve();
        await releaseOlderQuery.promise;
        return { kind: "FOUND", order: required(partial) };
      }
      return originalQuery(identity);
    };
    const older = reconcileCommand(h.runtime, command.id, h.runtime.clock(), "BACKGROUND");
    await olderQueryStarted.promise;
    try {
      expect(await reconcileCommand(h.runtime, command.id, h.runtime.clock(), "OPERATOR")).toMatchObject({
        result: "RECONCILED",
        after: "ACCEPTED",
      });
    } finally {
      releaseOlderQuery.resolve();
    }
    expect(await older).toMatchObject({ result: "NOT_APPLICABLE", after: "ACCEPTED", apply: null });
    expect(
      await withClient(required(h.runtime.pool), (client) => getOrderForCommand(client, command.id)),
    ).toMatchObject({ status: "FILLED" });
    expect((await computeReadiness(h.runtime)).ready).toBe(true);
  });

  it("rejects foreign reconciliation IDs before venue reads, schedule resets, or account mutations", async () => {
    const faults = { dropResponseFor: new Set<string>() };
    const foreign = await startHarness(roomy(), "scenario-a-constrained-acquisition", { paperFaults: faults });
    const local = await startHarness(roomy(), "scenario-a-constrained-acquisition");
    harnesses.push(foreign, local);
    const command = await readyBuy(foreign, "foreign-reconciliation");
    faults.dropResponseFor.add(command.client_order_id);
    expect(await dispatchOnce(foreign.runtime, foreign.runtime.clock())).toMatchObject({
      kind: "ARMED",
      outcome: "OUTCOME_UNKNOWN",
    });
    // Model a process that crashed before its response was persisted.
    await required(foreign.runtime.pool).query("UPDATE commands SET state = 'ARMED' WHERE id = $1", [command.id]);
    let queries = 0;
    required(local.runtime.execution).queryOrder = async () => {
      queries += 1;
      return { kind: "NOT_FOUND", detail: "foreign venue identity" };
    };
    const schedule = { attempts: 3, next_at: local.clock.now + 30_000 };
    local.runtime.reconciliation.set(command.id, schedule);
    const beforeEvents = await withClient(required(local.runtime.pool), (client) =>
      listAuditEvents(client, local.accountId),
    );
    await expect(reconcileCommand(local.runtime, command.id, local.runtime.clock(), "OPERATOR")).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    const op = await operator(local);
    const refused = await opRequest(
      local,
      op.token,
      "POST",
      `/v1/commands/${command.id}/reconcile`,
      {},
      { "idempotency-key": "foreign-reconcile-refusal" },
    );
    expect(refused.status).toBe(404);
    expect(refused.body.error).toMatchObject({ code: "NOT_FOUND" });
    expect(queries).toBe(0);
    expect(local.runtime.reconciliation.get(command.id)).toEqual(schedule);
    expect(
      (await withClient(required(foreign.runtime.pool), (client) => listCommands(client, foreign.accountId)))[0]?.state,
    ).toBe("ARMED");
    expect(
      await withClient(required(local.runtime.pool), (client) => listAuditEvents(client, local.accountId)),
    ).toEqual(beforeEvents);
  });

  it("still releases an unaccepted confirmed rejection and consumes its single attempt", async () => {
    const h = await startHarness(roomy(), "scenario-a-constrained-acquisition");
    harnesses.push(h);
    const command = await readyBuy(h, "confirmed-rejection");
    required(h.runtime.execution).submitOnce = async () => ({
      kind: "REJECTED_CONFIRMED",
      code: "UNSUPPORTED",
      detail: "venue did not accept the order",
    });
    expect(await dispatchOnce(h.runtime, h.runtime.clock())).toMatchObject({
      kind: "ARMED",
      outcome: "REJECTED_CONFIRMED",
    });
    const current = required(
      (await withClient(required(h.runtime.pool), (client) => listCommands(client, h.accountId)))[0],
    );
    expect(current.state).toBe("REJECTED_CONFIRMED");
    const reservations = await withClient(required(h.runtime.pool), (client) =>
      listReservationsForProposal(client, command.proposal_id),
    );
    expect(reservations.map((row) => [row.kind, row.state])).toEqual([
      ["ATTEMPT", "CONSUMED"],
      ["QUOTE", "RELEASED"],
    ]);
    const alpha = seededAgent(h, "agent_alpha");
    expect(
      (await withClient(required(h.runtime.pool), (client) => getLeaseById(client, alpha.lease_id)))?.attempts_consumed,
    ).toBe(1);
  });
});
