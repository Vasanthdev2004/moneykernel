import {
  appendAuditEvent,
  countOutstandingCommands,
  getProposalById,
  invalidateAllActiveApprovals,
  listCommandsNeedingReconciliation,
  listConflictMembers,
  listConflicts,
  listPreArmProposals,
  lockAccountRow,
  PRE_ARM_STATES,
  resolveConflict,
  withClient,
  withTransaction,
} from "@moneykernel/persistence";
import type { KernelRuntime } from "../boot.ts";
import { newId } from "../ids.ts";
import { endProposalInTx } from "./proposals.ts";
import { type ReconcileReport, reconcileCommand } from "./reconciliation.ts";

export type RecoveryReport = {
  examined: number;
  reconciled: string[];
  unsettled: string[];
  unknown: string[];
  invalidated_proposals: string[];
  invalidated_approvals: number;
  expired_conflicts: number;
  outstanding_after: number;
  reports: ReconcileReport[];
};

/**
 * Restart protocol, remainder of prd.md 11.8 (boot already paused the account
 * and advanced the epoch): reconcile armed/unknown/unsettled commands against
 * the venue by their stable identities, never by resending; invalidate every
 * approval bound to the previous epoch; end the pre-arm proposals it covered
 * and release only their never-armed holds. Armed holds stay until their
 * command is reconciled. The account remains PAUSED for an operator.
 */
export async function recoverOnBoot(runtime: KernelRuntime, now: Date): Promise<RecoveryReport> {
  const pool = runtime.pool;
  const account = runtime.account;
  const report: RecoveryReport = {
    examined: 0,
    reconciled: [],
    unsettled: [],
    unknown: [],
    invalidated_proposals: [],
    invalidated_approvals: 0,
    expired_conflicts: 0,
    outstanding_after: 0,
    reports: [],
  };
  if (pool === null || account === null) return report;

  const pending = await withClient(pool, (client) => listCommandsNeedingReconciliation(client, account.id));
  for (const command of pending) {
    report.examined += 1;
    const result = await reconcileCommand(runtime, command.id, now, "BOOT");
    report.reports.push(result);
    if (result.result === "RECONCILED") report.reconciled.push(command.id);
    else if (result.result === "ACCEPTED_UNSETTLED") report.unsettled.push(command.id);
    else report.unknown.push(command.id);
  }

  await withTransaction(pool, async (tx) => {
    const row = await lockAccountRow(tx, account.id);
    // Every approval was bound to the previous epoch. Proposals that carried one (APPROVED, COMMAND_CREATED with a
    // READY command) end here with their never-armed holds released; proposals still collecting or awaiting
    // approval keep their holds until their own TTL, so an idempotent retry after the restart sees the same
    // decision (prd.md 11.8: release only provably never-armed *expired* holds).
    report.invalidated_approvals = await invalidateAllActiveApprovals(tx, account.id);
    for (const proposal of await listPreArmProposals(tx, account.id)) {
      if (proposal.expires_at.getTime() <= now.getTime()) {
        await endProposalInTx(tx, runtime, proposal, "EXPIRED", "proposal TTL elapsed during downtime", now, {
          epoch: row.epoch,
        });
        report.invalidated_proposals.push(proposal.id);
      } else if (proposal.state === "APPROVED" || proposal.state === "COMMAND_CREATED") {
        await endProposalInTx(tx, runtime, proposal, "INVALIDATED", "approval bound to the previous epoch", now, {
          epoch: row.epoch,
        });
        report.invalidated_proposals.push(proposal.id);
      }
    }
    for (const conflict of await listConflicts(tx, account.id, "OPEN")) {
      const members = await listConflictMembers(tx, conflict.id);
      const stillOpen = await Promise.all(members.map((id) => getProposalById(tx, id)));
      if (stillOpen.some((p) => p !== null && PRE_ARM_STATES.includes(p.state))) continue;
      await resolveConflict(tx, conflict.id, "EXPIRED", { reason: "members ended during downtime" }, null, now);
      report.expired_conflicts += 1;
    }
    report.outstanding_after = (await countOutstandingCommands(tx, account.id)).total;
    if (
      report.examined > 0 ||
      report.invalidated_proposals.length > 0 ||
      report.invalidated_approvals > 0 ||
      report.expired_conflicts > 0
    ) {
      await appendAuditEvent(tx, {
        id: newId("evt"),
        accountId: account.id,
        type: "ACCOUNT_RECONCILING",
        payload: {
          epoch: row.epoch,
          examined_commands: report.examined,
          reconciled: report.reconciled,
          unsettled: report.unsettled,
          unknown: report.unknown,
          invalidated_proposals: report.invalidated_proposals,
          invalidated_approvals: report.invalidated_approvals,
          expired_conflicts: report.expired_conflicts,
          outstanding_after: report.outstanding_after,
          note: "boot recovery: query by stable order identity, no resend; operator resume required",
        },
        occurredAt: now,
      });
    }
  });
  return report;
}
