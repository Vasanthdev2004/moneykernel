import type {
  CandidateOrder,
  DecisionOutcome,
  OrderType,
  Policy,
  ReasonCode,
  RuleCheck,
  Side,
  TradeIntent,
} from "@moneykernel/contracts";

/**
 * Snapshot of everything the pure evaluator sees. Assembled by the kernel
 * inside the admission transaction. Decimal fields are plain strings here;
 * the evaluator canonicalizes every one through `dec()` and rejects anything
 * that is not a valid decimal string.
 */
export type AgentView = {
  id: string;
  status: "ACTIVE" | "QUARANTINED" | "DISABLED";
  revision: number;
};

export type AccountView = {
  id: string;
  status: "PAUSED" | "READY" | "RECONCILING" | "ERROR";
  epoch: number;
  quote_asset: string;
};

export type LeaseView = {
  id: string;
  revision: number;
  agent_id: string;
  status: "ACTIVE" | "EXPIRED" | "REVOKED" | "EXHAUSTED";
  budget_quote: string;
  consumed_quote: string;
  attempt_limit: number;
  attempts_consumed: number;
  starts_at: string;
  expires_at: string;
  allowed_symbols: string[];
  allowed_sides: Side[];
  allowed_order_types: OrderType[];
};

export type PolicyView = Policy & { version: number };

export type ObservationView = {
  snapshot_id: string;
  symbol: string;
  received_at: string;
  source_timestamp: string | null;
  payload_hash: string;
};

/** Latest usable valuation mark for a symbol. */
export type MarkView = {
  symbol: string;
  price: string;
  snapshot_id: string;
  received_at: string;
  payload_hash: string;
};

export type SymbolRulesView = {
  symbol: string;
  base_asset: string;
  quote_asset: string;
  status: "TRADING" | "HALT" | "BREAK" | "UNKNOWN";
  tick_size: string;
  step_size: string;
  min_qty: string;
  max_qty: string;
  min_notional: string;
  max_notional: string | null;
  unsupported_filters: string[];
  snapshot_id: string | null;
  payload_hash: string | null;
};

/**
 * Resource picture for this account, lease, and agent. Every "outstanding" or
 * "reserved" figure EXCLUDES the proposal being evaluated (prd.md 9.2: never
 * subtract a candidate's own hold twice).
 */
export type ResourceView = {
  quote_owned: string;
  outstanding_quote_reservations: string;
  unresolved_debit_quote: string;
  lease_outstanding_buy_quote: string;
  lease_reserved_attempts: number;
  agent_base_owned: string;
  agent_base_reserved: string;
  /** Account-owned non-quote holdings, for equity valuation. */
  holdings: Array<{ asset: string; quantity: string }>;
  /** Conservative pending BUY exposure for the intent's symbol (quantity times max(mark, limit)). */
  pending_buy_exposure_quote: string;
  /** Sum of fee reserves held by pending BUY proposals across all symbols. */
  pending_fee_reserves_quote: string;
  ledger_version: number;
};

export type EvaluationInput = {
  now: string;
  intent: TradeIntent;
  agent: AgentView;
  account: AccountView;
  lease: LeaseView;
  policy: PolicyView;
  symbol_rules: SymbolRulesView | null;
  /** Observations the intent referenced, resolved by the kernel. */
  observations: ObservationView[];
  /** Fresh marks by symbol for the intent symbol and every held asset. */
  marks: MarkView[];
  resources: ResourceView;
};

export type InputRefs = {
  policy_version: number;
  lease_revision: number;
  account_epoch: number;
  ledger_version: number;
  snapshot_ids: string[];
  snapshot_hashes: string[];
};

export type EvaluationResult = {
  outcome: Exclude<DecisionOutcome, "HOLD">;
  reason_codes: ReasonCode[];
  /** The rule whose cap bound the candidate, when the outcome is COUNTERPROPOSE. */
  limiting_rule: string | null;
  checks: RuleCheck[];
  candidate: CandidateOrder | null;
  normalized_request: Record<string, unknown>;
  input_refs: InputRefs;
};
