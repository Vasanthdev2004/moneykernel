import { fileURLToPath } from "node:url";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { type ErrorCode, errorEnvelope, MAX_INTENT_BODY_BYTES } from "@moneykernel/contracts";
import Fastify, { type FastifyError, type FastifyInstance, LogController } from "fastify";
import type { KernelRuntime } from "./boot.ts";
import { newId } from "./ids.ts";
import { agentRoutes } from "./routes/agent.ts";
import { consoleRoutes } from "./routes/console.ts";
import { demoRoutes } from "./routes/demo.ts";
import { exportRoutes } from "./routes/export.ts";
import { healthRoutes } from "./routes/health.ts";
import { registerMetrics } from "./routes/metrics.ts";
import { operatorRoutes } from "./routes/operator.ts";
import { operatorAuthRoutes } from "./routes/operator-auth.ts";
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

const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../web/dist/", import.meta.url));

export type BuildAppOptions = { webRoot?: string };

/** Builds the API and, in production, the same-origin operator console. */
export function buildApp(runtime: KernelRuntime, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: runtime.config.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers['x-csrf-token']",
          "res.headers['set-cookie']",
        ],
        censor: "[REDACTED]",
      },
    },
    bodyLimit: MAX_INTENT_BODY_BYTES,
    genReqId: () => newId("req"),
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: "request_id" }),
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
    keepAliveTimeout: 72_000,
    trustProxy: runtime.config.trustProxy,
  });

  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  app.register(rateLimit, {
    global: true,
    max: runtime.config.httpRateLimitPerMinute,
    timeWindow: 60_000,
    errorResponseBuilder: (request) =>
      errorEnvelope("RATE_LIMITED", "request rate limit exceeded; retry later", request.id),
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
    if (request.url.startsWith("/metrics") || request.url.startsWith("/v1/") || request.url.startsWith("/health/")) {
      reply.header("Cache-Control", "no-store");
    }
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;
    const code = codeForStatus(status, error.code);
    if (status >= 500) request.log.error({ err: error, request_id: request.id }, "unhandled error");
    const message = status >= 500 ? "internal error" : error.message;
    reply.code(status).send(errorEnvelope(code, message, request.id));
  });

  app.register(healthRoutes, { runtime });
  app.register(statusRoutes, { runtime });
  app.register(agentRoutes, { runtime });
  app.register(operatorAuthRoutes, { runtime });
  app.register(operatorRoutes, { runtime });
  app.register(consoleRoutes, { runtime });
  app.register(exportRoutes, { runtime });
  app.register(demoRoutes, { runtime });
  registerMetrics(app, runtime);

  if (runtime.config.nodeEnv === "production") {
    app.register(fastifyStatic, {
      root: options.webRoot ?? DEFAULT_WEB_ROOT,
      prefix: "/",
      wildcard: false,
      dotfiles: "deny",
      setHeaders: (reply, filePath) => {
        reply.header(
          "Cache-Control",
          filePath.includes("/assets/") || filePath.includes("\\assets\\")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const servesConsole =
      runtime.config.nodeEnv === "production" &&
      request.method === "GET" &&
      request.headers.accept?.includes("text/html") &&
      !request.url.startsWith("/v1/") &&
      !request.url.startsWith("/health/") &&
      request.url !== "/metrics";
    if (servesConsole) return reply.type("text/html").sendFile("index.html");
    return reply.code(404).send(errorEnvelope("NOT_FOUND", "unknown route", request.id));
  });
  return app;
}
