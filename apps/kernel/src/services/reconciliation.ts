import {
  NonNegativeDecimalStringSchema,
  type NormalizedFill,
  type NormalizedOrder,
  type OrderQueryResult,
  PolicySchema,
  PositiveDecimalStringSchema,
} from "@moneykernel/contracts";
import { add, dec, eq, feeReserve, gt, isZero, max, min, sub, toDecimalString, ZERO } from "@moneykernel/domain";
import type { PoolClient } from "@moneykernel/persistence";
import {
  addLeaseConsumedQuote,
  appendAuditEvent,
  appendLedgerEntries,
  applyAllocationDelta,
  applyBalanceDelta,
  type CommandRow,
  type CommandState,
  consumeArmedReservationPart,
  countOutstandingCommands,
  type FillRow,
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
  /** Null when the observation was refused before any trustworthy order identity was recorded. */
  order_id: string | null;
  order_status: NormalizedOrder["status"];
  new_fills: number;
  duplicate_fills: number;
  skipped_fills: number;
  /** Terminal order, fill detail matches the order totals, every fee asset supported. */
  complete: boolean;
  /** This result confirms a complete committed settlement, including a repeated observation. */
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

function sameDecimal(left: unknown, right: unknown): boolean {
  const a = NonNegativeDecimalStringSchema.safeParse(left);
  const b = NonNegativeDecimalStringSchema.safeParse(right);
  return a.success && b.success && eq(dec(a.data), dec(b.data));
}

function sameFillAmounts(
  left: Pick<NormalizedFill, "base_qty" | "price" | "quote_qty" | "commission_asset" | "commission_qty">,
  right: Pick<NormalizedFill, "base_qty" | "price" | "quote_qty" | "commission_asset" | "commission_qty"> | FillRow,
): boolean {
  return (
    left.commission_asset === right.commission_asset &&
    (["base_qty", "price", "quote_qty", "commission_qty"] as const).every((field) =>
      sameDecimal(left[field], right[field]),
    )
  );
}

/** The venue observation must identify the exact persisted order, even when it came from a typed adapter. */
function observationProblems(
  command: CommandRow,
  order: NormalizedOrder,
  fills: NormalizedFill[],
  existing: OrderRow | null,
): string[] {
  const exact = command.exact_payload;
  const problems: string[] = [];
  for (const field of ["environment", "client_order_id", "symbol", "side", "order_type"] as const) {
    if (order[field] !== exact[field]) problems.push(`order ${field} differs from the armed command`);
  }
  for (const field of ["quantity", "limit_price"] as const) {
    if (!sameDecimal(order[field], exact[field])) problems.push(`order ${field} differs from the armed command`);
  }
  if (
    existing?.exchange_order_id !== null &&
    existing?.exchange_order_id !== undefined &&
    order.exchange_order_id !== existing.exchange_order_id
  ) {
    problems.push("venue order identity changed");
  }
  if (
    !["NEW", "PARTIALLY_FILLED", "FILLED", "CANCELED", "EXPIRED"].includes(order.status) ||
    !NonNegativeDecimalStringSchema.safeParse(order.executed_base).success ||
    !NonNegativeDecimalStringSchema.safeParse(order.executed_quote).success
  )
    problems.push("invalid order observation");
  for (const fill of fills) {
    if (
      fill.symbol !== order.symbol ||
      fill.side !== order.side ||
      fill.order.symbol !== order.symbol ||
      fill.order.client_order_id !== command.client_order_id ||
      (order.exchange_order_id !== null && fill.order.exchange_order_id !== order.exchange_order_id)
    ) {
      problems.push(`fill ${fill.fill_id} does not identify the observed order`);
    }
    if (
      fill.fill_id.length === 0 ||
      !PositiveDecimalStringSchema.safeParse(fill.base_qty).success ||
      !PositiveDecimalStringSchema.safeParse(fill.price).success ||
      !PositiveDecimalStringSchema.safeParse(fill.quote_qty).success ||
      !NonNegativeDecimalStringSchema.safeParse(fill.commission_qty).success ||
      !Number.isFinite(Date.parse(fill.event_time))
    ) {
      problems.push(`fill ${fill.fill_id} has invalid financial values or event time`);
    }
  }
  return problems;
}

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
  const relevantFills = input.fills.filter((fill) => fill.order.client_order_id === command.client_order_id);
  const identityProblems = observationProblems(command, order, relevantFills, existing);
  const observedById = new Map<string, NormalizedFill>();
  let hasNewFill = false;
  for (const fill of relevantFills) {
    const duplicate = observedById.get(fill.fill_id);
    if (duplicate !== undefined && !sameFillAmounts(fill, duplicate))
      identityProblems.push(`fill ${fill.fill_id} changed within one observation`);
    observedById.set(fill.fill_id, fill);
    const recorded = await tx.query<FillRow>(
      "SELECT * FROM fills WHERE account_id = $1 AND symbol = $2 AND exchange_trade_id = $3",
      [accountId, fill.symbol, fill.fill_id],
    );
    const prior = recorded.rows[0];
    if (prior === undefined) hasNewFill = true;
    if (
      prior !== undefined &&
      (prior.order_id !== existing?.id ||
        !sameFillAmounts(fill, prior) ||
        prior.event_time.getTime() !== Date.parse(fill.event_time))
    ) {
      identityProblems.push(`fill ${fill.fill_id} differs from its immutable recorded identity`);
    }
  }
  if (identityProblems.length > 0) {
    await raiseIncidentOnce(
      tx,
      accountId,
      intent.agent_id,
      command.id,
      "RECONCILIATION_IDENTITY_MISMATCH",
      "CRITICAL",
      {
        problems: identityProblems,
        order_raw_hash: order.raw_hash,
        fill_ids: relevantFills.map((fill) => fill.fill_id),
      },
      now,
    );
    // A late contradictory response cannot erase a previously committed settlement.
    if (command.reconciled_at === null) await updateCommandState(tx, command.id, "OUTCOME_UNKNOWN", now);
    await setAccountStatus(tx, accountId, "RECONCILING", now);
    return {
      order_id: existing?.id ?? null,
      order_status: order.status,
      new_fills: 0,
      duplicate_fills: 0,
      skipped_fills: relevantFills.length,
      complete: false,
      reconciled: false,
      executed_base: existing?.executed_base ?? "0",
      executed_quote: existing?.executed_quote ?? "0",
      fee_quote: "0",
      fee_base: "0",
      consumed_quote: "0",
      released_quote: "0",
      consumed_base: "0",
      released_base: "0",
      lease_consumed_delta: "0",
      problems: identityProblems,
    };
  }
  if (
    command.reconciled_at !== null &&
    existing !== null &&
    TERMINAL_ORDER_STATES.includes(existing.status) &&
    !hasNewFill &&
    !gt(dec(order.executed_base), dec(existing.executed_base)) &&
    !gt(dec(order.executed_quote), dec(existing.executed_quote))
  ) {
    // A slower dispatch/read can return after another reconciler completed the command.
    // Known duplicate fills and an older summary cannot roll the durable order backward.
    const recorded = await listFillsForOrder(tx, existing.id);
    const feeQuote = recorded
      .filter((fill) => fill.commission_asset === quoteAsset)
      .reduce((sum, fill) => add(sum, dec(fill.commission_qty)), ZERO);
    const feeBase = recorded
      .filter((fill) => fill.commission_asset === baseAsset)
      .reduce((sum, fill) => add(sum, dec(fill.commission_qty)), ZERO);
    await appendAuditEvent(tx, {
      id: newId("evt"),
      accountId,
      type: "ORDER_OBSERVED",
      occurredAt: now,
      payload: {
        command_id: command.id,
        order_id: existing.id,
        status: order.status,
        executed_base: order.executed_base,
        executed_quote: order.executed_quote,
        preserved_status: existing.status,
        source,
        note: "already settled; duplicate or older observation did not change accounting",
      },
    });
    return {
      order_id: existing.id,
      order_status: existing.status,
      new_fills: 0,
      duplicate_fills: relevantFills.length,
      skipped_fills: 0,
      complete: true,
      reconciled: true,
      executed_base: toDecimalString(dec(existing.executed_base)),
      executed_quote: toDecimalString(dec(existing.executed_quote)),
      fee_quote: toDecimalString(feeQuote),
      fee_base: toDecimalString(feeBase),
      consumed_quote: "0",
      released_quote: "0",
      consumed_base: "0",
      released_base: "0",
      lease_consumed_delta: "0",
      problems: [],
    };
  }
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
  for (const fill of relevantFills) {
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
    // Quote is shared account cash, whose attribution remains in the operator bucket.
    await applyAllocationDelta(tx, accountId, "UNASSIGNED", quoteAsset, deltas.quoteDelta);
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
  const policyResult = await tx.query<{ canonical_policy: Record<string, unknown> }>(
    "SELECT canonical_policy FROM policy_versions WHERE id = $1 AND account_id = $2",
    [proposal.policy_id, accountId],
  );
  const policy = PolicySchema.parse(policyResult.rows[0]?.canonical_policy);
  const feeRate = dec(policy.fee_rate);
  // Venue commissions round independently per fill; aggregating before rounding understates that envelope.
  const modeledQuoteFee =
    policy.fee_asset === quoteAsset
      ? recorded.reduce((sum, fill) => add(sum, feeReserve(dec(fill.quote_qty), feeRate)), ZERO)
      : ZERO;
  const modeledBaseFee =
    policy.fee_asset === baseAsset
      ? recorded.reduce((sum, fill) => add(sum, feeReserve(dec(fill.base_qty), feeRate)), ZERO)
      : ZERO;
  const feeMismatch = gt(feeQuote, modeledQuoteFee) || gt(feeBase, modeledBaseFee);
  if (feeMismatch) {
    problems.push("actual fill fees exceed the approved fee model; operator investigation required");
    await raiseIncidentOnce(
      tx,
      accountId,
      intent.agent_id,
      command.id,
      "FEE_MODEL_MISMATCH",
      "CRITICAL",
      {
        policy_id: proposal.policy_id,
        fee_asset: policy.fee_asset,
        fee_rate: policy.fee_rate,
        actual_quote_fee: toDecimalString(feeQuote),
        actual_base_fee: toDecimalString(feeBase),
      },
      now,
    );
  }
  const reservations = await listReservationsForProposal(tx, proposal.id);
  const executionByKind = { QUOTE: add(sumQuote, feeQuote), BASE: add(sumBase, feeBase) };
  let shortfall = false;
  for (const kind of [side === "BUY" ? "QUOTE" : "BASE"] as const) {
    const heldAndConsumed = reservations
      .filter((r) => r.kind === kind && (r.state === "ARMED" || r.state === "CONSUMED"))
      .reduce((total, r) => add(total, dec(r.amount)), ZERO);
    if (gt(executionByKind[kind], heldAndConsumed)) {
      shortfall = true;
      problems.push(
        `executed ${kind} ${toDecimalString(executionByKind[kind])} exceeded the hold ${toDecimalString(heldAndConsumed)}`,
      );
      await raiseIncidentOnce(
        tx,
        accountId,
        intent.agent_id,
        command.id,
        "RESERVATION_SHORTFALL",
        "CRITICAL",
        {
          kind,
          held: toDecimalString(heldAndConsumed),
          executed: toDecimalString(executionByKind[kind]),
        },
        now,
      );
    }
  }
  const accountingBlocked = skippedFills > 0 || feeMismatch || shortfall;
  if (accountingBlocked) {
    const accountRow = await lockAccountRow(tx, accountId);
    if (accountRow.status !== "RECONCILING") {
      await setAccountStatus(tx, accountId, "RECONCILING", now);
      await appendAuditEvent(tx, {
        id: newId("evt"),
        accountId,
        type: "ACCOUNT_RECONCILING",
        payload: {
          command_id: command.id,
          problems,
          note: "accounting discrepancy requires investigation; holds retained",
        },
        occurredAt: now,
      });
    }
  }
  const complete = terminal && totalsAgree && !accountingBlocked;

  let consumedQuote = ZERO;
  let releasedQuote = ZERO;
  let consumedBase = ZERO;
  let releasedBase = ZERO;
  let reconciled = false;
  if (!accountingBlocked) {
    const consumedByKind = {
      QUOTE: reservations
        .filter((r) => r.kind === "QUOTE" && r.state === "CONSUMED")
        .reduce((total, r) => add(total, dec(r.amount)), ZERO),
      BASE: reservations
        .filter((r) => r.kind === "BASE" && r.state === "CONSUMED")
        .reduce((total, r) => add(total, dec(r.amount)), ZERO),
    };
    for (const reservation of reservations) {
      if (reservation.state !== "ARMED" || reservation.kind === "ATTEMPT") continue;
      const held = dec(reservation.amount);
      const wanted = max(sub(executionByKind[reservation.kind], consumedByKind[reservation.kind]), ZERO);
      const consumed = min(held, wanted);
      const released = complete ? max(sub(held, wanted), ZERO) : ZERO;
      if (complete) {
        await settleArmedReservation(
          tx,
          reservation,
          toDecimalString(consumed),
          toDecimalString(released),
          newId("rsv"),
          now,
        );
      } else if (!isZero(consumed)) {
        await consumeArmedReservationPart(tx, reservation, toDecimalString(consumed), newId("rsv"), now);
      } else {
        continue;
      }
      consumedByKind[reservation.kind] = add(consumedByKind[reservation.kind], consumed);
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
          note: complete
            ? "only the unfilled remainder is released after terminal reconciliation (prd.md 11.6)"
            : "applied execution moved to consumed; unfilled remainder stays armed (prd.md 11.6)",
        },
        occurredAt: now,
      });
    }
  }
  if (complete) {
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

export class ReconciliationError extends Error {
  readonly code = "NOT_FOUND";
  readonly status = 404;

  constructor() {
    super("command not found for this account");
    this.name = "ReconciliationError";
  }
}

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
  if (command === null || command.account_id !== account.id) throw new ReconciliationError();
  // The account binding is required before even local investigation state can
  // change. Operator retries start a new bounded read investigation.
  if (source === "OPERATOR") runtime.reconciliation.delete(command.id);
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
    if (locked === null || locked.account_id !== account.id) throw new ReconciliationError();
    if (locked.state !== command.state || locked.reconciled_at !== null) {
      return {
        ...base,
        after: locked.state,
        result: "NOT_APPLICABLE",
        detail: locked.reconciled_at !== null ? "command settled concurrently" : "command changed concurrently",
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
      const observed = await getCommandById(tx, command.id);
      if (observed === null) throw new Error(`command ${command.id} vanished during reconciliation`);
      const after = observed.state;
      const accepted = after === "ACCEPTED";
      const reconciled = accepted && observed.reconciled_at !== null;
      if (accepted) runtime.reconciliation.delete(command.id);
      else runtime.reconciliation.set(command.id, { attempts, next_at: now.getTime() + backoffMs(attempts) });
      return {
        ...base,
        after,
        result: !accepted ? "STILL_UNKNOWN" : reconciled ? "RECONCILED" : "ACCEPTED_UNSETTLED",
        detail: !accepted
          ? `observation refused; outcome remains unresolved: ${apply.problems.join("; ")}`
          : reconciled
            ? `order ${apply.order_status}; ${apply.new_fills} new fill(s) applied; holds settled${apply.problems.length > 0 ? `; latest observation problems: ${apply.problems.join("; ")}` : ""}`
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
