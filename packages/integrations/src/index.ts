/**
 * @moneykernel/integrations — observation and execution adapters. Owns
 * normalization and provenance only; never authority decisions (prd.md 12.3).
 */
export const INTEGRATIONS_VERSION = "0.1.0";

export * from "./fixture/market-adapter.ts";
export * from "./fixture/scenario.ts";
