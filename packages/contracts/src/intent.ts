import { z } from "zod";
import { PositiveDecimalStringSchema } from "./decimal-string.ts";
import { AssetSchema, IdSchema, OrderTypeSchema, SideSchema, SymbolSchema } from "./primitives.ts";

/** Maximum request body for intent submission (prd.md 15.3). */
export const MAX_INTENT_BODY_BYTES = 16 * 1024;
export const MAX_OBSERVATION_REFS = 10;
export const MAX_RATIONALE_CHARS = 500;

/**
 * Size is a discriminated union: BUY commits quote notional, SELL commits base
 * quantity. The unit is never inferred from the symbol or a float.
 */
export const IntentSizeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("QUOTE_NOTIONAL"),
    quote_asset: AssetSchema,
    amount: PositiveDecimalStringSchema,
  }),
  z.strictObject({
    kind: z.literal("BASE_QUANTITY"),
    base_asset: AssetSchema,
    amount: PositiveDecimalStringSchema,
  }),
]);
export type IntentSize = z.infer<typeof IntentSizeSchema>;

/** Immutable strategy request (prd.md 15.3). Unknown fields are rejected: there is no override path. */
export const TradeIntentSchema = z
  .strictObject({
    schema_version: z.literal("1"),
    lease_id: IdSchema,
    symbol: SymbolSchema,
    side: SideSchema,
    order_type: OrderTypeSchema,
    size: IntentSizeSchema,
    limit_price: PositiveDecimalStringSchema,
    observation_ids: z.array(IdSchema).max(MAX_OBSERVATION_REFS).default([]),
    rationale: z.string().max(MAX_RATIONALE_CHARS).optional(),
    strategy_run_id: IdSchema.optional(),
  })
  .superRefine((intent, ctx) => {
    if (intent.side === "BUY" && intent.size.kind !== "QUOTE_NOTIONAL") {
      ctx.addIssue({ code: "custom", path: ["size", "kind"], message: "BUY intents must size by QUOTE_NOTIONAL" });
    }
    if (intent.side === "SELL" && intent.size.kind !== "BASE_QUANTITY") {
      ctx.addIssue({ code: "custom", path: ["size", "kind"], message: "SELL intents must size by BASE_QUANTITY" });
    }
  });

export type TradeIntent = z.infer<typeof TradeIntentSchema>;
export type TradeIntentInput = z.input<typeof TradeIntentSchema>;

/** Headers/metadata that accompany an intent submission but are not part of the immutable payload. */
export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/);
