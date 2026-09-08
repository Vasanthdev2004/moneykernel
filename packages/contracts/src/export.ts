import { z } from "zod";
import { DecisionOutcomeSchema } from "./decision.ts";
import { AuditEventSchema } from "./events.ts";
import {
  EnvironmentSchema,
  Hex64Schema,
  IdSchema,
  IsoTimestampSchema,
  NonNegativeIntSchema,
  ProvenanceSchema,
} from "./primitives.ts";
import { ReasonCodeSchema } from "./reason-codes.ts";
import { InputRefsSchema, NormalizedRequestSchema, RuleCheckSchema } from "./receipt.ts";
import { AccountStatusSchema } from "./status.ts";

/**
 * Sanitized run export (prd.md 15.2 `GET /v1/runs/:id/export`, 23.4). Everything
 * an offline verifier needs: the hash-chained event log, every decision
 * receipt with its archived evaluation context, and the authority, reservation,
 * command, order, fill, and ledger rows that must agree numerically. Never
 * carries agent token hashes, operator secrets, or provider keys.
 */
const Row = z.record(z.string(), z.unknown());

export const ExportedReceiptSchema = z.strictObject({
  decision_id: IdSchema,
  intent_id: IdSchema,
  proposal_id: IdSchema.nullable(),
  engine_version: z.string(),
  normalized_request: NormalizedRequestSchema,
  input_refs: InputRefsSchema,
  outcome: DecisionOutcomeSchema,
  reason_codes: z.array(ReasonCodeSchema),
  checks: z.array(RuleCheckSchema),
  evaluated_at: IsoTimestampSchema,
  decision_fingerprint: Hex64Schema,
  /** The exact evaluator input archived with the decision; null for receipts written before migration 0005. */
  evaluation_input: z.unknown().nullable(),
});
export type ExportedReceipt = z.infer<typeof ExportedReceiptSchema>;

export const RunExportSchema = z.strictObject({
  schema_version: z.literal("1"),
  exported_at: IsoTimestampSchema,
  engine_version: z.string(),
  environment: EnvironmentSchema,
  account: z.strictObject({
    id: IdSchema,
    alias: z.string(),
    environment: EnvironmentSchema,
    status: AccountStatusSchema,
    epoch: NonNegativeIntSchema,
    quote_asset: z.string(),
    configuration_hash: Hex64Schema,
  }),
  provenance: ProvenanceSchema,
  integration_manifest: z.string(),
  policy_versions: z.array(Row),
  agents: z.array(Row),
  leases: z.array(Row),
  intents: z.array(Row),
  receipts: z.array(ExportedReceiptSchema),
  proposals: z.array(Row),
  reservations: z.array(Row),
  approvals: z.array(Row),
  commands: z.array(Row),
  orders: z.array(Row),
  fills: z.array(Row),
  ledger_entries: z.array(Row),
  balances: z.array(Row),
  allocations: z.array(Row),
  conflicts: z.array(Row),
  incidents: z.array(Row),
  audit_events: z.array(AuditEventSchema),
  /** The chain is verified from genesis (null) unless a trusted checkpoint hash is supplied out of band. */
  checkpoint: z.strictObject({ previous_hash: Hex64Schema.nullable(), event_count: NonNegativeIntSchema }),
});
export type RunExport = z.infer<typeof RunExportSchema>;
