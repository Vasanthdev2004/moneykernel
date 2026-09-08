import { errorEnvelope, IdSchema } from "@moneykernel/contracts";
import { getProposalById, withClient } from "@moneykernel/persistence";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOperator } from "../auth/operator.ts";
import type { KernelRuntime } from "../boot.ts";
import { clientOrderIdFor } from "../services/approvals.ts";

const DemoFaultSchema = z.strictObject({
  kind: z.literal("DROP_RESPONSE_AFTER_ACCEPT"),
  proposal_id: IdSchema,
});

/**
 * REPLAY-only synthetic fault scenarios for the recorded demo (prd.md 23.2 scene four, 27.4). The fault targets
 * the deterministic client order id a proposal would get when approved, so it can be armed before the operator
 * approves and no race with the dispatcher exists. Refused outside REPLAY: SHADOW and TESTNET venues are never
 * asked to misbehave, and no fault ever reaches an exchange.
 */
export async function demoRoutes(app: FastifyInstance, options: { runtime: KernelRuntime }): Promise<void> {
  const { runtime } = options;
  app.addHook("preHandler", requireOperator(runtime));

  app.post("/v1/demo/faults", async (request, reply) => {
    if (runtime.config.environment !== "REPLAY") {
      reply.code(403);
      return errorEnvelope("FORBIDDEN", "synthetic faults exist only in REPLAY", request.id);
    }
    if (runtime.pool === null || runtime.account === null) {
      reply.code(503);
      return errorEnvelope("NOT_READY", "kernel has no loaded account", request.id);
    }
    const parsed = DemoFaultSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return errorEnvelope("INVALID_SHAPE", "expected { kind, proposal_id }", request.id, parsed.error.issues);
    }
    const accountId = runtime.account.id;
    const proposal = await withClient(runtime.pool, (client) => getProposalById(client, parsed.data.proposal_id));
    if (proposal === null || proposal.account_id !== accountId) {
      reply.code(404);
      return errorEnvelope("NOT_FOUND", "proposal not found", request.id);
    }
    const clientOrderId = clientOrderIdFor(runtime.config.environment, accountId, proposal.id);
    runtime.paperFaults.dropResponseFor ??= new Set<string>();
    runtime.paperFaults.dropResponseFor.add(clientOrderId);
    reply.code(201);
    return {
      kind: parsed.data.kind,
      proposal_id: proposal.id,
      client_order_id: clientOrderId,
      note: "SYNTHETIC FAULT SCENARIO: the paper venue will accept and record this order, then drop the response.",
    };
  });
}
