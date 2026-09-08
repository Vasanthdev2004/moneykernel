import {
  ApprovalRequestSchema,
  ConflictResolutionRequestSchema,
  type ErrorCode,
  errorEnvelope,
  hashCanonical,
  IdempotencyKeySchema,
  InventoryAssignmentRequestSchema,
  IssueLeaseRequestSchema,
  LeaseCapabilitiesSchema,
  PolicySchema,
  RegisterAgentRequestSchema,
  RejectProposalRequestSchema,
  ResumeRequestSchema,
  StopRequestSchema,
} from "@moneykernel/contracts";
import { dec, eq, toDecimalString, ZERO } from "@moneykernel/domain";
import {
  appendAuditEvent,
  claimOperatorRequest,
  completeOperatorRequest,
  countOutstandingCommands,
  findActiveLeaseForAgent,
  getCurrentPolicy,
  getIntentById,
  getLeaseById,
  listAgents,
  listAssetBalances,
  listCommands,
  listConflictMembers,
  listConflicts,
  listIncidents,
  listInventoryAllocations,
  listLeases,
  listPreArmProposals,
  listPreArmProposalsForAgent,
  lockAccountRow,
  lockAgentRow,
  setLeaseStatus,
  sumReservedBase,
  UNASSIGNED_OWNER,
  upsertInventoryAllocation,
  withClient,
  withTransaction,
} from "@moneykernel/persistence";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireOperator } from "../auth/operator.ts";
import type { KernelRuntime } from "../boot.ts";
import { newId } from "../ids.ts";
import { resumeAccount, stopAccount } from "../services/account-control.ts";
import { approveProposal } from "../services/approvals.ts";
import { endProposalInTx, rejectProposal, resolveConflictRequest } from "../services/proposals.ts";
import { quarantineAgentInTx } from "../services/quarantine.ts";
import { issueLease, LeaseConflictError, registerAgent, setPolicy } from "../services/registry.ts";

type ServiceError = Error & { code: ErrorCode; status: number; details?: unknown; reasonCodes?: string[] };

function isServiceError(error: unknown): error is ServiceError {
  return (
    error instanceof Error &&
    typeof (error as ServiceError).code === "string" &&
    typeof (error as ServiceError).status === "number"
  );
}

function sendServiceError(request: FastifyRequest, reply: FastifyReply, error: ServiceError) {
  reply.code(error.status);
  const details =
    error.reasonCodes !== undefined
      ? { reason_codes: error.reasonCodes, ...(error.details === undefined ? {} : { details: error.details }) }
      : error.details;
  return errorEnvelope(error.code, error.message, request.id, details);
}

function idempotencyKeyOf(request: FastifyRequest): string | null {
  const header = request.headers["idempotency-key"];
  const parsed = IdempotencyKeySchema.safeParse(Array.isArray(header) ? header[0] : header);
  return parsed.success ? parsed.data : null;
}

/**
 * Operator API (prd.md 15.2, 18.1). Every handler runs behind operator
 * session auth. Mutations that the PRD lists as idempotent require an
 * Idempotency-Key. Durable claims bind each key to its request, and completed
 * results replay across restarts. Unresolved claims never rerun automatically.
 */
export async function operatorRoutes(app: FastifyInstance, options: { runtime: KernelRuntime }): Promise<void> {
  const { runtime } = options;
  app.addHook("preHandler", requireOperator(runtime));

  const requireRuntime = (reply: FastifyReply, request: FastifyRequest) => {
    if (runtime.pool === null || runtime.account === null) {
      reply.code(503);
      return errorEnvelope("NOT_READY", "kernel has no loaded account", request.id);
    }
    return null;
  };

  async function idempotent(
    request: FastifyRequest,
    reply: FastifyReply,
    scope: string,
    run: () => Promise<{ status: number; body: unknown }>,
  ) {
    const key = idempotencyKeyOf(request);
    if (key === null) {
      reply.code(400);
      return errorEnvelope(
        "INVALID_SHAPE",
        "Idempotency-Key header is required (8-128 chars of [A-Za-z0-9_.:-])",
        request.id,
      );
    }
    const pool = runtime.pool;
    const account = runtime.account;
    if (pool === null || account === null) {
      reply.code(503);
      return errorEnvelope("NOT_READY", "kernel has no loaded account", request.id);
    }
    const identity = { accountId: account.id, operatorId: request.operator?.id ?? "operator", scope, key };
    const payloadHash = hashCanonical({
      method: request.method,
      scope,
      params: { ...(request.params as Record<string, unknown>) },
      body: request.body ?? {},
    });
    const claim = await claimOperatorRequest(pool, { ...identity, payloadHash, now: runtime.clock() });
    if (claim.request.payload_hash !== payloadHash) {
      reply.code(409);
      return errorEnvelope("IDEMPOTENCY_KEY_REUSED", "idempotency key was used with a different request", request.id);
    }
    if (!claim.claimed) {
      if (claim.request.state === "PENDING") {
        reply.code(409);
        return errorEnvelope(
          "STATE_CONFLICT",
          "operator request is pending or its outcome is unresolved; inspect the account before taking further action",
          request.id,
          { request_state: "PENDING" },
        );
      }
      if (claim.request.response_status === null) throw new Error("completed operator request has no response");
      reply.code(claim.request.response_status);
      reply.header("Idempotent-Replayed", "true");
      return claim.request.response_body;
    }
    let result: { status: number; body: unknown };
    try {
      result = await run();
    } catch (error) {
      if (!isServiceError(error)) throw error; // Keep the durable claim PENDING when completion is uncertain.
      result = { status: error.status, body: sendServiceError(request, reply, error) };
    }
    await completeOperatorRequest(pool, { ...identity, payloadHash, ...result, now: runtime.clock() });
    reply.code(result.status);
    return result.body;
  }

  // --- agents ---------------------------------------------------------------
  app.get("/v1/agents", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null || runtime.pool === null || runtime.account === null) return blocked;
    const accountId = runtime.account.id;
    return withClient(runtime.pool, async (client) => {
      const agents = await listAgents(client, accountId);
      const out = [];
      for (const agent of agents) {
        const lease = await findActiveLeaseForAgent(client, accountId, agent.id);
        const holdings = await listInventoryAllocations(client, accountId, agent.id);
        out.push({
          id: agent.id,
          name: agent.name,
          strategy_kind: agent.strategy_kind,
          status: agent.status,
          revision: agent.revision,
          active_lease:
            lease === null
              ? null
              : {
                  lease_id: lease.id,
                  revision: lease.revision,
                  acquisition_budget_quote: lease.budget_quote,
                  consumed_quote: lease.consumed_quote,
                  max_submission_attempts: lease.attempt_limit,
                  attempts_consumed: lease.attempts_consumed,
                  starts_at: lease.starts_at.toISOString(),
                  expires_at: lease.expires_at.toISOString(),
                  ...lease.capability_json,
                },
          holdings: holdings.map((h) => ({ asset: h.asset, quantity: h.owned_quantity })),
        });
      }
      return { agents: out };
    });
  });

  app.post("/v1/agents", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null || runtime.pool === null || runtime.account === null) return blocked;
    const parsed = RegisterAgentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return errorEnvelope("INVALID_SHAPE", "invalid agent registration", request.id, parsed.error.issues);
    }
    const { agent, token } = await registerAgent(
      runtime.pool,
      runtime.account.id,
      { name: parsed.data.name, strategyKind: parsed.data.strategy_kind },
      runtime.clock(),
    );
    reply.code(201);
    return {
      agent: {
        id: agent.id,
        name: agent.name,
        strategy_kind: agent.strategy_kind,
        status: agent.status,
        revision: agent.revision,
      },
      token,
      note: "The token is shown once and stored only as a hash.",
    };
  });

  app.post("/v1/agents/:id/quarantine", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null || runtime.pool === null || runtime.account === null) return blocked;
    const { id } = request.params as { id: string };
    const accountId = runtime.account.id;
    const operatorId = request.operator?.id ?? "operator";
    const now = runtime.clock();
    const result = await withTransaction(runtime.pool, async (tx) => {
      await lockAccountRow(tx, accountId);
      const agent = await lockAgentRow(tx, id);
      if (agent === null || agent.account_id !== accountId) return null;
      if (agent.status === "QUARANTINED")
        return {
          already: true,
          agent,
          invalidated_proposals: [] as string[],
          released_reservations: 0,
          incident_id: null as string | null,
        };
      const q = await quarantineAgentInTx(tx, {
        accountId,
        agent,
        trigger: "OPERATOR",
        evidence: { operator_id: operatorId },
        operatorId,
        now,
      });
      return { already: false, ...q };
    });
    if (result === null) {
      reply.code(404);
      return errorEnvelope("NOT_FOUND", "agent not found", request.id);
    }
    reply.code(result.already ? 200 : 201);
    return {
      agent_id: result.agent.id,
      status: result.agent.status,
      revision: result.agent.revision,
      invalidated_proposals: result.invalidated_proposals,
      released_reservations: result.released_reservations,
      incident_id: result.incident_id,
      note: "New authority blocked. Armed or unknown commands keep their reservations until reconciled. Holdings are unchanged.",
    };
  });

  // --- leases -----------------------------------------------------------------
  app.get("/v1/leases", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null || runtime.pool === null || runtime.account === null) return blocked;
    const accountId = runtime.account.id;
    const leases = await withClient(runtime.pool, (client) => listLeases(client, accountId));
    return {
      leases: leases.map((l) => ({
        lease_id: l.id,
        agent_id: l.agent_id,
        revision: l.revision,
        status: l.status,
        acquisition_budget_quote: l.budget_quote,
        consumed_quote: l.consumed_quote,
        max_submission_attempts: l.attempt_limit,
        attempts_consumed: l.attempts_consumed,
        starts_at: l.starts_at.toISOString(),
        expires_at: l.expires_at.toISOString(),
        ...l.capability_json,
      })),
    };
  });

  app.post("/v1/leases", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null || runtime.pool === null || runtime.account === null) return blocked;
    const parsed = IssueLeaseRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return errorEnvelope("INVALID_SHAPE", "invalid lease request", request.id, parsed.error.issues);
    }
    const now = runtime.clock();
    const startsAt = parsed.data.starts_at === undefined ? now : new Date(parsed.data.starts_at);
    const expiresAt = new Date(parsed.data.expires_at);
    if (expiresAt.getTime() <= startsAt.getTime() || expiresAt.getTime() <= now.getTime()) {
      reply.code(422);
      return errorEnvelope("INVALID_FINANCIAL_VALUE", "lease must expire after it starts and after now", request.id);
    }
    try {
      const lease = await issueLease(
        runtime.pool,
        runtime.account.id,
        {
          agentId: parsed.data.agent_id,
          budgetQuote: parsed.data.acquisition_budget_quote,
          attemptLimit: parsed.data.max_submission_attempts,
          startsAt,
          expiresAt,
          capabilities: LeaseCapabilitiesSchema.parse({
            allowed_symbols: parsed.data.allowed_symbols,
            allowed_sides: parsed.data.allowed_sides,
            allowed_order_types: parsed.data.allowed_order_types,
          }),
        },
        now,
      );
      reply.code(201);
      return {
        lease_id: lease.id,
        agent_id: lease.agent_id,
        revision: lease.revision,
        status: lease.status,
        starts_at: lease.starts_at.toISOString(),
        expires_at: lease.expires_at.toISOString(),
      };
    } catch (error) {
      if (error instanceof LeaseConflictError) {
        reply.code(409);
        return errorEnvelope("STATE_CONFLICT", error.message, request.id);
      }
      if (isServiceError(error)) return sendServiceError(request, reply, error);
      if (error instanceof Error && /foreign key/i.test(error.message)) {
        reply.code(404);
        return errorEnvelope("NOT_FOUND", "agent not found", request.id);
      }
      throw error;
    }
  });

  app.post("/v1/leases/:id/revoke", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null || runtime.pool === null || runtime.account === null) return blocked;
    const { id } = request.params as { id: string };
    const accountId = runtime.account.id;
    const now = runtime.clock();
    const operatorId = request.operator?.id ?? "operator";
    const result = await withTransaction(runtime.pool, async (tx) => {
      await lockAccountRow(tx, accountId);
      const lease = await getLeaseById(tx, id, { lock: true });
      if (lease === null || lease.account_id !== accountId) return null;
      if (lease.status !== "ACTIVE") return { lease, ended: [] as string[], already: true };
      const revoked = await setLeaseStatus(tx, lease.id, "REVOKED", now);
      const ended: string[] = [];
      for (const proposal of await listPreArmProposalsForAgent(tx, accountId, lease.agent_id)) {
        const intent = await getIntentById(tx, proposal.intent_id);
        if (intent?.lease_id !== lease.id) continue;
        await endProposalInTx(tx, runtime, proposal, "INVALIDATED", "lease revoked", now, {
          lease_id: lease.id,
          operator_id: operatorId,
        });
        ended.push(proposal.id);
      }
      await appendAuditEvent(tx, {
        id: newId("evt"),
        accountId,
        type: "LEASE_REVOKED",
        payload: {
          lease_id: lease.id,
          agent_id: lease.agent_id,
          revision: revoked.revision,
          operator_id: operatorId,
          invalidated_proposals: ended,
          consumed_quote_retained: revoked.consumed_quote,
        },
        occurredAt: now,
      });
      return { lease: revoked, ended, already: false };
    });
    if (result === null) {
      reply.code(404);
      return errorEnvelope("NOT_FOUND", "lease not found", request.id);
    }
    reply.code(result.already ? 200 : 201);
    return {
      lease_id: result.lease.id,
      status: result.lease.status,
      revision: result.lease.revision,
      invalidated_proposals: result.ended,
      note: "Revocation blocks new dispatch authority. Consumed budget and history are kept; armed commands are not undone.",
    };
  });

  // --- policy ---------------------------------------------------------------------
  app.get("/v1/policy", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null || runtime.pool === null || runtime.account === null) return blocked;
    const accountId = runtime.account.id;
    const row = await withClient(runtime.pool, (client) => getCurrentPolicy(client, accountId));
    if (row === null) {
      reply.code(404);
      return errorEnvelope("NOT_FOUND", "no policy version yet", request.id);
    }
    reply.header("ETag", `"${row.version}"`);
    return {
      version: row.version,
      hash: row.hash,
      created_by: row.created_by,
      created_at: row.created_at.toISOString(),
      policy: row.canonical_policy,
    };
  });

  app.put("/v1/policy", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null || runtime.pool === null || runtime.account === null) return blocked;
    const accountId = runtime.account.id;
    const parsed = PolicySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return errorEnvelope("INVALID_SHAPE", "invalid policy", request.id, parsed.error.issues);
    }
    const ifMatch = request.headers["if-match"];
    const operatorId = request.operator?.id ?? "operator";
    const pool = runtime.pool;
    try {
      const { row, ended } = await withTransaction(pool, async (tx) => {
        await lockAccountRow(tx, accountId);
        const current = await getCurrentPolicy(tx, accountId);
        const expected = current === null ? "0" : String(current.version);
        if (ifMatch !== expected && ifMatch !== `"${expected}"`) {
          throw Object.assign(new Error(`If-Match must equal the current policy version ${expected}`), {
            code: "STALE_VERSION",
            status: 409,
          });
        }
        const now = runtime.clock();
        const row = await setPolicy(pool, accountId, parsed.data, operatorId, now, tx);
        const ended: string[] = [];
        for (const proposal of await listPreArmProposals(tx, accountId)) {
          await endProposalInTx(tx, runtime, proposal, "INVALIDATED", "policy version changed", now, {
            policy_version: row.version,
            operator_id: operatorId,
          });
          ended.push(proposal.id);
        }
        return { row, ended };
      });
      reply.code(201);
      reply.header("ETag", `"${row.version}"`);
      return { version: row.version, hash: row.hash, invalidated_proposals: ended };
    } catch (error) {
      if (isServiceError(error)) return sendServiceError(request, reply, error);
      throw error;
    }
  });

  // --- inventory attribution (prd.md 9.4) ---------------------------------------------
  app.post("/v1/inventory/assignments", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null || runtime.pool === null || runtime.account === null) return blocked;
    const accountId = runtime.account.id;
    const parsed = InventoryAssignmentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return errorEnvelope("INVALID_SHAPE", "invalid assignments", request.id, parsed.error.issues);
    }
    const now = runtime.clock();
    const operatorId = request.operator?.id ?? "operator";
    try {
      const result = await withTransaction(runtime.pool, async (tx) => {
        const account = await lockAccountRow(tx, accountId);
        if (account.status !== "PAUSED")
          throw Object.assign(new Error("inventory can only be attributed while the account is paused"), {
            code: "STATE_CONFLICT",
            status: 409,
          });
        if ((await countOutstandingCommands(tx, accountId)).total !== 0) {
          throw Object.assign(new Error("inventory cannot be reassigned while commands are outstanding"), {
            code: "STATE_CONFLICT",
            status: 409,
          });
        }
        const owners = [...new Set(parsed.data.assignments.map((a) => a.owner))]
          .filter((owner) => owner !== UNASSIGNED_OWNER)
          .sort();
        for (const owner of owners) {
          const agent = await lockAgentRow(tx, owner);
          if (agent === null || agent.account_id !== accountId) {
            throw Object.assign(new Error("inventory owner is not bound to this account"), {
              code: "NOT_FOUND",
              status: 404,
            });
          }
        }
        for (const a of parsed.data.assignments) {
          const reserved = await sumReservedBase(tx, accountId, a.owner, a.asset);
          if (dec(a.quantity).lt(dec(reserved))) {
            throw Object.assign(new Error("inventory assignment cannot remove reserved base quantity"), {
              code: "STATE_CONFLICT",
              status: 409,
            });
          }
          await upsertInventoryAllocation(tx, accountId, a.owner, a.asset, a.quantity);
        }
        const balances = await listAssetBalances(tx, accountId);
        const allocations = await listInventoryAllocations(tx, accountId);
        const touched = new Set(parsed.data.assignments.map((a) => a.asset));
        for (const asset of touched) {
          const owned = dec(balances.find((b) => b.asset === asset)?.owned_quantity ?? "0");
          const attributed = allocations
            .filter((x) => x.asset === asset)
            .reduce((acc, x) => acc.plus(dec(x.owned_quantity)), ZERO);
          if (!eq(owned, attributed)) {
            throw Object.assign(
              new Error(
                `attribution for ${asset} (${toDecimalString(attributed)}) must equal owned quantity (${toDecimalString(owned)}); attribution cannot create holdings`,
              ),
              { code: "INVALID_FINANCIAL_VALUE", status: 422 },
            );
          }
        }
        await appendAuditEvent(tx, {
          id: newId("evt"),
          accountId,
          type: "INVENTORY_ASSIGNED",
          payload: {
            operator_id: operatorId,
            assignments: parsed.data.assignments,
            note: "internal attribution, not a transfer",
          },
          occurredAt: now,
        });
        return { assignments: parsed.data.assignments.length };
      });
      reply.code(201);
      return result;
    } catch (error) {
      if (isServiceError(error)) return sendServiceError(request, reply, error);
      throw error;
    }
  });

  // --- proposals, approvals, conflicts ------------------------------------------------
  app.get("/v1/proposals", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null || runtime.pool === null || runtime.account === null) return blocked;
    const accountId = runtime.account.id;
    return withClient(runtime.pool, async (client) => {
      const proposals = await listPreArmProposals(client, accountId);
      const out = [];
      for (const p of proposals) {
        const intent = await getIntentById(client, p.intent_id);
        out.push({
          proposal_id: p.id,
          revision: p.revision,
          state: p.state,
          agent_id: intent?.agent_id ?? null,
          lease_id: intent?.lease_id ?? null,
          requested: intent?.canonical_payload ?? null,
          candidate: p.normalized_order,
          proposal_hash: p.proposal_hash,
          account_epoch: p.account_epoch,
          lease_revision: p.lease_revision,
          policy_id: p.policy_id,
          created_at: p.created_at.toISOString(),
          expires_at: p.expires_at.toISOString(),
        });
      }
      const conflicts = await listConflicts(client, accountId, "OPEN");
      const openConflicts = [];
      for (const c of conflicts)
        openConflicts.push({
          conflict_id: c.id,
          symbol: c.symbol,
          status: c.status,
          proposal_ids: await listConflictMembers(client, c.id),
          created_at: c.created_at.toISOString(),
        });
      return { proposals: out, conflicts: openConflicts, server_time: runtime.clock().toISOString() };
    });
  });

  app.post("/v1/proposals/:id/approve", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null) return blocked;
    const { id } = request.params as { id: string };
    const parsed = ApprovalRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return errorEnvelope(
        "INVALID_SHAPE",
        "approval must carry proposal_revision, proposal_hash, expected_account_epoch, operator_confirmation: true",
        request.id,
        parsed.error.issues,
      );
    }
    return idempotent(request, reply, `approve:${id}`, async () => {
      const result = await approveProposal(runtime, {
        proposalId: id,
        request: parsed.data,
        operatorId: request.operator?.id ?? "operator",
        now: runtime.clock(),
      });
      return { status: result.status, body: result.response };
    });
  });

  app.post("/v1/proposals/:id/reject", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null) return blocked;
    const { id } = request.params as { id: string };
    const parsed = RejectProposalRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return errorEnvelope("INVALID_SHAPE", "invalid rejection", request.id, parsed.error.issues);
    }
    try {
      const proposal = await rejectProposal(
        runtime,
        id,
        request.operator?.id ?? "operator",
        parsed.data.reason,
        runtime.clock(),
      );
      return { proposal_id: proposal.id, state: proposal.state };
    } catch (error) {
      if (isServiceError(error)) return sendServiceError(request, reply, error);
      throw error;
    }
  });

  app.post("/v1/conflicts/:id/resolve", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null) return blocked;
    const { id } = request.params as { id: string };
    const parsed = ConflictResolutionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return errorEnvelope(
        "INVALID_SHAPE",
        "resolution must be { action: SELECT, proposal_id } or { action: REJECT_BOTH }",
        request.id,
        parsed.error.issues,
      );
    }
    return idempotent(request, reply, `resolve:${id}`, async () => ({
      status: 200,
      body: await resolveConflictRequest(runtime, id, parsed.data, request.operator?.id ?? "operator", runtime.clock()),
    }));
  });

  // --- account control ---------------------------------------------------------------
  app.post("/v1/account/stop", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null) return blocked;
    const parsed = StopRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return errorEnvelope("INVALID_SHAPE", "invalid stop request", request.id, parsed.error.issues);
    }
    return idempotent(request, reply, "stop", async () => ({
      status: 200,
      body: await stopAccount(runtime, request.operator?.id ?? "operator", parsed.data.reason, runtime.clock()),
    }));
  });

  app.post("/v1/account/resume", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null) return blocked;
    const parsed = ResumeRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return errorEnvelope("INVALID_SHAPE", "invalid resume request", request.id, parsed.error.issues);
    }
    return idempotent(request, reply, "resume", async () => ({
      status: 200,
      body: await resumeAccount(
        runtime,
        request.operator?.id ?? "operator",
        parsed.data.acknowledged_incident_ids,
        runtime.clock(),
      ),
    }));
  });

  app.get("/v1/incidents", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null || runtime.pool === null || runtime.account === null) return blocked;
    const accountId = runtime.account.id;
    const incidents = await withClient(runtime.pool, (client) => listIncidents(client, accountId));
    return {
      incidents: incidents.map((i) => ({
        ...i,
        created_at: i.created_at.toISOString(),
        resolved_at: i.resolved_at?.toISOString() ?? null,
      })),
    };
  });

  app.get("/v1/commands", async (request, reply) => {
    const blocked = requireRuntime(reply, request);
    if (blocked !== null || runtime.pool === null || runtime.account === null) return blocked;
    const accountId = runtime.account.id;
    const commands = await withClient(runtime.pool, (client) => listCommands(client, accountId));
    return {
      commands: commands.map((c) => ({
        ...c,
        created_at: c.created_at.toISOString(),
        updated_at: c.updated_at.toISOString(),
        armed_at: c.armed_at?.toISOString() ?? null,
        reconciled_at: c.reconciled_at?.toISOString() ?? null,
      })),
    };
  });
}
