// State-to-presentation mappings (prd.md 17.1, 17.4). Every state carries a
// label and a glyph next to its color, and the distinctions the PRD mandates
// are spelled out in the label itself.
import type {
  AccountStatus,
  AgentStatus,
  CommandState,
  DecisionOutcome,
  Environment,
  IncidentSeverity,
  IntegrationState,
  ProposalState,
  RuleResult,
} from "./types.ts";

export type Tone = "neutral" | "gold" | "red" | "amber" | "green" | "muted";

export interface Presentation {
  tone: Tone;
  glyph: string;
  label: string;
  note?: string;
}

export function modeBadge(mode: Environment | null): Presentation {
  switch (mode) {
    case "REPLAY":
      return { tone: "gold", glyph: "⟲", label: "REPLAY · SYNTHETIC FIXTURE" };
    case "SHADOW":
      return { tone: "gold", glyph: "◑", label: "SHADOW · VIRTUAL FUNDS" };
    case "TESTNET":
      return { tone: "gold", glyph: "◇", label: "TESTNET · READ ONLY" };
    default:
      return { tone: "amber", glyph: "?", label: "MODE UNKNOWN · not loaded" };
  }
}

export function accountStatus(status: AccountStatus | null): Presentation {
  switch (status) {
    case "READY":
      return { tone: "neutral", glyph: "●", label: "READY" };
    case "PAUSED":
      return { tone: "amber", glyph: "▮▮", label: "PAUSED", note: "no new command can be armed" };
    case "RECONCILING":
      return { tone: "amber", glyph: "↻", label: "RECONCILING", note: "outstanding command outcome" };
    case "ERROR":
      return { tone: "red", glyph: "✕", label: "ERROR" };
    default:
      return { tone: "muted", glyph: "–", label: "UNKNOWN" };
  }
}

export function integrationState(state: IntegrationState): Presentation {
  switch (state) {
    case "CONNECTED":
      return { tone: "neutral", glyph: "●", label: "CONNECTED" };
    case "DEGRADED":
      return { tone: "amber", glyph: "◐", label: "DEGRADED" };
    case "NOT_CONNECTED":
      return { tone: "amber", glyph: "○", label: "NOT CONNECTED" };
    case "NOT_CONFIGURED":
      return { tone: "muted", glyph: "–", label: "NOT CONFIGURED" };
    case "BLOCKED":
      return { tone: "red", glyph: "⊘", label: "BLOCKED" };
  }
}

export function agentStatus(status: AgentStatus): Presentation {
  switch (status) {
    case "ACTIVE":
      return { tone: "neutral", glyph: "●", label: "ACTIVE" };
    case "QUARANTINED":
      return { tone: "red", glyph: "⚠", label: "QUARANTINED", note: "new authority blocked until reviewed" };
    case "DISABLED":
      return { tone: "muted", glyph: "○", label: "DISABLED" };
  }
}

export function proposalState(state: ProposalState | string): Presentation {
  switch (state) {
    case "COLLECTING":
      return { tone: "amber", glyph: "◔", label: "COLLECTING", note: "collection window running · not yet approvable" };
    case "CONFLICT_HELD":
      return { tone: "amber", glyph: "⚠", label: "CONFLICT HELD", note: "resolve in the conflict panel" };
    case "AWAITING_APPROVAL":
      return { tone: "gold", glyph: "◆", label: "AWAITING APPROVAL", note: "needs an explicit operator decision" };
    case "APPROVED":
      return {
        tone: "neutral",
        glyph: "◇",
        label: "APPROVED · NOT SUBMITTED",
        note: "approval stored; dispatch pending",
      };
    case "COMMAND_CREATED":
      return {
        tone: "neutral",
        glyph: "▷",
        label: "COMMAND CREATED",
        note: "approved command exists; see command and order for execution status",
      };
    case "RECEIVED":
      return { tone: "muted", glyph: "·", label: "RECEIVED" };
    case "DENIED":
      return { tone: "red", glyph: "✕", label: "DENIED" };
    case "INVALIDATED":
      return { tone: "red", glyph: "⊘", label: "INVALIDATED" };
    case "REJECTED":
      return { tone: "red", glyph: "✕", label: "REJECTED" };
    case "EXPIRED":
      return { tone: "muted", glyph: "⌛", label: "EXPIRED" };
    default:
      return { tone: "muted", glyph: "?", label: state };
  }
}

export function commandState(state: CommandState | string): Presentation {
  switch (state) {
    case "READY":
      return { tone: "neutral", glyph: "○", label: "READY", note: "not armed" };
    case "ARMED":
      return {
        tone: "amber",
        glyph: "◉",
        label: "ARMED",
        note: "durable arm recorded; dispatch or venue response may be pending",
      };
    case "ACCEPTED":
      return {
        tone: "neutral",
        glyph: "◎",
        label: "ACCEPTED",
        note: "venue accepted the order; fill status is shown separately",
      };
    case "REJECTED_CONFIRMED":
      return { tone: "red", glyph: "✕", label: "REJECTED · CONFIRMED" };
    case "OUTCOME_UNKNOWN":
      return { tone: "amber", glyph: "?", label: "OUTCOME UNKNOWN", note: "reservations retained until reconciled" };
    case "ABORTED_PRE_ARM":
      return { tone: "red", glyph: "⊘", label: "ABORTED PRE-ARM", note: "never sent" };
    default:
      return { tone: "muted", glyph: "?", label: state };
  }
}

export function decisionOutcome(outcome: DecisionOutcome | string): Presentation {
  switch (outcome) {
    case "ALLOW_PROPOSAL":
      return { tone: "neutral", glyph: "✓", label: "ALLOWED AS REQUESTED", note: "candidate equals the request" };
    case "COUNTERPROPOSE":
      return {
        tone: "amber",
        glyph: "◆",
        label: "COUNTERPROPOSED",
        note: "candidate differs from the request; not approved",
      };
    case "DENY":
      return { tone: "red", glyph: "✕", label: "DENIED" };
    case "HOLD":
      return { tone: "amber", glyph: "◔", label: "HELD" };
    default:
      return { tone: "muted", glyph: "?", label: outcome };
  }
}

export function ruleResult(result: RuleResult | string): Presentation {
  switch (result) {
    case "PASS":
      return { tone: "neutral", glyph: "✓", label: "PASS" };
    case "FAIL":
      return { tone: "red", glyph: "✕", label: "FAIL" };
    case "LIMITING":
      return { tone: "amber", glyph: "◆", label: "LIMITING" };
    case "SKIPPED":
      return { tone: "muted", glyph: "–", label: "SKIPPED" };
    default:
      return { tone: "muted", glyph: "?", label: result };
  }
}

export function incidentSeverity(severity: IncidentSeverity | string): Presentation {
  switch (severity) {
    case "CRITICAL":
      return { tone: "red", glyph: "▲", label: "CRITICAL" };
    case "WARNING":
      return { tone: "amber", glyph: "▲", label: "WARNING" };
    case "INFO":
      return { tone: "muted", glyph: "ℹ", label: "INFO" };
    default:
      return { tone: "muted", glyph: "?", label: severity };
  }
}

export function reservationState(state: string): Presentation {
  switch (state) {
    case "HELD":
      return { tone: "amber", glyph: "◔", label: "HELD" };
    case "ARMED":
      return { tone: "amber", glyph: "◉", label: "ARMED" };
    case "CONSUMED":
      return { tone: "neutral", glyph: "✓", label: "CONSUMED" };
    case "RELEASED":
      return { tone: "muted", glyph: "○", label: "RELEASED" };
    default:
      return { tone: "muted", glyph: "?", label: state };
  }
}

/** Timeline tone: red for blocks/denials, amber for unresolved states, green only for verified committed transitions. */
export function eventTone(type: string, payload: Record<string, unknown>): Tone {
  switch (type) {
    case "FILL_RECONCILED":
    case "ACCOUNT_RESUMED":
    case "ACCOUNT_RECONCILED":
      return "green";
    case "AGENT_QUARANTINED":
    case "AGENT_DISABLED":
    case "ACCOUNT_STOPPED":
    case "APPROVAL_INVALIDATED":
    case "LEASE_REVOKED":
      return "red";
    case "CONFLICT_CREATED":
    case "ACCOUNT_RECONCILING":
    case "INCIDENT_RAISED":
    case "LEASE_EXPIRED":
    case "LEASE_EXHAUSTED":
      return "amber";
    case "COMMAND_OUTCOME": {
      const outcome = payload.outcome ?? payload.state;
      if (outcome === "OUTCOME_UNKNOWN") return "amber";
      if (outcome === "REJECTED_CONFIRMED") return "red";
      return "neutral";
    }
    case "DECISION_RECORDED": {
      const outcome = payload.outcome;
      if (outcome === "DENY") return "red";
      if (outcome === "COUNTERPROPOSE" || outcome === "HOLD") return "amber";
      return "neutral";
    }
    case "PROPOSAL_STATE_CHANGED": {
      const to = payload.to ?? payload.state;
      if (to === "DENIED" || to === "REJECTED" || to === "INVALIDATED") return "red";
      if (to === "CONFLICT_HELD" || to === "COLLECTING") return "amber";
      return "neutral";
    }
    case "APPROVAL_CREATED":
      return "gold";
    default:
      return "neutral";
  }
}
