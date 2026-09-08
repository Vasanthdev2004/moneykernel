import type { NormalizedFill, NormalizedOrder, OrderQueryResult } from "@moneykernel/contracts";
import { add, dec, eq, gt, isZero, max, min, sub, toDecimalString, ZERO } from "@moneykernel/domain";
import type { PoolClient } from "@moneykernel/persistence";
import {
  addLeaseConsumedQuote,
  appendAuditEvent,
  appendLedgerEntries,
  applyAllocationDelta,
  applyBalanceDelta,
  type CommandRow,
  type CommandState,
  countOutstandingCommands,
  getCommandById,
  getIntentById,
  getOrderForCommand,
  getProposalById,
  insertFillOnce,
  insertIncident,
  insertOrder,
  type LedgerEntryInput,
  latestSnapshotsBySymbol,
  listCommandsNeedingReconciliation,
  listFillsForOrder,
  listOpenIncidentsForCommand,
  listReservationsForProposal,
  lockAccountRow,
  type OrderRow,
  type ProposalRow,
  resolveIncident,
  setAccountStatus,
  settleArmedReservation,
  updateCommandState,
  updateOrderObservation,
  withClient,
  withTransaction,
} from "@moneykernel/persistence";
import type { KernelRuntime } from "../boot.ts";
import { newId } from "../ids.ts";

export type ReconciliationSource = "DISPATCH" | "BOOT" | "BACKGROUND" | "OPERATOR";

const TERMINAL_ORDER_STATES: NormalizedOrder["status"][] = ["FILLED", "CANCELED", "EXPIRED"];

/** Bounded investigation window for automatic re-queries (prd.md 11.7): after this many, only an operator retries. */
export const MAX_AUTOMATIC_RECONCILE_ATTEMPTS = 6;

export type ApplyResult = {
  order_id: string;
  order_status: NormalizedOrder["status"];
  new_fills: number;
  duplicate_fills: number;
  skipped_fills: number;
  /** Terminal order, fill detail matches the order totals, every fee asset supported. */
  complete: boolean;
  /** `commands.reconciled_at` was set in this transaction. */
  reconciled: boolean;
  executed_base: string;
  executed_quote: string;
  fee_quote: string;
  fee_base: string;
  consumed_quote: string;
  released_quote: string;
  consumed_base: string;
  released_base: string;
  lease_consumed_delta: string;
  problems: string[];
};

type FillDeltas = {
  base: string;
  quote: string;
  feeAsset: string;
  fee: string;
  baseDelta: string;
  quoteDelta: string;
  allocationDelta: string;
  leaseDelta: string;
};

function fillDeltas(
  side: "BUY" | "SELL",
  quoteAsset: string,
  baseAsset: string,
  fill: NormalizedFill,
): FillDeltas | null {
  const base = dec(fill.base_qty);
  const quote = dec(fill.quote_qty);
  const fee = dec(fill.commission_qty);
  const feeInQuote = fill.commission_asset === quoteAsset;
  const feeInBase = fill.commission_asset === baseAsset;
  if (!feeInQuote && !feeInBase && !isZero(fee)) return null;
  const baseDelta = side === "BUY" ? base : base.negated();
  const quoteDelta = side === "BUY" ? quote.negated() : quote;
  return {
    base: fill.base_qty,
    quote: fill.quote_qty,
    feeAsset: fill.commission_asset,
    fee: fill.commission_qty,
    baseDelta: toDecimalString(feeInBase ? sub(baseDelta, fee) : baseDelta),
    quoteDelta: toDecimalString(feeInQuote ? sub(quoteDelta, fee) : quoteDelta),
    // Net acquired (or net released) inventory: a base-asset fee reduces what the agent actually holds (T-15).
    allocationDelta: toDecimalString(feeInBase ? sub(baseDelta, fee) : baseDelta),
    // Acquisition budget consumes executed BUY cost plus any quote fee; SELL proceeds never replenish it (T-16).
    leaseDelta: toDecimalString(side === "BUY" ? (feeInQuote ? add(quote, fee) : quote) : ZERO),
  };
}

async function baseAssetFor(
  tx: PoolClient,
  accountId: string,
  proposal: ProposalRow,
  intentPayload: unknown,
): Promise<string> {
  const rules = await latestSnapshotsBySymbol(tx, accountId, "SYMBOL_RULES", [proposal.normalized_order.symbol]);
  const row = rules.get(proposal.normalized_order.symbol);
  if (row !== undefined && typeof row.payload.base_asset === "string") return row.payload.base_asset;
  const size = (intentPayload as { size?: { kind?: string; base_asset?: string } }).size;
  if (size?.kind === "BASE_QUANTITY" && typeof size.base_asset === "string") return size.base_asset;
  throw new Error(`cannot determine the base asset for ${proposal.normalized_order.symbol}`);
}

async function raiseIncidentOnce(
  tx: PoolClient,
  accountId: string,
  agentId: string | null,
  commandId: string,
  type: string,
  severity: "WARNING" | "CRITICAL",
  evidence: Record<string, unknown>,
  now: Date,
): Promise<void> {
  const open = await listOpenIncidentsForCommand(tx, accountId, commandId);
  if (open.some((i) => i.type === type)) return;
  const incident = await insertIncident(tx, {
    id: newId("incident"),
    accountId,
    agentId,
    type,
    severity,
    status: "OPEN",
    evidence: { command_id: commandId, ...evidence },
    now,
  });
  await appendAuditEvent(tx, {
    id: newId("evt"),
    accountId,
    type: "INCIDENT_RAISED",
    payload: { incident_id: incident.id, type, severity, command_id: commandId, ...evidence },
    occurredAt: now,
  });
}

/**
 * Fill application shape (prd.md 28.3, 11.6, 14.4 "Fill reconciliation"):
 * insert each fill by its external identity; apply signed base/quote/fee
 * journal deltas, controlled balances, and inventory attribution exactly once
 * per new fill; move executed BUY cost into consumed lease budget; on a
 * terminal order whose fill detail matches its totals, settle the armed hold
 * (consume the executed part, release only the remainder) and stamp the
 * command reconciled. Order totals are cross-checks; fills drive the ledger.
 * The caller holds the account row lock and the command row lock.
 */
export async function applyObservedOrderInTx(
  tx: PoolClient,
  runtime: KernelRuntime,
  input: {
    command: CommandRow;
    order: NormalizedOrder;
    fills: NormalizedFill[];
    now: Date;
    source: ReconciliationSource;
  },
): Promise<ApplyResult> {
  const { command, order, now, source } = input;
  const account = runtime.account;
  if (account === null) throw new Error("no account");
  const accountId = command.account_id;
  const quoteAsset = account.quote_asset;
  const proposal = await getProposalById(tx, command.proposal_id);
  if (proposal === null) throw new Error(`proposal ${command.proposal_id} missing for command ${command.id}`);
  const intent = await getIntentById(tx, proposal.intent_id);
  if (intent === null) throw new Error(`intent ${proposal.intent_id} missing`);
  const side = proposal.normalized_order.side;
  const baseAsset = await baseAssetFor(tx, accountId, proposal, intent.canonical_payload);
  const problems: string[] = [];

  const existing = await getOrderForCommand(tx, command.id);
  const orderRow: OrderRow =
    existing === null
      ? await insertOrder(tx, {
          id: newId("order"),
          accountId,
          commandId: command.id,
          exchangeOrderId: order.exchange_order_id,
          clientOrderId: command.client_order_id,
          symbol: order.symbol,
          status: order.status,
          executedBase: order.executed_base,
          executedQuote: order.executed_quote,
          observedAt: now,
        })
      : await updateOrderObservation(tx, existing.id, {
          status: order.status,
          executedBase: order.executed_base,
          executedQuote: order.executed_quote,
          exchangeOrderId: order.exchange_order_id,
          observedAt: now,
        });

  let newFills = 0;
  let duplicateFills = 0;
  let skippedFills = 0;
  let leaseConsumedDelta = ZERO;
  for (const fill of input.fills.filter((f) => f.order.client_order_id === command.client_order_id)) {
    const deltas = fillDeltas(side, quoteAsset, baseAsset, fill);
    if (deltas === null) {
      // T-45: an unsupported fee asset is never dropped from the ledger and never guessed; the command stays open.
      skippedFills += 1;
      problems.push(
        `fill ${fill.fill_id} charges fee in ${fill.commission_asset}; only ${quoteAsset}/${baseAsset} fees are modelled`,
      );
      await raiseIncidentOnce(
        tx,
        accountId,
        intent.agent_id,
        command.id,
        "UNSUPPORTED_FEE_ASSET",
        "CRITICAL",
        {
          fill_id: fill.fill_id,
          commission_asset: fill.commission_asset,
          commission_qty: fill.commission_qty,
          note: "fill retained at the venue; accounting paused until the fee model is qualified (prd.md 11.7)",
        },
        now,
      );
      continue;
    }
    const inserted = await insertFillOnce(tx, {
      id: newId("fill"),
      accountId,
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
    if (inserted === null) {
      duplicateFills += 1; // T-39: already applied; the ledger's unique index would refuse a second application anyway.
      continue;
    }
    newFills += 1;
    const entries: LedgerEntryInput[] = [
      {
        id: newId("ledger"),
        agentId: intent.agent_id,
        asset: baseAsset,
        signedDelta: toDecimalString(side === "BUY" ? dec(deltas.base) : dec(deltas.base).negated()),
        category: "FILL_BASE",
        sourceFillId: inserted.id,
        sourceRef: fill.fill_id,
      },
      {
        id: newId("ledger"),
        agentId: intent.agent_id,
        asset: quoteAsset,
        signedDelta: toDecimalString(side === "BUY" ? dec(deltas.quote).negated() : dec(deltas.quote)),
        category: "FILL_QUOTE",
        sourceFillId: inserted.id,
        sourceRef: fill.fill_id,
      },
    ];
    if (!isZero(dec(deltas.fee))) {
      entries.push({
        id: newId("ledger"),
        agentId: intent.agent_id,
        asset: deltas.feeAsset,
        signedDelta: toDecimalString(dec(deltas.fee).negated()),
        category: "FILL_FEE",
        sourceFillId: inserted.id,
        sourceRef: fill.fill_id,
      });
    }
    await appendLedgerEntries(tx, accountId, entries, now);
    await applyBalanceDelta(tx, accountId, baseAsset, deltas.baseDelta);
    await applyBalanceDelta(tx, accountId, quoteAsset, deltas.quoteDelta);
    await applyAllocationDelta(tx, accountId, intent.agent_id, baseAsset, deltas.allocationDelta);
    if (!isZero(dec(deltas.leaseDelta))) {
      await addLeaseConsumedQuote(tx, intent.lease_id, deltas.leaseDelta, now);
      leaseConsumedDelta = add(leaseConsumedDelta, dec(deltas.leaseDelta));
    }
    await appendAuditEvent(tx, {
      id: newId("evt"),
      accountId,
      type: "FILL_RECONCILED",
      payload: {
        command_id: command.id,
        order_id: orderRow.id,
        fill_id: inserted.id,
        exchange_trade_id: fill.fill_id,
        symbol: fill.symbol,
        side,
        base_qty: fill.base_qty,
        price: fill.price,
        quote_qty: fill.quote_qty,
        commission_asset: fill.commission_asset,
        commission_qty: fill.commission_qty,
        base_delta: deltas.baseDelta,
        quote_delta: deltas.quoteDelta,
        agent_id: intent.agent_id,
        agent_allocation_delta: deltas.allocationDelta,
        lease_id: intent.lease_id,
        lease_consumed_delta: deltas.leaseDelta,
        source,
      },
      occurredAt: now,
    });
  }

  // Cross-check: fills recorded for this order versus the venue's order totals (prd.md 28.3).
  const recorded = await listFillsForOrder(tx, orderRow.id);
  let sumBase = ZERO;
  let sumQuote = ZERO;
  let feeQuote = ZERO;
  let feeBase = ZERO;
  for (const f of recorded) {
    sumBase = add(sumBase, dec(f.base_qty));
    sumQuote = add(sumQuote, dec(f.quote_qty));
    if (f.commission_asset === quoteAsset) feeQuote = add(feeQuote, dec(f.commission_qty));
    else if (f.commission_asset === baseAsset) feeBase = add(feeBase, dec(f.commission_qty));
  }
  const totalsAgree = eq(sumBase, dec(order.executed_base)) && eq(sumQuote, dec(order.executed_quote));
  if (!totalsAgree) {
    problems.push(
      `order totals ${order.executed_base}/${order.executed_quote} differ from recorded fills ${toDecimalString(sumBase)}/${toDecimalString(sumQuote)}; conservative buffer kept`,
    );
    await raiseIncidentOnce(
      tx,
      accountId,
      intent.agent_id,
      command.id,
      "FILL_DETAIL_INCOMPLETE",
      "WARNING",
      {
        order_id: orderRow.id,
        executed_base: order.executed_base,
        executed_quote: order.executed_quote,
        fills_base: toDecimalString(sumBase),
        fills_quote: toDecimalString(sumQuote),
      },
      now,
    );
  }
  const terminal = TERMINAL_ORDER_STATES.includes(order.status);
  const complete = terminal && totalsAgree && skippedFills === 0;

  let consumedQuote = ZERO;
  let releasedQuote = ZERO;
  let consumedBase = ZERO;
  let releasedBase = ZERO;
  let reconciled = false;
  if (complete) {
    const executedCostQuote = add(sumQuote, feeQuote);
    const executedBaseOut = add(sumBase, feeBase);
    for (const reservation of await listReservationsForProposal(tx, proposal.id)) {
      if (reservation.state !== "ARMED") continue;
      const held = dec(reservation.amount);
      const wanted =
        reservation.kind === "QUOTE" ? executedCostQuote : reservation.kind === "BASE" ? executedBaseOut : ZERO;
      const consumed = min(held, wanted);
      const released = max(sub(held, wanted), ZERO);
      if (gt(wanted, held)) {
        problems.push(
          `executed ${reservation.kind} ${toDecimalString(wanted)} exceeded the hold ${reservation.amount}`,
        );
        await raiseIncidentOnce(
          tx,
          accountId,
          intent.agent_id,
          command.id,
          "RESERVATION_SHORTFALL",
          "WARNING",
          {
            reservation_id: reservation.id,
            kind: reservation.kind,
            held: reservation.amount,
            executed: toDecimalString(wanted),
          },
          now,
        );
      }
      await settleArmedReservation(
        tx,
        reservation,
        toDecimalString(consumed),
        toDecimalString(released),
        newId("rsv"),
        now,
      );
      if (reservation.kind === "QUOTE") {
        consumedQuote = add(consumedQuote, consumed);
        releasedQuote = add(releasedQuote, released);
      } else if (reservation.kind === "BASE") {
        consumedBase = add(consumedBase, consumed);
        releasedBase = add(releasedBase, released);
      }
      await appendAuditEvent(tx, {
        id: newId("evt"),
        accountId,
        type: "RESERVATION_CONSUMED",
        payload: {
          proposal_id: proposal.id,
          command_id: command.id,
          reservation_id: reservation.id,
          kind: reservation.kind,
          asset: reservation.asset,
          held: reservation.amount,
          consumed: toDecimalString(consumed),
          released: toDecimalString(released),
          note: "only the unfilled remainder is released after terminal reconciliation (prd.md 11.6)",
        },
        occurredAt: now,
      });
    }
    await updateCommandState(tx, command.id, "ACCEPTED", now, { outcomeRef: orderRow.id, reconciledAt: now });
    for (const incident of await listOpenIncidentsForCommand(tx, accountId, command.id)) {
      if (incident.type !== "OUTCOME_UNKNOWN") continue;
      await resolveIncident(tx, incident.id, `reconciler:${source}`, now);
      await appendAuditEvent(tx, {
        id: newId("evt"),
        accountId,
        type: "INCIDENT_RESOLVED",
        payload: {
          incident_id: incident.id,
          type: incident.type,
          command_id: command.id,
          resolved_by: `reconciler:${source}`,
        },
        occurredAt: now,
      });
    }
    reconciled = true;
  } else if (command.state !== "ACCEPTED") {
    // The venue knows the order: it is accepted, just not settled yet. Holds stay ARMED.
    await updateCommandState(tx, command.id, "ACCEPTED", now, { outcomeRef: orderRow.id });
  }

  await appendAuditEvent(tx, {
    id: newId("evt"),
    accountId,
    type: "ORDER_OBSERVED",
    payload: {
      command_id: command.id,
      order_id: orderRow.id,
      client_order_id: command.client_order_id,
      exchange_order_id: order.exchange_order_id,
      status: order.status,
      executed_base: order.executed_base,
      executed_quote: order.executed_quote,
      new_fills: newFills,
      duplicate_fills: duplicateFills,
      skipped_fills: skippedFills,
      complete,
      reconciled,
      consumed_quote: toDecimalString(consumedQuote),
      released_quote: toDecimalString(releasedQuote),
      consumed_base: toDecimalString(consumedBase),
      released_base: toDecimalString(releasedBase),
      problems,
      source,
    },
    occurredAt: now,
  });

  if (reconciled) {
    const accountRow = await lockAccountRow(tx, accountId);
    if (accountRow.status === "RECONCILING" && (await countOutstandingCommands(tx, accountId)).total === 0) {
      await setAccountStatus(tx, accountId, "PAUSED", now);
      await appendAuditEvent(tx, {
        id: newId("evt"),
        accountId,
        type: "ACCOUNT_RECONCILED",
        payload: { command_id: command.id, status: "PAUSED", note: "operator resume required (prd.md 11.1)" },
        occurredAt: now,
      });
    }
  }

  return {
    order_id: orderRow.id,
    order_status: order.status,
    new_fills: newFills,
    duplicate_fills: duplicateFills,
    skipped_fills: skippedFills,
    complete,
    reconciled,
    executed_base: toDecimalString(sumBase),
    executed_quote: toDecimalString(sumQuote),
    fee_quote: toDecimalString(feeQuote),
    fee_base: toDecimalString(feeBase),
    consumed_quote: toDecimalString(consumedQuote),
    released_quote: toDecimalString(releasedQuote),
    consumed_base: toDecimalString(consumedBase),
    released_base: toDecimalString(releasedBase),
    lease_consumed_delta: toDecimalString(leaseConsumedDelta),
    problems,
  };
}

export type ReconcileReport = {
  command_id: string;
  client_order_id: string;
  before: CommandState;
  after: CommandState;
  result: "RECONCILED" | "ACCEPTED_UNSETTLED" | "STILL_UNKNOWN" | "NOT_APPLICABLE";
  detail: string;
  apply: ApplyResult | null;
  attempts: number;
};

/**
 * Reconciles one command by asking the venue what happened to the stable
 * client order id (prd.md 11.7 "query known order identifiers and fills"). No
 * path here submits anything. NOT_FOUND keeps the command unknown: absence is
 * never treated as a definitive rejection (T-36). A command still ARMED (crash
 * between the arm commit and the response) becomes OUTCOME_UNKNOWN when the
 * venue does not know it (T-37), never READY again.
 */
export async function reconcileCommand(
  runtime: KernelRuntime,
  commandId: string,
  now: Date,
  source: ReconciliationSource,
): Promise<ReconcileReport> {
  const pool = runtime.pool;
  const account = runtime.account;
  const execution = runtime.execution;
  if (pool === null || account === null) throw new Error("kernel has no loaded account");
  const command = await withClient(pool, (client) => getCommandById(client, commandId));
  if (command === null) throw new Error(`command ${commandId} not found`);
  const attempts = (runtime.reconciliation.get(commandId)?.attempts ?? 0) + 1;
  const base = { command_id: command.id, client_order_id: command.client_order_id, before: command.state, attempts };
  const needsWork =
    command.state === "ARMED" ||
    command.state === "OUTCOME_UNKNOWN" ||
    (command.state === "ACCEPTED" && command.reconciled_at === null);
  if (!needsWork) {
    return {
      ...base,
      after: command.state,
      result: "NOT_APPLICABLE",
      detail: "command needs no reconciliation",
      apply: null,
    };
  }
  if (execution === null) {
    return {
      ...base,
      after: command.state,
      result: "STILL_UNKNOWN",
      detail: "no execution adapter to query",
      apply: null,
    };
  }
  const proposal = await withClient(pool, (client) => getProposalById(client, command.proposal_id));
  const existingOrder = await withClient(pool, (client) => getOrderForCommand(client, command.id));
  const symbol = proposal?.normalized_order.symbol ?? existingOrder?.symbol ?? "";

  // Venue reads happen outside any database transaction (prd.md 11.3).
  let query: OrderQueryResult;
  let fills: NormalizedFill[] = [];
  try {
    query = await execution.queryOrder({
      client_order_id: command.client_order_id,
      exchange_order_id: existingOrder?.exchange_order_id ?? null,
      symbol,
    });
    if (query.kind === "FOUND") {
      const page = await execution.listRelevantFills({ since_event_time: null, since_fill_id: null });
      fills = page.fills.filter((f) => f.order.client_order_id === command.client_order_id);
    }
  } catch (error) {
    query = { kind: "QUERY_FAILED", detail: error instanceof Error ? error.message : String(error) };
  }

  return withTransaction(pool, async (tx) => {
    await lockAccountRow(tx, account.id);
    const locked = await getCommandById(tx, command.id, { lock: true });
    if (locked === null || locked.state !== command.state) {
      return {
        ...base,
        after: locked?.state ?? command.state,
        result: "NOT_APPLICABLE",
        detail: "command changed concurrently",
        apply: null,
      };
    }
    if (query.kind === "FOUND") {
      const apply = await applyObservedOrderInTx(tx, runtime, {
        command: locked,
        order: query.order,
        fills,
        now,
        source,
      });
      runtime.reconciliation.delete(command.id);
      const after: CommandState = "ACCEPTED";
      return {
        ...base,
        after,
        result: apply.reconciled ? "RECONCILED" : "ACCEPTED_UNSETTLED",
        detail: apply.reconciled
          ? `order ${apply.order_status}; ${apply.new_fills} new fill(s) applied; holds settled`
          : `order ${apply.order_status}; accounting incomplete: ${apply.problems.join("; ") || "order not terminal"}`,
        apply,
      };
    }
    runtime.reconciliation.set(command.id, { attempts, next_at: now.getTime() + backoffMs(attempts) });
    const detail = `${query.kind}: ${query.detail}`;
    if (locked.state === "ARMED") {
      await updateCommandState(tx, command.id, "OUTCOME_UNKNOWN", now, { outcomeRef: detail });
      const row = await lockAccountRow(tx, account.id);
      if (row.status !== "RECONCILING") await setAccountStatus(tx, account.id, "RECONCILING", now);
      await raiseIncidentOnce(
        tx,
        account.id,
        null,
        command.id,
        "OUTCOME_UNKNOWN",
        "CRITICAL",
        {
          client_order_id: command.client_order_id,
          detail,
          note: "armed before a crash; venue does not report the order yet; no resend (prd.md 11.7)",
        },
        now,
      );
      await appendAuditEvent(tx, {
        id: newId("evt"),
        accountId: account.id,
        type: "COMMAND_OUTCOME",
        payload: { command_id: command.id, outcome: "OUTCOME_UNKNOWN", detail, source, attempts },
        occurredAt: now,
      });
      return { ...base, after: "OUTCOME_UNKNOWN", result: "STILL_UNKNOWN", detail, apply: null };
    }
    if (source !== "BACKGROUND") {
      await appendAuditEvent(tx, {
        id: newId("evt"),
        accountId: account.id,
        type: "COMMAND_OUTCOME",
        payload: { command_id: command.id, outcome: locked.state, detail, source, attempts, note: "still unresolved" },
        occurredAt: now,
      });
    }
    return { ...base, after: locked.state, result: "STILL_UNKNOWN", detail, apply: null };
  });
}

function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts, 30) * 1000;
}

export type ReconcileSweep = { examined: number; reports: ReconcileReport[]; deferred: string[]; exhausted: string[] };

/** Background pass: bounded, backed-off re-queries for every command whose external effect is unsettled. */
export async function reconcileOutstanding(runtime: KernelRuntime, now: Date): Promise<ReconcileSweep> {
  const pool = runtime.pool;
  const account = runtime.account;
  const sweep: ReconcileSweep = { examined: 0, reports: [], deferred: [], exhausted: [] };
  if (pool === null || account === null || runtime.writer === null || runtime.execution === null) return sweep;
  const pending = await withClient(pool, (client) => listCommandsNeedingReconciliation(client, account.id));
  for (const command of pending) {
    sweep.examined += 1;
    const schedule = runtime.reconciliation.get(command.id);
    if (schedule !== undefined && schedule.attempts >= MAX_AUTOMATIC_RECONCILE_ATTEMPTS) {
      sweep.exhausted.push(command.id);
      continue;
    }
    if (schedule !== undefined && schedule.next_at > now.getTime()) {
      sweep.deferred.push(command.id);
      continue;
    }
    sweep.reports.push(await reconcileCommand(runtime, command.id, now, "BACKGROUND"));
  }
  return sweep;
}
