import { randomBytes } from "node:crypto";
import { verifyEventChain } from "@moneykernel/contracts";
import { loadScenario, type Scenario } from "@moneykernel/integrations";
import { createPool, listAuditEvents, migrate, withClient } from "@moneykernel/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot, type KernelRuntime } from "../../../apps/kernel/src/boot.ts";
import { loadConfig } from "../../../apps/kernel/src/config.ts";
import { FIXTURES_DIR } from "../../../apps/kernel/src/fixtures.ts";
import { registerAgent, setVirtualBalances } from "../../../apps/kernel/src/services/registry.ts";
import { seedScenario } from "../../../apps/kernel/src/services/seed.ts";

const DATABASE_URL_TEST =
  process.env.DATABASE_URL_TEST ?? "postgresql://moneykernel:LOCAL_DEV_ONLY@localhost:5432/moneykernel_test";
const NOW = new Date("2026-09-08T12:00:00Z");
const runtimes: KernelRuntime[] = [];

function scenario(): Scenario {
  return loadScenario("scenario-b-opposing-intents", FIXTURES_DIR);
}

async function start(mode = "REPLAY"): Promise<KernelRuntime> {
  const runtime = await boot(
    loadConfig({
      DATABASE_URL: DATABASE_URL_TEST,
      OPERATOR_BOOTSTRAP_SECRET: "seed-safety-review-secret",
      MONEYKERNEL_MODE: mode,
      MONEYKERNEL_ACCOUNT_ALIAS: `seed-safety-${randomBytes(6).toString("hex")}`,
      REPLAY_FIXTURE: "scenario-b-opposing-intents",
      LOG_LEVEL: "silent",
      ...(mode === "TESTNET"
        ? { BINANCE_TESTNET_API_KEY: "test-placeholder", BINANCE_TESTNET_API_SECRET: "test-placeholder" }
        : {}),
    }),
    { clock: () => NOW },
  );
  runtimes.push(runtime);
  if (runtime.pool === null || runtime.account === null) throw new Error("seed test account unavailable");
  return runtime;
}

async function state(runtime: KernelRuntime) {
  if (runtime.pool === null || runtime.account === null) throw new Error("seed test account unavailable");
  const result = await runtime.pool.query(
    `SELECT
       (SELECT status FROM accounts WHERE id = $1) AS status,
       (SELECT COUNT(*)::int FROM agents WHERE account_id = $1) AS agents,
       (SELECT COUNT(*)::int FROM leases WHERE account_id = $1) AS leases,
       (SELECT COUNT(*)::int FROM policy_versions WHERE account_id = $1) AS policies,
       (SELECT COUNT(*)::int FROM snapshots WHERE account_id = $1) AS snapshots,
       (SELECT COUNT(*)::int FROM ledger_entries WHERE account_id = $1) AS ledger_entries,
       (SELECT COUNT(*)::int FROM audit_events WHERE account_id = $1) AS events,
       (SELECT SUM(owned_quantity)::text FROM asset_balances WHERE account_id = $1 AND asset = 'BTC') AS owned_btc,
       (SELECT SUM(owned_quantity)::text FROM inventory_allocations WHERE account_id = $1 AND asset = 'BTC') AS allocated_btc,
       (SELECT SUM(owned_quantity)::text FROM inventory_allocations WHERE account_id = $1 AND asset = 'USDT' AND agent_or_unassigned_id = 'UNASSIGNED') AS unassigned_usdt`,
    [runtime.account.id],
  );
  return result.rows[0];
}

beforeAll(async () => {
  const pool = createPool(DATABASE_URL_TEST);
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
});

afterAll(async () => {
  for (const runtime of runtimes) await runtime.shutdown();
});

describe("scenario initialization and inventory conservation", () => {
  it("records one conserved baseline, assigns the remainder, and keeps the audit chain valid", async () => {
    const runtime = await start();
    await seedScenario(runtime, scenario());
    expect(await state(runtime)).toMatchObject({
      status: "READY",
      agents: 2,
      leases: 2,
      policies: 1,
      ledger_entries: 2,
      owned_btc: "0.001000000000000000",
      allocated_btc: "0.001000000000000000",
      unassigned_usdt: "900.000000000000000000",
    });
    const pool = runtime.pool;
    const accountId = runtime.account?.id;
    if (pool === null || accountId === undefined) throw new Error("no account");
    const journals = await pool.query(
      "SELECT asset, signed_delta::text, category, source_ref, sequence::text FROM ledger_entries WHERE account_id = $1 ORDER BY sequence",
      [accountId],
    );
    expect(journals.rows.map(({ asset, signed_delta, category }) => ({ asset, signed_delta, category }))).toEqual([
      { asset: "BTC", signed_delta: "0.001000000000000000", category: "BASELINE" },
      { asset: "USDT", signed_delta: "900.000000000000000000", category: "BASELINE" },
    ]);
    const events = await withClient(pool, (tx) => listAuditEvents(tx, accountId));
    expect(verifyEventChain(events, null).ok).toBe(true);
    const assignment = events.find((event) => event.type === "INVENTORY_ASSIGNED");
    expect(assignment?.payload.baseline_ref).toBe(journals.rows[0]?.source_ref);
    expect(assignment?.payload.ledger_version).toBe(2);
  });

  it("refuses to seed again after restart without changing or resuming the existing run", async () => {
    const first = await start();
    await seedScenario(first, scenario());
    await first.shutdown();
    const restarted = await boot(first.config, { clock: () => NOW });
    runtimes.push(restarted);
    const before = await state(restarted);
    expect(before.status).toBe("PAUSED");
    await expect(seedScenario(restarted, scenario())).rejects.toThrow(/fresh account alias/);
    expect(await state(restarted)).toEqual(before);
  });

  it("allows exactly one concurrent seed to commit", async () => {
    const runtime = await start();
    const results = await Promise.allSettled([seedScenario(runtime, scenario()), seedScenario(runtime, scenario())]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await state(runtime)).toMatchObject({
      agents: 2,
      leases: 2,
      policies: 1,
      ledger_entries: 2,
      owned_btc: "0.001000000000000000",
      allocated_btc: "0.001000000000000000",
    });
  });

  it("rolls back the entire seed when assigned inventory exceeds owned inventory", async () => {
    const runtime = await start();
    const invalid = scenario();
    invalid.account.inventory_allocations = { agent_inventory_guard: { BTC: "0.002" } };
    const before = await state(runtime);
    await expect(seedScenario(runtime, invalid)).rejects.toThrow(/exceed owned BTC/);
    expect(await state(runtime)).toEqual(before);
    await seedScenario(runtime, scenario());
    expect((await state(runtime)).allocated_btc).toBe("0.001000000000000000");
  });

  it("rejects cross-account owners and unsupported precision before creating a baseline", async () => {
    const foreign = await start();
    const target = await start();
    if (foreign.pool === null || foreign.account === null || target.pool === null || target.account === null) {
      throw new Error("no account");
    }
    const { agent } = await registerAgent(
      foreign.pool,
      foreign.account.id,
      { name: "Foreign", strategyKind: "SCRIPTED" },
      NOW,
    );
    const before = await state(target);
    await expect(
      setVirtualBalances(
        target.pool,
        target.account.id,
        {
          balances: { BTC: "1" },
          allocations: { [agent.id]: { BTC: "1" } },
          operatorId: "test",
        },
        NOW,
      ),
    ).rejects.toThrow(/not bound/);
    await expect(
      setVirtualBalances(
        target.pool,
        target.account.id,
        {
          balances: { BTC: "0.0000000000000000001" },
          allocations: {},
          operatorId: "test",
        },
        NOW,
      ),
    ).rejects.toThrow(/fractional digits/);
    expect(await state(target)).toEqual(before);
  });

  it("refuses a second baseline and virtual funds on TESTNET", async () => {
    const runtime = await start();
    if (runtime.pool === null || runtime.account === null) throw new Error("no account");
    const input = { balances: { BTC: "0.1" }, allocations: {}, operatorId: "test" };
    await setVirtualBalances(runtime.pool, runtime.account.id, input, NOW);
    const before = await state(runtime);
    await expect(setVirtualBalances(runtime.pool, runtime.account.id, input, NOW)).rejects.toThrow(/already exists/);
    expect(await state(runtime)).toEqual(before);

    const testnet = await start("TESTNET");
    if (testnet.pool === null || testnet.account === null) throw new Error("no account");
    const beforeTestnet = await state(testnet);
    await expect(setVirtualBalances(testnet.pool, testnet.account.id, input, NOW)).rejects.toThrow(/TESTNET/);
    expect(await state(testnet)).toEqual(beforeTestnet);
  });

  it("refuses initial activation when readiness is blocked", async () => {
    const runtime = await start("SHADOW");
    const before = await state(runtime);
    await expect(seedScenario(runtime, scenario())).rejects.toThrow(/readiness/);
    expect(await state(runtime)).toEqual(before);
  });
});
