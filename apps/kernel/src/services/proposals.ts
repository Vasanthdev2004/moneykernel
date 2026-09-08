import {
  type ConflictResolutionRequest,
  type ErrorCode,
  PolicySchema,
  TradeIntentSchema,
} from "@moneykernel/contracts";
import { evaluate } from "@moneykernel/domain";
import type { PoolClient } from "@moneykernel/persistence";
import {
  abortReadyCommandForProposal,
  addConflictMember,
  appendAuditEvent,
  findOpenConflictForProposal,
  findOpenConflictForSymbol,
  getAgentById,
  getConflictById,
  getCurrentPolicy,
  getIntentById,
  getLeaseById,
  getProposalById,
  hasInFlightOppositeCommand,
  insertConflict,
  invalidateApprovalsForProposal,
  listConflictMembers,
  listPreArmProposals,
  lockAccountRow,
  type ProposalRow,
  resolveConflict,
  transitionReservations,
  updateProposalState,
  withTransaction,
} from "@moneykernel/persistence";
import type { KernelRuntime } from "../boot.ts";
import { newId } from "../ids.ts";
import { recordProposalRevision, recordReceipt } from "./admission.ts";
import { assembleEvaluationInput, refreshInputsForSymbol } from "./evaluation.ts";

export class ProposalError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  constructor(code: ErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.name = "ProposalError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type TerminalPreArmState = "INVALIDATED" | "REJECTED" | "EXPIRED";

/**
 * Ends a pre-arm proposal: releases only HELD (never-armed) reservations,
 * invalidates its unused approval, aborts a READY command, records why.
 * Armed or unknown reservations are never touched here (INV-09).
 */
export async function endProposalInTx(
  tx: PoolClient,
  runtime: KernelRuntime,
  proposal: ProposalRow,
  state: TerminalPreArmState,
  reason: string,
  now: Date,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await updateProposalState(tx, proposal.id, state, now);
  const invalidated = await invalidateApprovalsForProposal(
    tx,
    proposal.id,
    state === "EXPIRED" ? "EXPIRED" : "INVALIDATED",
  );
  const aborted = await abortReadyCommandForProposal(tx, proposal.id, now);
  const released = await transitionReservations(tx, proposal.id, ["HELD"], "RELEASED", now);
  await appendAuditEvent(tx, {
    id: newId("evt"),
    accountId: proposal.account_id,
    type: "PROPOSAL_STATE_CHANGED",
    payload: {
      proposal_id: proposal.id,
      from: proposal.state,
      to: state,
      reason,
      released_reservations: released,
      invalidated_approvals: invalidated,
      aborted_commands: aborted,
      ...extra,
    },
    occurredAt: now,
  });
  if (released > 0) {
    await appendAuditEvent(tx, {
      id: newId("evt"),
      accountId: proposal.account_id,
      type: "RESERVATION_RELEASED",
      payload: { proposal_id: proposal.id, count: released, reason },
      occurredAt: now,
    });
  }
  void runtime;
}

export type SweepReport = { promoted: string[]; conflicted: string[]; expired: string[]; held: string[] };

const OPPOSABLE: ProposalRow["state"][] = [
  "COLLECTING",
  "CONFLICT_HELD",
  "AWAITING_APPROVAL",
  "APPROVED",
  "COMMAND_CREATED",
];

/**
 * Proposal sweep (prd.md 10.2, 10.4 no-ops, 11.1): expires stale pre-arm
 * proposals, then promotes COLLECTING proposals whose window has elapsed to
 * AWAITING_APPROVAL, or into a conflict when an opposite-side candidate on the
 * same symbol is still pre-arm. A proposal whose opposite side is already in
 * flight stays held until reconciliation. Runs under the account lock.
 */
export async function sweepProposals(runtime: KernelRuntime, now: Date): Promise<SweepReport> {
  const pool = runtime.pool;
  const account = runtime.account;
  const report: SweepReport = { promoted: [], conflicted: [], expired: [], held: [] };
  if (pool === null || account === null) return report;
  return withTransaction(pool, async (tx) => {
    await lockAccountRow(tx, account.id);
    const policyRow = await getCurrentPolicy(tx, account.id);
    const windowMs =
      policyRow === null ? 750 : PolicySchema.parse(policyRow.canonical_policy).conflict_collection_window_ms;
    const open = await listPreArmProposals(tx, account.id);
    const live: ProposalRow[] = [];
    for (const proposal of open) {
      if (proposal.expires_at.getTime() <= now.getTime()) {
        await endProposalInTx(tx, runtime, proposal, "EXPIRED", "proposal TTL elapsed before dispatch", now);
        report.expired.push(proposal.id);
      } else live.push(proposal);
    }
    for (const proposal of live) {
      if (proposal.state !== "COLLECTING") continue;
      if (proposal.created_at.getTime() + windowMs > now.getTime()) continue;
      const order = proposal.normalized_order;
      if (await hasInFlightOppositeCommand(tx, account.id, order.symbol, order.side)) {
        report.held.push(proposal.id);
        continue;
      }
      const opposing = live.filter(
        (other) =>
          other.id !== proposal.id &&
          other.normalized_order.symbol === order.symbol &&
          other.normalized_order.side !== order.side &&
          OPPOSABLE.includes(other.state),
      );
      if (opposing.length === 0) {
        await updateProposalState(tx, proposal.id, "AWAITING_APPROVAL", now);
        proposal.state = "AWAITING_APPROVAL";
        await appendAuditEvent(tx, {
          id: newId("evt"),
          accountId: account.id,
          type: "PROPOSAL_STATE_CHANGED",
          payload: {
            proposal_id: proposal.id,
            from: "COLLECTING",
            to: "AWAITING_APPROVAL",
            reason: "collection window elapsed; no opposing pending intent",
          },
          occurredAt: now,
        });
        report.promoted.push(proposal.id);
        continue;
      }
      const conflict =
        (await findOpenConflictForSymbol(tx, account.id, order.symbol)) ??
        (await insertConflict(tx, { id: newId("conflict"), accountId: account.id, symbol: order.symbol, now }));
      const members = [proposal, ...opposing];
      for (const member of members) {
        await addConflictMember(tx, conflict.id, member.id);
        if (member.state === "CONFLICT_HELD") continue;
        const from = member.state;
        const invalidated = await invalidateApprovalsForProposal(tx, member.id, "INVALIDATED");
        const aborted = await abortReadyCommandForProposal(tx, member.id, now);
        await updateProposalState(tx, member.id, "CONFLICT_HELD", now);
        member.state = "CONFLICT_HELD";
        await appendAuditEvent(tx, {
          id: newId("evt"),
          accountId: account.id,
          type: "PROPOSAL_STATE_CHANGED",
          payload: {
            proposal_id: member.id,
            from,
            to: "CONFLICT_HELD",
            conflict_id: conflict.id,
            invalidated_approvals: invalidated,
            aborted_commands: aborted,
            reason: "opposing pending intents require review",
          },
          occurredAt: now,
        });
        report.conflicted.push(member.id);
      }
      await appendAuditEvent(tx, {
        id: newId("evt"),
        accountId: account.id,
        type: "CONFLICT_CREATED",
        payload: { conflict_id: conflict.id, symbol: order.symbol, proposal_ids: members.map((m) => m.id) },
        occurredAt: now,
      });
    }
    return report;
  });
}

/** Operator rejection of an undispatched candidate. */
export async function rejectProposal(
  runtime: KernelRuntime,
  proposalId: string,
  operatorId: string,
  reason: string | undefined,
  now: Date,
): Promise<ProposalRow> {
  const pool = runtime.pool;
  const account = runtime.account;
  if (pool === null || account === null) throw new ProposalError("NOT_READY", 503, "kernel has no loaded account");
  return withTransaction(pool, async (tx) => {
    await lockAccountRow(tx, account.id);
    const proposal = await getProposalById(tx, proposalId, { lock: true });
    if (proposal === null || proposal.account_id !== account.id)
      throw new ProposalError("NOT_FOUND", 404, "proposal not found");
    if (!OPPOSABLE.includes(proposal.state)) {
      throw new ProposalError(
        "STATE_CONFLICT",
        409,
        `proposal is ${proposal.state}; only undispatched candidates can be rejected`,
      );
    }
    await endProposalInTx(tx, runtime, proposal, "REJECTED", reason ?? "operator rejected", now, {
      operator_id: operatorId,
    });
    const updated = await getProposalById(tx, proposalId);
    if (updated === null) throw new ProposalError("INTERNAL", 500, "proposal vanished");
    return updated;
  });
}

export type ConflictResolutionResult = {
  conflict_id: string;
  status: "RESOLVED_SELECTED" | "RESOLVED_REJECTED_BOTH";
  rejected_proposal_ids: string[];
  selected: null | {
    previous_proposal_id: string;
    outcome: string;
    reason_codes: string[];
    new_proposal_id: string | null;
    state: string | null;
  };
};

/**
 * Conflict resolution (prd.md 10.2 step 7, FR-06): the operator selects one
 * candidate or rejects both. Nothing is netted or dispatched. A selected
 * candidate has its holds released, is re-evaluated against current state,
 * and if still admissible becomes a new proposal revision that must be
 * approved separately (T-28).
 */
export async function resolveConflictRequest(
  runtime: KernelRuntime,
  conflictId: string,
  request: ConflictResolutionRequest,
  operatorId: string,
  now: Date,
): Promise<ConflictResolutionResult> {
  const pool = runtime.pool;
  const account = runtime.account;
  if (pool === null || account === null) throw new ProposalError("NOT_READY", 503, "kernel has no loaded account");

  // Refresh inputs outside the transaction when a re-evaluation is coming.
  let refreshedRulesId: string | null = null;
  if (request.action === "SELECT") {
    const selected = await withTransaction(pool, (tx) => getProposalById(tx, request.proposal_id));
    if (selected !== null)
      refreshedRulesId = await refreshInputsForSymbol(
        runtime,
        account.id,
        account.quote_asset,
        selected.normalized_order.symbol,
      );
  }

  return withTransaction(pool, async (tx) => {
    const accountRow = await lockAccountRow(tx, account.id);
    const conflict = await getConflictById(tx, conflictId, { lock: true });
    if (conflict === null || conflict.account_id !== account.id)
      throw new ProposalError("NOT_FOUND", 404, "conflict not found");
    if (conflict.status !== "OPEN") throw new ProposalError("STATE_CONFLICT", 409, `conflict is ${conflict.status}`);
    const memberIds = await listConflictMembers(tx, conflict.id);
    const members: ProposalRow[] = [];
    for (const id of memberIds) {
      const row = await getProposalById(tx, id, { lock: true });
      if (row !== null) members.push(row);
    }

    if (request.action === "REJECT_BOTH") {
      const rejected: string[] = [];
      for (const member of members) {
        if (member.state !== "CONFLICT_HELD") continue;
        await endProposalInTx(tx, runtime, member, "REJECTED", "operator rejected both sides of the conflict", now, {
          conflict_id: conflict.id,
          operator_id: operatorId,
        });
        rejected.push(member.id);
      }
      await resolveConflict(
        tx,
        conflict.id,
        "RESOLVED_REJECTED_BOTH",
        { action: "REJECT_BOTH", rejected },
        operatorId,
        now,
      );
      await appendAuditEvent(tx, {
        id: newId("evt"),
        accountId: account.id,
        type: "CONFLICT_RESOLVED",
        payload: { conflict_id: conflict.id, action: "REJECT_BOTH", rejected, operator_id: operatorId },
        occurredAt: now,
      });
      return {
        conflict_id: conflict.id,
        status: "RESOLVED_REJECTED_BOTH",
        rejected_proposal_ids: rejected,
        selected: null,
      };
    }

    const winner = members.find((m) => m.id === request.proposal_id);
    if (winner === undefined || winner.state !== "CONFLICT_HELD") {
      throw new ProposalError("STATE_CONFLICT", 409, "selected proposal is not a held member of this conflict");
    }
    const rejected: string[] = [];
    for (const member of members) {
      if (member.id === winner.id || member.state !== "CONFLICT_HELD") continue;
      await endProposalInTx(tx, runtime, member, "REJECTED", "operator selected the opposing candidate", now, {
        conflict_id: conflict.id,
        operator_id: operatorId,
      });
      rejected.push(member.id);
    }

    // Release the winner's own holds, then re-evaluate the original intent against current state.
    await endProposalInTx(
      tx,
      runtime,
      winner,
      "INVALIDATED",
      "superseded by revalidation after conflict resolution",
      now,
      { conflict_id: conflict.id },
    );
    const intentRow = await getIntentById(tx, winner.intent_id);
    const agent = intentRow === null ? null : await getAgentById(tx, intentRow.agent_id);
    const lease = intentRow === null ? null : await getLeaseById(tx, intentRow.lease_id, { lock: true });
    const policyRow = await getCurrentPolicy(tx, account.id);
    let selected: ConflictResolutionResult["selected"] = null;
    if (intentRow !== null && agent !== null && lease !== null && policyRow !== null) {
      const intent = TradeIntentSchema.parse(intentRow.canonical_payload);
      const policy = PolicySchema.parse(policyRow.canonical_policy);
      const { input, baseAsset } = await assembleEvaluationInput({
        tx,
        accountRow,
        agent,
        lease,
        policyRow,
        policy,
        intent,
        now,
        refreshedRulesId,
      });
      const result = evaluate(input);
      const revised = await recordProposalRevision(tx, {
        runtime,
        now,
        intentId: intentRow.id,
        revision: winner.revision + 1,
        state: "AWAITING_APPROVAL",
        accountId: account.id,
        agentId: agent.id,
        accountEpoch: accountRow.epoch,
        lease: { id: lease.id, revision: lease.revision, expires_at: lease.expires_at },
        policy: { id: policyRow.id, version: policyRow.version, max_proposal_age_ms: policy.max_proposal_age_ms },
        quoteAsset: account.quote_asset,
        baseAsset,
        result,
      });
      await recordReceipt(tx, {
        runtime,
        now,
        intentId: intentRow.id,
        proposalId: revised?.id ?? null,
        accountId: account.id,
        result,
      });
      selected = {
        previous_proposal_id: winner.id,
        outcome: result.outcome,
        reason_codes: result.reason_codes,
        new_proposal_id: revised?.id ?? null,
        state: revised?.state ?? null,
      };
    }
    await resolveConflict(
      tx,
      conflict.id,
      "RESOLVED_SELECTED",
      { action: "SELECT", selected_proposal_id: winner.id, rejected, revalidation: selected },
      operatorId,
      now,
    );
    await appendAuditEvent(tx, {
      id: newId("evt"),
      accountId: account.id,
      type: "CONFLICT_RESOLVED",
      payload: {
        conflict_id: conflict.id,
        action: "SELECT",
        selected_proposal_id: winner.id,
        rejected,
        revalidation: selected,
        operator_id: operatorId,
      },
      occurredAt: now,
    });
    return { conflict_id: conflict.id, status: "RESOLVED_SELECTED", rejected_proposal_ids: rejected, selected };
  });
}

export async function openConflictForProposal(tx: PoolClient, proposalId: string): Promise<boolean> {
  return (await findOpenConflictForProposal(tx, proposalId)) !== null;
}
