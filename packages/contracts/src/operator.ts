import { z } from "zod";
import { NonNegativeDecimalStringSchema } from "./decimal-string.ts";
import { LeaseCapabilitiesSchema } from "./policy.ts";
import { AssetSchema, IdSchema, IsoTimestampSchema } from "./primitives.ts";

/** Operator-facing request contracts (prd.md 15.2). Structured forms only; no natural-language policy. */

export const OperatorLoginSchema = z.strictObject({
  bootstrap_secret: z.string().min(1).max(512),
});

export const RegisterAgentRequestSchema = z.strictObject({
  name: z.string().min(1).max(64),
  strategy_kind: z.enum(["SCRIPTED", "MODEL", "RECORDED", "SUPPORTED_AGENT"]),
});

export const IssueLeaseRequestSchema = LeaseCapabilitiesSchema.extend({
  agent_id: IdSchema,
  acquisition_budget_quote: NonNegativeDecimalStringSchema,
  max_submission_attempts: z.number().int().min(0).max(1000),
  starts_at: IsoTimestampSchema.optional(),
  expires_at: IsoTimestampSchema,
});
export type IssueLeaseRequest = z.infer<typeof IssueLeaseRequestSchema>;

export const InventoryAssignmentRequestSchema = z.strictObject({
  assignments: z
    .array(
      z.strictObject({
        owner: z.union([IdSchema, z.literal("UNASSIGNED")]),
        asset: AssetSchema,
        quantity: NonNegativeDecimalStringSchema,
      }),
    )
    .min(1)
    .max(50),
});

export const RejectProposalRequestSchema = z.strictObject({
  reason: z.string().max(200).optional(),
});

export const ConflictResolutionRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("SELECT"), proposal_id: IdSchema }),
  z.strictObject({ action: z.literal("REJECT_BOTH") }),
]);
export type ConflictResolutionRequest = z.infer<typeof ConflictResolutionRequestSchema>;

export const StopRequestSchema = z.strictObject({
  reason: z.string().max(200).optional(),
});

export const ResumeRequestSchema = z.strictObject({
  acknowledged_incident_ids: z.array(IdSchema).max(100).default([]),
});
