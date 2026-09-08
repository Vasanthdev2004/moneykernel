import { verifyEventChain } from "@moneykernel/contracts";
import {
  loadScenario,
  MemoryPaperVenueStore,
  type PaperExecutionAdapter,
  type Scenario,
} from "@moneykernel/integrations";
import {
  countOutstandingCommands,
  getLeaseById,
  listAssetBalances,
  listAuditEvents,
  listCommands,
  listFillsForOrder,
  listIncidents,
  listInventoryAllocations,
  listLedgerEntries,
  listReservationsForProposal,
  withClient,
  withTransaction,
} from "@moneykernel/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot } from "../../../apps/kernel/src/boot.ts";
import { loadConfig } from "../../../apps/kernel/src/config.ts";
import { dispatchOnce } from "../../../apps/kernel/src/dispatcher/dispatch.ts";
import { FIXTURES_DIR } from "../../../apps/kernel/src/fixtures.ts";
import { computeReadiness } from "../../../apps/kernel/src/readiness.ts";
import { sweepProposals } from "../../../apps/kernel/src/services/proposals.ts";
import { applyObservedOrderInTx, reconcileOutstanding } from "../../../apps/kernel/src/services/reconciliation.ts";
import {
  buyIntent,
  DATABASE_URL_TEST,
  type Harness,
  migrateTestDatabase,
  OPERATOR_SECRET,
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

beforeAll(async () => {
  await migrateTestDatabase();
});

afterAll(async () => {
  for (const h of harnesses) await stopHarness(h).catch(() => undefined);
});

function roomy(usdt: string): Scenario {
  const s = loadScenario("scenario-a-constrained-acquisition", FIXTURES_DIR);
  s.account.balances = { USDT: usdt };
  s.account.inventory_allocations = {};
  s.policy = {
    ...(s.policy ?? {}),
    max_order_notional_quote: "1000",
    max_symbol_share: "1",
    min_quote_cash_buffer: "0",
    valuation_buffer_quote: "0",
    max_unique_intents_per_60s: 1000,
  };
  return s;
}

function scenarioD(): Scenario {
  const s = loadScenario("scenario-d-lost-response", FIXTURES_DIR);
  s.policy = { ...(s.policy ?? {}), max_unique_intents_per_60s: 1000 };
  return s;
}

async function approveExact(h: Harness, token: string, proposal: Record<string, unknown>, key: string) {
  return opRequest(
    h,
    token,
    "POST",
    `/v1/proposals/${String(proposal.proposal_id)}/approve`,
    {
      proposal_revision: proposal.revision ?? proposal.proposal_revision,
      proposal_hash: proposal.proposal_hash,
      expected_account_epoch: h.runtime.account?.epoch ?? 1,
      operator_confirmation: true,
    },
    { "idempotency-key": key },
  );
}

/** Submits, sweeps, approves one BUY and returns the READY command's client order id. */
async function readyBuy(h: Harness, amount: string, key: string) {
  const alpha = seededAgent(h, "agent_alpha");
  const op = await operator(h);
  const obs = await observationFor(h, alpha.token, "SOLUSDT");
  const submitted = await submitIntent(h, alpha.token, key, buyIntent(alpha.lease_id, "SOLUSDT", amount, "100", obs));
  expect(submitted.status).toBe(201);
  h.tick(800);
  await sweepProposals(h.runtime, new Date(h.clock.now));
  const approved = await approveExact(h, op.token, submitted.body, `${key}-approve`);
  expect(approved.status).toBe(201);
  const pool = h.runtime.pool;
  if (pool === null) throw new Error("no pool");
  const commands = await withClient(pool, (c) => listCommands(c, h.accountId));
  const command = commands.find((c) => c.proposal_id === submitted.body.proposal_id);
  if (command === undefined) throw new Error("no command");
  return { alpha, op, proposalId: String(submitted.body.proposal_id), command };
}

function poolOf(h: Harness) {
  const pool = h.runtime.pool;
  if (pool === null) throw new Error("no pool");
  return pool;
}

describe("fill accounting settles in the dispatch transaction (FR-08, INV-08, T-39, T-40, prd.md 11.6, 28.3)", () => {
  it("applies a full paper fill once: balances, attribution, lease consumption, hold consumed, reconciled marker", async () => {
    const h = await startHarness(roomy("1000"), "scenario-a-constrained-acquisition");
    harnesses.push(h);
    const { alpha, op, proposalId, command } = await readyBuy(h, "20", "recon-full-001");
    const pool = poolOf(h);

    const report = await dispatchOnce(h.runtime, new Date(h.clock.now));
    expect(report.kind).toBe("ARMED");
    if (report.kind !== "ARMED") throw new Error("not armed");
    expect(report.outcome).toBe("ACCEPTED");
    expect(report.reconciliation?.reconciled).toBe(true);
    expect(report.reconciliation?.executed_base).toBe("0.2");
    expect(report.reconciliation?.executed_quote).toBe("20");
    expect(report.reconciliation?.fee_quote).toBe("0.02");
    expect(report.reconciliation?.consumed_quote).toBe("20.02");
    expect(report.reconciliation?.released_quote).toBe("0");

    const balances = await withClient(pool, (c) => listAssetBalances(c, h.accountId));
    expect(Object.fromEntries(balances.map((b) => [b.asset, b.owned_quantity]))).toEqual({
      SOL: "0.200000000000000000",
      USDT: "979.980000000000000000",
    });
    const allocations = await withClient(pool, (c) => listInventoryAllocations(c, h.accountId, alpha.agent_id));
    expect(allocations.map((a) => [a.asset, a.owned_quantity])).toEqual([["SOL", "0.200000000000000000"]]);
    const lease = await withClient(pool, (c) => getLeaseById(c, alpha.lease_id));
    expect(lease?.consumed_quote).toBe("20.020000000000000000");
    expect(lease?.attempts_consumed).toBe(1);

    const reservations = await withClient(pool, (c) => listReservationsForProposal(c, proposalId));
    expect(reservations.map((r) => [r.kind, r.state, r.amount])).toEqual([
      ["ATTEMPT", "CONSUMED", "1.000000000000000000"],
      ["QUOTE", "CONSUMED", "20.020000000000000000"],
    ]);
    const commands = await withClient(pool, (c) => listCommands(c, h.accountId));
    expect(commands[0]?.state).toBe("ACCEPTED");
    expect(commands[0]?.reconciled_at).not.toBeNull();
    expect((await withClient(pool, (c) => countOutstandingCommands(c, h.accountId))).total).toBe(0);
    expect((await computeReadiness(h.runtime)).ready).toBe(true);

    // Operator view: order, fills, and the three journal entries that fill produced.
    const detail = await opRequest(h, op.token, "GET", `/v1/commands/${command.id}`);
    expect(detail.status).toBe(200);
    const order = detail.body.order as { status: string; executed_base: string };
    expect(order.status).toBe("FILLED");
    expect((detail.body.fills as unknown[]).length).toBe(1);
    const ledger = detail.body.ledger_entries as Array<{ category: string; asset: string; signed_delta: string }>;
    expect(ledger.map((l) => [l.category, l.asset, l.signed_delta])).toEqual([
      ["FILL_BASE", "SOL", "0.200000000000000000"],
      ["FILL_QUOTE", "USDT", "-20.000000000000000000"],
      ["FILL_FEE", "USDT", "-0.020000000000000000"],
    ]);
    const all = await withClient(pool, (c) => listLedgerEntries(c, h.accountId));
    expect(all.map((l) => l.sequence)).toEqual(["1", "2", "3", "4"]);

    // T-39: the same fill identity applied again changes nothing.
    const again = await withTransaction(pool, async (tx) => {
      const paper = h.runtime.execution as PaperExecutionAdapter;
      const query = await paper.queryOrder({
        client_order_id: command.client_order_id,
        exchange_order_id: null,
        symbol: "SOLUSDT",
      });
      if (query.kind !== "FOUND") throw new Error("paper lost the order");
      const fills = (await paper.listRelevantFills({ since_event_time: null, since_fill_id: null })).fills;
      const [locked] = await listCommands(tx, h.accountId, ["ACCEPTED"]);
      if (locked === undefined) throw new Error("no command");
      return applyObservedOrderInTx(tx, h.runtime, {
        command: locked,
        order: query.order,
        fills,
        now: new Date(h.clock.now),
        source: "OPERATOR",
      });
    });
    expect(again.new_fills).toBe(0);
    expect(again.duplicate_fills).toBe(1);
    const balancesAfter = await withClient(pool, (c) => listAssetBalances(c, h.accountId));
    expect(balancesAfter).toEqual(balances);
    expect((await withClient(pool, (c) => listLedgerEntries(c, h.accountId))).length).toBe(4);

    // An operator re-query of a settled command is a no-op, never a resubmission.
    const reconcile = await opRequest(
      h,
      op.token,
      "POST",
      `/v1/commands/${command.id}/reconcile`,
      {},
      {
        "idempotency-key": "recon-full-001-op",
      },
    );
    expect(reconcile.status).toBe(200);
    expect(reconcile.body.result).toBe("NOT_APPLICABLE");
    expect((h.runtime.execution as PaperExecutionAdapter).submitCount).toBe(1);

    // T-16 hook: the acquisition budget stays consumed; the agent sees it in its context.
    const ctx = await h.app.inject({
      method: "GET",
      url: "/v1/agent/context",
      headers: { authorization: `Bearer ${alpha.token}` },
    });
    expect((ctx.json() as { lease: { consumed_quote: string } }).lease.consumed_quote).toBe("20.020000000000000000");
    const events = await withClient(pool, (c) => listAuditEvents(c, h.accountId, { limit: 5000 }));
    expect(verifyEventChain(events, null).ok).toBe(true);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["COMMAND_ARMED", "FILL_RECONCILED", "RESERVATION_CONSUMED", "ORDER_OBSERVED"]),
    );
  });

  it("T-40: a partial IOC fill then expiry consumes the executed cost and releases only the remainder", async () => {
    const h = await startHarness(scenarioD(), "scenario-d-lost-response");
    harnesses.push(h);
    const { alpha, proposalId } = await readyBuy(h, "20", "recon-partial-001");
    const pool = poolOf(h);
    const report = await dispatchOnce(h.runtime, new Date(h.clock.now));
    if (report.kind !== "ARMED") throw new Error("not armed");
    expect(report.outcome).toBe("ACCEPTED");
    expect(report.reconciliation).toMatchObject({
      order_status: "EXPIRED",
      executed_base: "0.12",
      executed_quote: "12",
      fee_quote: "0.012",
      consumed_quote: "12.012",
      released_quote: "8.008",
      reconciled: true,
    });
    const reservations = await withClient(pool, (c) => listReservationsForProposal(c, proposalId));
    expect(reservations.filter((r) => r.kind === "QUOTE").map((r) => [r.state, r.amount])).toEqual([
      ["CONSUMED", "12.012000000000000000"],
      ["RELEASED", "8.008000000000000000"],
    ]);
    const balances = await withClient(pool, (c) => listAssetBalances(c, h.accountId));
    expect(Object.fromEntries(balances.map((b) => [b.asset, b.owned_quantity]))).toEqual({
      SOL: "0.120000000000000000",
      USDT: "987.988000000000000000",
    });
    const lease = await withClient(pool, (c) => getLeaseById(c, alpha.lease_id));
    expect(lease?.consumed_quote).toBe("12.012000000000000000");
    expect((await withClient(pool, (c) => countOutstandingCommands(c, h.accountId))).total).toBe(0);
  });
});

describe("restart recovery by stable identity (prd.md 11.8, 27.4, T-35, T-36, T-37, T-38, T-42)", () => {
  it("scenario D: dropped response, crash, restart; the venue is queried, nothing is resent", async () => {
    const store = new MemoryPaperVenueStore();
    const faults = { dropResponseFor: new Set<string>() };
    let h = await startHarness(scenarioD(), "scenario-d-lost-response", {
      paperVenueStore: store,
      paperFaults: faults,
    });
    harnesses.push(h);
    const { alpha, proposalId, command } = await readyBuy(h, "20", "recon-lost-001");
    faults.dropResponseFor.add(command.client_order_id);

    const report = await dispatchOnce(h.runtime, new Date(h.clock.now));
    if (report.kind !== "ARMED") throw new Error("not armed");
    expect(report.outcome).toBe("OUTCOME_UNKNOWN");
    let pool = poolOf(h);
    let commands = await withClient(pool, (c) => listCommands(c, h.accountId));
    expect(commands.map((c) => c.state)).toEqual(["OUTCOME_UNKNOWN"]);
    expect(h.runtime.account && (await computeReadiness(h.runtime)).ready).toBe(false);
    const incidents = await withClient(pool, (c) => listIncidents(c, h.accountId, "OPEN"));
    expect(incidents.map((i) => i.type)).toEqual(["OUTCOME_UNKNOWN"]);
    let reservations = await withClient(pool, (c) => listReservationsForProposal(c, proposalId));
    expect(reservations.filter((r) => r.kind === "QUOTE").map((r) => r.state)).toEqual(["ARMED"]);
    expect((h.runtime.execution as PaperExecutionAdapter).submitCount).toBe(1);

    // Crash before the response was persisted; the venue's memory survives, the kernel's process state does not.
    h.tick(7_000);
    h = await restartHarness(h, scenarioD());
    harnesses.push(h);
    pool = poolOf(h);
    expect(h.runtime.recovery).toMatchObject({ examined: 1, reconciled: [command.id], unknown: [], unsettled: [] });
    expect(h.runtime.bootChecks.find((c) => c.name === "recovery")?.ok).toBe(true);
    expect(h.runtime.bootChecks.find((c) => c.name === "unresolved_commands")?.ok).toBe(true);
    expect(h.runtime.account?.status).toBe("PAUSED");
    expect(h.runtime.account?.epoch).toBe(2);

    commands = await withClient(pool, (c) => listCommands(c, h.accountId));
    expect(commands.length).toBe(1);
    expect(commands[0]?.client_order_id).toBe(command.client_order_id);
    expect(commands[0]?.state).toBe("ACCEPTED");
    expect(commands[0]?.reconciled_at).not.toBeNull();
    const paper = h.runtime.execution as PaperExecutionAdapter;
    expect(paper.submitCount).toBe(1);
    expect(Object.keys(paper.venueState().orders)).toEqual([command.client_order_id]);
    const orderRow = commands[0]?.outcome_ref ?? "";
    const fills = await withClient(pool, (c) => listFillsForOrder(c, orderRow));
    expect(fills.map((f) => [f.base_qty, f.price, f.commission_qty])).toEqual([
      ["0.120000000000000000", "100.000000000000000000", "0.012000000000000000"],
    ]);
    reservations = await withClient(pool, (c) => listReservationsForProposal(c, proposalId));
    expect(reservations.filter((r) => r.kind === "QUOTE").map((r) => [r.state, r.amount])).toEqual([
      ["CONSUMED", "12.012000000000000000"],
      ["RELEASED", "8.008000000000000000"],
    ]);
    const lease = await withClient(pool, (c) => getLeaseById(c, alpha.lease_id));
    expect(lease?.consumed_quote).toBe("12.012000000000000000");
    const balances = await withClient(pool, (c) => listAssetBalances(c, h.accountId));
    expect(Object.fromEntries(balances.map((b) => [b.asset, b.owned_quantity]))).toEqual({
      SOL: "0.120000000000000000",
      USDT: "987.988000000000000000",
    });
    expect((await withClient(pool, (c) => listIncidents(c, h.accountId, "OPEN"))).length).toBe(0);
    expect((await computeReadiness(h.runtime)).ready).toBe(true);

    // Only an operator returns the account to READY after reconciliation (prd.md 11.1).
    const op = await operator(h);
    const resume = await opRequest(
      h,
      op.token,
      "POST",
      "/v1/account/resume",
      {},
      { "idempotency-key": "recon-lost-resume" },
    );
    expect(resume.status).toBe(200);
    expect(resume.body.status).toBe("READY");
    expect((await dispatchOnce(h.runtime, new Date(h.clock.now))).kind).toBe("IDLE");
    const events = await withClient(pool, (c) => listAuditEvents(c, h.accountId, { limit: 5000 }));
    expect(verifyEventChain(events, null).ok).toBe(true);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        "ACCOUNT_BOOTED",
        "FILL_RECONCILED",
        "INCIDENT_RESOLVED",
        "ACCOUNT_RECONCILING",
        "ACCOUNT_RESUMED",
      ]),
    );
  });

  it("T-37 / T-36 / T-42: armed before a crash, unknown to the venue: stays unknown, holds retained, no new order", async () => {
    const store = new MemoryPaperVenueStore();
    const faults = { dropResponseFor: new Set<string>() };
    let h = await startHarness(roomy("1000"), "scenario-a-constrained-acquisition", {
      paperVenueStore: store,
      paperFaults: faults,
    });
    harnesses.push(h);
    const { alpha, proposalId, command } = await readyBuy(h, "20", "recon-armed-001");
    faults.dropResponseFor.add(command.client_order_id);
    const report = await dispatchOnce(h.runtime, new Date(h.clock.now));
    if (report.kind !== "ARMED") throw new Error("not armed");
    expect(report.outcome).toBe("OUTCOME_UNKNOWN");
    // Model the crash between the arm commit and the venue call: the command is ARMED and the venue never saw it.
    let pool = poolOf(h);
    await pool.query("UPDATE commands SET state = 'ARMED', outcome_ref = NULL WHERE id = $1", [command.id]);
    await pool.query("DELETE FROM incidents WHERE account_id = $1", [h.accountId]);
    await pool.query("UPDATE accounts SET status = 'READY' WHERE id = $1", [h.accountId]);

    h = await restartHarness(h, roomy("1000"), { paperVenueStore: new MemoryPaperVenueStore() });
    harnesses.push(h);
    pool = poolOf(h);
    expect(h.runtime.recovery).toMatchObject({ examined: 1, reconciled: [], unknown: [command.id] });
    expect(h.runtime.bootChecks.find((c) => c.name === "recovery")?.ok).toBe(false);
    let commands = await withClient(pool, (c) => listCommands(c, h.accountId));
    expect(commands.map((c) => c.state)).toEqual(["OUTCOME_UNKNOWN"]);
    const incidents = await withClient(pool, (c) => listIncidents(c, h.accountId, "OPEN"));
    expect(incidents.map((i) => [i.type, i.severity])).toEqual([["OUTCOME_UNKNOWN", "CRITICAL"]]);
    expect((await computeReadiness(h.runtime)).ready).toBe(false);
    let reservations = await withClient(pool, (c) => listReservationsForProposal(c, proposalId));
    expect(reservations.filter((r) => r.kind === "QUOTE").map((r) => r.state)).toEqual(["ARMED"]);

    // Background re-queries back off and stay bounded; absence is never a rejection.
    const first = await reconcileOutstanding(h.runtime, new Date(h.clock.now));
    expect(first.deferred).toEqual([command.id]);
    h.tick(60_000);
    const second = await reconcileOutstanding(h.runtime, new Date(h.clock.now));
    expect(second.reports.map((r) => r.result)).toEqual(["STILL_UNKNOWN"]);
    expect((h.runtime.execution as PaperExecutionAdapter).submitCount).toBe(0);

    // T-42: the lease expires while the outcome is unknown; the armed hold stays, nothing new is created.
    h.tick(30 * 60_000);
    await sweepProposals(h.runtime, new Date(h.clock.now));
    reservations = await withClient(pool, (c) => listReservationsForProposal(c, proposalId));
    expect(reservations.filter((r) => r.kind === "QUOTE").map((r) => r.state)).toEqual(["ARMED"]);
    commands = await withClient(pool, (c) => listCommands(c, h.accountId));
    expect(commands.length).toBe(1);
    const op = await operator(h);
    const resume = await opRequest(
      h,
      op.token,
      "POST",
      "/v1/account/resume",
      {},
      { "idempotency-key": "recon-armed-resume" },
    );
    expect(resume.status).toBe(409);
    const manual = await opRequest(
      h,
      op.token,
      "POST",
      `/v1/commands/${command.id}/reconcile`,
      {},
      {
        "idempotency-key": "recon-armed-manual",
      },
    );
    expect(manual.status).toBe(200);
    expect(manual.body.result).toBe("STILL_UNKNOWN");
    expect(await withClient(pool, (c) => getLeaseById(c, alpha.lease_id))).not.toBeNull();

    // The venue's real memory comes back (T-38): recovery finds the same identity and settles it.
    h = await restartHarness(h, roomy("1000"), { paperVenueStore: store });
    harnesses.push(h);
    pool = poolOf(h);
    expect(h.runtime.recovery).toMatchObject({ examined: 1, reconciled: [command.id] });
    commands = await withClient(pool, (c) => listCommands(c, h.accountId));
    expect(commands.map((c) => c.state)).toEqual(["ACCEPTED"]);
    expect((await withClient(pool, (c) => listIncidents(c, h.accountId, "OPEN"))).length).toBe(0);
    expect((await computeReadiness(h.runtime)).ready).toBe(true);
    expect(Object.keys((h.runtime.execution as PaperExecutionAdapter).venueState().orders)).toEqual([
      command.client_order_id,
    ]);
  });
});

describe("SHADOW mode wiring (prd.md 13.1, 13.4, T-49)", () => {
  it("boots with the read-only public REST adapter and a live-book paper executor; no network call at boot", async () => {
    const runtime = await boot(
      loadConfig({
        DATABASE_URL: DATABASE_URL_TEST,
        OPERATOR_BOOTSTRAP_SECRET: OPERATOR_SECRET,
        MONEYKERNEL_MODE: "SHADOW",
        MONEYKERNEL_ACCOUNT_ALIAS: `shadow-${Date.now().toString(36)}`,
        LOG_LEVEL: "silent",
      }),
      { paperVenueStore: new MemoryPaperVenueStore() },
    );
    try {
      expect(runtime.bootChecks.find((c) => c.name === "market_adapter")?.ok).toBe(true);
      expect(runtime.market?.source).toBe("BINANCE_PUBLIC_REST");
      const paper = runtime.execution as PaperExecutionAdapter;
      expect(paper.bookKind).toBe("LIVE");
      expect(paper.environment).toBe("SHADOW");
      const adapter = runtime.market as unknown as { requestCount: number };
      expect(adapter.requestCount).toBe(0);
      expect(runtime.marketHealth.last_successful_read_at).toBeNull();
    } finally {
      await runtime.shutdown();
    }
  });
});
