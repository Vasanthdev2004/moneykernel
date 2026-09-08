import { join } from "node:path";
import type { ExecutionAdapter, MarketAdapter } from "@moneykernel/contracts";
import {
  BINANCE_PUBLIC_DATA_BASE_URL,
  BINANCE_TESTNET_BASE_URL,
  BinancePublicRestMarketAdapter,
  FilePaperVenueStore,
  FixtureMarketAdapter,
  loadScenario,
  PaperExecutionAdapter,
  type PaperFaults,
  type PaperVenueStore,
} from "@moneykernel/integrations";
import {
  type AccountRow,
  appendAuditEvent,
  countOutstandingCommands,
  createPool,
  ensureAccountPaused,
  findAccountByAlias,
  migrationStatus,
  type Pool,
  type PoolClient,
  releaseWriterLock,
  tryAcquireWriterLock,
  withClient,
  withTransaction,
} from "@moneykernel/persistence";
import { SessionStore } from "./auth/operator.ts";
import type { KernelConfig } from "./config.ts";
import { FIXTURES_DIR } from "./fixtures.ts";
import { newId } from "./ids.ts";
import { type RecoveryReport, recoverOnBoot } from "./services/recovery.ts";

export type ReadinessCheck = { name: string; ok: boolean; detail: string };

export type WriterSession = { client: PoolClient; key: string };

export type KernelRuntime = {
  config: KernelConfig;
  pool: Pool | null;
  writer: WriterSession | null;
  account: AccountRow | null;
  /** Market observation adapter selected at construction time by mode (prd.md 13.1); null when none is qualified. */
  market: MarketAdapter | null;
  /** Execution adapter selected by mode at construction time; null until qualified (REPLAY/SHADOW: paper). */
  execution: ExecutionAdapter | null;
  sessions: SessionStore;
  /** Checks established at boot that do not change while the process runs. */
  bootChecks: ReadinessCheck[];
  /** Backoff schedule for automatic re-queries of unsettled commands (prd.md 11.7). */
  reconciliation: Map<string, { attempts: number; next_at: number }>;
  /** Boot recovery outcome (prd.md 11.8); null when recovery did not run (auxiliary process, no adapter). */
  recovery: RecoveryReport | null;
  /** Last successful observation read and last failure, for truthful integration status (FR-11). */
  marketHealth: { last_successful_read_at: string | null; last_error: string | null };
  startedAt: Date;
  clock: () => Date;
  shutdown: () => Promise<void>;
};

export type BootOptions = {
  clock?: () => Date;
  log?: (message: string) => void;
  /** Auxiliary processes (seed, tooling) share the database but must never own the writer lock. */
  skipWriterLock?: boolean;
  /** Auxiliary processes load the existing account without pausing it or bumping the epoch. */
  skipAccountBoot?: boolean;
  /** REPLAY scenario id; defaults to the configured fixture. */
  fixtureId?: string;
  /** Paper venue memory; tests share one instance across restarts. Default: a file under the state directory. */
  paperVenueStore?: PaperVenueStore;
  /** Fault injection for the paper venue (tests and recorded fault scenarios only). */
  paperFaults?: PaperFaults;
};

export function paperVenuePath(config: KernelConfig): string {
  return join(config.stateDir, `paper-venue-${config.environment}-${config.accountAlias}.json`);
}

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
 *   reconcile armed/unknown/unsettled commands against the venue by stable
 *   identity (never resend) -> invalidate stale approvals and pre-arm holds ->
 *   publish readiness. Anything still unsettled blocks readiness. Operator
 *   Resume is always required.
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
  let market: MarketAdapter | null = null;
  let execution: ExecutionAdapter | null = null;
  const sessions = new SessionStore();
  const reconciliation = new Map<string, { attempts: number; next_at: number }>();
  let recovery: RecoveryReport | null = null;
  const marketHealth = { last_successful_read_at: null as string | null, last_error: null as string | null };

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
    market,
    execution,
    sessions,
    bootChecks: checks,
    reconciliation,
    recovery,
    marketHealth,
    startedAt,
    clock,
    shutdown,
  });

  // Adapters are fixed by mode at construction time; never chosen by a model or a request (prd.md 13.1).
  // The paper venue's memory lives outside the kernel database so a restart can ask it what happened.
  const venueStore = options.paperVenueStore ?? new FilePaperVenueStore(paperVenuePath(config));
  if (config.environment === "REPLAY") {
    const fixtureId = options.fixtureId ?? config.replayFixture;
    try {
      const scenario = loadScenario(fixtureId, FIXTURES_DIR);
      market = new FixtureMarketAdapter(scenario, clock, newId);
      const feeRate = typeof scenario.policy?.fee_rate === "string" ? scenario.policy.fee_rate : "0.001";
      execution = new PaperExecutionAdapter({ kind: "FIXTURE", scenario }, clock, {
        environment: config.environment,
        feeRate,
        feeAsset: config.quoteAsset,
        store: venueStore,
        faults: options.paperFaults,
      });
      checks.push({ name: "market_adapter", ok: true, detail: `fixture ${scenario.scenario_id} (SYNTHETIC_FIXTURE)` });
    } catch (error) {
      checks.push({ name: "market_adapter", ok: false, detail: errorMessage(error) });
    }
  } else if (config.environment === "SHADOW") {
    try {
      const live = new BinancePublicRestMarketAdapter({
        source: "BINANCE_PUBLIC_REST",
        baseUrl: BINANCE_PUBLIC_DATA_BASE_URL,
        clock,
        newId,
      });
      market = live;
      execution = new PaperExecutionAdapter({ kind: "LIVE", market: live }, clock, {
        environment: config.environment,
        feeRate: "0.001",
        feeAsset: config.quoteAsset,
        store: venueStore,
        faults: options.paperFaults,
      });
      checks.push({
        name: "market_adapter",
        ok: true,
        detail: `Binance public REST reads (BINANCE_PUBLIC_REST) at ${BINANCE_PUBLIC_DATA_BASE_URL}; read-only`,
      });
    } catch (error) {
      checks.push({ name: "market_adapter", ok: false, detail: errorMessage(error) });
    }
  } else {
    try {
      market = new BinancePublicRestMarketAdapter({
        source: "BINANCE_TESTNET_REST",
        baseUrl: BINANCE_TESTNET_BASE_URL,
        clock,
        newId,
      });
      checks.push({
        name: "market_adapter",
        ok: true,
        detail: `Spot Testnet public reads (BINANCE_TESTNET_REST) at ${BINANCE_TESTNET_BASE_URL}; execution unqualified`,
      });
    } catch (error) {
      checks.push({ name: "market_adapter", ok: false, detail: errorMessage(error) });
    }
  }

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
  if (options.skipWriterLock) {
    checks.push({ name: "writer_lock", ok: true, detail: "not taken: auxiliary process" });
  } else {
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
  }

  if (migrationsOk && (writer !== null || options.skipWriterLock)) {
    try {
      const now = clock();
      if (options.skipAccountBoot) {
        account = await withClient(pool, (client) =>
          findAccountByAlias(client, config.environment, config.accountAlias),
        );
        checks.push({
          name: "account",
          ok: account !== null,
          detail:
            account === null
              ? "account does not exist yet; start the kernel first"
              : `${account.id} status=${account.status} epoch=${account.epoch} (loaded, not paused)`,
        });
      } else {
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
      }
      if (account !== null && !options.skipAccountBoot && execution !== null) {
        // Remainder of the restart protocol: reconcile by stable identity, invalidate stale authority.
        recovery = await recoverOnBoot(runtime(), now);
        checks.push({
          name: "recovery",
          ok: recovery.unknown.length === 0 && recovery.unsettled.length === 0,
          detail: `examined=${recovery.examined} reconciled=${recovery.reconciled.length} unsettled=${recovery.unsettled.length} unknown=${recovery.unknown.length} invalidated_proposals=${recovery.invalidated_proposals.length}`,
        });
      }
      if (account !== null) {
        const accountId = account.id;
        const counts = await withClient(pool, (client) => countOutstandingCommands(client, accountId));
        checks.push({
          name: "unresolved_commands",
          ok: counts.total === 0,
          detail: `armed=${counts.armed} unknown=${counts.unknown} accepted_unreconciled=${counts.accepted_unreconciled}`,
        });
      }
    } catch (error) {
      checks.push({ name: "account", ok: false, detail: errorMessage(error) });
    }
  } else {
    checks.push({ name: "account", ok: false, detail: "skipped: migrations or writer lock not ready" });
  }

  checks.push({
    name: "execution_adapter",
    ok: execution !== null,
    detail:
      config.environment === "TESTNET"
        ? "Binance Spot Testnet adapter is not qualified (P1); refusing to start execution"
        : execution === null
          ? "no execution adapter for this mode"
          : `paper executor (${config.environment === "REPLAY" ? "fixture book" : "live public book"}), venue journal ${
              options.paperVenueStore === undefined ? paperVenuePath(config) : "in memory"
            }; no external write path exists in this mode`,
  });

  return runtime();
}
