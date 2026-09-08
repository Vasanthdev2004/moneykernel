import { randomBytes } from "node:crypto";
import { loadScenario } from "@moneykernel/integrations";
import { createPool, migrate } from "@moneykernel/persistence";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/kernel/src/app.ts";
import { boot } from "../../../apps/kernel/src/boot.ts";
import { loadConfig } from "../../../apps/kernel/src/config.ts";
import { FIXTURES_DIR } from "../../../apps/kernel/src/fixtures.ts";
import { seedScenario } from "../../../apps/kernel/src/services/seed.ts";

const databaseUrl =
  process.env.DATABASE_URL_TEST ?? "postgresql://moneykernel:LOCAL_DEV_ONLY@localhost:5432/moneykernel_test";
const clock = () => new Date("2026-09-08T12:00:00Z");
const configuredProvider = {
  MODEL_PROVIDER: "anthropic",
  MODEL_ID: "synthetic-provenance-test-model",
  MODEL_API_KEY: "synthetic-no-call-key",
};

async function start(strategyKind: string, providerConfigured = false) {
  const env = {
    DATABASE_URL: databaseUrl,
    OPERATOR_BOOTSTRAP_SECRET: "synthetic-provenance-test-secret",
    MONEYKERNEL_ACCOUNT_ALIAS: `provenance-${randomBytes(5).toString("hex")}`,
    LOG_LEVEL: "silent",
    ...(providerConfigured ? configuredProvider : {}),
  };
  const runtime = await boot(loadConfig(env), { clock });
  try {
    const scenario = loadScenario("scenario-a-constrained-acquisition", FIXTURES_DIR);
    const fixtureAgent = scenario.agents[0];
    if (fixtureAgent === undefined) throw new Error("fixture agent missing");
    fixtureAgent.strategy_kind = strategyKind;
    const seeded = await seedScenario(runtime, scenario);
    const agent = seeded.agents[0];
    if (agent === undefined) throw new Error("seeded agent missing");
    return { env, runtime, app: buildApp(runtime), agent };
  } catch (error) {
    await runtime.shutdown();
    throw error;
  }
}

type Context = {
  provenance: { model_source: string };
  observations: Array<{ symbol: string; snapshot_id: string }>;
};

describe("strategy provenance is evidence-based and stable on replay (FR-11, T-57)", () => {
  beforeAll(async () => {
    const pool = createPool(databaseUrl);
    try {
      await migrate(pool);
    } finally {
      await pool.end();
    }
  });

  it("preserves SCRIPTED context and historical decisions after provider configuration changes", async () => {
    const h = await start("SCRIPTED");
    let { runtime, app } = h;
    const headers = { authorization: `Bearer ${h.agent.token}` };
    try {
      const context = await app.inject({ method: "GET", url: "/v1/agent/context", headers });
      expect(context.statusCode).toBe(200);
      const ctx = context.json<Context>();
      expect(ctx.provenance.model_source).toBe("SCRIPTED");
      const observation = ctx.observations.find((o) => o.symbol === "SOLUSDT");
      if (observation === undefined) throw new Error("SOL observation missing");
      const body = {
        schema_version: "1",
        lease_id: h.agent.lease_id,
        symbol: "SOLUSDT",
        side: "BUY",
        order_type: "LIMIT_IOC",
        size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "5" },
        limit_price: "100",
        observation_ids: [observation.snapshot_id],
        // A caller's run identifier is not proof that a model produced the request.
        strategy_run_id: "unverified_live_run",
      };
      const submission = {
        method: "POST" as const,
        url: "/v1/agent/intents",
        headers: { ...headers, "idempotency-key": "scripted-provenance-retry" },
        payload: body,
      };
      const first = await app.inject(submission);
      expect(first.statusCode).toBe(201);
      expect(first.json().outcome).toBe("ALLOW_PROPOSAL");
      expect(first.json().provenance.model_source).toBe("SCRIPTED");

      await app.close();
      await runtime.shutdown();
      runtime = await boot(loadConfig({ ...h.env, ...configuredProvider }), { clock });
      app = buildApp(runtime);

      const retried = await app.inject(submission);
      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toEqual(first.json());
      const read = await app.inject({
        method: "GET",
        url: `/v1/agent/intents/${first.json().intent_id}`,
        headers,
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().provenance.model_source).toBe("SCRIPTED");
      const restartedContext = await app.inject({ method: "GET", url: "/v1/agent/context", headers });
      expect(restartedContext.json<Context>().provenance.model_source).toBe("SCRIPTED");
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/session",
        payload: { bootstrap_secret: h.env.OPERATOR_BOOTSTRAP_SECRET },
      });
      expect(login.statusCode).toBe(201);
      const status = await app.inject({
        method: "GET",
        url: "/v1/status",
        headers: { authorization: `Bearer ${login.json().session_token}` },
      });
      expect(status.statusCode).toBe(200);
      expect(status.json().provenance.model_source).toBe("DISABLED");
      expect(status.json().integration.model.state).toBe("NOT_CONNECTED");
    } finally {
      await app.close();
      await runtime.shutdown();
    }
  });

  it.each(["RECORDED", "LIVE_PROVIDER", "UNKNOWN"])(
    "does not infer model evidence from the registered kind %s or provider configuration",
    async (strategyKind) => {
      const h = await start(strategyKind, true);
      try {
        const response = await h.app.inject({
          method: "GET",
          url: "/v1/agent/context",
          headers: { authorization: `Bearer ${h.agent.token}` },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json<Context>().provenance.model_source).toBe("DISABLED");
      } finally {
        await h.app.close();
        await h.runtime.shutdown();
      }
    },
  );
});
