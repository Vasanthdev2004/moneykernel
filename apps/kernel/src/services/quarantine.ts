import type { Policy, ReasonCode } from "@moneykernel/contracts";
import type { PoolClient } from "@moneykernel/persistence";
import {
  type AgentRow,
  abortReadyCommandForProposal,
  appendAuditEvent,
  countAgentIntentsSince,
  countHardViolationsSince,
  insertIncident,
  invalidateApprovalsForProposal,
  listPreArmProposalsForAgent,
  setAgentStatus,
  transitionReservations,
  updateProposalState,
} from "@moneykernel/persistence";
import { newId } from "../ids.ts";

/** Reason codes that count as hard authority violations (prd.md 10.4). Budget outcomes never count. */
export const HARD_VIOLATION_CODES: ReasonCode[] = [
  "SYMBOL_NOT_ALLOWED",
  "SIDE_NOT_ALLOWED",
  "UNSUPPORTED_ORDER_TYPE",
  "LEASE_MISMATCH",
];
export const QUARANTINE_WINDOW_MS = 60_000;

export type QuarantineTrigger = "INTENT_BURST" | "HARD_VIOLATIONS" | "OPERATOR";

export type QuarantineResult = {
  agent: AgentRow;
  invalidated_proposals: string[];
  released_reservations: number;
  incident_id: string;
};

/**
 * Quarantine transaction (prd.md 10.5), executed under the account lock the
 * caller already holds: status + revision, invalidate unused approvals, cancel
 * undispatched proposals, release only never-armed reservations, keep armed or
 * unknown ones, append incident and audit events. No automatic reinstatement.
 */
export async function quarantineAgentInTx(
  tx: PoolClient,
  input: {
    accountId: string;
    agent: AgentRow;
    trigger: QuarantineTrigger;
    evidence: Record<string, unknown>;
    operatorId?: string;
    now: Date;
  },
): Promise<QuarantineResult> {
  const { accountId, agent, now } = input;
  const updated = await setAgentStatus(tx, agent.id, "QUARANTINED", now);
  const proposals = await listPreArmProposalsForAgent(tx, accountId, agent.id);
  let released = 0;
  const invalidated: string[] = [];
  for (const proposal of proposals) {
    await updateProposalState(tx, proposal.id, "INVALIDATED", now);
    await invalidateApprovalsForProposal(tx, proposal.id, "INVALIDATED");
    await abortReadyCommandForProposal(tx, proposal.id, now);
    released += await transitionReservations(tx, proposal.id, ["HELD"], "RELEASED", now);
    invalidated.push(proposal.id);
  }
  const incident = await insertIncident(tx, {
    id: newId("incident"),
    accountId,
    agentId: agent.id,
    type: "AGENT_QUARANTINED",
    severity: "CRITICAL",
    status: "OPEN",
    evidence: {
      trigger: input.trigger,
      ...input.evidence,
      invalidated_proposals: invalidated,
      released_reservations: released,
    },
    now,
  });
  await appendAuditEvent(tx, {
    id: newId("evt"),
    accountId,
    type: "AGENT_QUARANTINED",
    payload: {
      agent_id: agent.id,
      revision: updated.revision,
      trigger: input.trigger,
      operator_id: input.operatorId ?? null,
      incident_id: incident.id,
      invalidated_proposals: invalidated,
      released_reservations: released,
      note: "new authority blocked; armed or unknown commands retained; holdings unchanged",
    },
    occurredAt: now,
  });
  return {
    agent: updated,
    invalidated_proposals: invalidated,
    released_reservations: released,
    incident_id: incident.id,
  };
}

/** Burst rule: more than max unique intents in the trailing window (the (max+1)th triggers, prd.md 10.4). */
export async function enforceBurstThreshold(
  tx: PoolClient,
  input: { accountId: string; agent: AgentRow; policy: Policy; now: Date },
): Promise<QuarantineResult | null> {
  if (input.agent.status !== "ACTIVE") return null;
  const since = new Date(input.now.getTime() - QUARANTINE_WINDOW_MS);
  const count = await countAgentIntentsSince(tx, input.agent.id, since);
  if (count < input.policy.max_unique_intents_per_60s) return null;
  return quarantineAgentInTx(tx, {
    accountId: input.accountId,
    agent: input.agent,
    trigger: "INTENT_BURST",
    evidence: {
      unique_intents_in_window: count,
      limit: input.policy.max_unique_intents_per_60s,
      window_ms: QUARANTINE_WINDOW_MS,
    },
    now: input.now,
  });
}

/** Records a hard authority violation durably (resolved immediately; it is evidence, not an open incident). */
export async function recordHardViolation(
  tx: PoolClient,
  input: { accountId: string; agentId: string; reason: string; evidence: Record<string, unknown>; now: Date },
): Promise<void> {
  await insertIncident(tx, {
    id: newId("incident"),
    accountId: input.accountId,
    agentId: input.agentId,
    type: "HARD_AUTHORITY_VIOLATION",
    severity: "INFO",
    status: "RESOLVED",
    evidence: { reason: input.reason, ...input.evidence },
    resolvedBy: "system",
    now: input.now,
  });
}

/** Hard-violation rule: three in the trailing window trigger quarantine. Counts receipts and recorded violations. */
export async function enforceHardViolationThreshold(
  tx: PoolClient,
  input: { accountId: string; agent: AgentRow; policy: Policy; now: Date },
): Promise<QuarantineResult | null> {
  if (input.agent.status !== "ACTIVE") return null;
  const since = new Date(input.now.getTime() - QUARANTINE_WINDOW_MS);
  const count = await countHardViolationsSince(tx, input.agent.id, since, HARD_VIOLATION_CODES);
  if (count < input.policy.max_hard_violations_per_60s) return null;
  return quarantineAgentInTx(tx, {
    accountId: input.accountId,
    agent: input.agent,
    trigger: "HARD_VIOLATIONS",
    evidence: {
      hard_violations_in_window: count,
      limit: input.policy.max_hard_violations_per_60s,
      window_ms: QUARANTINE_WINDOW_MS,
    },
    now: input.now,
  });
}

export function isHardViolation(reasonCodes: readonly ReasonCode[]): boolean {
  return reasonCodes.some((code) => HARD_VIOLATION_CODES.includes(code));
}
