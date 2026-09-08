import { z } from "zod";
import { NonNegativeDecimalStringSchema, PositiveDecimalStringSchema } from "./decimal-string.ts";
import {
  Hex64Schema,
  IdSchema,
  IsoTimestampSchema,
  NonNegativeIntSchema,
  OrderTypeSchema,
  ProvenanceSchema,
  SideSchema,
  SymbolSchema,
} from "./primitives.ts";
import { ReasonCodeSchema } from "./reason-codes.ts";

/** Proposal state machine (prd.md 11.1). Local permission only; execution state lives on commands and orders. */
export const ProposalStateSchema = z.enum([
  "RECEIVED",
  "DENIED",
  "COLLECTING",
  "CONFLICT_HELD",
  "AWAITING_APPROVAL",
  "APPROVED",
  "INVALIDATED",
  "REJECTED",
  "EXPIRED",
  "COMMAND_CREATED",
]);
export type ProposalState = z.infer<typeof ProposalStateSchema>;

export const DecisionOutcomeSchema = z.enum(["ALLOW_PROPOSAL", "COUNTERPROPOSE", "DENY", "HOLD"]);
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

/** Exact normalized order the operator would approve. Immutable per proposal revision. */
export const CandidateOrderSchema = z.strictObject({
  symbol: SymbolSchema,
  side: SideSchema,
  order_type: OrderTypeSchema,
  quantity: PositiveDecimalStringSchema,
  limit_price: PositiveDecimalStringSchema,
  notional_quote: PositiveDecimalStringSchema,
  fee_reserve_quote: NonNegativeDecimalStringSchema,
  total_quote_reserved: NonNegativeDecimalStringSchema,
  base_reserved: NonNegativeDecimalStringSchema,
  /** Mark price the evaluator used for the symbol; dispatch-time drift is measured against it (prd.md 9.7). */
  reference_mark: PositiveDecimalStringSchema,
});
export type CandidateOrder = z.infer<typeof CandidateOrderSchema>;

export const AuthorityRefSchema = z.strictObject({
  policy_version: NonNegativeIntSchema,
  lease_revision: NonNegativeIntSchema,
  account_epoch: NonNegativeIntSchema,
  requires_operator_approval: z.boolean(),
});
export type AuthorityRef = z.infer<typeof AuthorityRefSchema>;

/** Response to intent submission (prd.md 15.4). A denied intent is a recorded product outcome, not an HTTP error. */
export const DecisionResponseSchema = z.strictObject({
  intent_id: IdSchema,
  proposal_id: IdSchema.nullable(),
  proposal_revision: NonNegativeIntSchema.nullable(),
  outcome: DecisionOutcomeSchema,
  state: ProposalStateSchema,
  reason_codes: z.array(ReasonCodeSchema),
  candidate: CandidateOrderSchema.nullable(),
  authority: AuthorityRefSchema,
  provenance: ProvenanceSchema,
  receipt_id: IdSchema,
  proposal_hash: Hex64Schema.nullable(),
  expires_at: IsoTimestampSchema.nullable(),
});
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;
