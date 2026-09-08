import { z } from "zod";
import { hashCanonical } from "./canonical-json.ts";
import { DecisionOutcomeSchema } from "./decision.ts";
import { TradeIntentSchema } from "./intent.ts";
import { Hex64Schema, IdSchema, IsoTimestampSchema, NonNegativeIntSchema } from "./primitives.ts";
import { ReasonCodeSchema } from "./reason-codes.ts";

export const RuleResultSchema = z.enum(["PASS", "FAIL", "LIMITING", "SKIPPED"]);

export const RuleCheckSchema = z.strictObject({
  rule: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  result: RuleResultSchema,
  observed: z.string().nullable(),
  limit: z.string().nullable(),
  unit: z.string().nullable(),
});
export type RuleCheck = z.infer<typeof RuleCheckSchema>;

export const InputRefsSchema = z
  .strictObject({
    policy_version: NonNegativeIntSchema,
    lease_revision: NonNegativeIntSchema,
    account_epoch: NonNegativeIntSchema,
    ledger_version: NonNegativeIntSchema,
    snapshot_ids: z.array(IdSchema),
    /** Each hash binds the observed content of the snapshot at the same array index. */
    snapshot_hashes: z.array(Hex64Schema),
  })
  .refine((refs) => refs.snapshot_ids.length === refs.snapshot_hashes.length, {
    path: ["snapshot_hashes"],
    message: "each snapshot id must have one corresponding content hash",
  });
export type InputRefs = z.infer<typeof InputRefsSchema>;

/**
 * The evaluator's derived request: account/agent identity comes from authenticated
 * kernel context, financial fields come from the intent, and an absent strategy
 * run is recorded as null. Rationale and the intent wire version are not inputs
 * to the financial decision. This is distinct from the agent submission shape.
 */
export const NormalizedRequestSchema = z
  .strictObject({
    account_id: IdSchema,
    agent_id: IdSchema,
    lease_id: TradeIntentSchema.shape.lease_id,
    symbol: TradeIntentSchema.shape.symbol,
    side: TradeIntentSchema.shape.side,
    order_type: TradeIntentSchema.shape.order_type,
    size: TradeIntentSchema.shape.size,
    limit_price: TradeIntentSchema.shape.limit_price,
    observation_ids: TradeIntentSchema.shape.observation_ids,
    strategy_run_id: IdSchema.nullable(),
  })
  .superRefine((request, ctx) => {
    // Apply the submission schema's side/size rule without accepting its other
    // fields or allowing derived account/agent identity into an agent request.
    const { account_id: _accountId, agent_id: _agentId, strategy_run_id, ...intent } = request;
    const result = TradeIntentSchema.safeParse({
      ...intent,
      schema_version: "1",
      ...(strategy_run_id === null ? {} : { strategy_run_id }),
    });
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }
    }
  });
export type NormalizedRequest = z.infer<typeof NormalizedRequestSchema>;

const DecisionFingerprintMaterialSchema = z.strictObject({
  engine_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  normalized_request: NormalizedRequestSchema,
  input_refs: InputRefsSchema,
  outcome: DecisionOutcomeSchema,
  reason_codes: z.array(ReasonCodeSchema),
  checks: z.array(RuleCheckSchema),
  evaluated_at: IsoTimestampSchema,
});

/**
 * Decision receipt envelope (prd.md 15.6). Immutable once written; later
 * events link to it but never edit its recorded outcome.
 */
export const DecisionReceiptSchema = z.strictObject({
  schema_version: z.literal("1"),
  decision_id: IdSchema,
  intent_id: IdSchema,
  proposal_id: IdSchema.nullable(),
  ...DecisionFingerprintMaterialSchema.shape,
  decision_fingerprint: Hex64Schema,
});
export type DecisionReceipt = z.infer<typeof DecisionReceiptSchema>;

/**
 * Fingerprint material (prd.md 14.5): canonical material inputs and the
 * deterministic outcome. Excludes transport request ids, display ids, and the
 * receipt's own id, so identical canonical inputs give identical fingerprints
 * across runs (T-55).
 */
export type DecisionFingerprintMaterial = z.input<typeof DecisionFingerprintMaterialSchema>;

/** Validate and canonicalize all fingerprint material before hashing it. */
export function decisionFingerprint(material: unknown): string {
  return hashCanonical(DecisionFingerprintMaterialSchema.parse(material));
}

/** Invalid external replay receipts fail verification rather than throwing. */
export function verifyReceiptFingerprint(receipt: unknown): boolean {
  const result = DecisionReceiptSchema.safeParse(receipt);
  if (!result.success) return false;
  const {
    schema_version: _schemaVersion,
    decision_id: _decisionId,
    intent_id: _intentId,
    proposal_id: _proposalId,
    decision_fingerprint,
    ...material
  } = result.data;
  return decisionFingerprint(material) === decision_fingerprint;
}
