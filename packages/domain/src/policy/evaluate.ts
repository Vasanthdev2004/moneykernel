import type { CandidateOrder, ReasonCode, RuleCheck } from "@moneykernel/contracts";
import {
  add,
  type Dec,
  dec,
  div,
  eq,
  feeReserve,
  floorToStep,
  fromLotCount,
  gt,
  gte,
  isPositive,
  lotCount,
  lt,
  lte,
  max,
  min,
  mul,
  notionalOf,
  ONE,
  quantityForNotional,
  ratio,
  roundPriceToTick,
  sub,
  toDecimalString,
  toDisplayString,
  ZERO,
} from "../decimal.ts";
import type { EvaluationInput, EvaluationResult, InputRefs, MarkView, SymbolRulesView } from "./types.ts";

/**
 * Pure policy evaluation (prd.md 28.1, 9.x). No IO, no clock reads: `input.now`
 * is explicit. Identical canonical inputs give identical results (FR-03).
 * Non-resizable violations deny outright; a resizable BUY is shrunk to the
 * largest valid smaller candidate and never rounded upward (FR-04).
 */

export const RULE = {
  ACCOUNT_STATUS: "ACCOUNT_STATUS",
  EXECUTION_RECONCILIATION: "EXECUTION_RECONCILIATION",
  AGENT_STATUS: "AGENT_STATUS",
  LEASE_IDENTITY: "LEASE_IDENTITY",
  LEASE_STATUS: "LEASE_STATUS",
  LEASE_WINDOW: "LEASE_WINDOW",
  ORDER_TYPE: "ORDER_TYPE",
  SYMBOL_ALLOWED: "SYMBOL_ALLOWED",
  SIDE_ALLOWED: "SIDE_ALLOWED",
  SYMBOL_RULES: "SYMBOL_RULES",
  FILTER_SUPPORT: "FILTER_SUPPORT",
  FEE_MODEL: "FEE_MODEL",
  OBSERVATION_FRESHNESS: "OBSERVATION_FRESHNESS",
  VALUATION: "VALUATION",
  SUBMISSION_LIMIT: "SUBMISSION_LIMIT",
  PRICE_TICK: "PRICE_TICK",
  LEASE_BUDGET: "LEASE_BUDGET",
  ORDER_NOTIONAL_CAP: "ORDER_NOTIONAL_CAP",
  QUOTE_AVAILABILITY: "QUOTE_AVAILABILITY",
  SYMBOL_EXPOSURE_LIMIT: "SYMBOL_EXPOSURE_LIMIT",
  LOT_SIZE: "LOT_SIZE",
  MIN_NOTIONAL: "MIN_NOTIONAL",
  BASE_INVENTORY: "BASE_INVENTORY",
} as const;

const FUTURE_TOLERANCE_MS = 1_000;

class CheckLog {
  readonly checks: RuleCheck[] = [];
  readonly reasons: ReasonCode[] = [];

  pass(rule: string, observed: string | null = null, limit: string | null = null, unit: string | null = null): void {
    this.checks.push({ rule, result: "PASS", observed, limit, unit });
  }

  fail(
    rule: string,
    code: ReasonCode,
    observed: string | null = null,
    limit: string | null = null,
    unit: string | null = null,
  ): void {
    this.checks.push({ rule, result: "FAIL", observed, limit, unit });
    if (!this.reasons.includes(code)) this.reasons.push(code);
  }

  limiting(rule: string, observed: string, limit: string, unit: string): void {
    this.checks.push({ rule, result: "LIMITING", observed, limit, unit });
  }

  skipped(rule: string): void {
    this.checks.push({ rule, result: "SKIPPED", observed: null, limit: null, unit: null });
  }

  get failed(): boolean {
    return this.checks.some((c) => c.result === "FAIL");
  }
}

function ageMs(now: number, iso: string): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return now - t;
}

function normalizedRequest(input: EvaluationInput): Record<string, unknown> {
  const { intent } = input;
  return {
    account_id: input.account.id,
    agent_id: input.agent.id,
    lease_id: intent.lease_id,
    symbol: intent.symbol,
    side: intent.side,
    order_type: intent.order_type,
    size: intent.size,
    limit_price: intent.limit_price,
    observation_ids: [...intent.observation_ids].sort(),
    strategy_run_id: intent.strategy_run_id ?? null,
  };
}

function collectRefs(input: EvaluationInput, usedMarks: MarkView[], rules: SymbolRulesView | null): InputRefs {
  const refs = new Map<string, string>();
  for (const o of input.observations) refs.set(o.snapshot_id, o.payload_hash);
  for (const m of usedMarks) refs.set(m.snapshot_id, m.payload_hash);
  if (rules?.snapshot_id && rules.payload_hash) refs.set(rules.snapshot_id, rules.payload_hash);
  const ids = [...refs.keys()].sort();
  return {
    policy_version: input.policy.version,
    lease_revision: input.lease.revision,
    account_epoch: input.account.epoch,
    ledger_version: input.resources.ledger_version,
    snapshot_ids: ids,
    snapshot_hashes: ids.map((id) => refs.get(id) ?? ""),
  };
}

function markFor(input: EvaluationInput, symbol: string): MarkView | null {
  return input.marks.find((m) => m.symbol === symbol) ?? null;
}

function isFresh(now: number, iso: string, maxAgeMs: number): { fresh: boolean; age: number | null } {
  const age = ageMs(now, iso);
  if (age === null) return { fresh: false, age: null };
  if (age < -FUTURE_TOLERANCE_MS) return { fresh: false, age };
  return { fresh: age <= maxAgeMs, age };
}

export function evaluate(input: EvaluationInput): EvaluationResult {
  const log = new CheckLog();
  const now = Date.parse(input.now);
  const { intent, agent, account, lease, policy } = input;
  const usedMarks: MarkView[] = [];
  const request = normalizedRequest(input);
  const finish = (
    result: Omit<EvaluationResult, "checks" | "reason_codes" | "normalized_request" | "input_refs">,
  ): EvaluationResult => ({
    ...result,
    reason_codes: [...log.reasons],
    checks: [...log.checks],
    normalized_request: request,
    input_refs: collectRefs(input, usedMarks, input.symbol_rules),
  });
  const deny = (): EvaluationResult => finish({ outcome: "DENY", limiting_rule: null, candidate: null });

  // --- authority and identity (non-resizable) ---
  if (account.status === "READY") log.pass(RULE.ACCOUNT_STATUS, account.status);
  else log.fail(RULE.ACCOUNT_STATUS, "ACCOUNT_PAUSED", account.status, "READY");

  if (account.outstanding_commands > 0) {
    log.fail(RULE.EXECUTION_RECONCILIATION, "OUTCOME_UNKNOWN", String(account.outstanding_commands), "0", "commands");
  } else log.pass(RULE.EXECUTION_RECONCILIATION, "0", "0", "commands");

  if (agent.status === "ACTIVE") log.pass(RULE.AGENT_STATUS, agent.status);
  else
    log.fail(
      RULE.AGENT_STATUS,
      agent.status === "QUARANTINED" ? "AGENT_QUARANTINED" : "AGENT_DISABLED",
      agent.status,
      "ACTIVE",
    );

  if (intent.lease_id === lease.id && lease.agent_id === agent.id) log.pass(RULE.LEASE_IDENTITY, lease.id);
  else log.fail(RULE.LEASE_IDENTITY, "LEASE_MISMATCH", intent.lease_id, lease.id);

  if (lease.status === "ACTIVE") log.pass(RULE.LEASE_STATUS, lease.status);
  else {
    const code: ReasonCode =
      lease.status === "REVOKED" ? "LEASE_REVOKED" : lease.status === "EXHAUSTED" ? "LEASE_EXHAUSTED" : "LEASE_EXPIRED";
    log.fail(RULE.LEASE_STATUS, code, lease.status, "ACTIVE");
  }

  const startsAt = Date.parse(lease.starts_at);
  const expiresAt = Date.parse(lease.expires_at);
  if (Number.isNaN(now) || Number.isNaN(startsAt) || Number.isNaN(expiresAt)) {
    log.fail(RULE.LEASE_WINDOW, "LEASE_EXPIRED", input.now, `${lease.starts_at}..${lease.expires_at}`);
  } else if (now < startsAt) log.fail(RULE.LEASE_WINDOW, "LEASE_NOT_STARTED", input.now, lease.starts_at);
  else if (now >= expiresAt) log.fail(RULE.LEASE_WINDOW, "LEASE_EXPIRED", input.now, lease.expires_at);
  else log.pass(RULE.LEASE_WINDOW, input.now, lease.expires_at);

  if (intent.order_type === "LIMIT_IOC" && lease.allowed_order_types.includes(intent.order_type)) {
    log.pass(RULE.ORDER_TYPE, intent.order_type);
  } else log.fail(RULE.ORDER_TYPE, "UNSUPPORTED_ORDER_TYPE", intent.order_type, lease.allowed_order_types.join(","));

  if (lease.allowed_symbols.includes(intent.symbol)) log.pass(RULE.SYMBOL_ALLOWED, intent.symbol);
  else log.fail(RULE.SYMBOL_ALLOWED, "SYMBOL_NOT_ALLOWED", intent.symbol, lease.allowed_symbols.join(","));

  if (lease.allowed_sides.includes(intent.side)) log.pass(RULE.SIDE_ALLOWED, intent.side);
  else log.fail(RULE.SIDE_ALLOWED, "SIDE_NOT_ALLOWED", intent.side, lease.allowed_sides.join(","));

  // --- exchange capability ---
  const rules = input.symbol_rules;
  if (rules === null || rules.symbol !== intent.symbol) {
    log.fail(RULE.SYMBOL_RULES, "FILTER_UNSUPPORTED", "no symbol rules", intent.symbol);
  } else if (rules.status !== "TRADING") {
    log.fail(RULE.SYMBOL_RULES, "FILTER_UNSUPPORTED", rules.status, "TRADING");
  } else if (rules.quote_asset !== policy.quote_asset || rules.quote_asset !== account.quote_asset) {
    log.fail(RULE.SYMBOL_RULES, "FILTER_UNSUPPORTED", rules.quote_asset, account.quote_asset);
  } else if (
    (intent.size.kind === "QUOTE_NOTIONAL" && intent.size.quote_asset !== rules.quote_asset) ||
    (intent.size.kind === "BASE_QUANTITY" && intent.size.base_asset !== rules.base_asset)
  ) {
    const declared = intent.size.kind === "QUOTE_NOTIONAL" ? intent.size.quote_asset : intent.size.base_asset;
    const expected = intent.size.kind === "QUOTE_NOTIONAL" ? rules.quote_asset : rules.base_asset;
    log.fail(RULE.SYMBOL_RULES, "FILTER_UNSUPPORTED", declared, expected);
  } else log.pass(RULE.SYMBOL_RULES, rules.status);

  if (rules !== null && rules.unsupported_filters.length > 0) {
    log.fail(RULE.FILTER_SUPPORT, "FILTER_UNSUPPORTED", rules.unsupported_filters.join(","), "none");
  } else if (rules !== null) log.pass(RULE.FILTER_SUPPORT, "none");

  // G2 qualifies quote-asset commissions only. Other fee assets need their own
  // inventory/valuation envelopes before they can grant any authority (prd.md 9.8).
  if (policy.fee_asset !== policy.quote_asset) {
    log.fail(RULE.FEE_MODEL, "FEE_MODEL_MISMATCH", policy.fee_asset, policy.quote_asset);
  } else log.pass(RULE.FEE_MODEL, policy.fee_asset, policy.quote_asset);

  // --- observation freshness (prd.md 13.8) ---
  const maxAge = policy.max_market_observation_age_ms;
  const symbolMark = markFor(input, intent.symbol);
  const unknownRefs = intent.observation_ids.filter((id) => !input.observations.some((o) => o.snapshot_id === id));
  const staleRefs = input.observations
    .filter((o) => intent.observation_ids.includes(o.snapshot_id))
    .filter((o) => !isFresh(now, o.received_at, maxAge).fresh);
  if (unknownRefs.length > 0) {
    log.fail(RULE.OBSERVATION_FRESHNESS, "STALE_MARKET_DATA", `unknown observation ${unknownRefs[0]}`, null);
  } else if (staleRefs.length > 0) {
    const first = staleRefs[0];
    const age = first === undefined ? null : ageMs(now, first.received_at);
    log.fail(
      RULE.OBSERVATION_FRESHNESS,
      "STALE_MARKET_DATA",
      age === null ? "unparseable" : String(age),
      String(maxAge),
      "ms",
    );
  } else if (symbolMark === null) {
    log.fail(RULE.OBSERVATION_FRESHNESS, "STALE_MARKET_DATA", `no mark for ${intent.symbol}`, String(maxAge), "ms");
  } else {
    const freshness = isFresh(now, symbolMark.received_at, maxAge);
    if (!freshness.fresh) {
      log.fail(
        RULE.OBSERVATION_FRESHNESS,
        "STALE_MARKET_DATA",
        freshness.age === null ? "unparseable" : String(freshness.age),
        String(maxAge),
        "ms",
      );
    } else {
      log.pass(RULE.OBSERVATION_FRESHNESS, String(freshness.age), String(maxAge), "ms");
      usedMarks.push(symbolMark);
    }
  }

  // --- submission attempts (prd.md 9.3) ---
  const attemptsUsed = lease.attempts_consumed + input.resources.lease_reserved_attempts;
  if (attemptsUsed + 1 <= lease.attempt_limit) {
    log.pass(RULE.SUBMISSION_LIMIT, String(attemptsUsed + 1), String(lease.attempt_limit), "attempts");
  } else
    log.fail(RULE.SUBMISSION_LIMIT, "SUBMISSION_LIMIT", String(attemptsUsed), String(lease.attempt_limit), "attempts");

  if (log.failed || rules === null || symbolMark === null) return deny();

  return intent.side === "BUY"
    ? evaluateBuy(input, rules, symbolMark, usedMarks, log, finish)
    : evaluateSell(input, rules, symbolMark, log, finish);
}

type Finish = (
  result: Omit<EvaluationResult, "checks" | "reason_codes" | "normalized_request" | "input_refs">,
) => EvaluationResult;

function evaluateBuy(
  input: EvaluationInput,
  rules: SymbolRulesView,
  symbolMark: MarkView,
  usedMarks: MarkView[],
  log: CheckLog,
  finish: Finish,
): EvaluationResult {
  const { intent, lease, policy, resources } = input;
  const now = Date.parse(input.now);
  const deny = (): EvaluationResult => finish({ outcome: "DENY", limiting_rule: null, candidate: null });
  if (intent.size.kind !== "QUOTE_NOTIONAL") return deny();

  const requestedNotional = dec(intent.size.amount);
  const tick = dec(rules.tick_size);
  const step = dec(rules.step_size);
  const feeRate = dec(policy.fee_rate);
  const feeFactor = add(ONE, feeRate);

  // Price: tick-normalized without weakening the limit (BUY rounds down).
  if (lt(dec(intent.limit_price), tick)) {
    log.fail(RULE.PRICE_TICK, "FILTER_PRICE_RANGE", intent.limit_price, rules.tick_size, rules.quote_asset);
    return deny();
  }
  const limit = roundPriceToTick(dec(intent.limit_price), tick, "BUY");
  log.pass(RULE.PRICE_TICK, toDecimalString(limit), rules.tick_size, rules.quote_asset);

  // Valuation: every held non-quote asset needs a fresh mark (prd.md 9.9).
  let equity = dec(resources.quote_owned);
  let existingSymbolExposure = ZERO;
  for (const holding of resources.holdings) {
    if (holding.asset === policy.quote_asset) continue;
    const symbol = `${holding.asset}${policy.quote_asset}`;
    const mark = markFor(input, symbol);
    const age = mark === null ? null : ageMs(now, mark.received_at);
    if (mark === null || age === null || age > policy.max_market_observation_age_ms || age < -FUTURE_TOLERANCE_MS) {
      log.fail(
        RULE.VALUATION,
        "STALE_MARKET_DATA",
        `no fresh mark for ${symbol}`,
        String(policy.max_market_observation_age_ms),
        "ms",
      );
      return deny();
    }
    if (!usedMarks.includes(mark)) usedMarks.push(mark);
    const value = mul(dec(holding.quantity), dec(mark.price));
    equity = add(equity, value);
    if (holding.asset === rules.base_asset) existingSymbolExposure = add(existingSymbolExposure, value);
  }
  log.pass(RULE.VALUATION, toDisplayString(equity), null, policy.quote_asset);

  // Caps, each a monotone upper bound on admissible notional (prd.md 9.10).
  const leaseRemaining = max(
    ZERO,
    sub(sub(dec(lease.budget_quote), dec(lease.consumed_quote)), dec(resources.lease_outstanding_buy_quote)),
  );
  const leaseCap = div(leaseRemaining, feeFactor);
  const orderCap = dec(policy.max_order_notional_quote);
  const quoteAvailable = max(
    ZERO,
    sub(
      sub(
        sub(dec(resources.quote_owned), dec(resources.outstanding_quote_reservations)),
        dec(resources.unresolved_debit_quote),
      ),
      dec(policy.min_quote_cash_buffer),
    ),
  );
  const quoteCap = div(quoteAvailable, feeFactor);

  const equityBeforeCandidateFee = sub(
    sub(equity, dec(resources.pending_fee_reserves_quote)),
    dec(policy.valuation_buffer_quote),
  );
  const maxShare = dec(policy.max_symbol_share);
  const pendingExposure = dec(resources.pending_buy_exposure_quote);
  const currentExposure = add(existingSymbolExposure, pendingExposure);
  const unitExposure = max(dec(symbolMark.price), limit);
  let exposureCap = ZERO;
  if (isPositive(equityBeforeCandidateFee)) {
    const headroom = max(ZERO, sub(mul(equityBeforeCandidateFee, maxShare), currentExposure));
    // q * unitExposure + currentExposure <= share * (equityBeforeCandidateFee - q * limit * feeRate).
    // Rounded-up fees are checked against integer lots below; this is the analytic upper bound.
    exposureCap = div(mul(headroom, limit), add(unitExposure, mul(maxShare, mul(limit, feeRate))));
  }

  const caps: Array<{ rule: string; code: ReasonCode; cap: Dec; limit: string; unit: string }> = [
    {
      rule: RULE.LEASE_BUDGET,
      code: "LEASE_BUDGET",
      cap: leaseCap,
      limit: toDecimalString(leaseRemaining),
      unit: policy.quote_asset,
    },
    {
      rule: RULE.ORDER_NOTIONAL_CAP,
      code: "ORDER_NOTIONAL_CAP",
      cap: orderCap,
      limit: policy.max_order_notional_quote,
      unit: policy.quote_asset,
    },
    {
      rule: RULE.QUOTE_AVAILABILITY,
      code: "INSUFFICIENT_QUOTE",
      cap: quoteCap,
      limit: toDecimalString(quoteAvailable),
      unit: policy.quote_asset,
    },
    {
      rule: RULE.SYMBOL_EXPOSURE_LIMIT,
      code: "SYMBOL_EXPOSURE_LIMIT",
      cap: exposureCap,
      limit: policy.max_symbol_share,
      unit: "RATIO",
    },
  ];
  const maxQtyByLot = dec(rules.max_qty);
  const maxNotionalByFilter = rules.max_notional === null ? null : dec(rules.max_notional);

  let notionalCap = requestedNotional;
  let limiting: { rule: string; code: ReasonCode } | null = null;
  for (const c of caps) {
    if (lt(c.cap, notionalCap)) {
      notionalCap = c.cap;
      limiting = { rule: c.rule, code: c.code };
    }
  }
  if (maxNotionalByFilter !== null && lt(maxNotionalByFilter, notionalCap)) {
    notionalCap = maxNotionalByFilter;
    limiting = { rule: RULE.LOT_SIZE, code: "FILTER_LOT_RANGE" };
  }

  let quantity = quantityForNotional(notionalCap, limit, step);
  if (gt(quantity, maxQtyByLot)) {
    quantity = floorToStep(maxQtyByLot, step);
    limiting = { rule: RULE.LOT_SIZE, code: "FILTER_LOT_RANGE" };
  }

  const fitsConcentration = (q: Dec): boolean => {
    const floor = sub(equityBeforeCandidateFee, feeReserve(notionalOf(q, limit), feeRate));
    return isPositive(floor) && lte(add(currentExposure, mul(q, unitExposure)), mul(floor, maxShare));
  };
  // Fee rounding can make the analytic bound slightly too large. Find the
  // largest valid lot count rather than denying a request that can be smaller.
  if (!fitsConcentration(quantity)) {
    let low = 0n;
    let high = lotCount(quantity, step);
    while (low < high) {
      const middle = (low + high + 1n) / 2n;
      if (fitsConcentration(fromLotCount(middle, step))) low = middle;
      else high = middle - 1n;
    }
    quantity = fromLotCount(low, step);
    limiting = { rule: RULE.SYMBOL_EXPOSURE_LIMIT, code: "SYMBOL_EXPOSURE_LIMIT" };
  }
  const notional = notionalOf(quantity, limit);
  const fee = feeReserve(notional, feeRate);
  const total = add(notional, fee);
  const equityFloor = sub(equityBeforeCandidateFee, fee);
  const projectedExposure = add(currentExposure, mul(quantity, unitExposure));
  const projectedShare = isPositive(equityFloor) ? ratio(projectedExposure, equityFloor) : null;

  // Record each cap as PASS or LIMITING with the values actually compared.
  for (const c of caps) {
    const bound = limiting !== null && limiting.rule === c.rule;
    const observed =
      c.rule === RULE.SYMBOL_EXPOSURE_LIMIT
        ? projectedShare === null
          ? "n/a"
          : toDisplayString(projectedShare)
        : toDecimalString(c.rule === RULE.ORDER_NOTIONAL_CAP ? notional : total);
    if (bound) log.limiting(c.rule, observed, c.limit, c.unit);
    else log.pass(c.rule, observed, c.limit, c.unit);
  }

  // Exchange minimums are never satisfied by rounding upward (FR-04, T-03).
  if (lt(quantity, dec(rules.min_qty)) || !isPositive(quantity)) {
    log.fail(RULE.LOT_SIZE, "FILTER_LOT_RANGE", toDecimalString(quantity), rules.min_qty, rules.base_asset);
    if (limiting !== null && !log.reasons.includes(limiting.code)) log.reasons.push(limiting.code);
    return deny();
  }
  log.pass(RULE.LOT_SIZE, toDecimalString(quantity), `${rules.min_qty}..${rules.max_qty}`, rules.base_asset);
  if (lt(notional, dec(rules.min_notional))) {
    log.fail(
      RULE.MIN_NOTIONAL,
      "FILTER_MIN_NOTIONAL",
      toDecimalString(notional),
      rules.min_notional,
      rules.quote_asset,
    );
    if (limiting !== null && !log.reasons.includes(limiting.code)) log.reasons.push(limiting.code);
    return deny();
  }
  log.pass(RULE.MIN_NOTIONAL, toDecimalString(notional), rules.min_notional, rules.quote_asset);

  // Defensive rechecks of the exact candidate against every envelope (prd.md 9.10 "independently rechecked").
  if (!fitsConcentration(quantity)) {
    log.fail(
      RULE.SYMBOL_EXPOSURE_LIMIT,
      "SYMBOL_EXPOSURE_LIMIT",
      projectedShare === null ? "n/a" : toDisplayString(projectedShare),
      policy.max_symbol_share,
      "RATIO",
    );
    return deny();
  }
  if (gt(total, leaseRemaining)) {
    log.fail(
      RULE.LEASE_BUDGET,
      "LEASE_BUDGET",
      toDecimalString(total),
      toDecimalString(leaseRemaining),
      policy.quote_asset,
    );
    return deny();
  }
  if (gt(total, quoteAvailable)) {
    log.fail(
      RULE.QUOTE_AVAILABILITY,
      "INSUFFICIENT_QUOTE",
      toDecimalString(total),
      toDecimalString(quoteAvailable),
      policy.quote_asset,
    );
    return deny();
  }

  const candidate: CandidateOrder = {
    symbol: intent.symbol,
    side: "BUY",
    order_type: intent.order_type,
    quantity: toDecimalString(quantity),
    limit_price: toDecimalString(limit),
    notional_quote: toDecimalString(notional),
    fee_reserve_quote: toDecimalString(fee),
    total_quote_reserved: toDecimalString(total),
    base_reserved: "0",
    reference_mark: toDecimalString(dec(symbolMark.price)),
  } as CandidateOrder;

  if (eq(notional, requestedNotional) && eq(limit, dec(intent.limit_price))) {
    return finish({ outcome: "ALLOW_PROPOSAL", limiting_rule: null, candidate });
  }
  if (limiting !== null) {
    if (!log.reasons.includes(limiting.code)) log.reasons.push(limiting.code);
    return finish({ outcome: "COUNTERPROPOSE", limiting_rule: limiting.rule, candidate });
  }
  log.reasons.push("SIZE_NORMALIZED");
  return finish({ outcome: "COUNTERPROPOSE", limiting_rule: RULE.LOT_SIZE, candidate });
}

function evaluateSell(
  input: EvaluationInput,
  rules: SymbolRulesView,
  symbolMark: MarkView,
  log: CheckLog,
  finish: Finish,
): EvaluationResult {
  const { intent, policy, resources } = input;
  const deny = (): EvaluationResult => finish({ outcome: "DENY", limiting_rule: null, candidate: null });
  if (intent.size.kind !== "BASE_QUANTITY") return deny();

  const tick = dec(rules.tick_size);
  const step = dec(rules.step_size);
  const limit = roundPriceToTick(dec(intent.limit_price), tick, "SELL");
  log.pass(RULE.PRICE_TICK, toDecimalString(limit), rules.tick_size, rules.quote_asset);

  const requested = dec(intent.size.amount);
  const quantity = floorToStep(requested, step);
  const agentAvailable = max(ZERO, sub(dec(resources.agent_base_owned), dec(resources.agent_base_reserved)));
  const accountOwned = resources.holdings
    .filter((holding) => holding.asset === rules.base_asset)
    .reduce((total, holding) => add(total, dec(holding.quantity)), ZERO);
  const accountAvailable = max(ZERO, sub(accountOwned, dec(resources.account_base_reserved)));
  const availableBase = min(agentAvailable, accountAvailable);

  // SELL authority never exceeds agent-attributed, unreserved inventory (INV-10). No downsizing: deny (T-13).
  if (gt(quantity, availableBase)) {
    log.fail(
      RULE.BASE_INVENTORY,
      "INSUFFICIENT_BASE",
      toDecimalString(quantity),
      toDecimalString(availableBase),
      rules.base_asset,
    );
    return deny();
  }
  log.pass(RULE.BASE_INVENTORY, toDecimalString(quantity), toDecimalString(availableBase), rules.base_asset);

  if (lt(quantity, dec(rules.min_qty)) || !isPositive(quantity) || gt(quantity, dec(rules.max_qty))) {
    log.fail(
      RULE.LOT_SIZE,
      "FILTER_LOT_RANGE",
      toDecimalString(quantity),
      `${rules.min_qty}..${rules.max_qty}`,
      rules.base_asset,
    );
    return deny();
  }
  log.pass(RULE.LOT_SIZE, toDecimalString(quantity), `${rules.min_qty}..${rules.max_qty}`, rules.base_asset);

  const notional = notionalOf(quantity, limit);
  if (gt(notional, dec(policy.max_order_notional_quote))) {
    log.fail(
      RULE.ORDER_NOTIONAL_CAP,
      "ORDER_NOTIONAL_CAP",
      toDecimalString(notional),
      policy.max_order_notional_quote,
      rules.quote_asset,
    );
    return deny();
  }
  log.pass(RULE.ORDER_NOTIONAL_CAP, toDecimalString(notional), policy.max_order_notional_quote, rules.quote_asset);
  if (lt(notional, dec(rules.min_notional))) {
    log.fail(
      RULE.MIN_NOTIONAL,
      "FILTER_MIN_NOTIONAL",
      toDecimalString(notional),
      rules.min_notional,
      rules.quote_asset,
    );
    return deny();
  }
  if (rules.max_notional !== null && gt(notional, dec(rules.max_notional))) {
    log.fail(RULE.MIN_NOTIONAL, "FILTER_LOT_RANGE", toDecimalString(notional), rules.max_notional, rules.quote_asset);
    return deny();
  }
  log.pass(RULE.MIN_NOTIONAL, toDecimalString(notional), rules.min_notional, rules.quote_asset);

  const candidate: CandidateOrder = {
    symbol: intent.symbol,
    side: "SELL",
    order_type: intent.order_type,
    quantity: toDecimalString(quantity),
    limit_price: toDecimalString(limit),
    notional_quote: toDecimalString(notional),
    fee_reserve_quote: "0",
    total_quote_reserved: "0",
    base_reserved: toDecimalString(quantity),
    reference_mark: toDecimalString(dec(symbolMark.price)),
  } as CandidateOrder;

  if (eq(quantity, requested) && eq(limit, dec(intent.limit_price))) {
    return finish({ outcome: "ALLOW_PROPOSAL", limiting_rule: null, candidate });
  }
  log.reasons.push("SIZE_NORMALIZED");
  return finish({ outcome: "COUNTERPROPOSE", limiting_rule: RULE.LOT_SIZE, candidate });
}

/** Exposed for tests and the orchestrator: is a comparison helper needed elsewhere. */
export const decimalHelpers = { gte, lte };
