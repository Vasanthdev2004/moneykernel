import type { DecimalString } from "./decimal-string.ts";
import type { Environment, MarketSource, OrderType, Side } from "./primitives.ts";

/**
 * MoneyKernel-owned adapter interfaces (prd.md 13.2). These are not assertions
 * about upstream tool names. `submitOnce` is deliberately not called
 * `ensureOrder` or `retryOrder`: callers must recognize the side effect.
 */

export type BookLevel = { price: DecimalString; quantity: DecimalString };

export type MarketSnapshot = {
  snapshot_id: string;
  symbol: string;
  source: MarketSource;
  request_started_at: string;
  received_at: string;
  /** Exchange-supplied event time when available; null means "local observation age" only (prd.md 13.8). */
  source_timestamp: string | null;
  bids: BookLevel[];
  asks: BookLevel[];
  last_price: DecimalString | null;
  payload_hash: string;
  parser_version: string;
};

export type SymbolStatus = "TRADING" | "HALT" | "BREAK" | "UNKNOWN";

export type SymbolRules = {
  symbol: string;
  base_asset: string;
  quote_asset: string;
  status: SymbolStatus;
  tick_size: DecimalString;
  /** Optional for historical fixtures. Null or zero disables that PRICE_FILTER bound. */
  min_price?: DecimalString | null;
  max_price?: DecimalString | null;
  step_size: DecimalString;
  min_qty: DecimalString;
  max_qty: DecimalString;
  min_notional: DecimalString;
  max_notional: DecimalString | null;
  base_precision: number;
  quote_precision: number;
  /** Active filters the kernel has not implemented; any entry blocks external execution (prd.md 9.10). */
  unsupported_filters: string[];
  source: MarketSource;
  received_at: string;
  payload_hash: string;
};

export type CapabilityStatus = "AVAILABLE" | "UNAVAILABLE" | "UNVERIFIED" | "BLOCKED";

export type CapabilityManifest = {
  adapter: string;
  environment: Environment;
  checked_at: string;
  capabilities: Record<string, { status: CapabilityStatus; detail: string | null }>;
};

export type AssetBalance = { asset: string; free: DecimalString; locked: DecimalString };

export type AccountSnapshot = {
  environment: Environment;
  account_ref: string;
  balances: AssetBalance[];
  request_started_at: string;
  received_at: string;
  source_timestamp: string | null;
  payload_hash: string;
};

export type ObservedOrderStatus = "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "EXPIRED";

export type NormalizedOrder = {
  environment: Environment;
  client_order_id: string;
  exchange_order_id: string | null;
  symbol: string;
  side: Side;
  order_type: OrderType;
  status: ObservedOrderStatus;
  quantity: DecimalString;
  limit_price: DecimalString;
  executed_base: DecimalString;
  executed_quote: DecimalString;
  last_observed_at: string;
  source_timestamp: string | null;
  raw_hash: string;
};

export type ExecutionResult =
  | { kind: "ACCEPTED"; order: NormalizedOrder }
  | { kind: "REJECTED_CONFIRMED"; code: string; detail: string }
  | { kind: "OUTCOME_UNKNOWN"; clientOrderId: string; detail: string };

/** The exact persisted payload a dispatcher sends once. */
export type ArmedCommand = {
  command_id: string;
  environment: Environment;
  account_id: string;
  client_order_id: string;
  symbol: string;
  side: Side;
  order_type: OrderType;
  quantity: DecimalString;
  limit_price: DecimalString;
  armed_at: string;
  payload_hash: string;
};

export type OrderIdentity = {
  client_order_id: string;
  exchange_order_id: string | null;
  symbol: string;
};

export type OrderQueryResult =
  | { kind: "FOUND"; order: NormalizedOrder }
  | { kind: "NOT_FOUND"; detail: string }
  | { kind: "QUERY_FAILED"; detail: string };

export type NormalizedFill = {
  /** Deduplication identity: the exchange trade id, or the paper simulator's deterministic fill id. */
  fill_id: string;
  order: OrderIdentity;
  symbol: string;
  side: Side;
  base_qty: DecimalString;
  price: DecimalString;
  quote_qty: DecimalString;
  commission_asset: string;
  commission_qty: DecimalString;
  event_time: string;
  raw_hash: string;
};

export type FillCursor = { since_event_time: string | null; since_fill_id: string | null };

export type FillPage = { fills: NormalizedFill[]; next_cursor: FillCursor | null; received_at: string };

export type AuthorizedCancelCommand = {
  command_id: string;
  order: OrderIdentity;
  authorized_by: string;
  authorized_at: string;
};

export type CancelResult = {
  kind: "CANCEL_ACKNOWLEDGED" | "ALREADY_TERMINAL" | "NOT_FOUND" | "OUTCOME_UNKNOWN";
  order: NormalizedOrder | null;
  detail: string;
};

export interface MarketAdapter {
  readonly source: MarketSource;
  discoverCapabilities(): Promise<CapabilityManifest>;
  getSnapshot(symbol: string): Promise<MarketSnapshot>;
  getSymbolRules(symbol: string): Promise<SymbolRules>;
}

export interface ExecutionAdapter {
  readonly environment: Environment;
  getAccountSnapshot(): Promise<AccountSnapshot>;
  submitOnce(command: ArmedCommand): Promise<ExecutionResult>;
  queryOrder(identity: OrderIdentity): Promise<OrderQueryResult>;
  listRelevantFills(cursor: FillCursor): Promise<FillPage>;
  cancelKnownOrder(command: AuthorizedCancelCommand): Promise<CancelResult>;
}
