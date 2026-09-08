import { z } from "zod";
import { NonNegativeDecimalStringSchema, PositiveDecimalStringSchema } from "./decimal-string.ts";
import { AssetSchema } from "./primitives.ts";

const PositiveIntSchema = z.number().int().positive();

/**
 * Reviewed policy settings (prd.md 9.7). Values are product settings to
 * validate, not exchange limits or trading recommendations. Changes create a
 * new immutable policy version; nothing here is model-generated.
 */
export const PolicySchema = z.strictObject({
  schema_version: z.literal("1"),
  quote_asset: AssetSchema,
  /** Upper bound per candidate before fees. */
  max_order_notional_quote: PositiveDecimalStringSchema,
  /** Admission-time marked concentration, as a ratio of the equity floor. */
  max_symbol_share: PositiveDecimalStringSchema.refine((v) => Number.parseFloat(v) <= 1, {
    message: "max_symbol_share is a ratio and cannot exceed 1",
  }),
  /** Quote cash excluded from strategy-spendable funds. */
  min_quote_cash_buffer: NonNegativeDecimalStringSchema,
  /** Subtracted from marked equity before concentration checks (prd.md 9.9). */
  valuation_buffer_quote: NonNegativeDecimalStringSchema,
  max_proposal_age_ms: PositiveIntSchema,
  max_market_observation_age_ms: PositiveIntSchema,
  max_account_observation_age_ms: PositiveIntSchema,
  max_price_drift_bps: NonNegativeDecimalStringSchema,
  conflict_collection_window_ms: z.number().int().nonnegative(),
  max_unique_intents_per_60s: PositiveIntSchema,
  max_hard_violations_per_60s: PositiveIntSchema,
  /** Reservation fee envelope rate. The paper adapter's actual fee model is fixture-controlled (prd.md 9.8). */
  fee_rate: NonNegativeDecimalStringSchema,
  fee_asset: AssetSchema,
  external_in_flight_limit: z.literal(1),
  proposal_hold_sweep_ms: PositiveIntSchema,
});

export type Policy = z.infer<typeof PolicySchema>;
export type PolicyInput = z.input<typeof PolicySchema>;

/** prd.md 9.7 defaults. Fee rate and valuation buffer are synthetic fixture assumptions, not this account's real fees. */
export const DEFAULT_POLICY: PolicyInput = {
  schema_version: "1",
  quote_asset: "USDT",
  max_order_notional_quote: "50",
  max_symbol_share: "0.25",
  min_quote_cash_buffer: "10",
  valuation_buffer_quote: "1",
  max_proposal_age_ms: 120_000,
  max_market_observation_age_ms: 5_000,
  max_account_observation_age_ms: 5_000,
  max_price_drift_bps: "50",
  conflict_collection_window_ms: 750,
  max_unique_intents_per_60s: 10,
  max_hard_violations_per_60s: 3,
  fee_rate: "0.001",
  fee_asset: "USDT",
  external_in_flight_limit: 1,
  proposal_hold_sweep_ms: 250,
};

/** Lease capabilities stored as capability_json (prd.md 9.1). */
export const LeaseCapabilitiesSchema = z.strictObject({
  allowed_symbols: z
    .array(z.string().regex(/^[A-Z0-9]{2,20}$/))
    .min(1)
    .max(3),
  allowed_sides: z.array(z.enum(["BUY", "SELL"])).min(1),
  allowed_order_types: z.array(z.enum(["LIMIT_IOC"])).min(1),
});
export type LeaseCapabilities = z.infer<typeof LeaseCapabilitiesSchema>;
