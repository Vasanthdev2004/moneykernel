import { countOutstandingCommands, withClient } from "@moneykernel/persistence";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { secretsMatch } from "../auth/operator.ts";
import type { KernelRuntime } from "../boot.ts";
import { computeReadiness } from "../readiness.ts";

type HttpSample = { count: number; durationSeconds: number };

function label(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function metric(name: string, help: string, type: "counter" | "gauge", value: number): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${value}`];
}

/** Small bounded metrics registry. Route labels come from Fastify's route templates, never raw URLs. */
export function registerMetrics(app: FastifyInstance, runtime: KernelRuntime): void {
  const started = new WeakMap<FastifyRequest, bigint>();
  const samples = new Map<string, HttpSample>();

  app.addHook("onRequest", async (request) => {
    started.set(request, process.hrtime.bigint());
  });

  app.addHook("onResponse", async (request, reply) => {
    const start = started.get(request);
    if (start === undefined) return;
    const route = request.routeOptions.url ?? "unmatched";
    const key = JSON.stringify([request.method, route, reply.statusCode]);
    const sample = samples.get(key) ?? { count: 0, durationSeconds: 0 };
    sample.count += 1;
    sample.durationSeconds += Number(process.hrtime.bigint() - start) / 1_000_000_000;
    samples.set(key, sample);
  });

  app.get("/metrics", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const expected = runtime.config.metricsBearerToken;
    if (expected.length === 0) {
      reply.code(404);
      return "not found\n";
    }
    const provided = /^Bearer\s+(.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
    if (!secretsMatch(provided, expected)) {
      reply.header("WWW-Authenticate", 'Bearer realm="moneykernel-metrics"');
      reply.code(401);
      return "unauthorized\n";
    }

    const readiness = await computeReadiness(runtime);
    let outstanding = { armed: 0, unknown: 0, accepted_unreconciled: 0, total: 0 };
    if (runtime.pool !== null && runtime.account !== null) {
      try {
        outstanding = await withClient(runtime.pool, (client) =>
          countOutstandingCommands(client, runtime.account?.id ?? ""),
        );
      } catch (error) {
        request.log.warn({ err: error }, "metrics command query failed");
      }
    }

    const lines = [
      "# MoneyKernel operational metrics",
      "# HELP moneykernel_info Static kernel build information.",
      "# TYPE moneykernel_info gauge",
      `moneykernel_info{environment="${label(runtime.config.environment)}",engine_version="${label(runtime.config.engineVersion)}"} 1`,
      ...metric("moneykernel_ready", "Whether every readiness check passes.", "gauge", readiness.ready ? 1 : 0),
      ...metric(
        "moneykernel_in_flight_commands",
        "Commands whose external outcome or accounting is not settled.",
        "gauge",
        outstanding.total,
      ),
      ...metric(
        "moneykernel_unknown_commands",
        "Commands with an unknown external outcome.",
        "gauge",
        outstanding.unknown,
      ),
      ...metric(
        "moneykernel_accepted_unreconciled_commands",
        "Accepted commands that have not completed reconciliation.",
        "gauge",
        outstanding.accepted_unreconciled,
      ),
      ...metric("moneykernel_process_uptime_seconds", "Kernel process uptime.", "gauge", process.uptime()),
    ];

    const lastMarketRead = runtime.marketHealth.last_successful_read_at;
    lines.push(
      ...metric(
        "moneykernel_market_observation_available",
        "Whether at least one market observation has succeeded since boot.",
        "gauge",
        lastMarketRead === null ? 0 : 1,
      ),
    );
    if (lastMarketRead !== null) {
      const ageMilliseconds = Math.max(0, runtime.clock().getTime() - Date.parse(lastMarketRead));
      lines.push(
        ...metric(
          "moneykernel_market_snapshot_age_seconds",
          "Age of the most recent successful market observation.",
          "gauge",
          ageMilliseconds / 1000,
        ),
        ...metric(
          "moneykernel_snapshot_age_ms",
          "Age of the most recent successful market observation in milliseconds.",
          "gauge",
          ageMilliseconds,
        ),
      );
    }

    lines.push(
      "# HELP moneykernel_http_requests_total HTTP responses by method, route template, and status.",
      "# TYPE moneykernel_http_requests_total counter",
      "# HELP moneykernel_http_request_duration_seconds_sum Total response time by method and route template.",
      "# TYPE moneykernel_http_request_duration_seconds_sum counter",
    );
    for (const [key, sample] of [...samples.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [method, route, status] = JSON.parse(key) as [string, string, number];
      const labels = `method="${label(method)}",route="${label(route)}",status="${status}"`;
      lines.push(`moneykernel_http_requests_total{${labels}} ${sample.count}`);
      lines.push(`moneykernel_http_request_duration_seconds_sum{${labels}} ${sample.durationSeconds}`);
    }

    reply.type("text/plain; version=0.0.4; charset=utf-8");
    return `${lines.join("\n")}\n`;
  });
}
