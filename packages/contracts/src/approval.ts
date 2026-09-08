import { z } from "zod";
import { Hex64Schema, NonNegativeIntSchema } from "./primitives.ts";

/**
 * Exact human approval (prd.md 15.5). The browser never resends a mutable
 * order payload; the backend binds the approval to its stored proposal by
 * revision, hash, and account epoch. `operator_confirmation` must be literally
 * true so a generic "approve everything" client cannot omit the explicit act.
 */
export const ApprovalRequestSchema = z.strictObject({
  proposal_revision: NonNegativeIntSchema,
  proposal_hash: Hex64Schema,
  expected_account_epoch: NonNegativeIntSchema,
  operator_confirmation: z.literal(true),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalStateSchema = z.enum(["ACTIVE", "CONSUMED", "INVALIDATED", "EXPIRED"]);
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

/** Reports that an approval was stored, never that a trade filled. */
export const ApprovalResponseSchema = z.strictObject({
  approval_id: z.string(),
  proposal_id: z.string(),
  proposal_revision: NonNegativeIntSchema,
  proposal_hash: Hex64Schema,
  state: ApprovalStateSchema,
  expires_at: z.string(),
  note: z.literal("Approval stored. Execution still requires dispatch-time revalidation; this is not a fill."),
});
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;
