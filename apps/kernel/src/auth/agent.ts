import { errorEnvelope } from "@moneykernel/contracts";
import { type AgentRow, findAgentByTokenHash, withClient } from "@moneykernel/persistence";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { KernelRuntime } from "../boot.ts";
import { hashAgentToken } from "../services/registry.ts";
import { rejectPublicMutation } from "./operator.ts";

const BEARER_RE = /^Bearer\s+(mka_[A-Za-z0-9_-]{32,})$/;

/**
 * Agent identity is derived from the scoped bearer token and nothing else
 * (FR-01). The token never appears in logs; only its hash is looked up. An
 * agent bound to another account is treated as unknown.
 */
export async function authenticateAgent(runtime: KernelRuntime, request: FastifyRequest): Promise<AgentRow | null> {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = BEARER_RE.exec(header);
  const token = match?.[1];
  if (token === undefined || runtime.pool === null || runtime.account === null) return null;
  const hash = hashAgentToken(token);
  const agent = await withClient(runtime.pool, (client) => findAgentByTokenHash(client, hash));
  if (agent === null || agent.account_id !== runtime.account.id) return null;
  return agent;
}

export function requireAgent(runtime: KernelRuntime) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const agent = await authenticateAgent(runtime, request);
    if (agent === null) {
      reply.code(401).send(errorEnvelope("UNAUTHENTICATED", "missing or invalid agent token", request.id));
      return;
    }
    if (rejectPublicMutation(runtime, request, reply)) return;
    request.agent = agent;
  };
}

declare module "fastify" {
  interface FastifyRequest {
    agent?: AgentRow;
  }
}
