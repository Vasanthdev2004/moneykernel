import { type ErrorCode, errorEnvelope, MAX_INTENT_BODY_BYTES } from "@moneykernel/contracts";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { KernelRuntime } from "./boot.ts";
import { newId } from "./ids.ts";
import { healthRoutes } from "./routes/health.ts";
import { statusRoutes } from "./routes/status.ts";

function codeForStatus(status: number, fastifyCode: string | undefined): ErrorCode {
  if (fastifyCode === "FST_ERR_CTP_INVALID_JSON_BODY" || fastifyCode === "FST_ERR_CTP_EMPTY_JSON_BODY")
    return "INVALID_JSON";
  switch (status) {
    case 400:
    case 413:
    case 415:
      return "INVALID_SHAPE";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "STATE_CONFLICT";
    case 422:
      return "INVALID_FINANCIAL_VALUE";
    case 429:
      return "RATE_LIMITED";
    case 503:
      return "NOT_READY";
    default:
      return "INTERNAL";
  }
}

/** Builds the HTTP application. Every response is JSON; errors use the contracts envelope (prd.md 15.7). */
export function buildApp(runtime: KernelRuntime): FastifyInstance {
  const app = Fastify({
    logger: { level: runtime.config.logLevel },
    bodyLimit: MAX_INTENT_BODY_BYTES,
    genReqId: () => newId("req"),
    requestIdHeader: false,
    trustProxy: false,
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;
    const code = codeForStatus(status, error.code);
    if (status >= 500) request.log.error({ err: error, request_id: request.id }, "unhandled error");
    const message = status >= 500 ? "internal error" : error.message;
    reply.code(status).send(errorEnvelope(code, message, request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(errorEnvelope("NOT_FOUND", "unknown route", request.id));
  });

  app.register(healthRoutes, { runtime });
  app.register(statusRoutes, { runtime });
  return app;
}
