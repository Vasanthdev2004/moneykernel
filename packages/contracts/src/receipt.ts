import { z } from "zod";
import { hashCanonical } from "./canonical-json.ts";
import { DecisionOutcomeSchema } from "./decision.ts";
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

export const InputRefsSchema = z.strictObject({
  policy_version: NonNegativeIntSchema,
  lease_revision: NonNegativeIntSchema,
  account_epoch: NonNegativeIntSchema,
  ledger_version: NonNegativeIntSchema,
  snapshot_ids: z.array(IdSchema),
  /** Content hashes of the snapshots, so the fingerprint binds to what was observed, not just which id. */
  snapshot_hashes: z.array(Hex64Schema).default([]),
});
export type InputRefs = z.infer<typeof InputRefsSchema>;

/**
 * Decision receipt envelope (prd.md 15.6). Immutable once written; later
 * events link to it but never edit its recorded outcome.
 */
export const DecisionReceiptSchema = z.strictObject({
  schema_version: z.literal("1"),
  engine_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  decision_id: IdSchema,
  intent_id: IdSchema,
  proposal_id: IdSchema.nullable(),
  outcome: DecisionOutcomeSchema,
  reason_codes: z.array(ReasonCodeSchema),
  checks: z.array(RuleCheckSchema),
  /** Canonical normalized request the evaluator saw. */
  normalized_request: z.record(z.string(), z.unknown()),
  input_refs: InputRefsSchema,
  evaluated_at: IsoTimestampSchema,
  decision_fingerprint: Hex64Schema,
});
export type DecisionReceipt = z.infer<typeof DecisionReceiptSchema>;

/**
 * Fingerprint material (prd.md 14.5): canonical material inputs and the
 * deterministic outcome. Excludes transport request ids, display ids, and the
 * receipt's own id, so identical canonical inputs give identical fingerprints
 * across runs (T-55).
 */
export type DecisionFingerprintMaterial = {
  engine_version: string;
  normalized_request: Record<string, unknown>;
  input_refs: InputRefs;
  outcome: DecisionReceipt["outcome"];
  reason_codes: DecisionReceipt["reason_codes"];
  checks: RuleCheck[];
  evaluated_at: string;
};

export function decisionFingerprint(material: DecisionFingerprintMaterial): string {
  return hashCanonical({
    engine_version: material.engine_version,
    normalized_request: material.normalized_request,
    input_refs: material.input_refs,
    outcome: material.outcome,
    reason_codes: material.reason_codes,
    checks: material.checks,
    evaluated_at: material.evaluated_at,
  });
}

/** Recomputes the fingerprint from a receipt's own material and compares. */
export function verifyReceiptFingerprint(receipt: DecisionReceipt): boolean {
  return decisionFingerprint(receipt) === receipt.decision_fingerprint;
}
