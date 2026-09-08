import { randomBytes } from "node:crypto";
import { createPool, migrate, type Pool, withTransaction } from "@moneykernel/persistence";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/kernel/src/app.ts";
import { boot, type KernelRuntime } from "../../../apps/kernel/src/boot.ts";
import { loadConfig } from "../../../apps/kernel/src/config.ts";
import { computeReadiness } from "../../../apps/kernel/src/readiness.ts";

const databaseUrl =
  process.env.DATABASE_URL_TEST ?? "postgresql://moneykernel:LOCAL_DEV_ONLY@localhost:5432/moneykernel_test";

function start(): Promise<KernelRuntime> {
  return boot(
    loadConfig({
      DATABASE_URL: databaseUrl,
      OPERATOR_BOOTSTRAP_SECRET: "synthetic-readiness-test-secret",
      MONEYKERNEL_ACCOUNT_ALIAS: `settlement-${randomBytes(5).toString("hex")}`,
      LOG_LEVEL: "silent",
    }),
  );
}

type OrderState = "NEW" | "PARTIALLY_FILLED" | "FILLED" | "EXPIRED" | null;

// Persist a known accepted command and its authority graph. A reconciliation
// marker in these fixtures represents a future reconciler's committed result;
// these tests prove readiness gates, not fill/fee accounting itself.
async function acceptedCommand(
  runtime: KernelRuntime,
  orderState: OrderState,
  reconciled = false,
  held = false,
): Promise<void> {
  const accountId = runtime.account?.id;
  if (!runtime.pool || !accountId) throw new Error("test account failed to boot");
  const id = `settlement_${randomBytes(5).toString("hex")}`;
  await withTransaction(runtime.pool, async (client) => {
    await client.query(
      `INSERT INTO agents (id, account_id, name, strategy_kind, status, revision, token_hash, created_at, updated_at)
       VALUES ($1, $2, 'Fixture', 'SCRIPTED', 'ACTIVE', 1, $1, now(), now())`,
      [id, accountId],
    );
    await client.query(
      `INSERT INTO leases (id, account_id, agent_id, revision, budget_quote, attempt_limit, starts_at, expires_at,
                           status, capability_json, created_at, updated_at)
       VALUES ($1, $2, $1, 1, 40, 1, now(), now() + interval '1 hour', 'ACTIVE', '{}', now(), now())`,
      [id, accountId],
    );
    await client.query(
      `INSERT INTO policy_versions (id, account_id, version, canonical_policy, hash, created_by, created_at)
       VALUES ($1, $2, 1, '{}', 'fixture', 'operator', now())`,
      [id, accountId],
    );
    await client.query(
      `INSERT INTO intents (id, account_id, agent_id, lease_id, idempotency_key, canonical_payload,
                            payload_hash, account_seq, created_at)
       VALUES ($1, $2, $1, $1, $1, '{}', 'fixture', 1, now())`,
      [id, accountId],
    );
    await client.query(
      `INSERT INTO proposals (id, intent_id, account_id, revision, normalized_order, proposal_hash, state,
                              expires_at, policy_id, lease_revision, account_epoch, created_at, updated_at)
       VALUES ($1, $1, $2, 1, '{}', 'fixture', 'COMMAND_CREATED', now() + interval '1 hour', $1, 1, 1, now(), now())`,
      [id, accountId],
    );
    await client.query(
      `INSERT INTO approvals (id, account_id, proposal_id, proposal_revision, proposal_hash, operator_id,
                              account_epoch, expires_at, status, created_at)
       VALUES ($1, $2, $1, 1, 'fixture', 'operator', 1, now() + interval '1 hour', 'CONSUMED', now())`,
      [id, accountId],
    );
    await client.query(
      `INSERT INTO commands (id, account_id, proposal_id, approval_id, client_order_id, state, exact_payload,
                             armed_at, reconciled_at, created_at, updated_at)
       VALUES ($1, $2, $1, $1, $1, 'ACCEPTED', '{}', now(), CASE WHEN $3 THEN now() ELSE NULL END, now(), now())`,
      [id, accountId, reconciled],
    );
    if (orderState !== null) {
      await client.query(
        `INSERT INTO orders (id, account_id, command_id, client_order_id, symbol, status,
                             executed_base, executed_quote, last_observed_at)
         VALUES ($1, $2, $1, $1, 'SOLUSDT', $3, '0.1', '10', now())`,
        [id, accountId, orderState],
      );
    }
    if (held) {
      await client.query(
        `INSERT INTO reservations (id, account_id, proposal_id, agent_id, asset, amount, kind, state, created_at)
         VALUES ($1, $2, $1, $1, 'USDT', '10', 'QUOTE', 'ARMED', now())`,
        [id, accountId],
      );
    }
  });
}

describe("accepted commands require reconciliation before readiness (INV-09, prd.md 11.6/11.8)", () => {
  beforeAll(async () => {
    const pool = createPool(databaseUrl);
    try {
      await migrate(pool);
    } finally {
      await pool.end();
    }
  });

  it.each([
    { state: "NEW" as OrderState, reconciled: false, held: false },
    { state: "PARTIALLY_FILLED" as OrderState, reconciled: false, held: false },
    { state: "FILLED" as OrderState, reconciled: false, held: false },
    { state: "EXPIRED" as OrderState, reconciled: false, held: false },
    { state: null as OrderState, reconciled: true, held: false },
    { state: "NEW" as OrderState, reconciled: true, held: false },
    { state: "FILLED" as OrderState, reconciled: true, held: true },
  ])("blocks $state with marker=$reconciled and hold=$held", async ({ state, reconciled, held }) => {
    const runtime = await start();
    const app = buildApp(runtime);
    try {
      await acceptedCommand(runtime, state, reconciled, held);
      const ready = await app.inject({ method: "GET", url: "/health/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().checks.find((c: { name: string }) => c.name === "unresolved_commands").ok).toBe(false);
      const status = await app.inject({ method: "GET", url: "/v1/status" });
      expect(status.statusCode).toBe(200);
      expect(status.json().in_flight_commands).toBe(1);
      expect(status.json().unresolved_commands).toBe(1);
      expect(status.json().account.status).toBe("PAUSED");
    } finally {
      await app.close();
      await runtime.shutdown();
    }
  });

  it("does not block a terminal, reconciled command without outstanding holds", async () => {
    const runtime = await start();
    try {
      await acceptedCommand(runtime, "FILLED", true);
      expect((await computeReadiness(runtime)).ready).toBe(true);
    } finally {
      await runtime.shutdown();
    }
  });

  it("retains the block after restart and in boot diagnostics", async () => {
    let runtime = await start();
    try {
      await acceptedCommand(runtime, "PARTIALLY_FILLED");
      const config = runtime.config;
      await runtime.shutdown();
      runtime = await boot(config);
      expect(runtime.bootChecks.find((c) => c.name === "unresolved_commands")?.ok).toBe(false);
      expect((await computeReadiness(runtime)).ready).toBe(false);
      expect(runtime.account?.status).toBe("PAUSED");
    } finally {
      await runtime.shutdown();
    }
  });

  it("unknown applied migrations prevent boot readiness and account initialization", async () => {
    const pool: Pool = createPool(databaseUrl);
    let runtime: KernelRuntime | undefined;
    try {
      await pool.query("INSERT INTO schema_migrations (version, name, checksum) VALUES (9999, 'future', 'fixture')");
      runtime = await start();
      expect(runtime.bootChecks.find((c) => c.name === "migrations")?.ok).toBe(false);
      expect(runtime.account).toBeNull();
      expect((await computeReadiness(runtime)).ready).toBe(false);
    } finally {
      if (runtime) await runtime.shutdown();
      await pool.query("DELETE FROM schema_migrations WHERE version = 9999");
      await pool.end();
    }
  });
});
