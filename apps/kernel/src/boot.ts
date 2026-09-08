import {
  type AccountRow,
  appendAuditEvent,
  countCommandsByState,
  createPool,
  ensureAccountPaused,
  migrationStatus,
  type Pool,
  type PoolClient,
  releaseWriterLock,
  tryAcquireWriterLock,
  withClient,
  withTransaction,
} from "@moneykernel/persistence";
import type { KernelConfig } from "./config.ts";
import { newId } from "./ids.ts";

export type ReadinessCheck = { name: string; ok: boolean; detail: string };

export type WriterSession = { client: PoolClient; key: string };

export type KernelRuntime = {
  config: KernelConfig;
  pool: Pool | null;
  writer: WriterSession | null;
  account: AccountRow | null;
  /** Checks established at boot that do not change while the process runs. */
  bootChecks: ReadinessCheck[];
  startedAt: Date;
  clock: () => Date;
  shutdown: () => Promise<void>;
};

export type BootOptions = {
  clock?: () => Date;
  log?: (message: string) => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function writerLockKey(config: KernelConfig): string {
  return `moneykernel:writer:${config.environment}:${config.accountAlias}`;
}

/**
 * Restart protocol, Gate 1 subset of prd.md 11.8:
 *   boot with the account PAUSED -> acquire the single-writer session lock ->
 *   increment the control epoch -> verify migrations and configuration ->
 *   load unresolved commands -> publish readiness. Reconciliation of armed or
 *   unknown commands arrives with the dispatcher (G3/G4); until then their
 *   presence simply blocks readiness. Operator Resume is always required.
 */
export async function boot(config: KernelConfig, options: BootOptions = {}): Promise<KernelRuntime> {
  const clock = options.clock ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  const checks: ReadinessCheck[] = [];
  const startedAt = clock();

  checks.push({
    name: "configuration",
    ok: true,
    detail: `mode=${config.environment} alias=${config.accountAlias} hash=${config.configurationHash.slice(0, 12)}${
      config.warnings.length > 0 ? ` warnings=${config.warnings.length}` : ""
    }`,
  });
  for (const warning of config.warnings) log(`config warning: ${warning}`);

  let pool: Pool | null = null;
  let writer: WriterSession | null = null;
  let account: AccountRow | null = null;

  const shutdown = async (): Promise<void> => {
    if (writer !== null) {
      try {
        await releaseWriterLock(writer.client, writer.key);
      } catch (error) {
        log(`writer lock release failed: ${errorMessage(error)}`);
      }
      writer.client.release();
      writer = null;
    }
    if (pool !== null) {
      await pool.end();
      pool = null;
    }
  };

  const runtime = (): KernelRuntime => ({
    config,
    pool,
    writer,
    account,
    bootChecks: checks,
    startedAt,
    clock,
    shutdown,
  });

  try {
    pool = createPool(config.databaseUrl, { applicationName: "moneykernel-kernel", max: 8 });
    await pool.query("SELECT 1");
    checks.push({ name: "database", ok: true, detail: "reachable" });
  } catch (error) {
    checks.push({ name: "database", ok: false, detail: errorMessage(error) });
    log(`database unreachable: ${errorMessage(error)}`);
    if (pool !== null) {
      await pool.end().catch(() => undefined);
      pool = null;
    }
    return runtime();
  }

  let migrationsOk = false;
  try {
    const status = await migrationStatus(pool);
    migrationsOk = status.pending.length === 0 && status.drift.length === 0;
    checks.push({
      name: "migrations",
      ok: migrationsOk,
      detail: migrationsOk
        ? `${status.applied.length} applied, schema current`
        : `${status.pending.length} pending, ${status.drift.length} drifted; run pnpm db:migrate`,
    });
  } catch (error) {
    checks.push({ name: "migrations", ok: false, detail: errorMessage(error) });
  }

  const key = writerLockKey(config);
  try {
    const client = await pool.connect();
    const acquired = await tryAcquireWriterLock(client, key);
    if (acquired) {
      writer = { client, key };
      checks.push({ name: "writer_lock", ok: true, detail: `held: ${key}` });
    } else {
      client.release();
      checks.push({
        name: "writer_lock",
        ok: false,
        detail: `another process holds ${key}; no automatic hot failover`,
      });
    }
  } catch (error) {
    checks.push({ name: "writer_lock", ok: false, detail: errorMessage(error) });
  }

  if (migrationsOk && writer !== null) {
    try {
      const now = clock();
      account = await withTransaction(pool, async (tx) => {
        const ensured = await ensureAccountPaused(tx, {
          environment: config.environment,
          alias: config.accountAlias,
          quoteAsset: config.quoteAsset,
          configurationHash: config.configurationHash,
          now,
        });
        await appendAuditEvent(tx, {
          id: newId("evt"),
          accountId: ensured.account.id,
          type: ensured.created ? "ACCOUNT_CREATED" : "ACCOUNT_BOOTED",
          payload: {
            environment: config.environment,
            alias: config.accountAlias,
            status: "PAUSED",
            epoch: ensured.account.epoch,
            configuration_hash: config.configurationHash,
            engine_version: config.engineVersion,
          },
          occurredAt: now,
        });
        return ensured.account;
      });
      checks.push({
        name: "account",
        ok: true,
        detail: `${account.id} status=${account.status} epoch=${account.epoch}`,
      });
      const counts = await withClient(pool, (client) => countCommandsByState(client, (account as AccountRow).id));
      const blocking = counts.ARMED + counts.OUTCOME_UNKNOWN;
      checks.push({
        name: "unresolved_commands",
        ok: blocking === 0,
        detail: `armed=${counts.ARMED} unknown=${counts.OUTCOME_UNKNOWN} ready=${counts.READY}`,
      });
    } catch (error) {
      checks.push({ name: "account", ok: false, detail: errorMessage(error) });
    }
  } else {
    checks.push({ name: "account", ok: false, detail: "skipped: migrations or writer lock not ready" });
  }

  checks.push({
    name: "execution_adapter",
    ok: config.environment !== "TESTNET",
    detail:
      config.environment === "TESTNET"
        ? "Binance Spot Testnet adapter is not qualified (P1); refusing to start execution"
        : "paper executor selected at construction time; no external write path exists in this mode",
  });

  return runtime();
}
