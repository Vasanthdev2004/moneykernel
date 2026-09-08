/**
 * @moneykernel/contracts — one contract source for the whole system.
 * Schemas, reason codes, canonicalization, hashing, and adapter interfaces.
 * No network, database, or exchange side effects live here.
 *
 * Frozen after Gate 1 (prd.md 21.3): any change needs an explicit
 * schema/version decision with producer, consumer, and tests updated together.
 */
export const CONTRACTS_VERSION = "1";

export * from "./adapters.ts";
export * from "./approval.ts";
export * from "./canonical-json.ts";
export * from "./decimal-string.ts";
export * from "./decision.ts";
export * from "./errors.ts";
export * from "./events.ts";
export * from "./intent.ts";
export * from "./operator.ts";
export * from "./policy.ts";
export * from "./primitives.ts";
export * from "./reason-codes.ts";
export * from "./receipt.ts";
export * from "./status.ts";
