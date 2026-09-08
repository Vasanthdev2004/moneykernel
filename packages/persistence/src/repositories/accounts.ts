import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { AccountEnvironment, AccountRow, AccountStatus } from "../db.ts";

export type EnsureAccountInput = {
  environment: AccountEnvironment;
  alias: string;
  quoteAsset: string;
  configurationHash: string;
  now: Date;
};

/** One controlled account per (environment, alias); the id is stable across restarts. */
export function deterministicAccountId(environment: string, alias: string): string {
  return `acct_${createHash("sha256").update(`${environment}:${alias}`).digest("hex").slice(0, 16)}`;
}

/**
 * Boot rule (prd.md 11.8): the account starts PAUSED and its control epoch
 * increments on every boot, which invalidates stale local authority bound to
 * the previous epoch. The caller runs this inside a transaction; the SELECT
 * ... FOR UPDATE (or the INSERT) holds the account row lock until commit.
 */
export async function ensureAccountPaused(
  client: PoolClient,
  input: EnsureAccountInput,
): Promise<{ account: AccountRow; created: boolean }> {
  const existing = await client.query<AccountRow>(
    "SELECT * FROM accounts WHERE environment = $1 AND alias = $2 FOR UPDATE",
    [input.environment, input.alias],
  );
  const current = existing.rows[0];
  if (current === undefined) {
    const id = deterministicAccountId(input.environment, input.alias);
    const inserted = await client.query<AccountRow>(
      `INSERT INTO accounts (id, environment, alias, status, epoch, state_version, quote_asset, configuration_hash, created_at, updated_at)
       VALUES ($1, $2, $3, 'PAUSED', 1, 1, $4, $5, $6, $6)
       RETURNING *`,
      [id, input.environment, input.alias, input.quoteAsset, input.configurationHash, input.now],
    );
    const account = inserted.rows[0];
    if (account === undefined) throw new Error("account insert returned no row");
    return { account, created: true };
  }
  const updated = await client.query<AccountRow>(
    `UPDATE accounts
       SET status = 'PAUSED', epoch = epoch + 1, state_version = state_version + 1, configuration_hash = $2, updated_at = $3
     WHERE id = $1
     RETURNING *`,
    [current.id, input.configurationHash, input.now],
  );
  const account = updated.rows[0];
  if (account === undefined) throw new Error("account update returned no row");
  return { account, created: false };
}

export async function findAccountByAlias(
  client: PoolClient,
  environment: AccountEnvironment,
  alias: string,
): Promise<AccountRow | null> {
  const result = await client.query<AccountRow>("SELECT * FROM accounts WHERE environment = $1 AND alias = $2", [
    environment,
    alias,
  ]);
  return result.rows[0] ?? null;
}

export async function getAccountById(client: PoolClient, id: string): Promise<AccountRow | null> {
  const result = await client.query<AccountRow>("SELECT * FROM accounts WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

/**
 * Status transitions (prd.md 11.1). The caller holds the account row lock.
 * Stopping increments the epoch so that any approval bound to the old epoch
 * is stale (prd.md 10.6); resuming does not.
 */
export async function setAccountStatus(
  client: PoolClient,
  id: string,
  status: AccountStatus,
  now: Date,
  options: { bumpEpoch?: boolean } = {},
): Promise<AccountRow> {
  const result = await client.query<AccountRow>(
    `UPDATE accounts
        SET status = $2, state_version = state_version + 1, epoch = epoch + $3, updated_at = $4
      WHERE id = $1 RETURNING *`,
    [id, status, options.bumpEpoch ? 1 : 0, now],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`account ${id} not found`);
  return row;
}
