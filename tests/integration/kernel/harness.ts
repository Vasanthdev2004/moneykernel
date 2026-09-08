import { randomBytes } from "node:crypto";
import { dec, toDecimalString, ZERO } from "@moneykernel/domain";
import type { Scenario } from "@moneykernel/integrations";
import { createPool, listOutstandingReservations, migrate, withClient } from "@moneykernel/persistence";
import { expect } from "vitest";
import { buildApp } from "../../../apps/kernel/src/app.ts";
import { boot, type KernelRuntime } from "../../../apps/kernel/src/boot.ts";
import { loadConfig } from "../../../apps/kernel/src/config.ts";
import { type SeedResult, seedScenario } from "../../../apps/kernel/src/services/seed.ts";

export const DATABASE_URL_TEST =
  process.env.DATABASE_URL_TEST ?? "postgresql://moneykernel:LOCAL_DEV_ONLY@localhost:5432/moneykernel_test";

export const OPERATOR_SECRET = "integration-test-operator-secret";

export type Harness = {
  runtime: KernelRuntime;
  app: ReturnType<typeof buildApp>;
  seed: SeedResult;
  clock: { now: number };
  accountId: string;
  alias: string;
  /** Advances the virtual clock. */
  tick: (ms: number) => void;
};

export async function migrateTestDatabase(): Promise<void> {
  const pool = createPool(DATABASE_URL_TEST, { applicationName: "test-migrate" });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}

export async function startHarness(
  scenario: Scenario,
  fixtureId: string,
  options: { alias?: string; seed?: boolean } = {},
): Promise<Harness> {
  const alias = options.alias ?? `h-${randomBytes(3).toString("hex")}`;
  const clock = { now: Date.parse("2026-09-08T12:00:00Z") };
  const config = loadConfig({
    DATABASE_URL: DATABASE_URL_TEST,
    OPERATOR_BOOTSTRAP_SECRET: OPERATOR_SECRET,
    MONEYKERNEL_MODE: "REPLAY",
    MONEYKERNEL_ACCOUNT_ALIAS: alias,
    REPLAY_FIXTURE: fixtureId,
    LOG_LEVEL: "silent",
  });
  const runtime = await boot(config, { clock: () => new Date(clock.now) });
  const failed = runtime.bootChecks.filter((c) => !c.ok);
  if (failed.length > 0 || runtime.account === null) throw new Error(`boot not ready: ${JSON.stringify(failed)}`);
  const seed =
    options.seed === false
      ? { account_id: runtime.account.id, policy_version: 0, agents: [], symbols: [] }
      : await seedScenario(runtime, scenario, { operatorId: "test" });
  const app = buildApp(runtime);
  return { runtime, app, seed, clock, accountId: runtime.account.id, alias, tick: (ms) => (clock.now += ms) };
}

export async function stopHarness(h: Harness): Promise<void> {
  await h.app.close();
  await h.runtime.shutdown();
}

export async function operatorLogin(h: Harness, secret: string = OPERATOR_SECRET) {
  const res = await h.app.inject({ method: "POST", url: "/v1/auth/session", payload: { bootstrap_secret: secret } });
  return {
    status: res.statusCode,
    body: res.json() as { session_token?: string; csrf_token?: string },
    cookie: res.headers["set-cookie"],
  };
}

export async function operator(h: Harness): Promise<{ token: string; csrf: string; cookie: string }> {
  const login = await operatorLogin(h);
  expect(login.status).toBe(201);
  const token = login.body.session_token;
  const csrf = login.body.csrf_token;
  const setCookie = Array.isArray(login.cookie) ? login.cookie[0] : login.cookie;
  if (token === undefined || csrf === undefined || typeof setCookie !== "string")
    throw new Error("login did not return a session");
  return { token, csrf, cookie: setCookie.split(";")[0] ?? "" };
}

export async function opRequest(
  h: Harness,
  token: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await h.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  const text = res.body;
  return {
    status: res.statusCode,
    body: (text.length === 0 ? {} : JSON.parse(text)) as Record<string, unknown>,
    headers: res.headers,
  };
}

export async function agentContext(h: Harness, token: string) {
  const res = await h.app.inject({
    method: "GET",
    url: "/v1/agent/context",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    observations: Array<{ snapshot_id: string; symbol: string }>;
    lease: { lease_id: string } | null;
  };
}

export async function observationFor(h: Harness, token: string, symbol: string): Promise<string> {
  const ctx = await agentContext(h, token);
  const obs = ctx.observations.find((o) => o.symbol === symbol);
  if (obs === undefined) throw new Error(`no observation for ${symbol}`);
  return obs.snapshot_id;
}

export function buyIntent(
  leaseId: string,
  symbol: string,
  amount: string,
  limit: string,
  observationId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    schema_version: "1",
    lease_id: leaseId,
    symbol,
    side: "BUY",
    order_type: "LIMIT_IOC",
    size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount },
    limit_price: limit,
    observation_ids: [observationId],
    ...extra,
  };
}

export function sellIntent(
  leaseId: string,
  symbol: string,
  base: string,
  amount: string,
  limit: string,
  observationId: string,
) {
  return {
    schema_version: "1",
    lease_id: leaseId,
    symbol,
    side: "SELL",
    order_type: "LIMIT_IOC",
    size: { kind: "BASE_QUANTITY", base_asset: base, amount },
    limit_price: limit,
    observation_ids: [observationId],
  };
}

export async function submitIntent(h: Harness, token: string, key: string, body: unknown) {
  const res = await h.app.inject({
    method: "POST",
    url: "/v1/agent/intents",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": key, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

export async function sumReserved(
  h: Harness,
  kind: "QUOTE" | "BASE" | "ATTEMPT",
  agentId?: string,
  states: string[] = ["HELD", "ARMED"],
): Promise<string> {
  const pool = h.runtime.pool;
  if (pool === null) throw new Error("no pool");
  const rows = await withClient(pool, (c) => listOutstandingReservations(c, h.accountId));
  let total = ZERO;
  for (const r of rows) {
    if (r.kind !== kind || !states.includes(r.state)) continue;
    if (agentId !== undefined && r.agent_id !== agentId) continue;
    total = total.plus(dec(r.amount));
  }
  return toDecimalString(total);
}

export function seededAgent(h: Harness, fixtureAgentId: string) {
  const agent = h.seed.agents.find((a) => a.fixture_agent_id === fixtureAgentId);
  if (agent === undefined) throw new Error(`${fixtureAgentId} not seeded`);
  return agent;
}
