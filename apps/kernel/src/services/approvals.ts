import { createHash } from "node:crypto";
import {
  type ApprovalRequest,
  type ApprovalResponse,
  type ArmedCommand,
  type ErrorCode,
  hashCanonical,
  type ReasonCode,
} from "@moneykernel/contracts";
import {
  appendAuditEvent,
  findOpenConflictForProposal,
  getActiveApproval,
  getAgentById,
  getCommandForProposal,
  getCurrentPolicy,
  getIntentById,
  getLeaseById,
  getProposalById,
  insertApproval,
  insertCommand,
  lockAccountRow,
  type ProposalRow,
  updateProposalState,
  withTransaction,
} from "@moneykernel/persistence";
import type { KernelRuntime } from "../boot.ts";
import { newId } from "../ids.ts";
import { endProposalInTx, sweepProposalsInTx } from "./proposals.ts";

export class ApprovalError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly reasonCodes: ReasonCode[];
  readonly details: unknown;
  constructor(code: ErrorCode, status: number, message: string, reasonCodes: ReasonCode[] = [], details?: unknown) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
    this.status = status;
    this.reasonCodes = reasonCodes;
    this.details = details;
  }
}

/** Deterministic, adapter-valid client order id bound to the environment, account, and proposal (prd.md 11.5). */
export function clientOrderIdFor(environment: string, accountId: string, proposalId: string): string {
  return `mk_${createHash("sha256").update(`${environment}:${accountId}:${proposalId}`).digest("hex").slice(0, 32)}`;
}

export type ApprovedCommandPayload = Pick<
  ArmedCommand,
  "environment" | "account_id" | "client_order_id" | "symbol" | "side" | "order_type" | "quantity" | "limit_price"
> & { proposal_hash: string };

/** Recompute the same material binding used when the proposal was created. */
export function proposalBindingHash(proposal: ProposalRow, policyVersion: number, environment: string): string {
  return hashCanonical({
    account_id: proposal.account_id,
    intent_id: proposal.intent_id,
    revision: proposal.revision,
    policy_version: policyVersion,
    lease_revision: proposal.lease_revision,
    account_epoch: proposal.account_epoch,
    environment,
    order: proposal.normalized_order,
  });
}

export function exactPayloadForProposal(
  environment: ArmedCommand["environment"],
  accountId: string,
  proposal: ProposalRow,
  clientOrderId: string,
): ApprovedCommandPayload {
  const order = proposal.normalized_order;
  return {
    environment,
    account_id: accountId,
    client_order_id: clientOrderId,
    symbol: order.symbol,
    side: order.side,
    order_type: order.order_type,
    quantity: order.quantity,
    limit_price: order.limit_price,
    proposal_hash: proposal.proposal_hash,
  };
}

function approvalResponse(approval: {
  id: string;
  proposal_id: string;
  proposal_revision: number;
  proposal_hash: string;
  status: ApprovalResponse["state"];
  expires_at: Date;
}): ApprovalResponse {
  return {
    approval_id: approval.id,
    proposal_id: approval.proposal_id,
    proposal_revision: approval.proposal_revision,
    proposal_hash: approval.proposal_hash,
    state: approval.status,
    expires_at: approval.expires_at.toISOString(),
    note: "Approval stored. Execution still requires dispatch-time revalidation; this is not a fill.",
  };
}

/**
 * Exact human approval (FR-07, INV-05): binds to the proposal revision, hash,
 * policy version, lease revision, account epoch, and environment. Single-use.
 * A second identical request on an already approved proposal returns the
 * stored approval (T-20); any mismatch is refused, never reinterpreted (T-21,
 * T-22). Creates the durable command (READY) that the dispatcher may arm once.
 */
export async function approveProposal(
  runtime: KernelRuntime,
  input: { proposalId: string; request: ApprovalRequest; operatorId: string; now: Date },
): Promise<{ status: 200 | 201; response: ApprovalResponse; proposal: ProposalRow }> {
  const pool = runtime.pool;
  const account = runtime.account;
  if (pool === null || account === null) throw new ApprovalError("NOT_READY", 503, "kernel has no loaded account");
  const { proposalId, request, operatorId } = input;

  const result = await withTransaction(pool, async (tx) => {
    const accountRow = await lockAccountRow(tx, account.id);
    await sweepProposalsInTx(tx, runtime, runtime.clock());
    const proposal = await getProposalById(tx, proposalId, { lock: true });
    if (proposal === null || proposal.account_id !== account.id)
      return { error: new ApprovalError("NOT_FOUND", 404, "proposal not found") };

    const bindingMatches =
      proposal.revision === request.proposal_revision && proposal.proposal_hash === request.proposal_hash;

    const alreadyApproved = proposal.state === "COMMAND_CREATED" || proposal.state === "APPROVED";
    const active = alreadyApproved ? await getActiveApproval(tx, proposal.id) : null;
    if (
      alreadyApproved &&
      !(active !== null && bindingMatches && active.account_epoch === request.expected_account_epoch)
    ) {
      return {
        error: new ApprovalError(
          "APPROVAL_CONSUMED",
          409,
          "proposal already carries an approval that does not match this request",
          ["STALE_APPROVAL"],
        ),
      };
    }
    if (!alreadyApproved && proposal.state !== "AWAITING_APPROVAL") {
      return {
        error: new ApprovalError(
          "STATE_CONFLICT",
          409,
          `proposal is ${proposal.state}; only AWAITING_APPROVAL candidates can be approved`,
          proposal.state === "CONFLICT_HELD" ? ["OPPOSING_INTENT"] : [],
        ),
      };
    }
    if (!bindingMatches) {
      return {
        error: new ApprovalError(
          "STALE_VERSION",
          409,
          "approval does not match the proposal revision or hash",
          ["STALE_APPROVAL"],
          { expected_revision: proposal.revision, expected_hash: proposal.proposal_hash },
        ),
      };
    }

    const stale: ReasonCode[] = [];
    if (request.expected_account_epoch !== accountRow.epoch || proposal.account_epoch !== accountRow.epoch)
      stale.push("STALE_APPROVAL");
    if (accountRow.status !== "READY") stale.push("ACCOUNT_PAUSED");
    const policyRow = await getCurrentPolicy(tx, account.id);
    if (policyRow === null || policyRow.id !== proposal.policy_id) stale.push("STALE_APPROVAL");
    else if (proposalBindingHash(proposal, policyRow.version, runtime.config.environment) !== proposal.proposal_hash)
      stale.push("STALE_APPROVAL");
    const intentRow = await getIntentById(tx, proposal.intent_id);
    const lease = intentRow === null ? null : await getLeaseById(tx, intentRow.lease_id, { lock: true });
    if (lease === null) stale.push("LEASE_EXPIRED");
    else {
      if (lease.revision !== proposal.lease_revision) stale.push("STALE_APPROVAL");
      if (lease.status === "REVOKED") stale.push("LEASE_REVOKED");
      else if (lease.status !== "ACTIVE") stale.push("LEASE_EXPIRED");
    }
    const agent = intentRow === null ? null : await getAgentById(tx, intentRow.agent_id);
    if (agent === null) stale.push("AGENT_DISABLED");
    else if (agent.status === "QUARANTINED") stale.push("AGENT_QUARANTINED");
    else if (agent.status !== "ACTIVE") stale.push("AGENT_DISABLED");
    // Proposal, approval, and lease row locks may each have waited. Authority
    // time must be sampled after those waits, not when the request arrived.
    const now = runtime.clock();
    if (proposal.expires_at.getTime() <= now.getTime()) stale.push("STALE_APPROVAL");
    if (lease !== null && lease.expires_at.getTime() <= now.getTime()) stale.push("LEASE_EXPIRED");
    if ((await findOpenConflictForProposal(tx, proposal.id)) !== null) stale.push("OPPOSING_INTENT");

    if (stale.length > 0) {
      const codes = [...new Set(stale)];
      // Stale authority can never be approved: end the candidate so a fresh proposal is required (FR-07).
      const terminal = codes.every((c) => c === "OPPOSING_INTENT" || c === "ACCOUNT_PAUSED");
      if (!terminal)
        await endProposalInTx(tx, runtime, proposal, "INVALIDATED", `approval refused: ${codes.join(",")}`, now, {
          operator_id: operatorId,
        });
      // Return the error until after commit: throwing here would undo the
      // invalidation, hold release, and audit records above.
      return {
        error: new ApprovalError(
          "STALE_VERSION",
          409,
          "authority changed since the proposal was made; a new proposal and approval are required",
          codes,
        ),
      };
    }

    if (alreadyApproved && active !== null)
      return { status: 200 as const, response: approvalResponse(active), proposal };

    const existingCommand = await getCommandForProposal(tx, proposal.id);
    if (existingCommand !== null)
      return { error: new ApprovalError("STATE_CONFLICT", 409, "proposal already has a command") };

    const approval = await insertApproval(tx, {
      id: newId("approval"),
      accountId: account.id,
      proposalId: proposal.id,
      proposalRevision: proposal.revision,
      proposalHash: proposal.proposal_hash,
      operatorId,
      accountEpoch: accountRow.epoch,
      expiresAt: proposal.expires_at,
      now,
    });
    await updateProposalState(tx, proposal.id, "APPROVED", now);
    const clientOrderId = clientOrderIdFor(runtime.config.environment, account.id, proposal.id);
    const command = await insertCommand(tx, {
      id: newId("cmd"),
      accountId: account.id,
      proposalId: proposal.id,
      approvalId: approval.id,
      clientOrderId,
      exactPayload: exactPayloadForProposal(runtime.config.environment, account.id, proposal, clientOrderId),
      now,
    });
    const updated = await updateProposalState(tx, proposal.id, "COMMAND_CREATED", now);
    await appendAuditEvent(tx, {
      id: newId("evt"),
      accountId: account.id,
      type: "APPROVAL_CREATED",
      payload: {
        approval_id: approval.id,
        proposal_id: proposal.id,
        proposal_revision: proposal.revision,
        proposal_hash: proposal.proposal_hash,
        account_epoch: accountRow.epoch,
        operator_id: operatorId,
        expires_at: approval.expires_at.toISOString(),
      },
      occurredAt: now,
    });
    await appendAuditEvent(tx, {
      id: newId("evt"),
      accountId: account.id,
      type: "COMMAND_CREATED",
      payload: { command_id: command.id, proposal_id: proposal.id, client_order_id: clientOrderId, state: "READY" },
      occurredAt: now,
    });
    return { status: 201 as const, response: approvalResponse(approval), proposal: updated };
  });
  if ("error" in result) throw result.error;
  return result;
}
