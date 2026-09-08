import type { FastifyInstance } from "fastify";
import type { KernelRuntime } from "../boot.ts";
import { computeReadiness } from "../readiness.ts";

export async function healthRoutes(app: FastifyInstance, options: { runtime: KernelRuntime }): Promise<void> {
  const { runtime } = options;

  /** Process is alive; no account details (prd.md 15.2). */
  app.get("/health/live", { config: { rateLimit: false } }, async () => ({
    status: "alive",
    server_time: runtime.clock().toISOString(),
  }));

  /** 200 only when every readiness check passes; otherwise 503 with the checks. */
  app.get("/health/ready", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (_request, reply) => {
    const readiness = await computeReadiness(runtime);
    reply.code(readiness.ready ? 200 : 503);
    return runtime.config.nodeEnv === "production" ? { ready: readiness.ready } : readiness;
  });
}
