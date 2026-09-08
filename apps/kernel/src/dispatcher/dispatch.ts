import {
  type ArmedCommand,
  type CandidateOrder,
  type ExecutionResult,
  type NormalizedFill,
  PolicySchema,
  type ReasonCode,
  TradeIntentSchema,
} from "@moneykernel/contracts";
import { bpsDrift, dec, evaluate, gt, toDecimalString } from "@moneykernel/domain";
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
  insertFillOnce,
  insertIncident,
  insertOrder,
  latestSnapshotsBySymbol,
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
import { assembleEvaluationInput, markFromSnapshot, refreshInputsForSymbol } from "../services/evaluation.ts";
import { endProposalInTx } from "../services/proposals.ts";

export type DispatchReport =
  | { kind: "IDLE"; detail: string }
  | { kind: "ABORTED_PRE_ARM"; command_id: string; reason_codes: ReasonCode[] }
  | { kind: "ARMED"; command_id: string; client_order_id: string; outcome: ExecutionResult["kind"]; fills: number };

const NO_ARM: DispatchReport = { kind: "IDLE", detail: "nothing to dispatch" };

function armedPayload(
  command: CommandRow,
  order: CandidateOrder,
  runtime: KernelRuntime,
  accountId: string,
  armedAt: Date,
): ArmedCommand {
  return {
    command_id: command.id,
    environment: runtime.config.environment,
    account_id: accountId,
    client_order_id: command.client_order_id,
    symbol: order.symbol,
    side: order.side,
    order_type: order.order_type,
    quantity: order.quantity,
    limit_price: order.limit_price,
    armed_at: armedAt.toISOString(),
    payload_hash: typeof command.exact_payload.proposal_hash === "string" ? command.exact_payload.proposal_hash : "",
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
export async function dispatchOnce(runtime: KernelRuntime, now: Date): Promise<DispatchReport> {
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
      const command = await getCommandById(tx, candidate.id, { lock: true });
      if (command === null || command.state !== "READY") return NO_ARM;
      const proposal = await getProposalById(tx, command.proposal_id, { lock: true });
      if (proposal === null) return NO_ARM;
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
      if (proposal.state !== "COMMAND_CREATED") codes.push("STALE_APPROVAL");
      if (proposal.account_epoch !== accountRow.epoch) codes.push("STALE_APPROVAL");
      if (proposal.expires_at.getTime() <= now.getTime()) codes.push("STALE_APPROVAL");
      const approval = await getActiveApproval(tx, proposal.id);
      if (
        approval === null ||
        approval.id !== command.approval_id ||
        approval.proposal_hash !== proposal.proposal_hash ||
        approval.account_epoch !== accountRow.epoch ||
        approval.expires_at.getTime() <= now.getTime()
      ) {
        codes.push("STALE_APPROVAL");
      }
      const policyRow = await getCurrentPolicy(tx, account.id);
      if (policyRow === null || policyRow.id !== proposal.policy_id) codes.push("STALE_APPROVAL");
      const intentRow = await getIntentById(tx, proposal.intent_id);
      const lease = intentRow === null ? null : await getLeaseById(tx, intentRow.lease_id, { lock: true });
      if (lease === null) codes.push("LEASE_EXPIRED");
      else {
        if (lease.revision !== proposal.lease_revision)
          codes.push(lease.status === "REVOKED" ? "LEASE_REVOKED" : "STALE_APPROVAL");
        if (lease.status === "REVOKED") codes.push("LEASE_REVOKED");
        else if (lease.status !== "ACTIVE") codes.push("LEASE_EXPIRED");
        if (lease.expires_at.getTime() <= now.getTime()) codes.push("LEASE_EXPIRED");
      }
      const agent = intentRow === null ? null : await getAgentById(tx, intentRow.agent_id);
      if (agent === null || agent.status !== "ACTIVE")
        codes.push(agent?.status === "QUARANTINED" ? "AGENT_QUARANTINED" : "AGENT_DISABLED");
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
      const { input } = await assembleEvaluationInput({
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

      // Arm: linearization point (prd.md 11.2). Consumes the approval and the attempt slot exactly once.
      const consumed = await consumeApproval(tx, approval.id, now);
      if (consumed === null) return abort(["STALE_APPROVAL"]);
      await consumeLeaseAttempt(tx, lease.id, now);
      await transitionReservations(tx, proposal.id, ["HELD"], "CONSUMED", now, ["ATTEMPT"]);
      await transitionReservations(tx, proposal.id, ["HELD"], "ARMED", now, ["QUOTE", "BASE"]);
      const armedCommand = await updateCommandState(tx, command.id, "ARMED", now, { armedAt: now });
      const payload = armedPayload(armedCommand, order, runtime, account.id, now);
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
          drift_bps: toDecimalString(drift),
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
  await withTransaction(pool, async (tx) => {
    await lockAccountRow(tx, account.id);
    if (result.kind === "ACCEPTED") {
      const orderRow = await insertOrder(tx, {
        id: newId("order"),
        accountId: account.id,
        commandId: command.id,
        exchangeOrderId: result.order.exchange_order_id,
        clientOrderId: payload.client_order_id,
        symbol: result.order.symbol,
        status: result.order.status,
        executedBase: result.order.executed_base,
        executedQuote: result.order.executed_quote,
        observedAt: now,
      });
      for (const fill of fills) {
        await insertFillOnce(tx, {
          id: newId("fill"),
          accountId: account.id,
          orderId: orderRow.id,
          exchangeTradeId: fill.fill_id,
          symbol: fill.symbol,
          baseQty: fill.base_qty,
          price: fill.price,
          quoteQty: fill.quote_qty,
          commissionAsset: fill.commission_asset,
          commissionQty: fill.commission_qty,
          eventTime: new Date(fill.event_time),
        });
      }
      await updateCommandState(tx, command.id, "ACCEPTED", now, { outcomeRef: orderRow.id });
      await appendAuditEvent(tx, {
        id: newId("evt"),
        accountId: account.id,
        type: "ORDER_OBSERVED",
        payload: {
          command_id: command.id,
          order_id: orderRow.id,
          client_order_id: payload.client_order_id,
          status: result.order.status,
          executed_base: result.order.executed_base,
          executed_quote: result.order.executed_quote,
          fills: fills.length,
          note: "accepted is not reconciled; accounting settles in reconciliation",
        },
        occurredAt: now,
      });
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
  return {
    kind: "ARMED",
    command_id: command.id,
    client_order_id: payload.client_order_id,
    outcome: result.kind,
    fills: fills.length,
  };
}
