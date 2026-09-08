import { randomBytes } from "node:crypto";
import {
  AccountNotFoundError,
  createPool,
  listMigrationFiles,
  lockAccountRow,
  MigrationDriftError,
  migrate,
  migrationStatus,
  type Pool,
  releaseWriterLock,
  tryAcquireWriterLock,
  withClient,
  withTransaction,
} from "@moneykernel/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE_URL =
  process.env.DATABASE_URL_TEST ?? "postgresql://moneykernel:LOCAL_DEV_ONLY@localhost:5432/moneykernel_test";

const REQUIRED_TABLES = [
  "accounts",
  "agents",
  "leases",
  "policy_versions",
  "snapshots",
  "asset_balances",
  "inventory_allocations",
  "intents",
  "proposals",
  "decision_receipts",
  "reservations",
  "approvals",
  "commands",
  "orders",
  "fills",
  "ledger_entries",
  "conflicts",
  "conflict_members",
  "incidents",
  "audit_events",
  "schema_migrations",
];

const dbName = `mk_migrate_${randomBytes(4).toString("hex")}`;
function urlFor(database: string): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${database}`;
  return u.toString();
}

const NOW = "2026-09-08T12:00:00Z";

async function seedAccount(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO accounts (id, environment, alias, status, epoch, state_version, quote_asset, configuration_hash, created_at, updated_at)
     VALUES ($1, 'REPLAY', $1, 'PAUSED', 1, 1, 'USDT', 'cfg', $2, $2)`,
    [id, NOW],
  );
}

async function seedAgent(pool: Pool, accountId: string, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO agents (id, account_id, name, strategy_kind, status, revision, token_hash, created_at, updated_at)
     VALUES ($1, $2, $1, 'SCRIPTED', 'ACTIVE', 1, $1 || '-token', $3, $3)`,
    [id, accountId, NOW],
  );
}

function insertLease(pool: Pool, id: string, accountId: string, agentId: string, status: string): Promise<unknown> {
  return pool.query(
    `INSERT INTO leases (id, account_id, agent_id, revision, budget_quote, attempt_limit, starts_at, expires_at, status, capability_json, created_at, updated_at)
     VALUES ($1, $2, $3, 1, '40', 2, $4, $4::timestamptz + interval '20 minutes', $5, '{}', $4, $4)`,
    [id, accountId, agentId, NOW, status],
  );
}

describe("migrations and schema constraints (prd.md 14.2, 14.6)", () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(BASE_URL, { max: 1, applicationName: "mk-test-admin" });
    await admin.query(`CREATE DATABASE ${dbName}`);
    pool = createPool(urlFor(dbName), { max: 4, applicationName: "mk-test" });
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it("applies every migration file exactly once and creates every required table", async () => {
    const files = listMigrationFiles();
    const first = await migrate(pool);
    expect(first.applied.length).toBe(files.length);
    expect(first.skipped).toBe(0);

    const tables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const names = new Set(tables.rows.map((r) => r.table_name));
    for (const table of REQUIRED_TABLES) expect(names.has(table), `missing table ${table}`).toBe(true);

    const second = await migrate(pool);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toBe(files.length);
    const status = await migrationStatus(pool);
    expect(status.pending).toEqual([]);
    expect(status.drift).toEqual([]);
    expect(status.applied.length).toBe(files.length);
  });

  it("detects checksum drift and refuses to migrate over it", async () => {
    const original = await pool.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE version = 1");
    await pool.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1");
    const status = await migrationStatus(pool);
    expect(status.drift.map((d) => d.version)).toEqual([1]);
    await expect(migrate(pool)).rejects.toBeInstanceOf(MigrationDriftError);
    await pool.query("UPDATE schema_migrations SET checksum = $1 WHERE version = 1", [original.rows[0]?.checksum]);
    expect((await migrationStatus(pool)).drift).toEqual([]);
  });

  it("account environment is immutable", async () => {
    await seedAccount(pool, "acct_immutable");
    await expect(pool.query("UPDATE accounts SET environment = 'SHADOW' WHERE id = 'acct_immutable'")).rejects.toThrow(
      /immutable/,
    );
    await pool.query("UPDATE accounts SET status = 'READY' WHERE id = 'acct_immutable'");
  });

  it("money columns reject negative values", async () => {
    await seedAccount(pool, "acct_money");
    await expect(
      pool.query(
        "INSERT INTO asset_balances (account_id, asset, owned_quantity, version) VALUES ('acct_money', 'USDT', '-1', 1)",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      "INSERT INTO asset_balances (account_id, asset, owned_quantity, version) VALUES ('acct_money', 'USDT', '0.000000000000000001', 1)",
    );
    const row = await pool.query<{ owned_quantity: string }>(
      "SELECT owned_quantity FROM asset_balances WHERE account_id = 'acct_money'",
    );
    expect(row.rows[0]?.owned_quantity).toBe("0.000000000000000001");
  });

  it("allows at most one ACTIVE lease per agent and account", async () => {
    await seedAccount(pool, "acct_lease");
    await seedAgent(pool, "acct_lease", "agent_lease");
    await insertLease(pool, "lease_1", "acct_lease", "agent_lease", "ACTIVE");
    await expect(insertLease(pool, "lease_2", "acct_lease", "agent_lease", "ACTIVE")).rejects.toMatchObject({
      code: "23505",
    });
    await insertLease(pool, "lease_3", "acct_lease", "agent_lease", "EXPIRED");
  });

  it("audit events are append-only", async () => {
    await seedAccount(pool, "acct_audit");
    await pool.query(
      `INSERT INTO audit_events (id, account_id, account_seq, type, payload, payload_hash, previous_hash, event_hash, occurred_at)
       VALUES ('evt_1', 'acct_audit', 1, 'ACCOUNT_CREATED', '{}', 'p', NULL, 'e', $1)`,
      [NOW],
    );
    await expect(pool.query("UPDATE audit_events SET type = 'X' WHERE id = 'evt_1'")).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM audit_events WHERE id = 'evt_1'")).rejects.toThrow(/append-only/);
    await expect(
      pool.query(
        `INSERT INTO audit_events (id, account_id, account_seq, type, payload, payload_hash, previous_hash, event_hash, occurred_at)
         VALUES ('evt_dup', 'acct_audit', 1, 'ACCOUNT_CREATED', '{}', 'p', NULL, 'e', $1)`,
        [NOW],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("the writer advisory lock is exclusive across sessions until released", async () => {
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      expect(await tryAcquireWriterLock(first, "writer:test")).toBe(true);
      expect(await tryAcquireWriterLock(second, "writer:test")).toBe(false);
      await releaseWriterLock(first, "writer:test");
      expect(await tryAcquireWriterLock(second, "writer:test")).toBe(true);
      await releaseWriterLock(second, "writer:test");
    } finally {
      first.release();
      second.release();
    }
  });

  it("row locks resolve accounts and transactions roll back on error", async () => {
    await seedAccount(pool, "acct_lock");
    await withClient(pool, async (client) => {
      await expect(lockAccountRow(client, "acct_missing")).rejects.toBeInstanceOf(AccountNotFoundError);
    });
    await expect(
      withTransaction(pool, async (client) => {
        const row = await lockAccountRow(client, "acct_lock");
        await client.query("UPDATE accounts SET epoch = epoch + 1 WHERE id = $1", [row.id]);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    const after = await pool.query<{ epoch: number }>("SELECT epoch FROM accounts WHERE id = 'acct_lock'");
    expect(after.rows[0]?.epoch).toBe(1);
  });
});
