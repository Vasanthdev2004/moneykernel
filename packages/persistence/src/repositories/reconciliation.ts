import type { PoolClient } from "pg";
import type { ReservationRow } from "./admission.ts";
import type { CommandRow, IncidentRow, OrderRow, OrderStatus } from "./coordination.ts";
import type { AssetBalanceRow, InventoryAllocationRow } from "./market.ts";
import type { LeaseRow } from "./registry.ts";

/**
 * Fill reconciliation persistence (prd.md 11.6, 14.3, 14.4, 28.3). Every
 * balance mutation is an append-only ledger entry referencing a fill, a
 * baseline, an assignment, or an explicit correction. The unique index on
 * (source_fill_id, category, asset) makes a second application of the same
 * fill identity fail at the database, which is what INV-08 / T-39 rely on.
 */
export const LEDGER_CATEGORIES = [
  "BASELINE",
  "ASSIGNMENT",
  "FILL_BASE",
  "FILL_QUOTE",
  "FILL_FEE",
  "CORRECTION",
] as const;
export type LedgerCategory = (typeof LEDGER_CATEGORIES)[number];

export type LedgerEntryRow = {
  id: string;
  account_id: string;
  agent_id: string | null;
  asset: string;
  signed_delta: string;
  category: LedgerCategory;
  source_fill_id: string | null;
  source_ref: string | null;
  sequence: string;
  created_at: Date;
};

export type LedgerEntryInput = {
  id: string;
  agentId: string | null;
  asset: string;
  signedDelta: string;
  category: LedgerCategory;
  sourceFillId: string | null;
  sourceRef: string | null;
};

/** Appends entries in order, continuing the account's sequence. Caller holds the account row lock. */
export async function appendLedgerEntries(
  client: PoolClient,
  accountId: string,
  entries: LedgerEntryInput[],
  now: Date,
): Promise<LedgerEntryRow[]> {
  if (entries.length === 0) return [];
  const seq = await client.query<{ v: string }>(
    "SELECT COALESCE(MAX(sequence), 0)::text AS v FROM ledger_entries WHERE account_id = $1",
    [accountId],
  );
  let sequence = Number(seq.rows[0]?.v ?? "0");
  const rows: LedgerEntryRow[] = [];
  for (const entry of entries) {
    sequence += 1;
    const result = await client.query<LedgerEntryRow>(
      `INSERT INTO ledger_entries (id, account_id, agent_id, asset, signed_delta, category, source_fill_id, source_ref, sequence, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        entry.id,
        accountId,
        entry.agentId,
        entry.asset,
        entry.signedDelta,
        entry.category,
        entry.sourceFillId,
        entry.sourceRef,
        sequence,
        now,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("ledger insert returned no row");
    rows.push(row);
  }
  return rows;
}

export async function listLedgerEntries(
  client: PoolClient,
  accountId: string,
  options: { limit?: number; sourceFillId?: string } = {},
): Promise<LedgerEntryRow[]> {
  const result = await client.query<LedgerEntryRow>(
    `SELECT * FROM ledger_entries
      WHERE account_id = $1 AND ($3::text IS NULL OR source_fill_id = $3)
      ORDER BY sequence LIMIT $2`,
    [accountId, options.limit ?? 1000, options.sourceFillId ?? null],
  );
  return result.rows;
}

/**
 * Applies a signed delta to a controlled balance. The row is created when the
 * asset is new to the account (first acquisition). The CHECK constraint
 * refuses a negative result, so an over-debit fails the whole transaction
 * instead of creating a short.
 */
export async function applyBalanceDelta(
  client: PoolClient,
  accountId: string,
  asset: string,
  signedDelta: string,
): Promise<AssetBalanceRow> {
  // UPDATE first: PostgreSQL checks constraints on the proposed INSERT tuple before conflict resolution,
  // so a negative delta must never travel through the INSERT path.
  const updated = await client.query<AssetBalanceRow>(
    `UPDATE asset_balances SET owned_quantity = owned_quantity + $3, version = version + 1
      WHERE account_id = $1 AND asset = $2 RETURNING *`,
    [accountId, asset, signedDelta],
  );
  const row = updated.rows[0];
  if (row !== undefined) return row;
  const inserted = await client.query<AssetBalanceRow>(
    "INSERT INTO asset_balances (account_id, asset, owned_quantity, version) VALUES ($1, $2, $3, 1) RETURNING *",
    [accountId, asset, signedDelta],
  );
  const created = inserted.rows[0];
  if (created === undefined) throw new Error("balance delta returned no row");
  return created;
}

export async function applyAllocationDelta(
  client: PoolClient,
  accountId: string,
  ownerId: string,
  asset: string,
  signedDelta: string,
): Promise<InventoryAllocationRow> {
  const updated = await client.query<InventoryAllocationRow>(
    `UPDATE inventory_allocations SET owned_quantity = owned_quantity + $4, version = version + 1
      WHERE account_id = $1 AND agent_or_unassigned_id = $2 AND asset = $3 RETURNING *`,
    [accountId, ownerId, asset, signedDelta],
  );
  const row = updated.rows[0];
  if (row !== undefined) return row;
  const inserted = await client.query<InventoryAllocationRow>(
    `INSERT INTO inventory_allocations (account_id, agent_or_unassigned_id, asset, owned_quantity, version)
     VALUES ($1, $2, $3, $4, 1) RETURNING *`,
    [accountId, ownerId, asset, signedDelta],
  );
  const created = inserted.rows[0];
  if (created === undefined) throw new Error("allocation delta returned no row");
  return created;
}

/** Moves executed BUY cost from reserved to consumed acquisition budget (prd.md 9.2, 11.6). Never decreases. */
export async function addLeaseConsumedQuote(
  client: PoolClient,
  leaseId: string,
  delta: string,
  now: Date,
): Promise<LeaseRow> {
  const result = await client.query<LeaseRow>(
    "UPDATE leases SET consumed_quote = consumed_quote + $2, updated_at = $3 WHERE id = $1 RETURNING *",
    [leaseId, delta, now],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`lease ${leaseId} not found`);
  return row;
}

// --- orders ---------------------------------------------------------------------

export async function getOrderByClientOrderId(
  client: PoolClient,
  accountId: string,
  clientOrderId: string,
  options: { lock?: boolean } = {},
): Promise<OrderRow | null> {
  const result = await client.query<OrderRow>(
    `SELECT * FROM orders WHERE account_id = $1 AND client_order_id = $2${options.lock ? " FOR UPDATE" : ""}`,
    [accountId, clientOrderId],
  );
  return result.rows[0] ?? null;
}

export async function updateOrderObservation(
  client: PoolClient,
  orderId: string,
  input: {
    status: OrderStatus;
    executedBase: string;
    executedQuote: string;
    exchangeOrderId: string | null;
    observedAt: Date;
  },
): Promise<OrderRow> {
  const result = await client.query<OrderRow>(
    `UPDATE orders
        SET status = $2, executed_base = $3, executed_quote = $4,
            exchange_order_id = COALESCE($5, exchange_order_id), last_observed_at = $6
      WHERE id = $1 RETURNING *`,
    [orderId, input.status, input.executedBase, input.executedQuote, input.exchangeOrderId, input.observedAt],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`order ${orderId} not found`);
  return row;
}

// --- reservations ---------------------------------------------------------------

/** Moves an applied fill's debit out of the live hold without releasing the unfilled remainder. */
export async function consumeArmedReservationPart(
  client: PoolClient,
  reservation: ReservationRow,
  consumedAmount: string,
  consumedRowId: string,
  now: Date,
): Promise<void> {
  const remaining = await client.query(
    `UPDATE reservations SET amount = amount - $2
      WHERE id = $1 AND state = 'ARMED' AND amount >= $2 RETURNING id`,
    [reservation.id, consumedAmount],
  );
  if (remaining.rowCount !== 1) throw new Error(`reservation ${reservation.id} cannot cover its consumed part`);
  await client.query(
    `INSERT INTO reservations (id, account_id, proposal_id, agent_id, asset, amount, kind, state, created_at, armed_at, released_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'CONSUMED', $8, $9, $10)`,
    [
      consumedRowId,
      reservation.account_id,
      reservation.proposal_id,
      reservation.agent_id,
      reservation.asset,
      consumedAmount,
      reservation.kind,
      reservation.created_at,
      reservation.armed_at,
      now,
    ],
  );
}

/**
 * Settles one ARMED hold after terminal reconciliation: the consumed part
 * stays on the original row as CONSUMED and the unfilled remainder becomes a
 * separate RELEASED row, so "sum of CONSUMED holds equals settled debits" is
 * queryable (prd.md 11.6: release only the unfilled remainder).
 */
export async function settleArmedReservation(
  client: PoolClient,
  reservation: ReservationRow,
  consumedAmount: string,
  releasedAmount: string,
  releasedRowId: string,
  now: Date,
): Promise<{ consumed: ReservationRow; released: ReservationRow | null }> {
  const consumed = await client.query<ReservationRow>(
    "UPDATE reservations SET state = 'CONSUMED', amount = $2, released_at = $3 WHERE id = $1 AND state = 'ARMED' RETURNING *",
    [reservation.id, consumedAmount, now],
  );
  const consumedRow = consumed.rows[0];
  if (consumedRow === undefined) throw new Error(`reservation ${reservation.id} is not ARMED`);
  let releasedRow: ReservationRow | null = null;
  if (releasedAmount !== "0") {
    const released = await client.query<ReservationRow>(
      `INSERT INTO reservations (id, account_id, proposal_id, agent_id, asset, amount, kind, state, created_at, armed_at, released_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'RELEASED', $8, $9, $10) RETURNING *`,
      [
        releasedRowId,
        reservation.account_id,
        reservation.proposal_id,
        reservation.agent_id,
        reservation.asset,
        releasedAmount,
        reservation.kind,
        reservation.created_at,
        reservation.armed_at,
        now,
      ],
    );
    releasedRow = released.rows[0] ?? null;
  }
  return { consumed: consumedRow, released: releasedRow };
}

// --- commands needing reconciliation ------------------------------------------------

/** Commands whose external effect is not fully settled: armed, unknown, or accepted without a reconciliation marker. */
export async function listCommandsNeedingReconciliation(client: PoolClient, accountId: string): Promise<CommandRow[]> {
  const result = await client.query<CommandRow>(
    `SELECT * FROM commands
      WHERE account_id = $1
        AND (state IN ('ARMED', 'OUTCOME_UNKNOWN') OR (state = 'ACCEPTED' AND reconciled_at IS NULL))
      ORDER BY armed_at NULLS FIRST, created_at, id`,
    [accountId],
  );
  return result.rows;
}

export async function listOpenIncidentsForCommand(
  client: PoolClient,
  accountId: string,
  commandId: string,
): Promise<IncidentRow[]> {
  const result = await client.query<IncidentRow>(
    `SELECT * FROM incidents
      WHERE account_id = $1 AND status = 'OPEN' AND evidence_refs->>'command_id' = $2
      ORDER BY created_at`,
    [accountId, commandId],
  );
  return result.rows;
}
