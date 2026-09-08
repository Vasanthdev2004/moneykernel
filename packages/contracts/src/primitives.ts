import { z } from "zod";

/** Identifiers: bounded length, restricted character set (prd.md 15.3). */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
export const IdSchema = z.string().regex(ID_RE, "identifier must be 1-64 characters of [A-Za-z0-9_.:-]");

export const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;
export const SymbolSchema = z.string().regex(SYMBOL_RE, "symbol must be 2-20 uppercase alphanumerics");

export const ASSET_RE = /^[A-Z0-9]{2,10}$/;
export const AssetSchema = z.string().regex(ASSET_RE, "asset must be 2-10 uppercase alphanumerics");

export const SideSchema = z.enum(["BUY", "SELL"]);
export type Side = z.infer<typeof SideSchema>;

/** The only supported order primitive (prd.md 4.3). This is a MoneyKernel name, not an upstream tool name. */
export const OrderTypeSchema = z.enum(["LIMIT_IOC"]);
export type OrderType = z.infer<typeof OrderTypeSchema>;

export const EnvironmentSchema = z.enum(["REPLAY", "SHADOW", "TESTNET"]);
export type Environment = z.infer<typeof EnvironmentSchema>;

export const MarketSourceSchema = z.enum([
  "SYNTHETIC_FIXTURE",
  "RECORDED_OBSERVATION",
  "BINANCE_PUBLIC_REST",
  "BINANCE_MCP_VIA_SUPPORTED_AGENT",
  "BINANCE_TESTNET_REST",
]);
export type MarketSource = z.infer<typeof MarketSourceSchema>;

export const ModelSourceSchema = z.enum([
  "DISABLED",
  "SCRIPTED",
  "RECORDED",
  "LIVE_PROVIDER",
  "SUPPORTED_AGENT_SESSION",
]);
export type ModelSource = z.infer<typeof ModelSourceSchema>;

export const ExecutionSourceSchema = z.enum(["NONE", "PAPER", "BINANCE_TESTNET"]);
export type ExecutionSource = z.infer<typeof ExecutionSourceSchema>;

export const ProvenanceSchema = z.strictObject({
  execution_mode: EnvironmentSchema,
  market_source: MarketSourceSchema,
  model_source: ModelSourceSchema,
  execution_source: ExecutionSourceSchema,
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const IsoTimestampSchema = z.iso.datetime({ offset: false });
export const NonNegativeIntSchema = z.number().int().nonnegative();
export const Hex64Schema = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase sha256 hex digest");
