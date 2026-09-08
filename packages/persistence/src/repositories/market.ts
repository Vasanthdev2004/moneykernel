import type { PoolClient } from "pg";

export type SnapshotType = "MARKET" | "SYMBOL_RULES" | "ACCOUNT";

export type SnapshotRow = {
  id: string;
  account_id: string;
  type: SnapshotType;
  source: string;
  source_time: Date | null;
  received_at: Date;
  payload: Record<string, unknown>;
  payload_hash: string;
  parser_version: string;
};

export type AssetBalanceRow = { account_id: string; asset: string; owned_quantity: string; version: number };
export type InventoryAllocationRow = {
  account_id: string;
  agent_or_unassigned_id: string;
  asset: string;
  owned_quantity: string;
  version: number;
};

export const UNASSIGNED_OWNER = "UNASSIGNED";

// --- snapshots (immutable) ----------------------------------------------------

export async function recordSnapshot(
  client: PoolClient,
  input: {
    id: string;
    accountId: string;
    type: SnapshotType;
    source: string;
    sourceTime: Date | null;
    receivedAt: Date;
    payload: Record<string, unknown>;
    payloadHash: string;
    parserVersion: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO snapshots (id, account_id, type, source, source_time, received_at, payload, payload_hash, parser_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    [
      input.id,
      input.accountId,
      input.type,
      input.source,
      input.sourceTime,
      input.receivedAt,
      JSON.stringify(input.payload),
      input.payloadHash,
      input.parserVersion,
    ],
  );
}

export async function getSnapshotsByIds(client: PoolClient, accountId: string, ids: string[]): Promise<SnapshotRow[]> {
  if (ids.length === 0) return [];
  const result = await client.query<SnapshotRow>(
    "SELECT * FROM snapshots WHERE account_id = $1 AND id = ANY($2::text[])",
    [accountId, ids],
  );
  return result.rows;
}

/** Latest snapshot of a type per symbol (payload->>'symbol'), for marks and symbol rules. */
export async function latestSnapshotsBySymbol(
  client: PoolClient,
  accountId: string,
  type: SnapshotType,
  symbols: string[],
): Promise<Map<string, SnapshotRow>> {
  const out = new Map<string, SnapshotRow>();
  if (symbols.length === 0) return out;
  const result = await client.query<SnapshotRow>(
    `SELECT DISTINCT ON (payload->>'symbol') *
       FROM snapshots
      WHERE account_id = $1 AND type = $2 AND payload->>'symbol' = ANY($3::text[])
      ORDER BY payload->>'symbol', received_at DESC, id DESC`,
    [accountId, type, symbols],
  );
  for (const row of result.rows) {
    const symbol = row.payload.symbol;
    if (typeof symbol === "string") out.set(symbol, row);
  }
  return out;
}

// --- balances and attribution -------------------------------------------------

export async function upsertAssetBalance(
  client: PoolClient,
  accountId: string,
  asset: string,
  ownedQuantity: string,
): Promise<AssetBalanceRow> {
  const result = await client.query<AssetBalanceRow>(
    `INSERT INTO asset_balances (account_id, asset, owned_quantity, version) VALUES ($1, $2, $3, 1)
     ON CONFLICT (account_id, asset) DO UPDATE SET owned_quantity = EXCLUDED.owned_quantity, version = asset_balances.version + 1
     RETURNING *`,
    [accountId, asset, ownedQuantity],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("balance upsert returned no row");
  return row;
}

export async function listAssetBalances(client: PoolClient, accountId: string): Promise<AssetBalanceRow[]> {
  const result = await client.query<AssetBalanceRow>(
    "SELECT * FROM asset_balances WHERE account_id = $1 ORDER BY asset",
    [accountId],
  );
  return result.rows;
}

export async function upsertInventoryAllocation(
  client: PoolClient,
  accountId: string,
  ownerId: string,
  asset: string,
  ownedQuantity: string,
): Promise<InventoryAllocationRow> {
  const result = await client.query<InventoryAllocationRow>(
    `INSERT INTO inventory_allocations (account_id, agent_or_unassigned_id, asset, owned_quantity, version) VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (account_id, agent_or_unassigned_id, asset)
     DO UPDATE SET owned_quantity = EXCLUDED.owned_quantity, version = inventory_allocations.version + 1
     RETURNING *`,
    [accountId, ownerId, asset, ownedQuantity],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("allocation upsert returned no row");
  return row;
}

export async function listInventoryAllocations(
  client: PoolClient,
  accountId: string,
  ownerId?: string,
): Promise<InventoryAllocationRow[]> {
  const result =
    ownerId === undefined
      ? await client.query<InventoryAllocationRow>(
          "SELECT * FROM inventory_allocations WHERE account_id = $1 ORDER BY agent_or_unassigned_id, asset",
          [accountId],
        )
      : await client.query<InventoryAllocationRow>(
          "SELECT * FROM inventory_allocations WHERE account_id = $1 AND agent_or_unassigned_id = $2 ORDER BY asset",
          [accountId, ownerId],
        );
  return result.rows;
}

export async function ledgerVersion(client: PoolClient, accountId: string): Promise<number> {
  const result = await client.query<{ v: string }>(
    "SELECT COALESCE(MAX(sequence), 0)::text AS v FROM ledger_entries WHERE account_id = $1",
    [accountId],
  );
  return Number(result.rows[0]?.v ?? "0");
}
