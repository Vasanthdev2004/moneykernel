import {
  type ArmedCommand,
  type ExecutionResult,
  hashCanonical,
  type NormalizedFill,
  PolicySchema,
  type ReasonCode,
  TradeIntentSchema,
} from "@moneykernel/contracts";
import { bpsDrift, dec, eq, evaluate, gt, toDisplayString } from "@moneykernel/domain";
import {
  appendAuditEvent,
  type CommandRow,
  consumeApproval,
  consumeLeaseAttempt,
  countInFlightCommands,
  findOpenConflictForProposal,
  getActiveApproval,
  getAgentById,
  getCommandById,
  getCurrentPolicy,
  getIntentById,
  getLeaseById,
  getProposalById,
  insertIncident,
  latestSnapshotsBySymbol,
  listReservationsForProposal,
  lockAccountRow,
  selectReadyCommand,
  setAccountStatus,
  transitionReservations,
  updateCommandState,
  withClient,
  withTransaction,
} from "@moneykernel/persistence";
import type { KernelRuntime } from "../boot.ts";
import { newId } from "../ids.ts";
import { type ApprovedCommandPayload, exactPayloadForProposal, proposalBindingHash } from "../services/approvals.ts";
import { assembleEvaluationInput, markFromSnapshot, refreshInputsForSymbol } from "../services/evaluation.ts";
import { endProposalInTx, sweepProposalsInTx } from "../services/proposals.ts";
import { type ApplyResult, applyObservedOrderInTx, reconcileCommand } from "../services/reconciliation.ts";
import { hasLiveWriterLease } from "../services/writer.ts";

export type DispatchReport =
  | { kind: "IDLE"; detail: string }
  | { kind: "ABORTED_PRE_ARM"; command_id: string; reason_codes: ReasonCode[] }
  | {
      kind: "ARMED";
      command_id: string;
      client_order_id: string;
      outcome: ExecutionResult["kind"];
      fills: number;
      /** Accounting applied in the same transaction as the observed response (prd.md 11.3 step 9). */
      reconciliation: ApplyResult | null;
    };

const NO_ARM: DispatchReport = { kind: "IDLE", detail: "nothing to dispatch" };

function armedPayload(command: CommandRow, armedAt: Date): ArmedCommand {
  // exact_payload is compared against the approved proposal before arming.
  const persisted = command.exact_payload as ApprovedCommandPayload;
  return {
    command_id: command.id,
    environment: persisted.environment,
    account_id: persisted.account_id,
    client_order_id: persisted.client_order_id,
    symbol: persisted.symbol,
    side: persisted.side,
    order_type: persisted.order_type,
    quantity: persisted.quantity,
    limit_price: persisted.limit_price,
    armed_at: armedAt.toISOString(),
    payload_hash: persisted.proposal_hash,
  };
}

/**
 * Dispatch protocol (prd.md 11.3, INV-01, INV-03, INV-05, INV-06, INV-07):
 * one READY command per pass; refresh inputs outside the transaction; inside
 * it recheck epoch, status, agent, lease, proposal expiry, conflicts, the
 * approval binding, reservation ownership, filters, and fresh risk inputs by
 * re-evaluating the exact approved order. Then atomically consume the approval,
 * arm the command, consume the attempt slot, and commit. Only after commit is
 * the exact persisted payload sent once; the outcome is persisted as observed.
 */
export async function dispatchOnce(runtime: KernelRuntime, _requestedAt: Date): Promise<DispatchReport> {
  const pool = runtime.pool;
  const account = runtime.account;
  const execution = runtime.execution;
  if (pool === null || account === null) return { kind: "IDLE", detail: "no account" };
  if (runtime.writer === null) return { kind: "IDLE", detail: "not the writer" };
  if (execution === null) return { kind: "IDLE", detail: "no execution adapter" };

  const candidate = await withClient(pool, (client) => selectReadyCommand(client, account.id));
  if (candidate === null) return NO_ARM;
  const proposalPeek = await withClient(pool, (client) => getProposalById(client, candidate.proposal_id));
  if (proposalPeek === null) return NO_ARM;
  const refreshedRulesId = await refreshInputsForSymbol(
    runtime,
    account.id,
    account.quote_asset,
    proposalPeek.normalized_order.symbol,
  );

  const armed = await withTransaction(
    pool,
    async (tx): Promise<{ payload: ArmedCommand; command: CommandRow } | DispatchReport> => {
      const accountRow = await lockAccountRow(tx, account.id);
      if (!(await hasLiveWriterLease(runtime)))
        return { kind: "IDLE", detail: "writer ownership lost; arming blocked" };
      await sweepProposalsInTx(tx, runtime, runtime.clock());
      const command = await getCommandById(tx, candidate.id, { lock: true });
      if (command === null) return NO_ARM;
      if (command.state === "ABORTED_PRE_ARM") {
        const expiredProposal = await getProposalById(tx, command.proposal_id);
        const expiredIntent = expiredProposal === null ? null : await getIntentById(tx, expiredProposal.intent_id);
        const expiredLease = expiredIntent === null ? null : await getLeaseById(tx, expiredIntent.lease_id);
        return {
          kind: "ABORTED_PRE_ARM",
          command_id: command.id,
          reason_codes:
            expiredLease !== null && expiredLease.expires_at.getTime() <= runtime.clock().getTime()
              ? ["STALE_APPROVAL", "LEASE_EXPIRED"]
              : ["STALE_APPROVAL"],
        };
      }
      if (command.state !== "READY") return NO_ARM;
      const proposal = await getProposalById(tx, command.proposal_id, { lock: true });
      if (proposal === null) return NO_ARM;
      let now = runtime.clock();
      const order = proposal.normalized_order;
      const abort = async (codes: ReasonCode[]): Promise<DispatchReport> => {
        await endProposalInTx(
          tx,
          runtime,
          proposal,
          "INVALIDATED",
          `dispatch recheck failed: ${codes.join(",")}`,
          now,
          { command_id: command.id },
        );
        await updateCommandState(tx, command.id, "ABORTED_PRE_ARM", now, { outcomeRef: codes.join(",") });
        return { kind: "ABORTED_PRE_ARM", command_id: command.id, reason_codes: codes };
      };

      if (accountRow.status !== "READY")
        return { kind: "IDLE", detail: `account ${accountRow.status}; arming blocked` };
      if ((await countInFlightCommands(tx, account.id)) > 0)
        return { kind: "IDLE", detail: "one external in-flight command per account" };

      const codes: ReasonCode[] = [];
      if (command.account_id !== account.id || proposal.account_id !== account.id) codes.push("STALE_APPROVAL");
      if (proposal.state !== "COMMAND_CREATED") codes.push("STALE_APPROVAL");
      if (proposal.account_epoch !== accountRow.epoch) codes.push("STALE_APPROVAL");
      const approval = await getActiveApproval(tx, proposal.id);
      if (
        approval === null ||
        approval.id !== command.approval_id ||
        approval.account_id !== account.id ||
        approval.proposal_revision !== proposal.revision ||
        approval.proposal_hash !== proposal.proposal_hash ||
        approval.account_epoch !== accountRow.epoch
      ) {
        codes.push("STALE_APPROVAL");
      }
      const policyRow = await getCurrentPolicy(tx, account.id);
      if (policyRow === null || policyRow.id !== proposal.policy_id) codes.push("STALE_APPROVAL");
      else if (proposalBindingHash(proposal, policyRow.version, runtime.config.environment) !== proposal.proposal_hash)
        codes.push("STALE_APPROVAL");
      if (
        hashCanonical(command.exact_payload) !==
        hashCanonical(
          exactPayloadForProposal(runtime.config.environment, account.id, proposal, command.client_order_id),
        )
      )
        codes.push("STALE_APPROVAL");
      const intentRow = await getIntentById(tx, proposal.intent_id);
      const lease = intentRow === null ? null : await getLeaseById(tx, intentRow.lease_id, { lock: true });
      if (lease === null) codes.push("LEASE_EXPIRED");
      else {
        if (lease.revision !== proposal.lease_revision)
          codes.push(lease.status === "REVOKED" ? "LEASE_REVOKED" : "STALE_APPROVAL");
        if (lease.status === "REVOKED") codes.push("LEASE_REVOKED");
        else if (lease.status !== "ACTIVE") codes.push("LEASE_EXPIRED");
      }
      const agent = intentRow === null ? null : await getAgentById(tx, intentRow.agent_id);
      if (agent === null || agent.status !== "ACTIVE")
        codes.push(agent?.status === "QUARANTINED" ? "AGENT_QUARANTINED" : "AGENT_DISABLED");
      now = runtime.clock();
      if (
        proposal.expires_at.getTime() <= now.getTime() ||
        (approval !== null && approval.expires_at.getTime() <= now.getTime())
      )
        codes.push("STALE_APPROVAL");
      if (lease !== null && lease.expires_at.getTime() <= now.getTime()) codes.push("LEASE_EXPIRED");
      if ((await findOpenConflictForProposal(tx, proposal.id)) !== null) codes.push("OPPOSING_INTENT");
      if (codes.length > 0) return abort([...new Set(codes)]);
      if (lease === null || agent === null || policyRow === null || intentRow === null || approval === null)
        return abort(["STALE_APPROVAL"]);

      // Fresh risk inputs: price drift against the proposal's mark, then the exact approved order re-evaluated.
      const policy = PolicySchema.parse(policyRow.canonical_policy);
      const markRows = await latestSnapshotsBySymbol(tx, account.id, "MARKET", [order.symbol]);
      const markRow = markRows.get(order.symbol);
      const mark = markRow === undefined ? null : markFromSnapshot(markRow);
      if (mark === null) return abort(["STALE_MARKET_DATA"]);
      const drift = bpsDrift(dec(order.reference_mark), dec(mark.price));
      if (gt(drift, dec(policy.max_price_drift_bps))) return abort(["PRICE_DRIFT"]);

      const original = TradeIntentSchema.parse(intentRow.canonical_payload);
      const exact = TradeIntentSchema.parse({
        ...original,
        limit_price: order.limit_price,
        size:
          order.side === "BUY"
            ? { kind: "QUOTE_NOTIONAL", quote_asset: account.quote_asset, amount: order.notional_quote }
            : {
                kind: "BASE_QUANTITY",
                base_asset: original.size.kind === "BASE_QUANTITY" ? original.size.base_asset : "",
                amount: order.quantity,
              },
        observation_ids: [],
      });
      const { input, baseAsset } = await assembleEvaluationInput({
        tx,
        accountRow,
        agent,
        lease,
        policyRow,
        policy,
        intent: exact,
        now,
        refreshedRulesId,
        excludeProposalId: proposal.id,
      });
      const recheck = evaluate(input);
      const same =
        recheck.candidate !== null &&
        recheck.outcome === "ALLOW_PROPOSAL" &&
        recheck.candidate.quantity === order.quantity &&
        recheck.candidate.limit_price === order.limit_price &&
        recheck.candidate.notional_quote === order.notional_quote;
      if (!same) {
        const reasons = recheck.reason_codes.length > 0 ? recheck.reason_codes : (["STALE_APPROVAL"] as ReasonCode[]);
        return abort([...new Set(reasons)]);
      }

      // Re-evaluating capacity does not prove this proposal still owns the
      // exact financial hold and single attempt slot granted at admission.
      const reservations = await listReservationsForProposal(tx, proposal.id);
      const attemptHold = reservations.find((r) => r.kind === "ATTEMPT");
      const fundsHold = reservations.find((r) => r.kind === (order.side === "BUY" ? "QUOTE" : "BASE"));
      if (
        reservations.length !== 2 ||
        reservations.some((r) => r.state !== "HELD" || r.account_id !== account.id || r.agent_id !== agent.id) ||
        attemptHold === undefined ||
        attemptHold.asset !== "ATTEMPT" ||
        !eq(dec(attemptHold.amount), dec("1")) ||
        fundsHold === undefined ||
        fundsHold.asset !== (order.side === "BUY" ? account.quote_asset : baseAsset) ||
        !eq(dec(fundsHold.amount), dec(order.side === "BUY" ? order.total_quote_reserved : order.base_reserved))
      )
        return abort(["STALE_APPROVAL"]);

      if (!(await hasLiveWriterLease(runtime)))
        return { kind: "IDLE", detail: "writer ownership lost; arming blocked" };

      // Arm: linearization point (prd.md 11.2). Consumes the approval and the attempt slot exactly once.
      const consumed = await consumeApproval(tx, approval.id, now);
      if (consumed === null) return abort(["STALE_APPROVAL"]);
      await consumeLeaseAttempt(tx, lease.id, now);
      const consumedSlots = await transitionReservations(tx, proposal.id, ["HELD"], "CONSUMED", now, ["ATTEMPT"]);
      const armedHolds = await transitionReservations(tx, proposal.id, ["HELD"], "ARMED", now, ["QUOTE", "BASE"]);
      if (consumedSlots !== 1 || armedHolds !== 1) throw new Error("reservation ownership changed during arm");
      const armedCommand = await updateCommandState(tx, command.id, "ARMED", now, { armedAt: now });
      const payload = armedPayload(armedCommand, now);
      await appendAuditEvent(tx, {
        id: newId("evt"),
        accountId: account.id,
        type: "COMMAND_ARMED",
        payload: {
          command_id: command.id,
          proposal_id: proposal.id,
          approval_id: approval.id,
          client_order_id: command.client_order_id,
          exact_payload: payload,
          drift_bps: toDisplayString(drift),
        },
        occurredAt: now,
      });
      await appendAuditEvent(tx, {
        id: newId("evt"),
        accountId: account.id,
        type: "APPROVAL_CONSUMED",
        payload: { approval_id: approval.id, proposal_id: proposal.id, command_id: command.id },
        occurredAt: now,
      });
      return { payload, command: armedCommand };
    },
  );

  if (!("payload" in armed)) return armed;
  return submitArmed(runtime, armed.command, armed.payload);
}

/** Sends the exact persisted payload once and records what was observed. Never resends on ambiguity (INV-07). */
async function submitArmed(
  runtime: KernelRuntime,
  command: CommandRow,
  payload: ArmedCommand,
): Promise<DispatchReport> {
  const pool = runtime.pool;
  const account = runtime.account;
  const execution = runtime.execution;
  if (pool === null || account === null || execution === null) return NO_ARM;
  let result: ExecutionResult;
  try {
    result = await execution.submitOnce(payload);
  } catch (error) {
    result = {
      kind: "OUTCOME_UNKNOWN",
      clientOrderId: payload.client_order_id,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const now = runtime.clock();
  let fills: NormalizedFill[] = [];
  if (result.kind === "ACCEPTED") {
    const page = await execution.listRelevantFills({ since_event_time: null, since_fill_id: null });
    fills = page.fills.filter((f) => f.order.client_order_id === payload.client_order_id);
  }
  let reconciliation: ApplyResult | null = null;
  let outcome = result.kind;
  let recheckKnownAcceptance = false;
  await withTransaction(pool, async (tx) => {
    await lockAccountRow(tx, account.id);
    const locked = await getCommandById(tx, command.id, { lock: true });
    if (locked === null) throw new Error(`command ${command.id} vanished`);
    if (result.kind !== "ACCEPTED" && locked.state === "ACCEPTED") {
      // A concurrent query may already have observed acceptance while submitOnce
      // was waiting. A late timeout or duplicate rejection cannot undo that
      // evidence, release unsettled holds, or reopen a reconciled command.
      outcome = "ACCEPTED";
      recheckKnownAcceptance = locked.reconciled_at === null;
      await appendAuditEvent(tx, {
        id: newId("evt"),
        accountId: account.id,
        type: "COMMAND_OUTCOME",
        payload: {
          command_id: command.id,
          outcome: "ACCEPTED",
          received_outcome: result.kind,
          detail: result.detail,
          note: "late submission response; recorded acceptance retained",
        },
        occurredAt: now,
      });
      return;
    }
    if (result.kind === "ACCEPTED") {
      // Persist the normalized response and reconcile observed fills in one transaction (prd.md 11.3 step 9).
      reconciliation = await applyObservedOrderInTx(tx, runtime, {
        command: locked,
        order: result.order,
        fills,
        now,
        source: "DISPATCH",
      });
      const observed = await getCommandById(tx, command.id);
      if (observed?.state === "OUTCOME_UNKNOWN") outcome = "OUTCOME_UNKNOWN";
    } else if (result.kind === "REJECTED_CONFIRMED") {
      await updateCommandState(tx, command.id, "REJECTED_CONFIRMED", now, {
        outcomeRef: `${result.code}: ${result.detail}`,
      });
      await transitionReservations(tx, command.proposal_id, ["ARMED"], "RELEASED", now);
      await appendAuditEvent(tx, {
        id: newId("evt"),
        accountId: account.id,
        type: "COMMAND_OUTCOME",
        payload: {
          command_id: command.id,
          outcome: "REJECTED_CONFIRMED",
          code: result.code,
          detail: result.detail,
          note: "attempt consumed; holds released",
        },
        occurredAt: now,
      });
    } else {
      await updateCommandState(tx, command.id, "OUTCOME_UNKNOWN", now, { outcomeRef: result.detail });
      await setAccountStatus(tx, account.id, "RECONCILING", now);
      await insertIncident(tx, {
        id: newId("incident"),
        accountId: account.id,
        agentId: null,
        type: "OUTCOME_UNKNOWN",
        severity: "CRITICAL",
        status: "OPEN",
        evidence: { command_id: command.id, client_order_id: payload.client_order_id, detail: result.detail },
        now,
      });
      await appendAuditEvent(tx, {
        id: newId("evt"),
        accountId: account.id,
        type: "COMMAND_OUTCOME",
        payload: {
          command_id: command.id,
          outcome: "OUTCOME_UNKNOWN",
          detail: result.detail,
          note: "reservations retained; account reconciling; no automatic resend",
        },
        occurredAt: now,
      });
    }
  });
  if (recheckKnownAcceptance) {
    // Investigate contradictory responses by stable identity after committing
    // the observation, without resubmitting or releasing unresolved resources.
    const rechecked = await reconcileCommand(runtime, command.id, runtime.clock(), "DISPATCH");
    reconciliation = rechecked.apply;
    if (rechecked.after === "OUTCOME_UNKNOWN") outcome = "OUTCOME_UNKNOWN";
  }
  return {
    kind: "ARMED",
    command_id: command.id,
    client_order_id: payload.client_order_id,
    outcome,
    fills: fills.length,
    reconciliation,
  };
}
