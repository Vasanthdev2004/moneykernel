import { randomBytes } from "node:crypto";
import { loadScenario } from "@moneykernel/integrations";
import { createPool, lockAccountRow, migrate, upsertAssetBalance, withTransaction } from "@moneykernel/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/kernel/src/app.ts";
import { boot } from "../../../apps/kernel/src/boot.ts";
import { loadConfig } from "../../../apps/kernel/src/config.ts";
import { FIXTURES_DIR } from "../../../apps/kernel/src/fixtures.ts";
import { seedScenario } from "../../../apps/kernel/src/services/seed.ts";

const databaseUrl =
  process.env.DATABASE_URL_TEST ?? "postgresql://moneykernel:LOCAL_DEV_ONLY@localhost:5432/moneykernel_test";
const harnesses: Array<Awaited<ReturnType<typeof start>>> = [];

async function start(leaseDurationMs = 60_000) {
  const clock = { now: Date.parse("2026-09-08T12:00:00Z") };
  const runtime = await boot(
    loadConfig({
      DATABASE_URL: databaseUrl,
      MONEYKERNEL_ACCOUNT_ALIAS: `admission-safety-${randomBytes(5).toString("hex")}`,
      OPERATOR_BOOTSTRAP_SECRET: "synthetic-admission-safety-secret",
      LOG_LEVEL: "silent",
    }),
    { clock: () => new Date(clock.now) },
  );
  if (!runtime.pool || !runtime.account || !runtime.market) throw new Error("harness failed to boot");
  const scenario = loadScenario("scenario-a-constrained-acquisition", FIXTURES_DIR);
  scenario.account.balances = { USDT: "100" };
  scenario.account.inventory_allocations = {};
  scenario.policy = {
    ...scenario.policy,
    max_order_notional_quote: "1000",
    max_symbol_share: "1",
    min_quote_cash_buffer: "0",
    valuation_buffer_quote: "0",
  };
  const fixtureAgent = scenario.agents[0];
  if (!fixtureAgent) throw new Error("fixture has no agent");
  fixtureAgent.lease.acquisition_budget_quote = "1000";
  fixtureAgent.lease.max_submission_attempts = 10;
  const seeded = await seedScenario(runtime, scenario, { leaseDurationMs });
  const agent = seeded.agents[0];
  if (!agent) throw new Error("seed has no agent");
  const app = buildApp(runtime);
  const context = await app.inject({
    method: "GET",
    url: "/v1/agent/context",
    headers: { authorization: `Bearer ${agent.token}` },
  });
  expect(context.statusCode).toBe(200);
  const observation = context.json().observations.find((o: { symbol: string }) => o.symbol === "SOLUSDT");
  if (!observation) throw new Error("missing SOL observation");
  const body = {
    schema_version: "1",
    lease_id: agent.lease_id,
    symbol: "SOLUSDT",
    side: "BUY",
    order_type: "LIMIT_IOC",
    size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "10" },
    limit_price: "100",
    observation_ids: [observation.snapshot_id],
  };
  return { runtime, pool: runtime.pool, accountId: runtime.account.id, app, agent, body, clock };
}

async function harness(leaseDurationMs?: number) {
  const h = await start(leaseDurationMs);
  harnesses.push(h);
  return h;
}

async function submit(h: Awaited<ReturnType<typeof start>>, key: string, body: unknown = h.body) {
  return h.app.inject({
    method: "POST",
    url: "/v1/agent/intents",
    headers: {
      authorization: `Bearer ${h.agent.token}`,
      "idempotency-key": key,
      "content-type": "application/json",
    },
    payload: JSON.stringify(body),
  });
}

async function quoteHolds(h: Awaited<ReturnType<typeof start>>) {
  const result = await h.pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM reservations WHERE account_id = $1 AND kind = 'QUOTE'",
    [h.accountId],
  );
  return result.rows[0]?.n;
}

beforeAll(async () => {
  const pool = createPool(databaseUrl);
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
});

afterAll(async () => {
  for (const h of harnesses) {
    await h.app.close();
    await h.runtime.shutdown();
  }
});

describe("admission uses locked current state (INV-04/09/12/16)", () => {
  it("uses a balance debit committed during the external observation refresh", async () => {
    const h = await harness();
    const market = h.runtime.market;
    if (!market) throw new Error("no market");
    h.runtime.market = {
      source: market.source,
      discoverCapabilities: () => market.discoverCapabilities(),
      getSymbolRules: (symbol) => market.getSymbolRules(symbol),
      getSnapshot: async (symbol) => {
        await withTransaction(h.pool, async (tx) => {
          await lockAccountRow(tx, h.accountId);
          await upsertAssetBalance(tx, h.accountId, "USDT", "0");
        });
        return market.getSnapshot(symbol);
      },
    };
    const response = await submit(h, "balance-race-001");
    expect(response.statusCode).toBe(201);
    expect(response.json().outcome).toBe("DENY");
    expect(response.json().candidate).toBeNull();
    expect(await quoteHolds(h)).toBe(0);
  });

  it("does not omit a newly held asset from the valuation inside the lock", async () => {
    const h = await harness();
    const market = h.runtime.market;
    if (!market) throw new Error("no market");
    h.runtime.market = {
      source: market.source,
      discoverCapabilities: () => market.discoverCapabilities(),
      getSymbolRules: (symbol) => market.getSymbolRules(symbol),
      getSnapshot: async (symbol) => {
        await withTransaction(h.pool, async (tx) => {
          await lockAccountRow(tx, h.accountId);
          await upsertAssetBalance(tx, h.accountId, "XYZ", "1");
        });
        return market.getSnapshot(symbol);
      },
    };
    const response = await submit(h, "holdings-race-001");
    expect(response.statusCode).toBe(201);
    expect(response.json().outcome).toBe("DENY");
    expect(response.json().reason_codes).toContain("STALE_MARKET_DATA");
    expect(await quoteHolds(h)).toBe(0);
  });

  it("checks lease expiry using time after waiting for the account lock", async () => {
    const h = await harness(3_000);
    const blocker = await h.pool.connect();
    let pending: ReturnType<typeof submit> | undefined;
    try {
      await blocker.query("BEGIN");
      // Permit preflight snapshot FK checks, but block the admission's row lock.
      await blocker.query("SELECT * FROM accounts WHERE id = $1 FOR NO KEY UPDATE", [h.accountId]);
      const pid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      pending = submit(h, "lease-lock-wait-001");
      await expect
        .poll(
          async () => {
            const result = await h.pool.query<{ blocked: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                WHERE $1::int = ANY(pg_blocking_pids(pid))
                  AND query = 'SELECT * FROM accounts WHERE id = $1 FOR UPDATE') AS blocked`,
              [pid],
            );
            return result.rows[0]?.blocked;
          },
          { timeout: 5_000, interval: 20 },
        )
        .toBe(true);
      // The observation remains under the 5s age bound; only the 3s lease expires.
      h.clock.now += 4_000;
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    if (!pending) throw new Error("submission was not started");
    const response = await pending;
    expect(response.statusCode).toBe(201);
    expect(response.json().outcome).toBe("DENY");
    expect(response.json().reason_codes).toContain("LEASE_EXPIRED");
    expect(await quoteHolds(h)).toBe(0);
  });

  it("denies unavailable current symbol rules despite an older cached rules row", async () => {
    const h = await harness();
    const market = h.runtime.market;
    if (!market) throw new Error("no market");
    h.runtime.market = {
      source: market.source,
      discoverCapabilities: () => market.discoverCapabilities(),
      getSnapshot: (symbol) => market.getSnapshot(symbol),
      getSymbolRules: async () => {
        throw new Error("upstream capability/schema changed");
      },
    };
    const response = await submit(h, "rules-refresh-001");
    expect(response.statusCode).toBe(201);
    expect(response.json().outcome).toBe("DENY");
    expect(response.json().reason_codes).toContain("FILTER_UNSUPPORTED");
    expect(typeof response.json().receipt_id).toBe("string");
    expect(await quoteHolds(h)).toBe(0);
  });

  it.each(["OUTCOME_UNKNOWN", "ARMED", "ACCEPTED"])(
    "denies new authority while a %s command is outstanding even if the account is READY",
    async (state) => {
      const h = await harness();
      const first = await submit(h, "command-first-001");
      expect(first.statusCode).toBe(201);
      const proposalId = first.json().proposal_id;
      expect(typeof proposalId).toBe("string");
      await withTransaction(h.pool, async (tx) => {
        await lockAccountRow(tx, h.accountId);
        await tx.query(
          `INSERT INTO approvals (id, account_id, proposal_id, proposal_revision, proposal_hash,
             operator_id, account_epoch, expires_at, status, created_at)
           SELECT id, account_id, id, revision, proposal_hash, 'fixture', account_epoch,
                  expires_at, 'CONSUMED', created_at FROM proposals WHERE id = $1`,
          [proposalId],
        );
        await tx.query(
          `INSERT INTO commands (id, account_id, proposal_id, approval_id, client_order_id, state,
             exact_payload, armed_at, created_at, updated_at)
           SELECT id, account_id, id, id, id, $2, normalized_order, created_at, created_at, created_at
             FROM proposals WHERE id = $1`,
          [proposalId, state],
        );
      });
      const second = await submit(h, "command-second-001");
      expect(second.statusCode).toBe(201);
      expect(second.json().outcome).toBe("DENY");
      expect(second.json().reason_codes).toContain("OUTCOME_UNKNOWN");
      expect(await quoteHolds(h)).toBe(1);
      // Previously recorded requests remain readable/idempotent while blocked.
      const replay = await submit(h, "command-first-001");
      expect(replay.statusCode).toBe(200);
      expect(replay.json().receipt_id).toBe(first.json().receipt_id);
    },
  );

  it("records a below-tick valid BUY as a denial instead of an HTTP 500", async () => {
    const h = await harness();
    const response = await submit(h, "below-tick-001", { ...h.body, limit_price: "0.001" });
    expect(response.statusCode).toBe(201);
    expect(response.json().outcome).toBe("DENY");
    expect(typeof response.json().receipt_id).toBe("string");
    expect(await quoteHolds(h)).toBe(0);
  });
});
