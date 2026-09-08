import { randomBytes } from "node:crypto";
import { decisionFingerprint, verifyEventChain } from "@moneykernel/contracts";
import { dec, lte, toDecimalString, ZERO } from "@moneykernel/domain";
import { loadScenario, type Scenario } from "@moneykernel/integrations";
import {
  createPool,
  getLatestReceiptForIntent,
  listAuditEvents,
  listOutstandingReservations,
  listReservationsForProposal,
  migrate,
  withClient,
} from "@moneykernel/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/kernel/src/app.ts";
import { boot, type KernelRuntime } from "../../../apps/kernel/src/boot.ts";
import { loadConfig } from "../../../apps/kernel/src/config.ts";
import { FIXTURES_DIR } from "../../../apps/kernel/src/fixtures.ts";
import { type SeedResult, seedScenario } from "../../../apps/kernel/src/services/seed.ts";

const DATABASE_URL_TEST =
  process.env.DATABASE_URL_TEST ?? "postgresql://moneykernel:LOCAL_DEV_ONLY@localhost:5432/moneykernel_test";

type Harness = {
  runtime: KernelRuntime;
  app: ReturnType<typeof buildApp>;
  seed: SeedResult;
  clock: { now: number };
  accountId: string;
};

async function startHarness(scenario: Scenario, fixtureId: string): Promise<Harness> {
  const alias = `adm-${randomBytes(3).toString("hex")}`;
  const clock = { now: Date.parse("2026-09-08T12:00:00Z") };
  const config = loadConfig({
    DATABASE_URL: DATABASE_URL_TEST,
    OPERATOR_BOOTSTRAP_SECRET: "integration-test-operator-secret",
    MONEYKERNEL_MODE: "REPLAY",
    MONEYKERNEL_ACCOUNT_ALIAS: alias,
    REPLAY_FIXTURE: fixtureId,
    LOG_LEVEL: "silent",
  });
  const runtime = await boot(config, { clock: () => new Date(clock.now) });
  const failed = runtime.bootChecks.filter((c) => !c.ok);
  if (failed.length > 0 || runtime.account === null) throw new Error(`boot not ready: ${JSON.stringify(failed)}`);
  const seed = await seedScenario(runtime, scenario, { operatorId: "test" });
  const app = buildApp(runtime);
  return { runtime, app, seed, clock, accountId: runtime.account.id };
}

type Ctx = { observations: Array<{ snapshot_id: string; symbol: string }>; lease: { lease_id: string } | null };

async function context(h: Harness, token: string): Promise<Ctx> {
  const res = await h.app.inject({
    method: "GET",
    url: "/v1/agent/context",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as Ctx;
}

function buyIntent(leaseId: string, symbol: string, amount: string, limit: string, observationId: string) {
  return {
    schema_version: "1",
    lease_id: leaseId,
    symbol,
    side: "BUY",
    order_type: "LIMIT_IOC",
    size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount },
    limit_price: limit,
    observation_ids: [observationId],
  };
}

function sellIntent(
  leaseId: string,
  symbol: string,
  base: string,
  amount: string,
  limit: string,
  observationId: string,
) {
  return {
    schema_version: "1",
    lease_id: leaseId,
    symbol,
    side: "SELL",
    order_type: "LIMIT_IOC",
    size: { kind: "BASE_QUANTITY", base_asset: base, amount },
    limit_price: limit,
    observation_ids: [observationId],
  };
}

async function submit(h: Harness, token: string, key: string, body: unknown) {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/agent/intents",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": key, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.json() };
}

async function observationFor(h: Harness, token: string, symbol: string): Promise<string> {
  const ctx = await context(h, token);
  const obs = ctx.observations.find((o) => o.symbol === symbol);
  if (obs === undefined) throw new Error(`no observation for ${symbol}`);
  return obs.snapshot_id;
}

async function sumReserved(h: Harness, kind: "QUOTE" | "BASE" | "ATTEMPT", agentId?: string): Promise<string> {
  const pool = h.runtime.pool;
  if (pool === null) throw new Error("no pool");
  const rows = await withClient(pool, (c) => listOutstandingReservations(c, h.accountId));
  let total = ZERO;
  for (const r of rows) {
    if (r.kind !== kind) continue;
    if (agentId !== undefined && r.agent_id !== agentId) continue;
    total = total.plus(dec(r.amount));
  }
  return toDecimalString(total);
}

const harnesses: Harness[] = [];
afterAll(async () => {
  for (const h of harnesses) {
    await h.app.close();
    await h.runtime.shutdown();
  }
});

beforeAll(async () => {
  const pool = createPool(DATABASE_URL_TEST, { applicationName: "admission-test-migrate" });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
});

describe("Scenario A over HTTP (prd.md 27.1, FR-01, FR-03, FR-04, FR-05, FR-10)", () => {
  let h: Harness;
  let alpha: { token: string; lease_id: string; agent_id: string };
  let observation: string;
  let first: { status: number; body: Record<string, unknown> };

  beforeAll(async () => {
    h = await startHarness(
      loadScenario("scenario-a-constrained-acquisition", FIXTURES_DIR),
      "scenario-a-constrained-acquisition",
    );
    harnesses.push(h);
    const seeded = h.seed.agents.find((a) => a.fixture_agent_id === "agent_alpha");
    if (seeded === undefined) throw new Error("alpha not seeded");
    alpha = seeded;
    observation = await observationFor(h, alpha.token, "SOLUSDT");
    first = await submit(
      h,
      alpha.token,
      "scenario-a-intent-001",
      buyIntent(alpha.lease_id, "SOLUSDT", "80", "100", observation),
    );
  });

  it("rejects missing or invalid agent tokens", async () => {
    const none = await h.app.inject({ method: "GET", url: "/v1/agent/context" });
    expect(none.statusCode).toBe(401);
    const bad = await h.app.inject({
      method: "GET",
      url: "/v1/agent/context",
      headers: { authorization: `Bearer mka_${"x".repeat(43)}` },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("T-02: an 80 USDT request becomes the exact 0.270 SOL counterproposal with reservations and a receipt", async () => {
    expect(first.status).toBe(201);
    const body = first.body as {
      outcome: string;
      state: string;
      reason_codes: string[];
      candidate: Record<string, string>;
      proposal_id: string;
      receipt_id: string;
      proposal_hash: string;
      expires_at: string;
      intent_id: string;
      authority: Record<string, unknown>;
    };
    expect({ outcome: body.outcome, reasons: body.reason_codes }).toEqual({
      outcome: "COUNTERPROPOSE",
      reasons: ["SYMBOL_EXPOSURE_LIMIT"],
    });
    expect(body.state).toBe("COLLECTING");
    expect(body.candidate).toMatchObject({
      quantity: "0.27",
      limit_price: "100",
      notional_quote: "27",
      fee_reserve_quote: "0.027",
      total_quote_reserved: "27.027",
    });
    expect(body.proposal_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.expires_at).toBe("2026-09-08T12:02:00.000Z");
    expect(body.authority).toEqual({
      policy_version: 1,
      lease_revision: 1,
      account_epoch: 1,
      requires_operator_approval: true,
    });

    const pool = h.runtime.pool;
    if (pool === null) throw new Error("no pool");
    const reservations = await withClient(pool, (c) => listReservationsForProposal(c, body.proposal_id));
    expect(reservations.map((r) => [r.kind, r.state, toDecimalString(dec(r.amount))])).toEqual([
      ["ATTEMPT", "HELD", "1"],
      ["QUOTE", "HELD", "27.027"],
    ]);
    const receipt = await withClient(pool, (c) => getLatestReceiptForIntent(c, body.intent_id));
    if (receipt === null) throw new Error("no receipt");
    expect(receipt.id).toBe(body.receipt_id);
    expect(
      decisionFingerprint({
        engine_version: receipt.engine_version,
        normalized_request: receipt.normalized_request,
        input_refs: receipt.input_refs,
        outcome: receipt.outcome,
        reason_codes: receipt.reasons,
        checks: receipt.checks,
        evaluated_at: receipt.evaluated_at.toISOString(),
      }),
    ).toBe(receipt.decision_fingerprint);
    const events = await withClient(pool, (c) => listAuditEvents(c, h.accountId));
    expect(verifyEventChain(events, null).ok).toBe(true);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["INTENT_RECEIVED", "RESERVATION_CREATED", "DECISION_RECORDED"]),
    );
  });

  it("T-18: the same key with the same payload replays the recorded outcome without new holds", async () => {
    const before = await sumReserved(h, "QUOTE");
    const again = await submit(
      h,
      alpha.token,
      "scenario-a-intent-001",
      buyIntent(alpha.lease_id, "SOLUSDT", "80", "100", observation),
    );
    expect(again.status).toBe(200);
    expect(again.body.intent_id).toBe(first.body.intent_id);
    expect(again.body.receipt_id).toBe(first.body.receipt_id);
    expect(await sumReserved(h, "QUOTE")).toBe(before);
  });

  it("T-19: the same key with a different payload is refused", async () => {
    const reused = await submit(
      h,
      alpha.token,
      "scenario-a-intent-001",
      buyIntent(alpha.lease_id, "SOLUSDT", "70", "100", observation),
    );
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("T-05 / T-06: malformed money and unknown fields are rejected before any state changes", async () => {
    const before = await sumReserved(h, "QUOTE");
    const exponent = await submit(
      h,
      alpha.token,
      "scenario-a-bad-1",
      buyIntent(alpha.lease_id, "SOLUSDT", "8e1", "100", observation),
    );
    expect(exponent.status).toBe(422);
    expect(exponent.body.error.code).toBe("INVALID_FINANCIAL_VALUE");
    const override = await submit(h, alpha.token, "scenario-a-bad-2", {
      ...buyIntent(alpha.lease_id, "SOLUSDT", "10", "100", observation),
      skip_policy: true,
    });
    expect(override.status).toBe(400);
    expect(override.body.error.code).toBe("INVALID_SHAPE");
    const noKey = await h.app.inject({
      method: "POST",
      url: "/v1/agent/intents",
      headers: { authorization: `Bearer ${alpha.token}`, "content-type": "application/json" },
      payload: JSON.stringify(buyIntent(alpha.lease_id, "SOLUSDT", "10", "100", observation)),
    });
    expect(noKey.statusCode).toBe(400);
    expect(await sumReserved(h, "QUOTE")).toBe(before);
  });

  it("T-52: another agent cannot read this intent; the owner can", async () => {
    const other = await h.runtime.pool;
    if (other === null) throw new Error("no pool");
    const { registerAgent } = await import("../../../apps/kernel/src/services/registry.ts");
    const stranger = await registerAgent(
      other,
      h.accountId,
      { name: "Stranger", strategyKind: "SCRIPTED" },
      new Date(h.clock.now),
    );
    const denied = await h.app.inject({
      method: "GET",
      url: `/v1/agent/intents/${first.body.intent_id}`,
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    expect(denied.statusCode).toBe(404);
    const own = await h.app.inject({
      method: "GET",
      url: `/v1/agent/intents/${first.body.intent_id}`,
      headers: { authorization: `Bearer ${alpha.token}` },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().receipt_id).toBe(first.body.receipt_id);
  });

  it("the second request finds the SOL headroom already consumed by the first hold and is denied", async () => {
    const second = await submit(
      h,
      alpha.token,
      "scenario-a-intent-002",
      buyIntent(alpha.lease_id, "SOLUSDT", "80", "100", await observationFor(h, alpha.token, "SOLUSDT")),
    );
    expect(second.status).toBe(201);
    // pending exposure 27 + existing 222.75 = 249.75 = 0.25 * 999: no headroom, no upward rounding
    expect({ outcome: second.body.outcome, reasons: second.body.reason_codes }).toEqual({
      outcome: "DENY",
      reasons: ["FILTER_LOT_RANGE", "SYMBOL_EXPOSURE_LIMIT"],
    });
    expect(second.body.proposal_id).toBeNull();
    expect(typeof second.body.receipt_id).toBe("string");
    expect(await sumReserved(h, "ATTEMPT", alpha.agent_id)).toBe("1");
    // consumed + outstanding never exceeds the lease budget of 40 (prd.md 20.4)
    expect(lte(dec(await sumReserved(h, "QUOTE", alpha.agent_id)), dec("40"))).toBe(true);
  });
});

describe("concurrent BUY admissions against one pool (T-11, T-12, INV-04)", () => {
  function roomyScenario(usdt: string): Scenario {
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

  it("T-11: two simultaneous 80 requests never reserve more than the 100 available", async () => {
    const h = await startHarness(roomyScenario("100"), "scenario-a-constrained-acquisition");
    harnesses.push(h);
    const alpha = h.seed.agents[0];
    if (alpha === undefined) throw new Error("no agent");
    const obs = await observationFor(h, alpha.token, "SOLUSDT");
    const [a, b] = await Promise.all([
      submit(h, alpha.token, "t11-alpha-first", buyIntent(alpha.lease_id, "SOLUSDT", "80", "100", obs)),
      submit(h, alpha.token, "t11-alpha-second", buyIntent(alpha.lease_id, "SOLUSDT", "80", "100", obs)),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const outcomes = [a.body.outcome, b.body.outcome].sort();
    expect(outcomes).toEqual(["ALLOW_PROPOSAL", "COUNTERPROPOSE"]);
    const totals = [a, b]
      .map((r) => (r.body.candidate as { total_quote_reserved: string }).total_quote_reserved)
      .sort();
    expect(totals).toEqual(["19.9199", "80.08"]);
    expect(lte(dec(await sumReserved(h, "QUOTE")), dec("100"))).toBe(true);
  });

  it("T-12: fifty concurrent requests keep budget and attempt bounds valid", async () => {
    const h = await startHarness(roomyScenario("1000"), "scenario-a-constrained-acquisition");
    harnesses.push(h);
    const alpha = h.seed.agents[0];
    if (alpha === undefined) throw new Error("no agent");
    const obs = await observationFor(h, alpha.token, "SOLUSDT");
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        submit(h, alpha.token, `t12-alpha-${i}`, buyIntent(alpha.lease_id, "SOLUSDT", "30", "100", obs)),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const admitted = results.filter((r) => r.body.proposal_id !== null);
    const denied = results.filter((r) => r.body.outcome === "DENY");
    // 30 USDT each against 1000 USDT: the attempt limit (5) binds before cash does.
    expect(admitted.length).toBe(5);
    expect(denied.length).toBe(45);
    expect(denied.every((r) => (r.body.reason_codes as string[]).includes("SUBMISSION_LIMIT"))).toBe(true);
    expect(await sumReserved(h, "ATTEMPT", alpha.agent_id)).toBe(String(admitted.length));
    expect(await sumReserved(h, "QUOTE")).toBe("150.15");
    const pool = h.runtime.pool;
    if (pool === null) throw new Error("no pool");
    const events = await withClient(pool, (c) => listAuditEvents(c, h.accountId, { limit: 5000 }));
    expect(verifyEventChain(events, null).ok).toBe(true);
  });
});

describe("SELL inventory authority (T-13, T-14, INV-10)", () => {
  it("denies a SELL beyond attributed inventory and reserves base at most once under contention", async () => {
    const h = await startHarness(
      loadScenario("scenario-b-opposing-intents", FIXTURES_DIR),
      "scenario-b-opposing-intents",
    );
    harnesses.push(h);
    const guard = h.seed.agents.find((a) => a.fixture_agent_id === "agent_inventory_guard");
    if (guard === undefined) throw new Error("guard not seeded");
    const obs = await observationFor(h, guard.token, "BTCUSDT");

    const short = await submit(
      h,
      guard.token,
      "t13-guard-short",
      sellIntent(guard.lease_id, "BTCUSDT", "BTC", "0.5", "100000", obs),
    );
    expect(short.status).toBe(201);
    expect(short.body.outcome).toBe("DENY");
    expect(short.body.reason_codes).toEqual(["INSUFFICIENT_BASE"]);

    const [a, b] = await Promise.all([
      submit(h, guard.token, "t14-guard-first", sellIntent(guard.lease_id, "BTCUSDT", "BTC", "0.0008", "100000", obs)),
      submit(h, guard.token, "t14-guard-second", sellIntent(guard.lease_id, "BTCUSDT", "BTC", "0.0008", "100000", obs)),
    ]);
    const admitted = [a, b].filter((r) => r.body.proposal_id !== null);
    expect(admitted.length).toBe(1);
    expect([a, b].some((r) => (r.body.reason_codes as string[]).includes("INSUFFICIENT_BASE"))).toBe(true);
    expect(await sumReserved(h, "BASE", guard.agent_id)).toBe("0.0008");
    expect(lte(dec(await sumReserved(h, "BASE", guard.agent_id)), dec("0.001"))).toBe(true);
  });
});
