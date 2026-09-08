import type { ErrorCode } from "@moneykernel/contracts";
import {
  appendAuditEvent,
  type CommandRow,
  invalidateAllActiveApprovals,
  listCommands,
  listConflicts,
  listIncidents,
  listPreArmProposals,
  lockAccountRow,
  migrationStatus,
  resolveConflict,
  setAccountStatus,
  withTransaction,
} from "@moneykernel/persistence";
import type { KernelRuntime } from "../boot.ts";
import { newId } from "../ids.ts";
import { endProposalInTx } from "./proposals.ts";

export class AccountControlError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  constructor(code: ErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.name = "AccountControlError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type StopResult = {
  status: "PAUSED";
  epoch: number;
  in_flight_commands: Array<{ command_id: string; client_order_id: string; state: string; armed_at: string | null }>;
  invalidated_proposals: string[];
  invalidated_approvals: number;
  note: string;
};

/**
 * Local stop (prd.md 10.6, FR-09): commit PAUSED, increment the epoch so every
 * approval bound to the old epoch is stale, end all pre-arm candidates and
 * release only their never-armed holds. Commands already armed stay in flight
 * and are reported; their outcomes may still change. Idempotent.
 */
export async function stopAccount(
  runtime: KernelRuntime,
  operatorId: string,
  reason: string | undefined,
  now: Date,
): Promise<StopResult> {
  const pool = runtime.pool;
  const account = runtime.account;
  if (pool === null || account === null)
    throw new AccountControlError("NOT_READY", 503, "kernel has no loaded account");
  return withTransaction(pool, async (tx) => {
    const before = await lockAccountRow(tx, account.id);
    const wasPaused = before.status === "PAUSED";
    const updated = wasPaused ? before : await setAccountStatus(tx, account.id, "PAUSED", now, { bumpEpoch: true });
    const invalidatedApprovals = await invalidateAllActiveApprovals(tx, account.id);
    const invalidated: string[] = [];
    for (const proposal of await listPreArmProposals(tx, account.id)) {
      await endProposalInTx(tx, runtime, proposal, "INVALIDATED", "account stopped", now, {
        operator_id: operatorId,
        epoch: updated.epoch,
      });
      invalidated.push(proposal.id);
    }
    for (const conflict of await listConflicts(tx, account.id, "OPEN")) {
      await resolveConflict(tx, conflict.id, "EXPIRED", { reason: "account stopped" }, operatorId, now);
    }
    const inFlight = await listCommands(tx, account.id, ["ARMED", "OUTCOME_UNKNOWN"]);
    if (!wasPaused) {
      await appendAuditEvent(tx, {
        id: newId("evt"),
        accountId: account.id,
        type: "ACCOUNT_STOPPED",
        payload: {
          operator_id: operatorId,
          reason: reason ?? null,
          epoch: updated.epoch,
          invalidated_proposals: invalidated,
          invalidated_approvals: invalidatedApprovals,
          in_flight_commands: inFlight.map((c) => c.id),
        },
        occurredAt: now,
      });
    }
    return {
      status: "PAUSED",
      epoch: updated.epoch,
      in_flight_commands: inFlight.map(describeCommand),
      invalidated_proposals: invalidated,
      invalidated_approvals: invalidatedApprovals,
      note:
        inFlight.length > 0
          ? "Commands armed before the stop remain in flight; their outcomes may still change and are not undone."
          : "No command was in flight.",
    };
  });
}

function describeCommand(c: CommandRow): StopResult["in_flight_commands"][number] {
  return {
    command_id: c.id,
    client_order_id: c.client_order_id,
    state: c.state,
    armed_at: c.armed_at?.toISOString() ?? null,
  };
}

export type ResumeResult = {
  status: "READY";
  epoch: number;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
};

/** Operator resume (prd.md 5.1, 11.8): readiness-gated; unresolved commands and open critical incidents block it. */
export async function resumeAccount(
  runtime: KernelRuntime,
  operatorId: string,
  acknowledgedIncidents: string[],
  now: Date,
): Promise<ResumeResult> {
  const pool = runtime.pool;
  const account = runtime.account;
  if (pool === null || account === null)
    throw new AccountControlError("NOT_READY", 503, "kernel has no loaded account");
  const checks: ResumeResult["checks"] = [];
  const migrations = await migrationStatus(pool);
  checks.push({
    name: "migrations",
    ok: migrations.pending.length === 0 && migrations.drift.length === 0,
    detail: `${migrations.pending.length} pending, ${migrations.drift.length} drifted`,
  });
  checks.push({
    name: "writer_lock",
    ok: runtime.writer !== null,
    detail: runtime.writer === null ? "not held by this process" : "held",
  });
  checks.push({
    name: "execution_adapter",
    ok: runtime.execution !== null,
    detail: runtime.execution === null ? "no qualified execution adapter for this mode" : "selected",
  });
  return withTransaction(pool, async (tx) => {
    const row = await lockAccountRow(tx, account.id);
    const inFlight = await listCommands(tx, account.id, ["ARMED", "OUTCOME_UNKNOWN"]);
    checks.push({
      name: "unresolved_commands",
      ok: inFlight.length === 0,
      detail: `${inFlight.length} armed or unknown`,
    });
    const open = (await listIncidents(tx, account.id, "OPEN")).filter(
      (i) => i.severity === "CRITICAL" && !acknowledgedIncidents.includes(i.id),
    );
    checks.push({
      name: "critical_incidents",
      ok: open.length === 0,
      detail: open.length === 0 ? "none unacknowledged" : open.map((i) => `${i.id}:${i.type}`).join(", "),
    });
    if (checks.some((c) => !c.ok))
      throw new AccountControlError("STATE_CONFLICT", 409, "account cannot resume until readiness checks pass", checks);
    const updated = row.status === "READY" ? row : await setAccountStatus(tx, account.id, "READY", now);
    if (row.status !== "READY") {
      await appendAuditEvent(tx, {
        id: newId("evt"),
        accountId: account.id,
        type: "ACCOUNT_RESUMED",
        payload: {
          operator_id: operatorId,
          epoch: updated.epoch,
          acknowledged_incidents: acknowledgedIncidents,
          checks,
        },
        occurredAt: now,
      });
    }
    return { status: "READY", epoch: updated.epoch, checks };
  });
}
