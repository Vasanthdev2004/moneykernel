import { lockAccountRow, type Pool, withTransaction } from "../db.ts";

export type OperatorRequestIdentity = {
  accountId: string;
  operatorId: string;
  scope: string;
  key: string;
};

export type OperatorRequestRow = {
  account_id: string;
  operator_id: string;
  scope: string;
  idempotency_key: string;
  payload_hash: string;
  state: "PENDING" | "COMPLETED";
  response_status: number | null;
  response_body: unknown;
  created_at: Date;
  completed_at: Date | null;
};

/** Claim once before invoking an existing control transaction. A previous claim never grants permission to rerun. */
export async function claimOperatorRequest(
  pool: Pool,
  input: OperatorRequestIdentity & { payloadHash: string; now: Date },
): Promise<{ claimed: boolean; request: OperatorRequestRow }> {
  return withTransaction(pool, async (tx) => {
    await lockAccountRow(tx, input.accountId);
    const identity = [input.accountId, input.operatorId, input.scope, input.key];
    const existing = await tx.query<OperatorRequestRow>(
      `SELECT * FROM operator_requests
        WHERE account_id = $1 AND operator_id = $2 AND scope = $3 AND idempotency_key = $4`,
      identity,
    );
    const previous = existing.rows[0];
    if (previous !== undefined) return { claimed: false, request: previous };
    const inserted = await tx.query<OperatorRequestRow>(
      `INSERT INTO operator_requests
         (account_id, operator_id, scope, idempotency_key, payload_hash, state, created_at)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', $6) RETURNING *`,
      [...identity, input.payloadHash, input.now],
    );
    const request = inserted.rows[0];
    if (request === undefined) throw new Error("operator request claim returned no row");
    return { claimed: true, request };
  });
}

/** Commit the response before sending it. A crash before this commit leaves a fail-closed PENDING claim. */
export async function completeOperatorRequest(
  pool: Pool,
  input: OperatorRequestIdentity & { payloadHash: string; status: number; body: unknown; now: Date },
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    await lockAccountRow(tx, input.accountId);
    const result = await tx.query(
      `UPDATE operator_requests SET state = 'COMPLETED', response_status = $6,
         response_body = $7::jsonb, completed_at = $8
       WHERE account_id = $1 AND operator_id = $2 AND scope = $3 AND idempotency_key = $4
         AND payload_hash = $5 AND state = 'PENDING'`,
      [
        input.accountId,
        input.operatorId,
        input.scope,
        input.key,
        input.payloadHash,
        input.status,
        JSON.stringify(input.body),
        input.now,
      ],
    );
    if (result.rowCount !== 1) throw new Error("operator request completion did not match its pending claim");
  });
}
