import pg from "pg";

// pg is CommonJS; the default import is the module object. Named runtime access goes through it.
const { Pool } = pg;

export type { Pool as PgPool, PoolClient } from "pg";
export type Pool = InstanceType<typeof Pool>;

export type AccountEnvironment = "REPLAY" | "SHADOW" | "TESTNET";
export type AccountStatus = "PAUSED" | "READY" | "RECONCILING" | "ERROR";

export type AccountRow = {
  id: string;
  environment: AccountEnvironment;
  alias: string;
  status: AccountStatus;
  epoch: number;
  state_version: number;
  quote_asset: string;
  configuration_hash: string;
  created_at: Date;
  updated_at: Date;
};

export class AccountNotFoundError extends Error {
  readonly accountId: string;
  constructor(accountId: string) {
    super(`account ${accountId} not found`);
    this.name = "AccountNotFoundError";
    this.accountId = accountId;
  }
}

export type CreatePoolOptions = { max?: number; applicationName?: string };

/**
 * NUMERIC and BIGINT columns arrive as strings (pg default), which is exactly
 * what the decimal-string contract wants; never install a float parser.
 */
export function createPool(databaseUrl: string, options: CreatePoolOptions = {}): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: options.max ?? 10,
    application_name: options.applicationName ?? "moneykernel",
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on("error", (error: Error) => {
    console.error(`[pg] idle client error: ${error.message}`);
  });
  return pool;
}

export async function withClient<T>(pool: Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** BEGIN / COMMIT, ROLLBACK on any throw. Keep transactions short; never await network I/O inside (prd.md 11.3). */
export async function withTransaction<T>(pool: Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

/**
 * Session-level advisory lock for single-writer ownership (prd.md 12.5). The
 * lock lives as long as the session, so the caller must keep this client
 * checked out for the lifetime of the writer. It is not a fencing token the
 * exchange understands; there is no automatic hot failover.
 */
export async function tryAcquireWriterLock(client: pg.PoolClient, key: string): Promise<boolean> {
  const result = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [key]);
  return result.rows[0]?.ok === true;
}

export async function releaseWriterLock(client: pg.PoolClient, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
}

/** Row lock on the account; first step of the fixed lock order (prd.md 12.5). */
export async function lockAccountRow(client: pg.PoolClient, accountId: string): Promise<AccountRow> {
  const result = await client.query<AccountRow>("SELECT * FROM accounts WHERE id = $1 FOR UPDATE", [accountId]);
  const row = result.rows[0];
  if (row === undefined) throw new AccountNotFoundError(accountId);
  return row;
}
