import { type AuditEvent, type AuditEventType, computeEventHash } from "@moneykernel/contracts";
import type { PoolClient } from "pg";

export type AppendAuditEventInput = {
  id: string;
  accountId: string;
  type: AuditEventType;
  payload: Record<string, unknown>;
  occurredAt: Date;
};

export type AppendedAuditEvent = { account_seq: number; payload_hash: string; event_hash: string };

type AuditEventRow = {
  id: string;
  account_id: string;
  account_seq: string;
  type: AuditEventType;
  payload: Record<string, unknown>;
  payload_hash: string;
  previous_hash: string | null;
  event_hash: string;
  occurred_at: Date;
};

/**
 * Appends one event to an account's hash chain (prd.md 14.5). The caller must
 * already hold the account row lock inside the same transaction so that
 * account_seq assignment is serialized (lock order in prd.md 12.5).
 */
export async function appendAuditEvent(client: PoolClient, input: AppendAuditEventInput): Promise<AppendedAuditEvent> {
  const last = await client.query<{ account_seq: string; event_hash: string }>(
    "SELECT account_seq, event_hash FROM audit_events WHERE account_id = $1 ORDER BY account_seq DESC LIMIT 1",
    [input.accountId],
  );
  const previous = last.rows[0];
  const accountSeq = previous === undefined ? 1 : Number(previous.account_seq) + 1;
  const previousHash = previous?.event_hash ?? null;
  const occurredAtIso = input.occurredAt.toISOString();
  const hashes = computeEventHash({
    previous_hash: previousHash,
    account_seq: accountSeq,
    type: input.type,
    payload: input.payload,
    occurred_at: occurredAtIso,
  });
  await client.query(
    `INSERT INTO audit_events (id, account_id, account_seq, type, payload, payload_hash, previous_hash, event_hash, occurred_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
    [
      input.id,
      input.accountId,
      accountSeq,
      input.type,
      JSON.stringify(input.payload),
      hashes.payload_hash,
      previousHash,
      hashes.event_hash,
      input.occurredAt,
    ],
  );
  return { account_seq: accountSeq, payload_hash: hashes.payload_hash, event_hash: hashes.event_hash };
}

function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    account_id: row.account_id,
    account_seq: Number(row.account_seq),
    type: row.type,
    payload: row.payload,
    payload_hash: row.payload_hash,
    previous_hash: row.previous_hash,
    event_hash: row.event_hash,
    occurred_at: row.occurred_at.toISOString(),
  };
}

/** Ordered slice of one account's events after a cursor, for SSE catch-up and chain verification. */
export async function listAuditEvents(
  client: PoolClient,
  accountId: string,
  options: { afterSeq?: number; limit?: number } = {},
): Promise<AuditEvent[]> {
  const afterSeq = options.afterSeq ?? 0;
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 5000);
  const result = await client.query<AuditEventRow>(
    `SELECT id, account_id, account_seq, type, payload, payload_hash, previous_hash, event_hash, occurred_at
       FROM audit_events
      WHERE account_id = $1 AND account_seq > $2
      ORDER BY account_seq ASC
      LIMIT $3`,
    [accountId, afterSeq, limit],
  );
  return result.rows.map(toAuditEvent);
}
