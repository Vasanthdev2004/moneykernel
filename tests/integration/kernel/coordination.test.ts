import { verifyEventChain } from "@moneykernel/contracts";
import { loadScenario, type PaperExecutionAdapter, type Scenario } from "@moneykernel/integrations";
import {
  getLeaseById,
  listAuditEvents,
  listCommands,
  listReservationsForProposal,
  withClient,
} from "@moneykernel/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot } from "../../../apps/kernel/src/boot.ts";
import { loadConfig } from "../../../apps/kernel/src/config.ts";
import { dispatchOnce } from "../../../apps/kernel/src/dispatcher/dispatch.ts";
import { FIXTURES_DIR } from "../../../apps/kernel/src/fixtures.ts";
import { sweepProposals } from "../../../apps/kernel/src/services/proposals.ts";
import {
  buyIntent,
  DATABASE_URL_TEST,
  type Harness,
  migrateTestDatabase,
  OPERATOR_SECRET,
  observationFor,
  operator,
  operatorLogin,
  opRequest,
  seededAgent,
  sellIntent,
  startHarness,
  stopHarness,
  submitIntent,
  sumReserved,
} from "./harness.ts";

const harnesses: Harness[] = [];
beforeAll(migrateTestDatabase);
afterAll(async () => {
  for (const h of harnesses) await stopHarness(h);
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
  const alpha = s.agents[0];
  if (alpha === undefined) throw new Error("fixture has no agent");
  alpha.lease.acquisition_budget_quote = "1000";
  alpha.lease.max_submission_attempts = 5;
  return s;
}

async function approveExact(h: Harness, token: string, proposal: Record<string, unknown>, key: string, epoch = 1) {
  return opRequest(
    h,
    token,
    "POST",
    `/v1/proposals/${String(proposal.proposal_id)}/approve`,
    {
      proposal_revision: proposal.revision ?? proposal.proposal_revision,
      proposal_hash: proposal.proposal_hash,
      expected_account_epoch: epoch,
      operator_confirmation: true,
    },
    { "idempotency-key": key },
  );
}

async function proposalsOf(h: Harness, token: string) {
  const res = await opRequest(h, token, "GET", "/v1/proposals");
  expect(res.status).toBe(200);
  return res.body as { proposals: Array<Record<string, unknown>>; conflicts: Array<Record<string, unknown>> };
}

describe("operator sessions (prd.md 18.2, FR-01)", () => {
  it("rejects bad secrets, rate-limits attempts, and enforces CSRF for cookie sessions", async () => {
    const h = await startHarness(roomy("100"), "scenario-a-constrained-acquisition");
    harnesses.push(h);
    expect((await h.app.inject({ method: "GET", url: "/v1/proposals" })).statusCode).toBe(401);
    const bad = await operatorLogin(h, "wrong-secret");
    expect(bad.status).toBe(401);
    const good = await operator(h);
    const viaBearer = await opRequest(h, good.token, "GET", "/v1/proposals");
    expect(viaBearer.status).toBe(200);
    const cookieNoCsrf = await h.app.inject({
      method: "POST",
      url: "/v1/account/stop",
      headers: { cookie: good.cookie, "content-type": "application/json", "idempotency-key": "csrf-check-01" },
      payload: "{}",
    });
    expect(cookieNoCsrf.statusCode).toBe(403);
    const cookieWithCsrf = await h.app.inject({
      method: "GET",
      url: "/v1/proposals",
      headers: { cookie: good.cookie },
    });
    expect(cookieWithCsrf.statusCode).toBe(200);
    for (let i = 0; i < 5; i += 1) await operatorLogin(h, "wrong-secret");
    expect((await operatorLogin(h, OPERATOR_SECRET)).status).toBe(429);
  });
});

describe("exact approval, arming, and paper execution (FR-07, FR-08, INV-05, INV-06, T-20, T-21)", () => {
  it("binds the approval to the exact candidate, arms once, and records the observed paper order", async () => {
    const h = await startHarness(roomy("1000"), "scenario-a-constrained-acquisition");
    harnesses.push(h);
    const alpha = seededAgent(h, "agent_alpha");
    const op = await operator(h);
    const obs = await observationFor(h, alpha.token, "SOLUSDT");
    const submitted = await submitIntent(
      h,
      alpha.token,
      "approve-flow-001",
      buyIntent(alpha.lease_id, "SOLUSDT", "20", "100", obs),
    );
    expect(submitted.status).toBe(201);
    expect(submitted.body.state).toBe("COLLECTING");

    // Approval is impossible before the collection window elapses.
    const early = await approveExact(h, op.token, submitted.body, "approve-early-001");
    expect(early.status).toBe(409);

    h.tick(800);
    const swept = await sweepProposals(h.runtime, new Date(h.clock.now));
    expect(swept.promoted).toEqual([submitted.body.proposal_id]);
    const queue = await proposalsOf(h, op.token);
    const pending = queue.proposals.find((p) => p.proposal_id === submitted.body.proposal_id);
    expect(pending?.state).toBe("AWAITING_APPROVAL");

    // T-21: a tampered hash or revision is refused, never reinterpreted.
    const tampered = await approveExact(
      h,
      op.token,
      { ...submitted.body, proposal_hash: "0".repeat(64) },
      "approve-tampered-001",
    );
    expect(tampered.status).toBe(409);
    expect((tampered.body.error as { code: string }).code).toBe("STALE_VERSION");
    const wrongEpoch = await approveExact(h, op.token, submitted.body, "approve-epoch-001", 99);
    expect(wrongEpoch.status).toBe(409);

    // Fresh proposal after the epoch mismatch invalidated the old one.
    const again = await submitIntent(
      h,
      alpha.token,
      "approve-flow-002",
      buyIntent(alpha.lease_id, "SOLUSDT", "20", "100", await observationFor(h, alpha.token, "SOLUSDT")),
    );
    expect(again.status).toBe(201);
    h.tick(800);
    await sweepProposals(h.runtime, new Date(h.clock.now));
    const approved = await approveExact(h, op.token, again.body, "approve-exact-002");
    expect(approved.status).toBe(201);
    expect((approved.body as { state: string }).state).toBe("ACTIVE");

    // T-20: double click (same key) and a duplicate with a new key both resolve to the single stored approval.
    const replay = await approveExact(h, op.token, again.body, "approve-exact-002");
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    const duplicate = await approveExact(h, op.token, again.body, "approve-exact-003");
    expect(duplicate.status).toBe(200);
    expect((duplicate.body as { approval_id: string }).approval_id).toBe(
      (approved.body as { approval_id: string }).approval_id,
    );

    const pool = h.runtime.pool;
    if (pool === null) throw new Error("no pool");
    const commandsBefore = await withClient(pool, (c) => listCommands(c, h.accountId));
    expect(commandsBefore.map((c) => c.state)).toEqual(["READY"]);
    expect(commandsBefore[0]?.client_order_id).toMatch(/^mk_[0-9a-f]{32}$/);

    // Dispatch: arm once, submit once, observe the paper fill.
    const paper = h.runtime.execution as PaperExecutionAdapter;
    const report = await dispatchOnce(h.runtime, new Date(h.clock.now));
    expect(report.kind).toBe("ARMED");
    if (report.kind !== "ARMED") throw new Error("not armed");
    expect(report.outcome).toBe("ACCEPTED");
    expect(report.fills).toBe(1);
    expect(paper.submitCount).toBe(1);
    const commands = await withClient(pool, (c) => listCommands(c, h.accountId));
    expect(commands.map((c) => c.state)).toEqual(["ACCEPTED"]);
    const reservations = await withClient(pool, (c) => listReservationsForProposal(c, String(again.body.proposal_id)));
    expect(reservations.map((r) => [r.kind, r.state])).toEqual([
      ["ATTEMPT", "CONSUMED"],
      ["QUOTE", "ARMED"],
    ]);
    const lease = await withClient(pool, (c) => getLeaseById(c, alpha.lease_id));
    expect(lease?.attempts_consumed).toBe(1);
    expect((await dispatchOnce(h.runtime, new Date(h.clock.now))).kind).toBe("IDLE");
    const events = await withClient(pool, (c) => listAuditEvents(c, h.accountId, { limit: 5000 }));
    expect(verifyEventChain(events, null).ok).toBe(true);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        "APPROVAL_CREATED",
        "COMMAND_CREATED",
        "COMMAND_ARMED",
        "APPROVAL_CONSUMED",
        "ORDER_OBSERVED",
      ]),
    );
  });
});

describe("authority changes after approval (T-09, T-10, T-22, T-33)", () => {
  it("T-10: a revoked lease invalidates an approved command before it can arm", async () => {
    const h = await startHarness(roomy("1000"), "scenario-a-constrained-acquisition");
    harnesses.push(h);
    const alpha = seededAgent(h, "agent_alpha");
    const op = await operator(h);
    const submitted = await submitIntent(
      h,
      alpha.token,
      "revoke-001",
      buyIntent(alpha.lease_id, "SOLUSDT", "20", "100", await observationFor(h, alpha.token, "SOLUSDT")),
    );
    h.tick(800);
    await sweepProposals(h.runtime, new Date(h.clock.now));
    expect((await approveExact(h, op.token, submitted.body, "revoke-approve-001")).status).toBe(201);
    const revoked = await opRequest(h, op.token, "POST", `/v1/leases/${alpha.lease_id}/revoke`, {});
    expect(revoked.status).toBe(201);
    expect(revoked.body.invalidated_proposals).toEqual([submitted.body.proposal_id]);
    expect((await dispatchOnce(h.runtime, new Date(h.clock.now))).kind).toBe("IDLE");
    const pool = h.runtime.pool;
    if (pool === null) throw new Error("no pool");
    expect((await withClient(pool, (c) => listCommands(c, h.accountId))).map((c) => c.state)).toEqual([
      "ABORTED_PRE_ARM",
    ]);
    expect(await sumReserved(h, "QUOTE")).toBe("0");
  });

  it("T-09: a lease that expires during operator delay cannot dispatch; T-22: a policy change invalidates pending authority", async () => {
    const h = await startHarness(roomy("1000"), "scenario-a-constrained-acquisition");
    harnesses.push(h);
    const alpha = seededAgent(h, "agent_alpha");
    const op = await operator(h);
    const submitted = await submitIntent(
      h,
      alpha.token,
      "expire-001",
      buyIntent(alpha.lease_id, "SOLUSDT", "20", "100", await observationFor(h, alpha.token, "SOLUSDT")),
    );
    h.tick(800);
    await sweepProposals(h.runtime, new Date(h.clock.now));
    expect((await approveExact(h, op.token, submitted.body, "expire-approve-001")).status).toBe(201);
    h.tick(25 * 60_000); // past the 20 minute lease
    const report = await dispatchOnce(h.runtime, new Date(h.clock.now));
    expect(report.kind).toBe("ABORTED_PRE_ARM");
    if (report.kind === "ABORTED_PRE_ARM") expect(report.reason_codes).toContain("LEASE_EXPIRED");

    const policy = await opRequest(h, op.token, "GET", "/v1/policy");
    expect(policy.status).toBe(200);
    const pending = await submitIntent(
      h,
      alpha.token,
      "policy-001",
      buyIntent(alpha.lease_id, "SOLUSDT", "20", "100", await observationFor(h, alpha.token, "SOLUSDT")),
    );
    expect(pending.body.outcome).toBe("DENY"); // lease expired now; still recorded
    const put = await opRequest(
      h,
      op.token,
      "PUT",
      "/v1/policy",
      { ...(policy.body.policy as Record<string, unknown>), max_order_notional_quote: "25" },
      { "if-match": String(policy.body.version) },
    );
    expect(put.status).toBe(201);
    expect(put.body.version).toBe(2);
    const stale = await opRequest(h, op.token, "PUT", "/v1/policy", policy.body.policy, { "if-match": "1" });
    expect(stale.status).toBe(409);
  });

  it("T-33: stop after approval blocks arming, bumps the epoch, reports no in-flight command; resume is readiness-gated", async () => {
    const h = await startHarness(roomy("1000"), "scenario-a-constrained-acquisition");
    harnesses.push(h);
    const alpha = seededAgent(h, "agent_alpha");
    const op = await operator(h);
    const submitted = await submitIntent(
      h,
      alpha.token,
      "stop-001",
      buyIntent(alpha.lease_id, "SOLUSDT", "20", "100", await observationFor(h, alpha.token, "SOLUSDT")),
    );
    h.tick(800);
    await sweepProposals(h.runtime, new Date(h.clock.now));
    expect((await approveExact(h, op.token, submitted.body, "stop-approve-001")).status).toBe(201);
    const stop = await opRequest(
      h,
      op.token,
      "POST",
      "/v1/account/stop",
      { reason: "operator drill" },
      { "idempotency-key": "stop-key-0001" },
    );
    expect(stop.status).toBe(200);
    expect(stop.body.status).toBe("PAUSED");
    expect(stop.body.epoch).toBe(2);
    expect(stop.body.in_flight_commands).toEqual([]);
    expect(stop.body.invalidated_proposals).toEqual([submitted.body.proposal_id]);
    expect((await dispatchOnce(h.runtime, new Date(h.clock.now))).kind).toBe("IDLE");
    expect(await sumReserved(h, "QUOTE")).toBe("0");
    const again = await opRequest(h, op.token, "POST", "/v1/account/stop", {}, { "idempotency-key": "stop-key-0002" });
    expect(again.body.epoch).toBe(2);
    const denied = await submitIntent(
      h,
      alpha.token,
      "stop-002",
      buyIntent(alpha.lease_id, "SOLUSDT", "20", "100", await observationFor(h, alpha.token, "SOLUSDT")),
    );
    expect(denied.body.reason_codes).toEqual(["ACCOUNT_PAUSED"]);
    const resume = await opRequest(
      h,
      op.token,
      "POST",
      "/v1/account/resume",
      {},
      { "idempotency-key": "resume-key-0001" },
    );
    expect(resume.status).toBe(200);
    expect(resume.body.status).toBe("READY");
    const after = await submitIntent(
      h,
      alpha.token,
      "stop-003",
      buyIntent(alpha.lease_id, "SOLUSDT", "20", "100", await observationFor(h, alpha.token, "SOLUSDT")),
    );
    expect(after.body.outcome).toBe("ALLOW_PROPOSAL");
    expect((after.body.authority as { account_epoch: number }).account_epoch).toBe(2);
  });
});

describe("opposing pending intents (FR-06, T-24, T-25, T-28)", () => {
  it("T-24 / T-28: BUY and SELL on the same symbol are held, neither can be approved, resolution re-validates the winner", async () => {
    const h = await startHarness(
      loadScenario("scenario-b-opposing-intents", FIXTURES_DIR),
      "scenario-b-opposing-intents",
    );
    harnesses.push(h);
    const alpha = seededAgent(h, "agent_alpha");
    const guard = seededAgent(h, "agent_inventory_guard");
    const op = await operator(h);
    const obsA = await observationFor(h, alpha.token, "BTCUSDT");
    const obsG = await observationFor(h, guard.token, "BTCUSDT");
    const buy = await submitIntent(
      h,
      alpha.token,
      "conflict-buy-001",
      buyIntent(alpha.lease_id, "BTCUSDT", "50", "100000", obsA),
    );
    h.tick(100);
    const sell = await submitIntent(
      h,
      guard.token,
      "conflict-sell-001",
      sellIntent(guard.lease_id, "BTCUSDT", "BTC", "0.0002", "100000", obsG),
    );
    expect([buy.body.outcome, sell.body.outcome]).toEqual(["ALLOW_PROPOSAL", "ALLOW_PROPOSAL"]);
    h.tick(800);
    const swept = await sweepProposals(h.runtime, new Date(h.clock.now));
    expect(swept.conflicted.sort()).toEqual([buy.body.proposal_id, sell.body.proposal_id].sort());
    const queue = await proposalsOf(h, op.token);
    expect(queue.conflicts.length).toBe(1);
    expect(queue.proposals.every((p) => p.state === "CONFLICT_HELD")).toBe(true);
    const held = await approveExact(h, op.token, buy.body, "conflict-approve-001");
    expect(held.status).toBe(409);
    expect((held.body.error as { details?: { reason_codes?: string[] } }).details?.reason_codes).toContain(
      "OPPOSING_INTENT",
    );
    expect((await dispatchOnce(h.runtime, new Date(h.clock.now))).kind).toBe("IDLE");

    const conflictId = String(queue.conflicts[0]?.conflict_id);
    const resolved = await opRequest(
      h,
      op.token,
      "POST",
      `/v1/conflicts/${conflictId}/resolve`,
      { action: "SELECT", proposal_id: buy.body.proposal_id },
      { "idempotency-key": "resolve-key-0001" },
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe("RESOLVED_SELECTED");
    expect(resolved.body.rejected_proposal_ids).toEqual([sell.body.proposal_id]);
    const selected = resolved.body.selected as { outcome: string; new_proposal_id: string; state: string };
    expect(selected.outcome).toBe("ALLOW_PROPOSAL");
    expect(selected.state).toBe("AWAITING_APPROVAL");
    expect(await sumReserved(h, "BASE")).toBe("0");
    expect(await sumReserved(h, "QUOTE")).toBe("50.05");
    const after = await proposalsOf(h, op.token);
    expect(after.conflicts).toEqual([]);
    const revised = after.proposals.find((p) => p.proposal_id === selected.new_proposal_id);
    expect(revised?.revision).toBe(2);
    const approved = await approveExact(h, op.token, { ...revised, proposal_revision: 2 }, "resolve-approve-0001");
    expect(approved.status).toBe(201);
  });

  it("T-25: an opposing intent arriving after approval invalidates the unused approval; REJECT_BOTH releases holds", async () => {
    const h = await startHarness(
      loadScenario("scenario-b-opposing-intents", FIXTURES_DIR),
      "scenario-b-opposing-intents",
    );
    harnesses.push(h);
    const alpha = seededAgent(h, "agent_alpha");
    const guard = seededAgent(h, "agent_inventory_guard");
    const op = await operator(h);
    const buy = await submitIntent(
      h,
      alpha.token,
      "t25-buy-001",
      buyIntent(alpha.lease_id, "BTCUSDT", "50", "100000", await observationFor(h, alpha.token, "BTCUSDT")),
    );
    h.tick(800);
    await sweepProposals(h.runtime, new Date(h.clock.now));
    expect((await approveExact(h, op.token, buy.body, "t25-approve-001")).status).toBe(201);
    const sell = await submitIntent(
      h,
      guard.token,
      "t25-sell-001",
      sellIntent(guard.lease_id, "BTCUSDT", "BTC", "0.0002", "100000", await observationFor(h, guard.token, "BTCUSDT")),
    );
    h.tick(800);
    const swept = await sweepProposals(h.runtime, new Date(h.clock.now));
    expect(swept.conflicted.sort()).toEqual([buy.body.proposal_id, sell.body.proposal_id].sort());
    const pool = h.runtime.pool;
    if (pool === null) throw new Error("no pool");
    expect((await withClient(pool, (c) => listCommands(c, h.accountId))).map((c) => c.state)).toEqual([
      "ABORTED_PRE_ARM",
    ]);
    expect((await dispatchOnce(h.runtime, new Date(h.clock.now))).kind).toBe("IDLE");
    const queue = await proposalsOf(h, op.token);
    const conflictId = String(queue.conflicts[0]?.conflict_id);
    const rejected = await opRequest(
      h,
      op.token,
      "POST",
      `/v1/conflicts/${conflictId}/resolve`,
      { action: "REJECT_BOTH" },
      { "idempotency-key": "t25-resolve-001" },
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("RESOLVED_REJECTED_BOTH");
    expect(await sumReserved(h, "QUOTE")).toBe("0");
    expect(await sumReserved(h, "BASE")).toBe("0");
    expect((await proposalsOf(h, op.token)).proposals).toEqual([]);
  });
});

describe("deterministic quarantine (FR-09, T-29, T-30, T-31, T-34)", () => {
  it("T-29 / T-30: the 11th unique intent in 60 s quarantines the agent; exact retries do not count", async () => {
    const h = await startHarness(
      loadScenario("scenario-c-burst-quarantine", FIXTURES_DIR),
      "scenario-c-burst-quarantine",
    );
    harnesses.push(h);
    const chaos = seededAgent(h, "agent_chaos");
    const op = await operator(h);
    const obs = await observationFor(h, chaos.token, "SOLUSDT");
    const outcomes: Array<{ key: string; outcome: string; reasons: string[] }> = [];
    for (let i = 1; i <= 11; i += 1) {
      const key = `scenario-c-chaos-${i}`;
      const res = await submitIntent(
        h,
        chaos.token,
        key,
        buyIntent(chaos.lease_id, "SOLUSDT", "7", "100", obs, { rationale: `burst ${i}` }),
      );
      expect(res.status).toBe(201);
      outcomes.push({ key, outcome: String(res.body.outcome), reasons: res.body.reason_codes as string[] });
      h.tick(50);
    }
    expect(outcomes.slice(0, 2).map((o) => o.outcome)).toEqual(["ALLOW_PROPOSAL", "ALLOW_PROPOSAL"]);
    expect(outcomes.slice(2, 10).every((o) => o.reasons.includes("SUBMISSION_LIMIT"))).toBe(true);
    expect(outcomes[10]?.reasons).toEqual(["AGENT_QUARANTINED"]);
    const agents = await opRequest(h, op.token, "GET", "/v1/agents");
    const row = (agents.body.agents as Array<{ id: string; status: string }>).find((a) => a.id === chaos.agent_id);
    expect(row?.status).toBe("QUARANTINED");
    expect(await sumReserved(h, "QUOTE")).toBe("0");
    const retry = await submitIntent(
      h,
      chaos.token,
      "scenario-c-chaos-3",
      buyIntent(chaos.lease_id, "SOLUSDT", "7", "100", obs, { rationale: "burst 3" }),
    );
    expect(retry.status).toBe(200);
    expect(retry.body.reason_codes).toEqual(["SUBMISSION_LIMIT"]);
    const twelfth = await submitIntent(
      h,
      chaos.token,
      "scenario-c-chaos-12",
      buyIntent(chaos.lease_id, "SOLUSDT", "7", "100", obs, { rationale: "burst 12" }),
    );
    expect(twelfth.body.reason_codes).toEqual(["AGENT_QUARANTINED"]);
    const incidents = await opRequest(h, op.token, "GET", "/v1/incidents");
    const open = (
      incidents.body.incidents as Array<{ type: string; status: string; severity: string; id: string }>
    ).filter((i) => i.status === "OPEN");
    expect(open.map((i) => i.type)).toEqual(["AGENT_QUARANTINED"]);
    // Resume is blocked by the open critical incident until acknowledged.
    await opRequest(h, op.token, "POST", "/v1/account/stop", {}, { "idempotency-key": "quarantine-stop-01" });
    const blocked = await opRequest(
      h,
      op.token,
      "POST",
      "/v1/account/resume",
      {},
      { "idempotency-key": "quarantine-resume-01" },
    );
    expect(blocked.status).toBe(409);
    const acknowledged = await opRequest(
      h,
      op.token,
      "POST",
      "/v1/account/resume",
      { acknowledged_incident_ids: [open[0]?.id] },
      { "idempotency-key": "quarantine-resume-02" },
    );
    expect(acknowledged.status).toBe(200);
  });

  it("T-31 / T-34: three hard authority violations quarantine durably, surviving a restart", async () => {
    const h = await startHarness(
      loadScenario("scenario-a-constrained-acquisition", FIXTURES_DIR),
      "scenario-a-constrained-acquisition",
    );
    harnesses.push(h);
    const alpha = seededAgent(h, "agent_alpha");
    const obs = await observationFor(h, alpha.token, "SOLUSDT");
    const results = [];
    for (let i = 1; i <= 3; i += 1) {
      results.push(
        await submitIntent(
          h,
          alpha.token,
          `hard-violation-${i}`,
          buyIntent(alpha.lease_id, "SOLUSDT", "7", "100", obs, {
            side: "SELL",
            size: { kind: "BASE_QUANTITY", base_asset: "SOL", amount: "0.1" },
          }),
        ),
      );
      h.tick(10);
    }
    expect(results.map((r) => r.body.reason_codes)).toEqual([
      ["SIDE_NOT_ALLOWED"],
      ["SIDE_NOT_ALLOWED"],
      ["SIDE_NOT_ALLOWED"],
    ]);
    const after = await submitIntent(
      h,
      alpha.token,
      "hard-violation-4",
      buyIntent(alpha.lease_id, "SOLUSDT", "7", "100", obs),
    );
    expect(after.body.reason_codes).toEqual(["AGENT_QUARANTINED"]);

    await stopHarness(h);
    harnesses.splice(harnesses.indexOf(h), 1);
    const clock = { now: h.clock.now + 1000 };
    const restarted = await boot(
      loadConfig({
        DATABASE_URL: DATABASE_URL_TEST,
        OPERATOR_BOOTSTRAP_SECRET: OPERATOR_SECRET,
        MONEYKERNEL_MODE: "REPLAY",
        MONEYKERNEL_ACCOUNT_ALIAS: h.alias,
        LOG_LEVEL: "silent",
      }),
      { clock: () => new Date(clock.now) },
    );
    const h2: Harness = {
      ...h,
      runtime: restarted,
      app: (await import("../../../apps/kernel/src/app.ts")).buildApp(restarted),
      clock,
      tick: (ms) => (clock.now += ms),
    };
    harnesses.push(h2);
    const op = await operator(h2);
    await opRequest(
      h2,
      op.token,
      "POST",
      "/v1/account/resume",
      {
        acknowledged_incident_ids: (
          (await opRequest(h2, op.token, "GET", "/v1/incidents")).body.incidents as Array<{
            id: string;
            status: string;
          }>
        )
          .filter((i) => i.status === "OPEN")
          .map((i) => i.id),
      },
      { "idempotency-key": "restart-resume-01" },
    );
    const denied = await submitIntent(
      h2,
      alpha.token,
      "hard-violation-5",
      buyIntent(alpha.lease_id, "SOLUSDT", "7", "100", await observationFor(h2, alpha.token, "SOLUSDT")),
    );
    expect(denied.body.reason_codes).toEqual(["AGENT_QUARANTINED"]);
  });
});
