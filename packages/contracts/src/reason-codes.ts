import { z } from "zod";

/**
 * Stable, machine-readable reason codes for product decisions (prd.md 15.7).
 * Every code has a deterministic user-facing template. An LLM may explain a
 * receipt later; it never produces or changes these.
 */
export const REASON_CODES = [
  "LEASE_EXPIRED",
  "LEASE_REVOKED",
  "LEASE_NOT_STARTED",
  "LEASE_EXHAUSTED",
  "LEASE_MISMATCH",
  "AGENT_QUARANTINED",
  "AGENT_DISABLED",
  "ACCOUNT_PAUSED",
  "LEASE_BUDGET",
  "SUBMISSION_LIMIT",
  "INSUFFICIENT_QUOTE",
  "INSUFFICIENT_BASE",
  "SYMBOL_NOT_ALLOWED",
  "SIDE_NOT_ALLOWED",
  "UNSUPPORTED_ORDER_TYPE",
  "ORDER_NOTIONAL_CAP",
  "SYMBOL_EXPOSURE_LIMIT",
  "STALE_MARKET_DATA",
  "STALE_ACCOUNT_DATA",
  "PRICE_DRIFT",
  "FILTER_MIN_NOTIONAL",
  "FILTER_PRICE_RANGE",
  "FILTER_LOT_RANGE",
  "FILTER_UNSUPPORTED",
  "SIZE_NORMALIZED",
  "OPPOSING_INTENT",
  "STALE_APPROVAL",
  "OUTCOME_UNKNOWN",
  "FEE_MODEL_MISMATCH",
  "EXTERNAL_ACTIVITY_DETECTED",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];
export const ReasonCodeSchema = z.enum(REASON_CODES);

/** Placeholders use {name}; values are inserted verbatim, never re-formatted. */
export const REASON_TEMPLATES: Readonly<Record<ReasonCode, string>> = {
  LEASE_EXPIRED: "Lease {lease_id} expired at {expires_at}; no new authority is granted.",
  LEASE_REVOKED: "Lease {lease_id} was revoked (revision {lease_revision}); no new authority is granted.",
  LEASE_NOT_STARTED: "Lease {lease_id} starts at {starts_at}; it grants no authority yet.",
  LEASE_EXHAUSTED: "Lease {lease_id} has consumed its full acquisition budget of {limit} {unit}.",
  LEASE_MISMATCH:
    "Lease {lease_id} is not the caller's active lease; identity is derived from the token, never from the request.",
  AGENT_QUARANTINED: "Agent {agent_id} is quarantined; new authority is blocked until an operator reviews it.",
  AGENT_DISABLED: "Agent {agent_id} is disabled.",
  ACCOUNT_PAUSED: "Account {account_id} is paused (epoch {account_epoch}); no new command can be armed.",
  LEASE_BUDGET: "Requested commitment {observed} {unit} exceeds remaining lease acquisition budget {limit} {unit}.",
  SUBMISSION_LIMIT: "Maximum order submission attempts reached: {observed} of {limit}.",
  INSUFFICIENT_QUOTE: "Available quote resource {limit} {unit} is below the required {observed} {unit}.",
  INSUFFICIENT_BASE:
    "Agent-attributed unreserved base inventory {limit} {unit} is below the requested {observed} {unit}.",
  SYMBOL_NOT_ALLOWED: "Symbol {symbol} is not in the lease allowlist.",
  SIDE_NOT_ALLOWED: "Side {side} is not permitted by the lease.",
  UNSUPPORTED_ORDER_TYPE: "Order type {order_type} is not supported; only LIMIT_IOC is allowed.",
  ORDER_NOTIONAL_CAP: "Order notional {observed} {unit} exceeds the per-order cap {limit} {unit}.",
  SYMBOL_EXPOSURE_LIMIT: "Projected {symbol} share {observed} would exceed the maximum {limit} of the equity floor.",
  STALE_MARKET_DATA: "Market observation is {observed} ms old; the maximum usable age is {limit} ms.",
  STALE_ACCOUNT_DATA: "Account observation is {observed} ms old; the maximum usable age is {limit} ms.",
  PRICE_DRIFT:
    "Acquisition price drifted {observed} bps since the proposal; the limit is {limit} bps. A fresh proposal is required.",
  FILTER_MIN_NOTIONAL:
    "Normalized notional {observed} {unit} is below the exchange minimum {limit} {unit}; quantity is never rounded upward.",
  FILTER_PRICE_RANGE: "Limit price {observed} is outside the exchange price filter range for {symbol}.",
  FILTER_LOT_RANGE: "Quantity {observed} is outside the exchange lot size range for {symbol}.",
  FILTER_UNSUPPORTED:
    "Exchange filter {filter} is not implemented; execution for {symbol} is blocked rather than guessed.",
  SIZE_NORMALIZED:
    "Requested size {observed} {unit} was rounded down to the exchange step; the exact candidate is {limit} {unit}.",
  OPPOSING_INTENT: "Opposing pending intents on {symbol} require operator review before dispatch.",
  STALE_APPROVAL:
    "Approval no longer matches the current proposal, policy, lease, or account versions; a new approval is required.",
  OUTCOME_UNKNOWN: "Command {command_id} has an unknown execution outcome; reservations are retained until reconciled.",
  FEE_MODEL_MISMATCH:
    "Observed fee {observed} {unit} is outside the qualified fee model; execution is paused for reconciliation.",
  EXTERNAL_ACTIVITY_DETECTED:
    "Unexplained account change detected for {asset}; the account is paused until an operator rebaselines it.",
};

const PLACEHOLDER_RE = /\{([a-z_]+)\}/g;

/** Renders a template deterministically. Missing parameters render as "?" so the omission is visible. */
export function renderReason(code: ReasonCode, params: Readonly<Record<string, string>> = {}): string {
  return REASON_TEMPLATES[code].replace(PLACEHOLDER_RE, (_match, name: string) => params[name] ?? "?");
}
