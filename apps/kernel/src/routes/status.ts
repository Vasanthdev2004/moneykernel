import {
  type ExecutionSource,
  errorEnvelope,
  type MarketSource,
  type ModelSource,
  type StatusResponse,
  StatusResponseSchema,
} from "@moneykernel/contracts";
import { countOutstandingCommands, getAccountById, withClient } from "@moneykernel/persistence";
import type { FastifyInstance } from "fastify";
import { requireOperator } from "../auth/operator.ts";
import type { KernelRuntime } from "../boot.ts";
import { computeReadiness } from "../readiness.ts";

function marketSourceFor(runtime: KernelRuntime): MarketSource {
  switch (runtime.config.environment) {
    case "REPLAY":
      return "SYNTHETIC_FIXTURE";
    case "SHADOW":
      return "BINANCE_PUBLIC_REST";
    case "TESTNET":
      return "BINANCE_TESTNET_REST";
  }
}

function executionSourceFor(runtime: KernelRuntime): ExecutionSource {
  return runtime.config.environment === "TESTNET" ? "BINANCE_TESTNET" : "PAPER";
}

function marketDataStatus(runtime: KernelRuntime): StatusResponse["integration"]["market_data"] {
  const env = runtime.config.environment;
  const health = runtime.marketHealth;
  if (env === "REPLAY") {
    return {
      state: "NOT_CONFIGURED",
      detail: "REPLAY uses synthetic or archived fixtures; no live market connection by design",
      last_successful_read_at: health.last_successful_read_at,
    };
  }
  if (runtime.market === null)
    return { state: "NOT_CONNECTED", detail: "no market adapter", last_successful_read_at: null };
  if (health.last_successful_read_at === null) {
    return {
      state: "NOT_CONNECTED",
      detail: health.last_error === null ? "no read attempted yet" : `last read failed: ${health.last_error}`,
      last_successful_read_at: null,
    };
  }
  const stale = runtime.clock().getTime() - Date.parse(health.last_successful_read_at) > 60_000;
  return {
    state: stale || health.last_error !== null ? "DEGRADED" : "CONNECTED",
    detail: `${env === "SHADOW" ? "Binance public REST" : "Spot Testnet public REST"} reads, labelled ${marketSourceFor(runtime)}${
      health.last_error === null ? "" : `; last error: ${health.last_error}`
    }`,
    last_successful_read_at: health.last_successful_read_at,
  };
}

function modelSourceFor(): ModelSource {
  // Provider configuration is not evidence of a model invocation. G2 has no model runner.
  return "DISABLED";
}

export async function statusRoutes(app: FastifyInstance, options: { runtime: KernelRuntime }): Promise<void> {
  const { runtime } = options;

  /** Current mode, account state, in-flight commands, provenance, integration truth (prd.md 15.2, FR-11). */
  app.get("/v1/status", { preHandler: requireOperator(runtime) }, async (request, reply) => {
    const readiness = await computeReadiness(runtime);
    if (runtime.pool === null || runtime.account === null) {
      reply.code(503);
      return errorEnvelope("NOT_READY", "kernel has no loaded account; see /health/ready", request.id, readiness);
    }
    const pool = runtime.pool;
    const accountId = runtime.account.id;
    const { account, counts } = await withClient(pool, async (client) => ({
      account: await getAccountById(client, accountId),
      counts: await countOutstandingCommands(client, accountId),
    }));
    if (account === null) {
      reply.code(503);
      return errorEnvelope("NOT_READY", "account row disappeared", request.id);
    }
    const env = runtime.config.environment;
    const modelDisabled = runtime.config.modelProvider === "disabled";

    const body: StatusResponse = {
      service: "moneykernel",
      engine_version: runtime.config.engineVersion,
      server_time: runtime.clock().toISOString(),
      mode: env,
      account: {
        id: account.id,
        alias: account.alias,
        environment: account.environment,
        status: account.status,
        epoch: account.epoch,
        quote_asset: account.quote_asset,
      },
      in_flight_commands: counts.total,
      unresolved_commands: counts.unknown + counts.accepted_unreconciled,
      provenance: {
        execution_mode: env,
        market_source: marketSourceFor(runtime),
        model_source: modelSourceFor(),
        execution_source: executionSourceFor(runtime),
      },
      integration: {
        agent_os_mcp: {
          state: "BLOCKED",
          detail:
            "Binance authorization server refuses non-allowlisted agents (Gate 0). No backend-owned Agent OS session exists; supported-agent relay pending.",
          last_successful_read_at: null,
        },
        market_data: marketDataStatus(runtime),
        execution: {
          state: env === "TESTNET" ? "BLOCKED" : runtime.execution === null ? "NOT_CONNECTED" : "CONNECTED",
          detail:
            env === "TESTNET"
              ? "Testnet execution unqualified (P1); no order write path"
              : runtime.execution === null
                ? "no execution adapter"
                : `paper executor over the ${env === "REPLAY" ? "fixture" : "live public"} book; virtual fills only, no external write path`,
          last_successful_read_at: null,
        },
        model: {
          state: modelDisabled ? "NOT_CONFIGURED" : "NOT_CONNECTED",
          detail: modelDisabled
            ? "MODEL_PROVIDER=disabled in the kernel; proposals arrive through the agent API (scripted, recorded, live provider, or supported agent session) and are labelled per agent strategy kind"
            : `${runtime.config.modelProvider} provider configured for the strategy runner; the kernel itself never calls a model`,
          last_successful_read_at: null,
        },
      },
      readiness,
    };
    // Self-check against the frozen contract before sending.
    return StatusResponseSchema.parse(body);
  });
}
