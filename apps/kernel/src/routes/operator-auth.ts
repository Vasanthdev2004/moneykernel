import { errorEnvelope, OperatorLoginSchema } from "@moneykernel/contracts";
import type { FastifyInstance } from "fastify";
import { clearSessionCookie, requireOperator, secretsMatch, sessionCookie } from "../auth/operator.ts";
import type { KernelRuntime } from "../boot.ts";

/** POST/DELETE /v1/auth/session (prd.md 15.2, 18.2). */
export async function operatorAuthRoutes(app: FastifyInstance, options: { runtime: KernelRuntime }): Promise<void> {
  const { runtime } = options;

  app.post("/v1/auth/session", async (request, reply) => {
    const now = runtime.clock();
    const clientKey = request.ip;
    if (!runtime.sessions.allowAttempt(clientKey, now)) {
      reply.code(429);
      return errorEnvelope("RATE_LIMITED", "too many login attempts; wait a minute", request.id);
    }
    const parsed = OperatorLoginSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return errorEnvelope("INVALID_SHAPE", "expected { bootstrap_secret }", request.id);
    }
    if (!secretsMatch(parsed.data.bootstrap_secret, runtime.config.operatorBootstrapSecret)) {
      runtime.sessions.recordFailure(clientKey, now);
      reply.code(401);
      return errorEnvelope("UNAUTHENTICATED", "invalid operator secret", request.id);
    }
    const session = runtime.sessions.create("operator", now);
    const loopback = ["127.0.0.1", "::1", "localhost"].includes(runtime.config.host);
    reply.header("Set-Cookie", sessionCookie(session, !loopback || runtime.config.nodeEnv === "production"));
    reply.code(201);
    return {
      session_token: session.token,
      csrf_token: session.csrf,
      operator_id: session.operator_id,
      expires_at: session.expires_at.toISOString(),
      note: "Use the bearer token for API clients, or the cookie plus X-CSRF-Token for browsers.",
    };
  });

  app.delete("/v1/auth/session", { preHandler: requireOperator(runtime) }, async (request, reply) => {
    if (request.operator !== undefined) runtime.sessions.delete(request.operator.token);
    reply.header("Set-Cookie", clearSessionCookie());
    reply.code(204);
    return null;
  });
}
