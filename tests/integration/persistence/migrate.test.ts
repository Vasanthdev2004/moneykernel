import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

async function seedCommand(pool: Pool, suffix: string): Promise<void> {
  await pool.query(
    `INSERT INTO intents (id, account_id, agent_id, lease_id, idempotency_key, canonical_payload, payload_hash, account_seq, created_at)
     VALUES ($1, 'acct_upgrade', 'agent_upgrade', 'lease_upgrade', $1, '{}', 'payload', 1, $2)`,
    [`intent_${suffix}`, NOW],
  );
  await pool.query(
    `INSERT INTO proposals (id, intent_id, account_id, revision, normalized_order, proposal_hash, state, expires_at, policy_id, lease_revision, account_epoch, created_at, updated_at)
     VALUES ($1, $2, 'acct_upgrade', 1, '{}', 'proposal', 'COMMAND_CREATED', $3, 'policy_upgrade', 1, 1, $3, $3)`,
    [`proposal_${suffix}`, `intent_${suffix}`, NOW],
  );
  await pool.query(
    `INSERT INTO approvals (id, account_id, proposal_id, proposal_revision, proposal_hash, operator_id, account_epoch, expires_at, status, consumed_at, created_at)
     VALUES ($1, 'acct_upgrade', $2, 1, 'proposal', 'operator', 1, $3, 'CONSUMED', $3, $3)`,
    [`approval_${suffix}`, `proposal_${suffix}`, NOW],
  );
  await pool.query(
    `INSERT INTO commands (id, account_id, proposal_id, approval_id, client_order_id, state, exact_payload, created_at, updated_at)
     VALUES ($1, 'acct_upgrade', $2, $3, $4, 'ACCEPTED', '{}', $5, $5)`,
    [`command_${suffix}`, `proposal_${suffix}`, `approval_${suffix}`, `client_${suffix}`, NOW],
  );
}

function insertObservedOrder(pool: Pool, suffix: string, symbol: string): Promise<unknown> {
  return pool.query(
    `INSERT INTO orders (id, account_id, command_id, exchange_order_id, client_order_id, symbol, status, executed_base, executed_quote, last_observed_at)
     VALUES ($1, 'acct_upgrade', $2, '123', $3, $4, 'FILLED', '1', '100', $5)`,
    [`order_${suffix}`, `command_${suffix}`, `client_${suffix}`, symbol, NOW],
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

  it("rejects unknown applied versions before executing a pending migration", async () => {
    const files = listMigrationFiles();
    const pendingVersion = files.length + 1;
    const unknownVersion = pendingVersion + 1;
    const dir = mkdtempSync(join(tmpdir(), "mk-migration-compat-"));
    try {
      for (const file of files) copyFileSync(file.path, join(dir, basename(file.path)));
      writeFileSync(
        join(dir, `${String(pendingVersion).padStart(4, "0")}_pending_probe.sql`),
        "CREATE TABLE migration_should_not_run (id INTEGER);",
      );
      await pool.query(
        "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, 'unknown_future', 'future')",
        [unknownVersion],
      );

      const currentStatus = await migrationStatus(pool);
      expect(currentStatus.pending).toEqual([]);
      expect(currentStatus.drift.map((entry) => entry.version)).toEqual([unknownVersion]);
      await expect(migrate(pool)).rejects.toBeInstanceOf(MigrationDriftError);

      const status = await migrationStatus(pool, dir);
      expect(status.pending.map((file) => file.version)).toEqual([pendingVersion]);
      expect(status.drift).toContainEqual({ version: unknownVersion, expected: "future", actual: "missing file" });
      await expect(migrate(pool, dir)).rejects.toBeInstanceOf(MigrationDriftError);
      const probe = await pool.query<{ relation: string | null }>(
        "SELECT to_regclass('public.migration_should_not_run')::text AS relation",
      );
      expect(probe.rows[0]?.relation).toBeNull();
      const applied = await pool.query("SELECT version FROM schema_migrations WHERE version = $1", [pendingVersion]);
      expect(applied.rows).toEqual([]);
    } finally {
      await pool.query("DELETE FROM schema_migrations WHERE version = $1", [unknownVersion]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upgrades existing orders to symbol-scoped exchange identities without losing data", async () => {
    const upgradeDbName = `mk_upgrade_${randomBytes(4).toString("hex")}`;
    const dir = mkdtempSync(join(tmpdir(), "mk-migration-upgrade-"));
    let upgradePool: Pool | undefined;
    await admin.query(`CREATE DATABASE ${upgradeDbName}`);
    try {
      upgradePool = createPool(urlFor(upgradeDbName), { max: 2, applicationName: "mk-upgrade-test" });
      const initial = listMigrationFiles()[0];
      if (initial === undefined) throw new Error("initial migration missing");
      copyFileSync(initial.path, join(dir, basename(initial.path)));
      expect((await migrate(upgradePool, dir)).applied.map((file) => file.version)).toEqual([1]);

      await seedAccount(upgradePool, "acct_upgrade");
      await seedAgent(upgradePool, "acct_upgrade", "agent_upgrade");
      await insertLease(upgradePool, "lease_upgrade", "acct_upgrade", "agent_upgrade", "ACTIVE");
      await upgradePool.query(
        `INSERT INTO policy_versions (id, account_id, version, canonical_policy, hash, created_by, created_at)
         VALUES ('policy_upgrade', 'acct_upgrade', 1, '{}', 'policy', 'operator', $1)`,
        [NOW],
      );
      for (const suffix of ["btc", "sol", "btc_duplicate"]) await seedCommand(upgradePool, suffix);
      await insertObservedOrder(upgradePool, "btc", "BTCUSDT");
      const original = await upgradePool.query("SELECT * FROM orders WHERE id = 'order_btc'");
      await expect(insertObservedOrder(upgradePool, "sol", "SOLUSDT")).rejects.toMatchObject({ code: "23505" });

      const upgraded = await migrate(upgradePool);
      expect(upgraded.applied.map((file) => file.version)).toContain(2);
      const preserved = await upgradePool.query("SELECT * FROM orders WHERE id = 'order_btc'");
      expect(preserved.rows).toEqual(original.rows);
      await insertObservedOrder(upgradePool, "sol", "SOLUSDT");
      await expect(insertObservedOrder(upgradePool, "btc_duplicate", "BTCUSDT")).rejects.toMatchObject({
        code: "23505",
      });
      expect((await migrate(upgradePool)).applied).toEqual([]);
    } finally {
      await upgradePool?.end();
      await admin.query(`DROP DATABASE ${upgradeDbName} WITH (FORCE)`);
      rmSync(dir, { recursive: true, force: true });
    }
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
