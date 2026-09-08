import {
  DEFAULT_POLICY,
  decisionFingerprint,
  type PolicyInput,
  PolicySchema,
  type TradeIntent,
  type TradeIntentInput,
  TradeIntentSchema,
} from "@moneykernel/contracts";
import { type EvaluationInput, evaluate, RULE } from "@moneykernel/domain";
import { describe, expect, it } from "vitest";

/**
 * Scenario A from prd.md 27.1, made balance-consistent: 110 USDT (100 usable
 * after the 10 USDT buffer), 2.2275 SOL at 100, 0.0066725 BTC at 100000,
 * marked equity 1000, remaining lease budget 40, order cap 50, max share 0.25.
 */
const NOW = "2026-09-08T12:00:00Z";
const T_MINUS_1S = "2026-09-08T11:59:59Z";

const buyIntent = (overrides: Partial<TradeIntentInput> = {}): TradeIntent =>
  TradeIntentSchema.parse({
    schema_version: "1",
    lease_id: "lease_alpha_01",
    symbol: "SOLUSDT",
    side: "BUY",
    order_type: "LIMIT_IOC",
    size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "80" },
    limit_price: "100",
    observation_ids: ["snapshot_fixture_sol_01"],
    rationale: "Example fixture proposal; the kernel must size it independently.",
    strategy_run_id: "strategy_run_01",
    ...overrides,
  });

const policyWith = (overrides: Partial<PolicyInput> = {}): EvaluationInput["policy"] => ({
  ...PolicySchema.parse({ ...DEFAULT_POLICY, ...overrides }),
  version: 1,
});

const SOL_RULES: NonNullable<EvaluationInput["symbol_rules"]> = {
  symbol: "SOLUSDT",
  base_asset: "SOL",
  quote_asset: "USDT",
  status: "TRADING",
  tick_size: "0.01",
  step_size: "0.001",
  min_qty: "0.001",
  max_qty: "9000",
  min_notional: "5",
  max_notional: null,
  unsupported_filters: [],
  snapshot_id: "rules_sol",
  payload_hash: "c".repeat(64),
};

function scenarioA(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    now: NOW,
    intent: buyIntent(),
    agent: { id: "agent_alpha", status: "ACTIVE", revision: 1 },
    account: { id: "acct_a", status: "READY", epoch: 1, quote_asset: "USDT" },
    lease: {
      id: "lease_alpha_01",
      revision: 1,
      agent_id: "agent_alpha",
      status: "ACTIVE",
      budget_quote: "40",
      consumed_quote: "0",
      attempt_limit: 2,
      attempts_consumed: 0,
      starts_at: "2026-09-08T12:00:00Z",
      expires_at: "2026-09-08T12:20:00Z",
      allowed_symbols: ["BTCUSDT", "SOLUSDT"],
      allowed_sides: ["BUY"],
      allowed_order_types: ["LIMIT_IOC"],
    },
    policy: policyWith(),
    symbol_rules: SOL_RULES,
    observations: [
      {
        snapshot_id: "snapshot_fixture_sol_01",
        symbol: "SOLUSDT",
        received_at: T_MINUS_1S,
        source_timestamp: NOW,
        payload_hash: "a".repeat(64),
      },
    ],
    marks: [
      {
        symbol: "SOLUSDT",
        price: "100",
        snapshot_id: "snapshot_fixture_sol_01",
        received_at: T_MINUS_1S,
        payload_hash: "a".repeat(64),
      },
      {
        symbol: "BTCUSDT",
        price: "100000",
        snapshot_id: "snapshot_fixture_btc_01",
        received_at: T_MINUS_1S,
        payload_hash: "b".repeat(64),
      },
    ],
    resources: {
      quote_owned: "110",
      outstanding_quote_reservations: "0",
      unresolved_debit_quote: "0",
      lease_outstanding_buy_quote: "0",
      lease_reserved_attempts: 0,
      agent_base_owned: "0",
      agent_base_reserved: "0",
      holdings: [
        { asset: "SOL", quantity: "2.2275" },
        { asset: "BTC", quantity: "0.0066725" },
      ],
      pending_buy_exposure_quote: "0",
      pending_fee_reserves_quote: "0",
      ledger_version: 1,
    },
    ...overrides,
  };
}

const check = (result: ReturnType<typeof evaluate>, rule: string) => result.checks.find((c) => c.rule === rule);

describe("Scenario A — constrained acquisition (prd.md 27.1, T-02)", () => {
  it("counterproposes exactly 0.270 SOL at 100 with the exposure rule limiting", () => {
    const result = evaluate(scenarioA());
    expect(result.outcome).toBe("COUNTERPROPOSE");
    expect(result.reason_codes).toEqual(["SYMBOL_EXPOSURE_LIMIT"]);
    expect(result.limiting_rule).toBe(RULE.SYMBOL_EXPOSURE_LIMIT);
    expect(result.candidate).toEqual({
      symbol: "SOLUSDT",
      side: "BUY",
      order_type: "LIMIT_IOC",
      quantity: "0.27",
      limit_price: "100",
      notional_quote: "27",
      fee_reserve_quote: "0.027",
      total_quote_reserved: "27.027",
      base_reserved: "0",
    });
    expect(check(result, RULE.LEASE_BUDGET)).toEqual({
      rule: "LEASE_BUDGET",
      result: "PASS",
      observed: "27.027",
      limit: "40",
      unit: "USDT",
    });
    expect(check(result, RULE.SYMBOL_EXPOSURE_LIMIT)).toEqual({
      rule: "SYMBOL_EXPOSURE_LIMIT",
      result: "LIMITING",
      observed: "0.25",
      limit: "0.25",
      unit: "RATIO",
    });
    expect(check(result, RULE.VALUATION)?.observed).toBe("1000");
    expect(result.normalized_request).toMatchObject({ symbol: "SOLUSDT", side: "BUY", size: { amount: "80" } });
    expect(result.input_refs.snapshot_ids).toEqual(["rules_sol", "snapshot_fixture_btc_01", "snapshot_fixture_sol_01"]);
  });

  it("is deterministic: identical inputs give identical results and fingerprints (FR-03, T-55)", () => {
    const a = evaluate(scenarioA());
    const b = evaluate(scenarioA());
    expect(b).toEqual(a);
    const material = (r: typeof a) => ({
      engine_version: "0.1.0",
      normalized_request: r.normalized_request,
      input_refs: r.input_refs,
      outcome: r.outcome,
      reason_codes: r.reason_codes,
      checks: r.checks,
      evaluated_at: NOW,
    });
    expect(decisionFingerprint(material(a))).toBe(decisionFingerprint(material(b)));
  });
});

describe("BUY sizing rules (prd.md 9.10, FR-04)", () => {
  it("T-01: an in-budget request is allowed unchanged with its fee envelope", () => {
    const result = evaluate(
      scenarioA({ intent: buyIntent({ size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "20" } }) }),
    );
    expect(result.outcome).toBe("ALLOW_PROPOSAL");
    expect(result.reason_codes).toEqual([]);
    expect(result.candidate).toMatchObject({
      quantity: "0.2",
      notional_quote: "20",
      fee_reserve_quote: "0.02",
      total_quote_reserved: "20.02",
    });
    expect(check(result, RULE.SYMBOL_EXPOSURE_LIMIT)?.observed).toBe("0.242992992992992992");
  });

  it("T-03: a candidate below the exchange minimum notional is denied, never rounded up", () => {
    const small = evaluate(
      scenarioA({ intent: buyIntent({ size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "4" } }) }),
    );
    expect(small.outcome).toBe("DENY");
    expect(small.reason_codes).toEqual(["FILTER_MIN_NOTIONAL"]);

    const base = scenarioA();
    const capped = evaluate({
      ...base,
      resources: {
        ...base.resources,
        holdings: [
          { asset: "SOL", quantity: "2.4675" },
          { asset: "BTC", quantity: "0.0066725" },
        ],
        quote_owned: "86",
      },
    });
    // equity floor 999, max exposure 249.75, existing SOL 246.75 -> headroom 3 < min notional 5
    expect(capped.outcome).toBe("DENY");
    expect(capped.reason_codes).toEqual(["FILTER_MIN_NOTIONAL", "SYMBOL_EXPOSURE_LIMIT"]);
    expect(capped.candidate).toBeNull();
  });

  it("T-04: sizes are floored to the lot step and prices to the tick without weakening the limit", () => {
    const base = scenarioA();
    const roomy: EvaluationInput = {
      ...base,
      lease: { ...base.lease, budget_quote: "1000" },
      policy: policyWith({ max_order_notional_quote: "1000", max_symbol_share: "0.9" }),
      resources: { ...base.resources, quote_owned: "2000" },
    };
    const result = evaluate({
      ...roomy,
      intent: buyIntent({
        size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "27.0005" },
        limit_price: "100.005",
      }),
    });
    expect(result.outcome).toBe("COUNTERPROPOSE");
    expect(result.reason_codes).toEqual(["SIZE_NORMALIZED"]);
    expect(result.candidate).toMatchObject({ quantity: "0.27", limit_price: "100", notional_quote: "27" });
  });

  it("T-11 arithmetic: a second 80 request sees the first hold and shrinks so the pool is never exceeded", () => {
    const base = scenarioA();
    const roomy: EvaluationInput = {
      ...base,
      lease: { ...base.lease, budget_quote: "1000" },
      // Concentration disabled (share 1, no valuation buffer) so the cash envelope is the binding rule.
      policy: policyWith({
        max_order_notional_quote: "1000",
        max_symbol_share: "1",
        min_quote_cash_buffer: "0",
        valuation_buffer_quote: "0",
      }),
      resources: { ...base.resources, quote_owned: "100", holdings: [] },
    };
    const first = evaluate(roomy);
    expect(first.outcome).toBe("ALLOW_PROPOSAL");
    expect(first.candidate?.total_quote_reserved).toBe("80.08");

    const second = evaluate({
      ...roomy,
      resources: {
        ...roomy.resources,
        outstanding_quote_reservations: "80.08",
        lease_outstanding_buy_quote: "80.08",
        lease_reserved_attempts: 1,
        pending_buy_exposure_quote: "80",
        pending_fee_reserves_quote: "0.08",
      },
    });
    expect(second.outcome).toBe("COUNTERPROPOSE");
    expect(second.reason_codes).toEqual(["INSUFFICIENT_QUOTE"]);
    expect(second.candidate).toMatchObject({
      quantity: "0.199",
      notional_quote: "19.9",
      total_quote_reserved: "19.9199",
    });
  });

  it("T-16: SELL proceeds never replenish a lease's historical acquisition allowance", () => {
    const base = scenarioA();
    const result = evaluate({
      ...base,
      lease: { ...base.lease, consumed_quote: "40" },
      resources: { ...base.resources, quote_owned: "500", holdings: [] },
    });
    expect(result.outcome).toBe("DENY");
    expect(result.reason_codes).toEqual(["FILTER_LOT_RANGE", "LEASE_BUDGET"]);
  });

  it("T-17: the lease budget check uses the envelope the caller computed without the candidate's own hold", () => {
    const base = scenarioA();
    const withOwnHoldExcluded = evaluate({
      ...base,
      resources: { ...base.resources, lease_outstanding_buy_quote: "0" },
    });
    const withOwnHoldDoubled = evaluate({
      ...base,
      resources: { ...base.resources, lease_outstanding_buy_quote: "27.027" },
    });
    expect(withOwnHoldExcluded.candidate?.notional_quote).toBe("27");
    expect(withOwnHoldDoubled.reason_codes).toEqual(["LEASE_BUDGET"]);
    // remaining 12.973 / 1.001 = 12.960... -> 0.1296 SOL floors to 0.129 -> 12.9 USDT
    expect(withOwnHoldDoubled.candidate?.notional_quote).toBe("12.9");
  });

  it("blocks risk-increasing proposals when a held asset has no fresh mark", () => {
    const base = scenarioA();
    const result = evaluate({ ...base, marks: base.marks.filter((m) => m.symbol !== "BTCUSDT") });
    expect(result.outcome).toBe("DENY");
    expect(result.reason_codes).toEqual(["STALE_MARKET_DATA"]);
    expect(check(result, RULE.VALUATION)?.result).toBe("FAIL");
  });
});

describe("non-resizable denials (prd.md 8, T-05 to T-08)", () => {
  it("T-07: symbols, sides, and order types outside the lease are denied with stable codes", () => {
    const base = scenarioA();
    expect(
      evaluate({
        ...base,
        intent: buyIntent({ symbol: "ETHUSDT" }),
        symbol_rules: { ...SOL_RULES, symbol: "ETHUSDT", base_asset: "ETH" },
      }).reason_codes,
    ).toContain("SYMBOL_NOT_ALLOWED");
    expect(evaluate({ ...base, lease: { ...base.lease, allowed_sides: ["SELL"] } }).reason_codes).toEqual([
      "SIDE_NOT_ALLOWED",
    ]);
    expect(evaluate({ ...base, lease: { ...base.lease, allowed_order_types: [] } }).reason_codes).toEqual([
      "UNSUPPORTED_ORDER_TYPE",
    ]);
  });

  it("T-08: missing, expired, revoked, exhausted, or not-yet-started leases grant nothing", () => {
    const base = scenarioA();
    expect(evaluate({ ...base, lease: { ...base.lease, status: "EXPIRED" } }).reason_codes).toEqual(["LEASE_EXPIRED"]);
    expect(evaluate({ ...base, lease: { ...base.lease, status: "REVOKED" } }).reason_codes).toEqual(["LEASE_REVOKED"]);
    expect(evaluate({ ...base, lease: { ...base.lease, status: "EXHAUSTED" } }).reason_codes).toEqual([
      "LEASE_EXHAUSTED",
    ]);
    expect(evaluate({ ...base, now: "2026-09-08T12:20:00Z" }).reason_codes).toContain("LEASE_EXPIRED");
    expect(evaluate({ ...base, now: "2026-09-08T11:59:59Z" }).reason_codes).toContain("LEASE_NOT_STARTED");
    expect(evaluate({ ...base, intent: buyIntent({ lease_id: "lease_other" }) }).reason_codes).toEqual([
      "LEASE_MISMATCH",
    ]);
  });

  it("paused accounts and quarantined agents are denied before any sizing", () => {
    const base = scenarioA();
    const paused = evaluate({ ...base, account: { ...base.account, status: "PAUSED" } });
    expect(paused.reason_codes).toEqual(["ACCOUNT_PAUSED"]);
    expect(paused.checks.some((c) => c.rule === RULE.PRICE_TICK)).toBe(false);
    expect(evaluate({ ...base, agent: { ...base.agent, status: "QUARANTINED" } }).reason_codes).toEqual([
      "AGENT_QUARANTINED",
    ]);
  });

  it("stale, future, or unknown observations fail closed", () => {
    const base = scenarioA();
    const observation = base.observations[0];
    if (observation === undefined) throw new Error("fixture has no observation");
    const stale = evaluate({ ...base, observations: [{ ...observation, received_at: "2026-09-08T11:59:50Z" }] });
    expect(stale.reason_codes).toEqual(["STALE_MARKET_DATA"]);
    const future = evaluate({ ...base, observations: [{ ...observation, received_at: "2026-09-08T12:00:05Z" }] });
    expect(future.reason_codes).toEqual(["STALE_MARKET_DATA"]);
    const unknown = evaluate({ ...base, intent: buyIntent({ observation_ids: ["snapshot_nope"] }) });
    expect(unknown.reason_codes).toEqual(["STALE_MARKET_DATA"]);
    const noMark = evaluate({ ...base, marks: base.marks.filter((m) => m.symbol !== "SOLUSDT") });
    expect(noMark.reason_codes).toEqual(["STALE_MARKET_DATA"]);
  });

  it("submission attempts are bounded by the lease, counting reserved slots", () => {
    const base = scenarioA();
    expect(evaluate({ ...base, lease: { ...base.lease, attempts_consumed: 2 } }).reason_codes).toEqual([
      "SUBMISSION_LIMIT",
    ]);
    expect(evaluate({ ...base, resources: { ...base.resources, lease_reserved_attempts: 2 } }).reason_codes).toEqual([
      "SUBMISSION_LIMIT",
    ]);
    expect(evaluate({ ...base, resources: { ...base.resources, lease_reserved_attempts: 1 } }).outcome).toBe(
      "COUNTERPROPOSE",
    );
  });

  it("unsupported exchange filters block rather than guess", () => {
    const base = scenarioA();
    expect(
      evaluate({ ...base, symbol_rules: { ...SOL_RULES, unsupported_filters: ["ICEBERG_PARTS"] } }).reason_codes,
    ).toEqual(["FILTER_UNSUPPORTED"]);
    expect(evaluate({ ...base, symbol_rules: { ...SOL_RULES, status: "HALT" } }).reason_codes).toEqual([
      "FILTER_UNSUPPORTED",
    ]);
    expect(evaluate({ ...base, symbol_rules: null }).reason_codes).toEqual(["FILTER_UNSUPPORTED"]);
  });
});

describe("SELL rules (INV-10, T-13)", () => {
  const sellIntent = (amount: string, limit = "100000"): TradeIntent =>
    TradeIntentSchema.parse({
      schema_version: "1",
      lease_id: "lease_guard",
      symbol: "BTCUSDT",
      side: "SELL",
      order_type: "LIMIT_IOC",
      size: { kind: "BASE_QUANTITY", base_asset: "BTC", amount },
      limit_price: limit,
      observation_ids: ["snapshot_fixture_btc_01"],
    });

  function scenarioB(amount: string, limit?: string): EvaluationInput {
    const base = scenarioA();
    return {
      ...base,
      intent: sellIntent(amount, limit),
      agent: { id: "agent_guard", status: "ACTIVE", revision: 1 },
      lease: {
        ...base.lease,
        id: "lease_guard",
        agent_id: "agent_guard",
        budget_quote: "0",
        allowed_symbols: ["BTCUSDT"],
        allowed_sides: ["SELL"],
      },
      symbol_rules: {
        symbol: "BTCUSDT",
        base_asset: "BTC",
        quote_asset: "USDT",
        status: "TRADING",
        tick_size: "0.01",
        step_size: "0.00001",
        min_qty: "0.00001",
        max_qty: "9000",
        min_notional: "5",
        max_notional: null,
        unsupported_filters: [],
        snapshot_id: "rules_btc",
        payload_hash: "d".repeat(64),
      },
      observations: [
        {
          snapshot_id: "snapshot_fixture_btc_01",
          symbol: "BTCUSDT",
          received_at: T_MINUS_1S,
          source_timestamp: NOW,
          payload_hash: "b".repeat(64),
        },
      ],
      resources: {
        ...base.resources,
        quote_owned: "900",
        holdings: [{ asset: "BTC", quantity: "0.001" }],
        agent_base_owned: "0.001",
        agent_base_reserved: "0",
      },
    };
  }

  it("allows a SELL within attributed inventory and reserves exactly the base quantity", () => {
    const result = evaluate(scenarioB("0.0002"));
    expect(result.outcome).toBe("ALLOW_PROPOSAL");
    expect(result.candidate).toMatchObject({
      side: "SELL",
      quantity: "0.0002",
      notional_quote: "20",
      base_reserved: "0.0002",
      total_quote_reserved: "0",
      fee_reserve_quote: "0",
    });
  });

  it("T-13: a SELL beyond attributed inventory is denied, never shorted or downsized", () => {
    const result = evaluate(scenarioB("0.5"));
    expect(result.outcome).toBe("DENY");
    expect(result.reason_codes).toEqual(["INSUFFICIENT_BASE"]);
    expect(result.candidate).toBeNull();
  });

  it("T-14 arithmetic: inventory already reserved by another pending SELL is not available twice", () => {
    const base = scenarioB("0.0008");
    const result = evaluate({ ...base, resources: { ...base.resources, agent_base_reserved: "0.0005" } });
    expect(result.reason_codes).toEqual(["INSUFFICIENT_BASE"]);
  });

  it("rounds SELL prices up to the tick and floors quantity to the step", () => {
    const result = evaluate(scenarioB("0.000205", "99999.995"));
    expect(result.outcome).toBe("COUNTERPROPOSE");
    expect(result.reason_codes).toEqual(["SIZE_NORMALIZED"]);
    expect(result.candidate).toMatchObject({ quantity: "0.0002", limit_price: "100000" });
  });

  it("denies a SELL below the minimum notional", () => {
    const result = evaluate(scenarioB("0.00004"));
    expect(result.reason_codes).toEqual(["FILTER_MIN_NOTIONAL"]);
  });
});
