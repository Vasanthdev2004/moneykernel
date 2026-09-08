import { randomBytes } from "node:crypto";
import { verifyEventChain } from "@moneykernel/contracts";
import { createPool, listAuditEvents, migrate, withClient } from "@moneykernel/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/kernel/src/app.ts";
import { boot, type KernelRuntime } from "../../../apps/kernel/src/boot.ts";
import { loadConfig } from "../../../apps/kernel/src/config.ts";

const DATABASE_URL_TEST =
  process.env.DATABASE_URL_TEST ?? "postgresql://moneykernel:LOCAL_DEV_ONLY@localhost:5432/moneykernel_test";

const alias = `boot-${randomBytes(4).toString("hex")}`;

function configFor(overrides: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: DATABASE_URL_TEST,
    OPERATOR_BOOTSTRAP_SECRET: "integration-test-operator-secret",
    MONEYKERNEL_MODE: "REPLAY",
    MONEYKERNEL_ACCOUNT_ALIAS: alias,
    LOG_LEVEL: "silent",
    ...overrides,
  });
}

describe("kernel boot in REPLAY (prd.md 11.8, G1 exit criterion)", () => {
  const runtimes: KernelRuntime[] = [];

  beforeAll(async () => {
    const pool = createPool(DATABASE_URL_TEST, { applicationName: "boot-test-migrate" });
    try {
      await migrate(pool);
    } finally {
      await pool.end();
    }
  });

  afterAll(async () => {
    for (const runtime of runtimes) await runtime.shutdown();
  });

  it("creates the account PAUSED at epoch 1, holds the writer lock, and reports ready", async () => {
    const runtime = await boot(configFor());
    runtimes.push(runtime);
    expect(runtime.account?.status).toBe("PAUSED");
    expect(runtime.account?.epoch).toBe(1);
    expect(runtime.account?.environment).toBe("REPLAY");
    expect(runtime.writer).not.toBeNull();
    const failed = runtime.bootChecks.filter((c) => !c.ok);
    expect(failed).toEqual([]);

    const app = buildApp(runtime);
    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/session",
      payload: { bootstrap_secret: "integration-test-operator-secret" },
    });
    expect(login.statusCode).toBe(201);
    const status = await app.inject({
      method: "GET",
      url: "/v1/status",
      headers: { authorization: `Bearer ${login.json().session_token}` },
    });
    expect(status.statusCode).toBe(200);
    const body = status.json();
    expect(body.mode).toBe("REPLAY");
    expect(body.account.status).toBe("PAUSED");
    expect(body.provenance.market_source).toBe("SYNTHETIC_FIXTURE");
    expect(body.provenance.execution_source).toBe("PAPER");
    expect(body.integration.agent_os_mcp.state).toBe("BLOCKED");
    const missing = await app.inject({ method: "GET", url: "/v1/nope" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("a second process cannot take the writer lock while the first holds it (no hot failover)", async () => {
    const second = await boot(configFor());
    runtimes.push(second);
    expect(second.writer).toBeNull();
    const lock = second.bootChecks.find((c) => c.name === "writer_lock");
    expect(lock?.ok).toBe(false);
    const app = buildApp(second);
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(503);
    await app.close();
  });

  it("a restart increments the control epoch and extends a valid audit chain", async () => {
    for (const runtime of runtimes.splice(0)) await runtime.shutdown();
    const restarted = await boot(configFor());
    runtimes.push(restarted);
    expect(restarted.account?.epoch).toBe(2);
    expect(restarted.account?.status).toBe("PAUSED");
    const accountId = restarted.account?.id;
    if (accountId === undefined || restarted.pool === null) throw new Error("no account after restart");
    const events = await withClient(restarted.pool, (client) => listAuditEvents(client, accountId));
    expect(events.map((e) => e.type)).toEqual(["ACCOUNT_CREATED", "ACCOUNT_BOOTED"]);
    expect(verifyEventChain(events, null)).toEqual({ ok: true, length: 2 });
  });

  it("refuses to be ready in TESTNET mode until the adapter is qualified", async () => {
    const runtime = await boot(
      configFor({ MONEYKERNEL_MODE: "TESTNET", BINANCE_TESTNET_API_KEY: "k", BINANCE_TESTNET_API_SECRET: "s" }),
    );
    runtimes.push(runtime);
    const adapter = runtime.bootChecks.find((c) => c.name === "execution_adapter");
    expect(adapter?.ok).toBe(false);
  });
});
