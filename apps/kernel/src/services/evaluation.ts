import type { Policy, TradeIntent } from "@moneykernel/contracts";
import {
  dec,
  type EvaluationInput,
  type MarkView,
  max,
  mul,
  type ObservationView,
  type SymbolRulesView,
  toDecimalString,
  ZERO,
} from "@moneykernel/domain";
import type { PoolClient } from "@moneykernel/persistence";
import {
  type AccountRow,
  type AgentRow,
  countOutstandingCommands,
  countReservedAttemptsForLease,
  getSnapshotsByIds,
  type LeaseRow,
  latestSnapshotsBySymbol,
  ledgerVersion,
  listAssetBalances,
  listInventoryAllocations,
  listPendingBuyProposals,
  type PolicyVersionRow,
  type SnapshotRow,
  sumOutstandingQuote,
  sumOutstandingQuoteForLease,
  sumReservedBase,
  withClient,
} from "@moneykernel/persistence";
import type { KernelRuntime } from "../boot.ts";
import { newId } from "../ids.ts";
import { refreshMarks, refreshSymbolRules } from "./observations.ts";

export function markFromSnapshot(row: SnapshotRow): MarkView | null {
  const symbol = row.payload.symbol;
  const last = row.payload.last_price;
  const bids = row.payload.bids;
  let price: string | null = typeof last === "string" ? last : null;
  if (price === null && Array.isArray(bids) && bids.length > 0) {
    const top = bids[0] as { price?: unknown };
    if (typeof top.price === "string") price = top.price;
  }
  if (typeof symbol !== "string" || price === null) return null;
  return {
    symbol,
    price,
    snapshot_id: row.id,
    received_at: row.received_at.toISOString(),
    payload_hash: row.payload_hash,
  };
}

export function rulesFromSnapshot(row: SnapshotRow | undefined): SymbolRulesView | null {
  if (row === undefined) return null;
  const p = row.payload as Record<string, unknown>;
  const str = (k: string): string => (typeof p[k] === "string" ? (p[k] as string) : "");
  const status = p.status;
  return {
    symbol: str("symbol"),
    base_asset: str("base_asset"),
    quote_asset: str("quote_asset"),
    status: status === "TRADING" || status === "HALT" || status === "BREAK" ? status : "UNKNOWN",
    tick_size: str("tick_size"),
    min_price: typeof p.min_price === "string" ? p.min_price : null,
    max_price: typeof p.max_price === "string" ? p.max_price : null,
    step_size: str("step_size"),
    min_qty: str("min_qty"),
    max_qty: str("max_qty"),
    min_notional: str("min_notional"),
    max_notional: typeof p.max_notional === "string" ? p.max_notional : null,
    unsupported_filters: Array.isArray(p.unsupported_filters) ? (p.unsupported_filters as string[]) : [],
    snapshot_id: row.id,
    payload_hash: row.payload_hash,
  };
}

/** Held non-quote assets expressed as symbols against the quote asset, for valuation marks. */
export async function heldSymbols(runtime: KernelRuntime, accountId: string, quote: string): Promise<string[]> {
  const pool = runtime.pool;
  if (pool === null) return [];
  const balances = await withClient(pool, (client) => listAssetBalances(client, accountId));
  return balances.filter((b) => b.asset !== quote && dec(b.owned_quantity).gt(0)).map((b) => `${b.asset}${quote}`);
}

/** Refresh marks for the symbol and every held asset plus the symbol rules, outside any transaction (prd.md 11.3). */
export async function refreshInputsForSymbol(
  runtime: KernelRuntime,
  accountId: string,
  quote: string,
  symbol: string,
): Promise<string | null> {
  const held = await heldSymbols(runtime, accountId, quote);
  await refreshMarks(runtime, accountId, [symbol, ...held]);
  const refreshed = await refreshSymbolRules(runtime, accountId, symbol, newId);
  return refreshed?.id ?? null;
}

export type EvaluationContext = {
  tx: PoolClient;
  accountRow: AccountRow;
  agent: AgentRow;
  lease: LeaseRow;
  policyRow: PolicyVersionRow;
  policy: Policy;
  intent: TradeIntent;
  now: Date;
  /** Exact rules read for this evaluation attempt; null means the refresh failed. */
  refreshedRulesId: string | null;
  /** The proposal whose own holds must be excluded when re-evaluating (prd.md 9.2, T-17). */
  excludeProposalId?: string;
};

/** Assembles the pure evaluator's input from locked database state. Reads only; the caller holds the account lock. */
export async function assembleEvaluationInput(
  ctx: EvaluationContext,
): Promise<{ input: EvaluationInput; baseAsset: string }> {
  const { tx, accountRow, agent, lease, policyRow, policy, intent, now, refreshedRulesId, excludeProposalId } = ctx;
  const quote = accountRow.quote_asset;
  const balances = await listAssetBalances(tx, accountRow.id);
  const held = balances
    .filter((b) => b.asset !== quote && dec(b.owned_quantity).gt(0))
    .map((b) => `${b.asset}${quote}`);

  const ruleRows = await getSnapshotsByIds(tx, accountRow.id, refreshedRulesId === null ? [] : [refreshedRulesId]);
  const rules = rulesFromSnapshot(
    ruleRows.find((row) => row.type === "SYMBOL_RULES" && row.payload.symbol === intent.symbol),
  );
  const refRows = await getSnapshotsByIds(tx, accountRow.id, intent.observation_ids);
  const observations: ObservationView[] = refRows
    .filter((r) => r.type === "MARKET")
    .map((r) => ({
      snapshot_id: r.id,
      symbol: typeof r.payload.symbol === "string" ? r.payload.symbol : "",
      received_at: r.received_at.toISOString(),
      source_timestamp: r.source_time?.toISOString() ?? null,
      payload_hash: r.payload_hash,
    }));
  const markRows = await latestSnapshotsBySymbol(tx, accountRow.id, "MARKET", [intent.symbol, ...held]);
  const marks: MarkView[] = [...markRows.values()].map(markFromSnapshot).filter((m): m is MarkView => m !== null);

  const quoteRow = balances.find((b) => b.asset === quote);
  const holdings = balances
    .filter((b) => b.asset !== quote && dec(b.owned_quantity).gt(0))
    .map((b) => ({ asset: b.asset, quantity: b.owned_quantity }));
  const baseAsset = rules?.base_asset ?? "";
  const allocations = await listInventoryAllocations(tx, accountRow.id, agent.id);
  const agentBase = allocations.find((a) => a.asset === baseAsset)?.owned_quantity ?? "0";

  const pending = await listPendingBuyProposals(tx, accountRow.id, excludeProposalId);
  const symbolMark = marks.find((m) => m.symbol === intent.symbol);
  let pendingExposure = ZERO;
  let pendingFees = ZERO;
  for (const p of pending) {
    const order = p.normalized_order;
    if (order.side !== "BUY") continue;
    pendingFees = pendingFees.plus(dec(order.fee_reserve_quote));
    if (order.symbol === intent.symbol) {
      const unit =
        symbolMark === undefined ? dec(order.limit_price) : max(dec(symbolMark.price), dec(order.limit_price));
      pendingExposure = pendingExposure.plus(mul(dec(order.quantity), unit));
    }
  }

  const input: EvaluationInput = {
    now: now.toISOString(),
    intent,
    agent: { id: agent.id, status: agent.status, revision: agent.revision },
    account: {
      id: accountRow.id,
      status: accountRow.status,
      epoch: accountRow.epoch,
      quote_asset: accountRow.quote_asset,
      outstanding_commands: (await countOutstandingCommands(tx, accountRow.id)).total,
    },
    lease: {
      id: lease.id,
      revision: lease.revision,
      agent_id: lease.agent_id,
      status: lease.status,
      budget_quote: lease.budget_quote,
      consumed_quote: lease.consumed_quote,
      attempt_limit: lease.attempt_limit,
      attempts_consumed: lease.attempts_consumed,
      starts_at: lease.starts_at.toISOString(),
      expires_at: lease.expires_at.toISOString(),
      allowed_symbols: lease.capability_json.allowed_symbols,
      allowed_sides: lease.capability_json.allowed_sides,
      allowed_order_types: lease.capability_json.allowed_order_types,
    },
    policy: { ...policy, version: policyRow.version },
    symbol_rules: rules,
    observations,
    marks,
    resources: {
      quote_owned: quoteRow?.owned_quantity ?? "0",
      outstanding_quote_reservations: await sumOutstandingQuote(tx, accountRow.id, excludeProposalId),
      unresolved_debit_quote: "0",
      lease_outstanding_buy_quote: await sumOutstandingQuoteForLease(tx, lease.id, excludeProposalId),
      lease_reserved_attempts: await countReservedAttemptsForLease(tx, lease.id, excludeProposalId),
      agent_base_owned: agentBase,
      agent_base_reserved:
        baseAsset === "" ? "0" : await sumReservedBase(tx, accountRow.id, agent.id, baseAsset, excludeProposalId),
      account_base_reserved:
        baseAsset === "" ? "0" : await sumReservedBase(tx, accountRow.id, null, baseAsset, excludeProposalId),
      holdings,
      pending_buy_exposure_quote: toDecimalString(pendingExposure),
      pending_fee_reserves_quote: toDecimalString(pendingFees),
      ledger_version: await ledgerVersion(tx, accountRow.id),
    },
  };
  return { input, baseAsset };
}
