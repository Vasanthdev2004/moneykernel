import {
  type AuditEvent,
  type AuditEventType,
  computeEventHash,
  DEFAULT_POLICY,
  decisionFingerprint,
  type ExportedReceipt,
  ExportedReceiptSchema,
  hashCanonical,
  PolicySchema,
  type RunExport,
  RunExportSchema,
  type TradeIntent,
  TradeIntentSchema,
} from "@moneykernel/contracts";
import { ENGINE_VERSION, type EvaluationInput, type EvaluationResult, evaluate } from "@moneykernel/domain";

/**
 * Synthetic but internally consistent run export for the offline verifier
 * (prd.md 23.4). Scenario A (prd.md 27.1, copied from
 * tests/unit/domain/policy-evaluate.test.ts, whose helpers are not exported) is
 * evaluated for real and fingerprinted for real; its 0.27 SOL at 100 candidate
 * is then approved, armed, filled in full with a 0.027 USDT commission, and
 * settled through reservations, ledger, balances, and allocations that agree
 * numerically. Audit events are hash-chained from genesis with computeEventHash.
 *
 * Exported amounts deliberately mix canonical strings with the
 * `numeric::text` form the kernel export emits (trailing zeros), which the
 * verifier must canonicalize before comparing.
 */
export const NOW = "2026-09-08T12:00:00Z";
const T_MINUS_1S = "2026-09-08T11:59:59Z";

export { ENGINE_VERSION };
export const ACCOUNT_ID = "acct_a";
export const AGENT_ID = "agent_alpha";
export const LEASE_ID = "lease_alpha_01";
export const INTENT_ID = "intent_01";
export const RECEIPT_ID = "receipt_01";
export const PROPOSAL_ID = "proposal_01";
export const APPROVAL_ID = "approval_01";
export const COMMAND_ID = "command_01";
export const ORDER_ID = "order_01";
export const FILL_ID = "fill_01";
const POLICY_ID = "policy_01";
const CLIENT_ORDER_ID = "mk-acct-a-000001";

const buyIntent = (): TradeIntent =>
  TradeIntentSchema.parse({
    schema_version: "1",
    lease_id: LEASE_ID,
    symbol: "SOLUSDT",
    side: "BUY",
    order_type: "LIMIT_IOC",
    size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "80" },
    limit_price: "100",
    observation_ids: ["snapshot_fixture_sol_01"],
    rationale: "Example fixture proposal; the kernel must size it independently.",
    strategy_run_id: "strategy_run_01",
  });

const policy = (): EvaluationInput["policy"] => ({
  ...PolicySchema.parse({ ...DEFAULT_POLICY, valuation_buffer_quote: "0.973" }),
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

/** Scenario A: 110 USDT, 2.2275 SOL at 100, 0.0066725 BTC at 100000; counterproposes 0.27 SOL at 100. */
export function scenarioA(): EvaluationInput {
  return {
    now: NOW,
    intent: buyIntent(),
    agent: { id: AGENT_ID, status: "ACTIVE", revision: 1 },
    account: { id: ACCOUNT_ID, status: "READY", epoch: 1, quote_asset: "USDT", outstanding_commands: 0 },
    lease: {
      id: LEASE_ID,
      revision: 1,
      agent_id: AGENT_ID,
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
    policy: policy(),
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
      account_base_reserved: "0",
      holdings: [
        { asset: "SOL", quantity: "2.2275" },
        { asset: "BTC", quantity: "0.0066725" },
      ],
      pending_buy_exposure_quote: "0",
      pending_fee_reserves_quote: "0",
      ledger_version: 1,
    },
  };
}

/** The same material the kernel hashes in recordReceipt (apps/kernel/src/services/admission.ts). */
export function fingerprintFor(result: EvaluationResult, evaluatedAt = NOW): string {
  return decisionFingerprint({
    engine_version: ENGINE_VERSION,
    normalized_request: result.normalized_request,
    input_refs: result.input_refs,
    outcome: result.outcome,
    reason_codes: result.reason_codes,
    checks: result.checks,
    evaluated_at: evaluatedAt,
  });
}

const secondsAfterNow = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1000).toISOString();

/** Chains events from genesis exactly as the kernel's append path does (prd.md 14.5). */
export function chainEvents(
  events: ReadonlyArray<{ type: AuditEventType; payload: Record<string, unknown>; occurred_at?: string }>,
): AuditEvent[] {
  let previous: string | null = null;
  return events.map((event, index) => {
    const account_seq = index + 1;
    const occurred_at = event.occurred_at ?? secondsAfterNow(index);
    const hashes = computeEventHash({
      previous_hash: previous,
      account_seq,
      type: event.type,
      payload: event.payload,
      occurred_at,
    });
    const chained: AuditEvent = {
      id: `evt_${String(account_seq).padStart(2, "0")}`,
      account_id: ACCOUNT_ID,
      account_seq,
      type: event.type,
      payload: event.payload,
      payload_hash: hashes.payload_hash,
      previous_hash: previous,
      event_hash: hashes.event_hash,
      occurred_at,
    };
    previous = hashes.event_hash;
    return chained;
  });
}

export function buildBundle(): RunExport {
  const input = scenarioA();
  const result = evaluate(input);
  const candidate = result.candidate;
  if (candidate === null) throw new Error("fixture expects Scenario A to counterpropose a candidate");
  const fingerprint = fingerprintFor(result);
  const intentPayloadHash = hashCanonical(input.intent);
  const proposalHash = hashCanonical({
    account_id: ACCOUNT_ID,
    intent_id: INTENT_ID,
    revision: 1,
    policy_version: 1,
    lease_revision: 1,
    account_epoch: 1,
    environment: "REPLAY",
    order: candidate,
  });
  const exactPayload = {
    environment: "REPLAY",
    account_id: ACCOUNT_ID,
    client_order_id: CLIENT_ORDER_ID,
    symbol: candidate.symbol,
    side: candidate.side,
    order_type: candidate.order_type,
    quantity: candidate.quantity,
    limit_price: candidate.limit_price,
    proposal_hash: proposalHash,
  };
  const reservations = [
    {
      id: "rsv_01",
      proposal_id: PROPOSAL_ID,
      agent_id: AGENT_ID,
      asset: "USDT",
      amount: "27.027000000000000000",
      kind: "QUOTE",
      state: "CONSUMED",
      created_at: secondsAfterNow(4),
      armed_at: secondsAfterNow(7),
      released_at: null,
    },
    {
      id: "rsv_02",
      proposal_id: PROPOSAL_ID,
      agent_id: AGENT_ID,
      asset: "ATTEMPT",
      amount: "1.000000000000000000",
      kind: "ATTEMPT",
      state: "CONSUMED",
      created_at: secondsAfterNow(4),
      armed_at: null,
      released_at: null,
    },
  ];
  const fill = {
    id: FILL_ID,
    order_id: ORDER_ID,
    exchange_trade_id: "paper-trade-1",
    symbol: "SOLUSDT",
    base_qty: "0.270000000000000000",
    price: "100.000000000000000000",
    quote_qty: "27.000000000000000000",
    commission_asset: "USDT",
    commission_qty: "0.027000000000000000",
    event_time: secondsAfterNow(8),
  };
  const events = chainEvents([
    { type: "ACCOUNT_CREATED", payload: { account_id: ACCOUNT_ID, environment: "REPLAY", epoch: 1 } },
    {
      type: "POLICY_UPDATED",
      occurred_at: NOW,
      payload: { policy_id: POLICY_ID, version: 1, hash: hashCanonical(input.policy), created_by: "seed" },
    },
    {
      type: "INVENTORY_ASSIGNED",
      occurred_at: NOW,
      payload: {
        baseline_ref: "bootstrap",
        ledger_version: 1,
        balances: { USDT: "1000" },
        allocations: { UNASSIGNED: { USDT: "1000" } },
        operator_id: "op_demo",
      },
    },
    {
      type: "AGENT_REGISTERED",
      occurred_at: secondsAfterNow(1),
      payload: { agent_id: AGENT_ID, name: "Alpha", strategy_kind: "alpha" },
    },
    {
      type: "LEASE_ISSUED",
      occurred_at: secondsAfterNow(2),
      payload: { lease_id: LEASE_ID, agent_id: AGENT_ID, budget_quote: "40", attempt_limit: 2 },
    },
    {
      type: "INTENT_RECEIVED",
      occurred_at: secondsAfterNow(3),
      payload: { intent_id: INTENT_ID, agent_id: AGENT_ID, lease_id: LEASE_ID, payload_hash: intentPayloadHash },
    },
    {
      type: "DECISION_RECORDED",
      occurred_at: NOW,
      payload: {
        receipt_id: RECEIPT_ID,
        intent_id: INTENT_ID,
        proposal_id: PROPOSAL_ID,
        outcome: result.outcome,
        reason_codes: result.reason_codes,
        decision_fingerprint: fingerprint,
      },
    },
    {
      type: "RESERVATION_CREATED",
      occurred_at: secondsAfterNow(5),
      payload: {
        proposal_id: PROPOSAL_ID,
        revision: 1,
        state: "AWAITING_APPROVAL",
        reservations: reservations.map((r) => ({ asset: r.asset, amount: r.amount, kind: r.kind })),
      },
    },
    {
      type: "APPROVAL_CREATED",
      occurred_at: secondsAfterNow(6),
      payload: {
        approval_id: APPROVAL_ID,
        proposal_id: PROPOSAL_ID,
        proposal_hash: proposalHash,
        operator_id: "op_demo",
      },
    },
    {
      type: "COMMAND_ARMED",
      occurred_at: secondsAfterNow(7),
      payload: {
        command_id: COMMAND_ID,
        proposal_id: PROPOSAL_ID,
        approval_id: APPROVAL_ID,
        client_order_id: CLIENT_ORDER_ID,
        exact_payload: {
          environment: "REPLAY",
          account_id: ACCOUNT_ID,
          command_id: COMMAND_ID,
          client_order_id: CLIENT_ORDER_ID,
          symbol: candidate.symbol,
          side: candidate.side,
          order_type: candidate.order_type,
          quantity: candidate.quantity,
          limit_price: candidate.limit_price,
          payload_hash: proposalHash,
          armed_at: secondsAfterNow(7),
        },
      },
    },
    {
      type: "COMMAND_OUTCOME",
      occurred_at: secondsAfterNow(8),
      payload: { command_id: COMMAND_ID, state: "ACCEPTED", order_id: ORDER_ID },
    },
    {
      type: "FILL_RECONCILED",
      occurred_at: secondsAfterNow(9),
      payload: {
        command_id: COMMAND_ID,
        order_id: ORDER_ID,
        fill_id: FILL_ID,
        base_qty: "0.27",
        quote_qty: "27",
        commission_asset: "USDT",
        commission_qty: "0.027",
        base_delta: "0.27",
        quote_delta: "-27.027",
      },
    },
  ]);
  return RunExportSchema.parse({
    schema_version: "1",
    exported_at: secondsAfterNow(60),
    engine_version: ENGINE_VERSION,
    environment: "REPLAY",
    account: {
      id: ACCOUNT_ID,
      alias: "replay-fixture",
      environment: "REPLAY",
      status: "READY",
      epoch: 1,
      quote_asset: "USDT",
      configuration_hash: "e".repeat(64),
    },
    provenance: {
      execution_mode: "REPLAY",
      market_source: "SYNTHETIC_FIXTURE",
      model_source: "SCRIPTED",
      execution_source: "PAPER",
    },
    integration_manifest: "docs/integration-manifest.json (fixture)",
    policy_versions: [
      {
        id: POLICY_ID,
        version: 1,
        policy: input.policy,
        hash: hashCanonical(input.policy),
        created_by: "seed",
        created_at: NOW,
      },
    ],
    agents: [
      {
        id: AGENT_ID,
        name: "Alpha",
        strategy_kind: "alpha",
        status: "ACTIVE",
        revision: 1,
        created_at: NOW,
        updated_at: NOW,
      },
    ],
    leases: [
      {
        id: LEASE_ID,
        agent_id: AGENT_ID,
        revision: 1,
        budget_quote: "40.000000000000000000",
        consumed_quote: "27.027000000000000000",
        attempt_limit: 2,
        attempts_consumed: 1,
        starts_at: input.lease.starts_at,
        expires_at: input.lease.expires_at,
        status: "ACTIVE",
        capability_json: {
          allowed_symbols: input.lease.allowed_symbols,
          allowed_sides: input.lease.allowed_sides,
          allowed_order_types: input.lease.allowed_order_types,
        },
        created_at: NOW,
        updated_at: secondsAfterNow(9),
      },
    ],
    intents: [
      {
        id: INTENT_ID,
        agent_id: AGENT_ID,
        lease_id: LEASE_ID,
        idempotency_key: "fixture-intent-0001",
        canonical_payload: input.intent,
        payload_hash: intentPayloadHash,
        account_seq: 1,
        created_at: secondsAfterNow(3),
      },
    ],
    receipts: [
      {
        decision_id: RECEIPT_ID,
        intent_id: INTENT_ID,
        proposal_id: PROPOSAL_ID,
        engine_version: ENGINE_VERSION,
        normalized_request: result.normalized_request,
        input_refs: result.input_refs,
        outcome: result.outcome,
        reason_codes: result.reason_codes,
        checks: result.checks,
        evaluated_at: NOW,
        decision_fingerprint: fingerprint,
        evaluation_input: input,
      },
    ],
    proposals: [
      {
        id: PROPOSAL_ID,
        intent_id: INTENT_ID,
        revision: 1,
        normalized_order: candidate,
        proposal_hash: proposalHash,
        state: "COMMAND_CREATED",
        expires_at: "2026-09-08T12:02:00Z",
        policy_id: POLICY_ID,
        lease_revision: 1,
        account_epoch: 1,
        created_at: secondsAfterNow(4),
        updated_at: secondsAfterNow(7),
      },
    ],
    reservations,
    approvals: [
      {
        id: APPROVAL_ID,
        proposal_id: PROPOSAL_ID,
        proposal_revision: 1,
        proposal_hash: proposalHash,
        operator_id: "op_demo",
        account_epoch: 1,
        expires_at: "2026-09-08T12:02:00Z",
        status: "CONSUMED",
        consumed_at: secondsAfterNow(7),
        created_at: secondsAfterNow(6),
      },
    ],
    commands: [
      {
        id: COMMAND_ID,
        proposal_id: PROPOSAL_ID,
        approval_id: APPROVAL_ID,
        client_order_id: CLIENT_ORDER_ID,
        state: "ACCEPTED",
        exact_payload: exactPayload,
        armed_at: secondsAfterNow(7),
        outcome_ref: `paper:${ORDER_ID}`,
        reconciled_at: secondsAfterNow(9),
        created_at: secondsAfterNow(7),
        updated_at: secondsAfterNow(9),
      },
    ],
    orders: [
      {
        id: ORDER_ID,
        command_id: COMMAND_ID,
        exchange_order_id: "paper-order-1",
        client_order_id: CLIENT_ORDER_ID,
        symbol: "SOLUSDT",
        status: "FILLED",
        executed_base: "0.270000000000000000",
        executed_quote: "27.000000000000000000",
        last_observed_at: secondsAfterNow(9),
      },
    ],
    fills: [fill],
    ledger_entries: [
      {
        id: "ledger_01",
        agent_id: null,
        asset: "USDT",
        signed_delta: "1000.000000000000000000",
        category: "BASELINE",
        source_fill_id: null,
        source_ref: "bootstrap",
        sequence: 1,
        created_at: NOW,
      },
      {
        id: "ledger_02",
        agent_id: AGENT_ID,
        asset: "SOL",
        signed_delta: "0.270000000000000000",
        category: "FILL_BASE",
        source_fill_id: FILL_ID,
        source_ref: fill.exchange_trade_id,
        sequence: 2,
        created_at: secondsAfterNow(9),
      },
      {
        id: "ledger_03",
        agent_id: AGENT_ID,
        asset: "USDT",
        signed_delta: "-27.000000000000000000",
        category: "FILL_QUOTE",
        source_fill_id: FILL_ID,
        source_ref: fill.exchange_trade_id,
        sequence: 3,
        created_at: secondsAfterNow(9),
      },
      {
        id: "ledger_04",
        agent_id: AGENT_ID,
        asset: "USDT",
        signed_delta: "-0.027000000000000000",
        category: "FILL_FEE",
        source_fill_id: FILL_ID,
        source_ref: fill.exchange_trade_id,
        sequence: 4,
        created_at: secondsAfterNow(9),
      },
    ],
    balances: [
      { asset: "SOL", owned_quantity: "0.270000000000000000", version: 1 },
      { asset: "USDT", owned_quantity: "972.973000000000000000", version: 2 },
    ],
    allocations: [
      { agent_or_unassigned_id: "UNASSIGNED", asset: "USDT", owned_quantity: "972.973000000000000000", version: 2 },
      { agent_or_unassigned_id: AGENT_ID, asset: "SOL", owned_quantity: "0.270000000000000000", version: 1 },
    ],
    conflicts: [],
    incidents: [],
    audit_events: events,
    checkpoint: {
      previous_hash: null,
      event_count: events.length,
      final_hash: events.at(-1)?.event_hash ?? null,
      final_seq: events.at(-1)?.account_seq ?? 0,
    },
  });
}

/**
 * A DENY receipt written before migration 0005: no proposal, and no archived
 * evaluation context, so it is verifiable by fingerprint only (prd.md 14.5).
 * Returns the intent row it links to as well.
 */
export function fingerprintOnlyReceipt(): { intent: Record<string, unknown>; receipt: ExportedReceipt } {
  const base = scenarioA();
  const input: EvaluationInput = {
    ...base,
    intent: TradeIntentSchema.parse({
      ...base.intent,
      size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "4" },
    }),
  };
  const result = evaluate(input);
  if (result.outcome !== "DENY") throw new Error("fixture expects a 4 USDT request to be denied below min notional");
  const evaluatedAt = secondsAfterNow(20);
  const intentId = "intent_02";
  return {
    intent: {
      id: intentId,
      agent_id: AGENT_ID,
      lease_id: LEASE_ID,
      idempotency_key: "fixture-intent-0002",
      canonical_payload: input.intent,
      payload_hash: hashCanonical(input.intent),
      account_seq: 2,
      created_at: evaluatedAt,
    },
    receipt: ExportedReceiptSchema.parse({
      decision_id: "receipt_02",
      intent_id: intentId,
      proposal_id: null,
      engine_version: ENGINE_VERSION,
      normalized_request: result.normalized_request,
      input_refs: result.input_refs,
      outcome: result.outcome,
      reason_codes: result.reason_codes,
      checks: result.checks,
      evaluated_at: evaluatedAt,
      decision_fingerprint: fingerprintFor(result, evaluatedAt),
      evaluation_input: null,
    }),
  };
}
