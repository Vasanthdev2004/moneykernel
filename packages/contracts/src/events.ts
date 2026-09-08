import { z } from "zod";
import { canonicalJson, sha256Hex } from "./canonical-json.ts";
import { Hex64Schema, IdSchema, IsoTimestampSchema, NonNegativeIntSchema } from "./primitives.ts";

/** Audit event types. Events explain state; the stream is not a command API (prd.md 12.6). */
export const AUDIT_EVENT_TYPES = [
  "ACCOUNT_CREATED",
  "ACCOUNT_BOOTED",
  "ACCOUNT_STOPPED",
  "ACCOUNT_RESUMED",
  "ACCOUNT_RECONCILING",
  "ACCOUNT_RECONCILED",
  "POLICY_UPDATED",
  "AGENT_REGISTERED",
  "AGENT_QUARANTINED",
  "AGENT_DISABLED",
  "AGENT_REINSTATED",
  "LEASE_ISSUED",
  "LEASE_REVOKED",
  "LEASE_EXPIRED",
  "LEASE_EXHAUSTED",
  "INVENTORY_ASSIGNED",
  "INTENT_RECEIVED",
  "DECISION_RECORDED",
  "PROPOSAL_STATE_CHANGED",
  "RESERVATION_CREATED",
  "RESERVATION_RELEASED",
  "RESERVATION_CONSUMED",
  "APPROVAL_CREATED",
  "APPROVAL_CONSUMED",
  "APPROVAL_INVALIDATED",
  "CONFLICT_CREATED",
  "CONFLICT_RESOLVED",
  "COMMAND_CREATED",
  "COMMAND_ARMED",
  "COMMAND_OUTCOME",
  "ORDER_OBSERVED",
  "FILL_RECONCILED",
  "INCIDENT_RAISED",
  "INCIDENT_RESOLVED",
  "SNAPSHOT_RECORDED",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
export const AuditEventTypeSchema = z.enum(AUDIT_EVENT_TYPES);

export const AuditEventSchema = z.strictObject({
  id: IdSchema,
  account_id: IdSchema,
  account_seq: NonNegativeIntSchema,
  type: AuditEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  payload_hash: Hex64Schema,
  previous_hash: Hex64Schema.nullable(),
  event_hash: Hex64Schema,
  occurred_at: IsoTimestampSchema,
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** Hash of the previous event hash, account sequence, event type, canonical payload, and timestamp (prd.md 14.5). */
export function computeEventHash(input: {
  previous_hash: string | null;
  account_seq: number;
  type: AuditEventType;
  payload: Record<string, unknown>;
  occurred_at: string;
}): { payload_hash: string; event_hash: string } {
  const canonicalPayload = canonicalJson(input.payload);
  const payloadHash = sha256Hex(canonicalPayload);
  const eventHash = sha256Hex(
    canonicalJson({
      previous_hash: input.previous_hash,
      account_seq: input.account_seq,
      type: input.type,
      payload_hash: payloadHash,
      occurred_at: input.occurred_at,
    }),
  );
  return { payload_hash: payloadHash, event_hash: eventHash };
}

export type ChainVerification =
  | { ok: true; length: number }
  | { ok: false; length: number; first_bad_seq: number; reason: string };

/**
 * Verifies an ordered slice of one account's events against a trusted
 * checkpoint hash (the event_hash immediately preceding the slice, or null
 * from genesis). Detects edited payloads, reordered sequence numbers, and
 * relinked hashes (T-54).
 */
export function verifyEventChain(events: ReadonlyArray<AuditEvent>, checkpointHash: string | null): ChainVerification {
  let previous = checkpointHash;
  let expectedSeq: number | null = null;
  for (const event of events) {
    if (expectedSeq !== null && event.account_seq !== expectedSeq) {
      return { ok: false, length: events.length, first_bad_seq: event.account_seq, reason: "sequence gap or reorder" };
    }
    if (event.previous_hash !== previous) {
      return { ok: false, length: events.length, first_bad_seq: event.account_seq, reason: "previous_hash mismatch" };
    }
    const recomputed = computeEventHash({
      previous_hash: event.previous_hash,
      account_seq: event.account_seq,
      type: event.type,
      payload: event.payload,
      occurred_at: event.occurred_at,
    });
    if (recomputed.payload_hash !== event.payload_hash) {
      return { ok: false, length: events.length, first_bad_seq: event.account_seq, reason: "payload_hash mismatch" };
    }
    if (recomputed.event_hash !== event.event_hash) {
      return { ok: false, length: events.length, first_bad_seq: event.account_seq, reason: "event_hash mismatch" };
    }
    previous = event.event_hash;
    expectedSeq = event.account_seq + 1;
  }
  return { ok: true, length: events.length };
}
