import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/kernel/src/app.ts";
import { SessionStore } from "../../../apps/kernel/src/auth/operator.ts";
import type { KernelRuntime } from "../../../apps/kernel/src/boot.ts";
import { loadConfig } from "../../../apps/kernel/src/config.ts";

/** A runtime whose boot could not reach the database: liveness must still work, readiness must be truthful. */
function unreadyRuntime(overrides: NodeJS.ProcessEnv = {}): KernelRuntime {
  const config = loadConfig({
    DATABASE_URL: "postgresql://nobody:nothing@127.0.0.1:1/none",
    OPERATOR_BOOTSTRAP_SECRET: "unit-test-operator-secret-value-x",
    LOG_LEVEL: "silent",
    ...overrides,
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
      payload: { bootstrap_secret: "unit-test-operator-secret-value-x" },
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
    expect(big.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(typeof big.headers["x-request-id"]).toBe("string");
    await app.close();
  });

  it("protects operational metrics with a separate bearer token", async () => {
    const token = "unit-test-metrics-token-value-123456789";
    const app = buildApp(unreadyRuntime({ METRICS_BEARER_TOKEN: token }));
    await app.inject({ method: "GET", url: "/health/live" });

    const denied = await app.inject({ method: "GET", url: "/metrics" });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers["www-authenticate"]).toContain("Bearer");

    const metrics = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers["content-type"]).toContain("text/plain");
    expect(metrics.body).toContain("moneykernel_ready 0");
    expect(metrics.body).toContain('route="/health/live"');
    expect(metrics.body).not.toContain(token);
    await app.close();
  });

  it("serves the console in production and enforces the configured browser origin", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "moneykernel-web-"));
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>MoneyKernel production</title>");
    const app = buildApp(
      unreadyRuntime({
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        PUBLIC_ORIGIN: "https://moneykernel.example",
        METRICS_BEARER_TOKEN: "m".repeat(32),
      }),
      { webRoot },
    );
    try {
      const consolePage = await app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
      expect(consolePage.statusCode).toBe(200);
      expect(consolePage.body).toContain("MoneyKernel production");

      const ready = await app.inject({ method: "GET", url: "/health/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toEqual({ ready: false });

      const denied = await app.inject({
        method: "POST",
        url: "/v1/auth/session",
        headers: { origin: "https://attacker.example" },
        payload: { bootstrap_secret: "unit-test-operator-secret-value-x" },
      });
      expect(denied.statusCode).toBe(403);

      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/session",
        headers: { origin: "https://moneykernel.example" },
        payload: { bootstrap_secret: "unit-test-operator-secret-value-x" },
      });
      expect(login.statusCode).toBe(201);
      expect(login.headers["set-cookie"]).toContain("Secure");
    } finally {
      await app.close();
      await rm(webRoot, { recursive: true, force: true });
    }
  });
});
