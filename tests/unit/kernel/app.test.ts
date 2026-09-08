import { describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/kernel/src/app.ts";
import { SessionStore } from "../../../apps/kernel/src/auth/operator.ts";
import type { KernelRuntime } from "../../../apps/kernel/src/boot.ts";
import { loadConfig } from "../../../apps/kernel/src/config.ts";

/** A runtime whose boot could not reach the database: liveness must still work, readiness must be truthful. */
function unreadyRuntime(): KernelRuntime {
  const config = loadConfig({
    DATABASE_URL: "postgresql://nobody:nothing@127.0.0.1:1/none",
    OPERATOR_BOOTSTRAP_SECRET: "unit-test-operator-secret-value",
    LOG_LEVEL: "silent",
  });
  return {
    config,
    pool: null,
    writer: null,
    account: null,
    market: null,
    execution: null,
    sessions: new SessionStore(),
    bootChecks: [
      { name: "configuration", ok: true, detail: "mode=REPLAY" },
      { name: "database", ok: false, detail: "connection refused" },
    ],
    reconciliation: new Map(),
    recovery: null,
    marketHealth: { last_successful_read_at: null, last_error: null },
    paperFaults: {},
    startedAt: new Date("2026-09-08T12:00:00Z"),
    clock: () => new Date("2026-09-08T12:00:00Z"),
    shutdown: async () => undefined,
  };
}

describe("kernel HTTP surface without a database (prd.md 19.5, 15.7)", () => {
  it("liveness answers while readiness and status fail closed", async () => {
    const app = buildApp(unreadyRuntime());
    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "alive", server_time: "2026-09-08T12:00:00.000Z" });

    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(503);
    const readiness = ready.json();
    expect(readiness.ready).toBe(false);
    expect(readiness.checks.find((c: { name: string }) => c.name === "database")?.ok).toBe(false);
    expect(readiness.checks.find((c: { name: string }) => c.name === "writer_lock")?.ok).toBe(false);

    const unauthenticated = await app.inject({ method: "GET", url: "/v1/status" });
    expect(unauthenticated.statusCode).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/session",
      payload: { bootstrap_secret: "unit-test-operator-secret-value" },
    });
    expect(login.statusCode).toBe(201);
    const token = login.json().session_token as string;
    const status = await app.inject({
      method: "GET",
      url: "/v1/status",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status.statusCode).toBe(503);
    expect(status.json().error.code).toBe("NOT_READY");
    expect(typeof status.json().error.request_id).toBe("string");
    await app.close();
  });

  it("unknown routes and oversized bodies use the error envelope", async () => {
    const app = buildApp(unreadyRuntime());
    const missing = await app.inject({ method: "GET", url: "/v1/does-not-exist" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("NOT_FOUND");

    const big = await app.inject({
      method: "POST",
      url: "/v1/status",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ pad: "x".repeat(20 * 1024) }),
    });
    expect([404, 413]).toContain(big.statusCode);
    expect(big.json().error.code).toMatch(/NOT_FOUND|INVALID_SHAPE/);
    expect(big.headers["x-content-type-options"]).toBe("nosniff");
    expect(big.headers["cache-control"]).toBe("no-store");
    await app.close();
  });
});
