import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { errorEnvelope } from "@moneykernel/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { KernelRuntime } from "../boot.ts";

export type OperatorSession = { token: string; csrf: string; operator_id: string; created_at: Date; expires_at: Date };

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES_PER_WINDOW = 5;
const FAILURE_WINDOW_MS = 60_000;

/**
 * Operator sessions (prd.md 18.2): the bootstrap secret is exchanged for a
 * short-lived server-side session. Sessions live in process memory; a restart
 * ends them, which is consistent with every restart pausing the account.
 */
export class SessionStore {
  private readonly sessions = new Map<string, OperatorSession>();
  private readonly failures = new Map<string, number[]>();

  create(operatorId: string, now: Date): OperatorSession {
    const session: OperatorSession = {
      token: `mko_${randomBytes(32).toString("base64url")}`,
      csrf: randomBytes(24).toString("base64url"),
      operator_id: operatorId,
      created_at: now,
      expires_at: new Date(now.getTime() + SESSION_TTL_MS),
    };
    this.sessions.set(session.token, session);
    return session;
  }

  get(token: string, now: Date): OperatorSession | null {
    const session = this.sessions.get(token);
    if (session === undefined) return null;
    if (session.expires_at.getTime() <= now.getTime()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  delete(token: string): void {
    this.sessions.delete(token);
  }

  /** Returns true when the caller may attempt a login; records the attempt window per client key. */
  allowAttempt(clientKey: string, now: Date): boolean {
    const recent = (this.failures.get(clientKey) ?? []).filter((t) => now.getTime() - t < FAILURE_WINDOW_MS);
    this.failures.set(clientKey, recent);
    return recent.length < MAX_FAILURES_PER_WINDOW;
  }

  recordFailure(clientKey: string, now: Date): void {
    const recent = (this.failures.get(clientKey) ?? []).filter((t) => now.getTime() - t < FAILURE_WINDOW_MS);
    recent.push(now.getTime());
    this.failures.set(clientKey, recent);
  }
}

export function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const SESSION_COOKIE = "mk_session";

export function sessionCookie(session: OperatorSession, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${session.token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Expires=${session.expires_at.toUTCString()}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Remote sessions may read and log out, but financial/product mutations require the explicit public setting. */
export function rejectPublicMutation(runtime: KernelRuntime, request: FastifyRequest, reply: FastifyReply): boolean {
  if (!MUTATING.has(request.method) || request.routeOptions.url === "/v1/auth/session") return false;
  const ip = request.ip.startsWith("::ffff:") ? request.ip.slice(7) : request.ip;
  const loopback = ip === "::1" || (isIP(ip) === 4 && ip.startsWith("127."));
  if (runtime.config.enablePublicMutations || loopback) return false;
  reply.code(403).send(errorEnvelope("FORBIDDEN", "public mutations are disabled for this kernel", request.id));
  return true;
}

function originAllowed(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== "string") return true;
  const host = request.headers.host;
  try {
    const url = new URL(origin);
    return typeof host === "string" && url.host === host;
  } catch {
    return false;
  }
}

/**
 * Operator authentication: a bearer session token (API clients) or the
 * session cookie plus a matching X-CSRF-Token header and same-origin check
 * (browser). Agents' tokens are a different scope and can never pass here.
 */
export function requireOperator(runtime: KernelRuntime) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const now = runtime.clock();
    let session: ReturnType<SessionStore["get"]> = null;
    let viaCookie = false;
    const auth = request.headers.authorization;
    const bearer = typeof auth === "string" ? /^Bearer\s+(mko_[A-Za-z0-9_-]+)$/.exec(auth)?.[1] : undefined;
    if (bearer !== undefined) session = runtime.sessions.get(bearer, now);
    if (session === null) {
      const cookie = cookieValue(request.headers.cookie, SESSION_COOKIE);
      if (cookie !== null) {
        session = runtime.sessions.get(cookie, now);
        viaCookie = true;
      }
    }
    if (session === null) {
      reply.code(401).send(errorEnvelope("UNAUTHENTICATED", "operator session required", request.id));
      return;
    }
    if (viaCookie && MUTATING.has(request.method)) {
      const csrf = request.headers["x-csrf-token"];
      if (csrf !== session.csrf || !originAllowed(request)) {
        reply.code(403).send(errorEnvelope("FORBIDDEN", "CSRF token or origin check failed", request.id));
        return;
      }
    }
    if (rejectPublicMutation(runtime, request, reply)) return;
    request.operator = { id: session.operator_id, token: session.token };
  };
}

declare module "fastify" {
  interface FastifyRequest {
    operator?: { id: string; token: string };
  }
}
