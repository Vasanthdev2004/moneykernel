/**
 * @moneykernel/domain — pure decisions, decimal math, state-transition rules.
 * No network, no database, no environment secrets (prd.md 12.3).
 */
export const DOMAIN_VERSION = "0.1.0";

export * from "./decimal.ts";
export * from "./policy/evaluate.ts";
export * from "./policy/types.ts";
