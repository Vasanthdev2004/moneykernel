import {
  type AccountSnapshot,
  type ArmedCommand,
  type AuthorizedCancelCommand,
  type BookLevel,
  type CancelResult,
  canonicalizeDecimal,
  type Environment,
  type ExecutionAdapter,
  type ExecutionResult,
  type FillCursor,
  type FillPage,
  hashCanonical,
  type MarketAdapter,
  type MarketSource,
  type NormalizedFill,
  type NormalizedOrder,
  type OrderIdentity,
  type OrderQueryResult,
} from "@moneykernel/contracts";
import {
  add,
  type Dec,
  dec,
  feeReserve,
  gte,
  isPositive,
  lte,
  min,
  mul,
  sub,
  toDecimalString,
  ZERO,
} from "@moneykernel/domain";
import type { Scenario } from "../fixture/scenario.ts";
import { emptyPaperVenueState, type PaperVenueState, type PaperVenueStore } from "./venue-store.ts";

export type PaperFaults = {
  /** Client order ids whose accepted response is dropped after the venue recorded the order (prd.md 27.4). */
  dropResponseFor?: Set<string>;
  /** REPLAY synthetic query outage. Runtime-only; never journaled, so a fresh process can recover the accepted order. */
  queryUnavailableFor?: Set<string>;
  /**
   * Client order ids whose order summary reports one more base step (0.001) executed than the fills it lists:
   * fill detail lagging the order state, which must keep a conservative buffer (prd.md 11.6, 28.3).
   */
  overstateExecutedFor?: Set<string>;
  /** Client order ids whose fills charge commission in the given asset instead of the configured fee asset (T-45). */
  commissionAssetFor?: Map<string, string>;
};

/** Where the paper venue reads the book it walks: the scenario's constant book, or the mode's live observation adapter. */
export type PaperBookSource = { kind: "FIXTURE"; scenario: Scenario } | { kind: "LIVE"; market: MarketAdapter };

export type PaperExecutorOptions = {
  environment: Environment;
  feeRate: string;
  feeAsset: string;
  faults?: PaperFaults;
  /** Venue memory that outlives the kernel process; absent means memory-only (unit tests). */
  store?: PaperVenueStore;
};

type PaperBook = {
  book_id: string;
  book_hash: string;
  source: MarketSource;
  bids: BookLevel[];
  asks: BookLevel[];
  received_at: string;
};

export const PAPER_SIMULATOR_VERSION = "paper-2";

/**
 * Deterministic paper executor (prd.md 13.7): walks the observed book within
 * the order's limit, applies the fixture fee model, and expires the unfilled
 * IOC remainder. Liquidity consumed by earlier paper orders on the same book
 * observation stays consumed, so repeated orders do not assume infinite depth;
 * a new observed book starts a new consumption pool. The venue keeps its own
 * journal (orders, fills, consumption, submission count) and writes it before
 * any response leaves, so a kernel crash after acceptance is recoverable by
 * querying the venue, never by resending. Paper results are a demonstration
 * model, not a market-impact or profitability backtest.
 */
export class PaperExecutionAdapter implements ExecutionAdapter {
  readonly environment: Environment;
  readonly simulatorVersion = PAPER_SIMULATOR_VERSION;
  private readonly book: PaperBookSource;
  private readonly clock: () => Date;
  private readonly feeRate: Dec;
  private readonly feeAsset: string;
  private readonly faults: PaperFaults;
  private readonly store: PaperVenueStore | null;
  private state: PaperVenueState;

  constructor(book: PaperBookSource, clock: () => Date, options: PaperExecutorOptions) {
    this.book = book;
    this.clock = clock;
    this.environment = options.environment;
    this.feeRate = dec(options.feeRate);
    this.feeAsset = options.feeAsset;
    this.faults = options.faults ?? {};
    this.store = options.store ?? null;
    this.state = this.store?.load() ?? emptyPaperVenueState(PAPER_SIMULATOR_VERSION);
  }

  /** Number of submitOnce invocations the venue has ever seen, including before a kernel restart. */
  get submitCount(): number {
    return this.state.submissions;
  }

  get bookKind(): PaperBookSource["kind"] {
    return this.book.kind;
  }

  /** Snapshot of the venue journal, for evidence and tests. */
  venueState(): PaperVenueState {
    return structuredClone(this.state);
  }

  private persist(): void {
    this.store?.save(this.state);
  }

  private async readBook(symbol: string): Promise<PaperBook | null> {
    if (this.book.kind === "FIXTURE") {
      const fixture = (this.book.scenario.market_snapshots ?? []).find((s) => s.symbol === symbol);
      if (fixture === undefined) return null;
      const bids = fixture.bids.map((l) => ({
        price: canonicalizeDecimal(l.price),
        quantity: canonicalizeDecimal(l.quantity),
      }));
      const asks = fixture.asks.map((l) => ({
        price: canonicalizeDecimal(l.price),
        quantity: canonicalizeDecimal(l.quantity),
      }));
      return {
        book_id: fixture.snapshot_id,
        book_hash: hashCanonical({ symbol, bids, asks }),
        source: "SYNTHETIC_FIXTURE",
        bids,
        asks,
        received_at: this.clock().toISOString(),
      };
    }
    const snapshot = await this.book.market.getSnapshot(symbol);
    return {
      book_id: snapshot.payload_hash,
      book_hash: snapshot.payload_hash,
      source: snapshot.source,
      bids: snapshot.bids,
      asks: snapshot.asks,
      received_at: snapshot.received_at,
    };
  }

  async getAccountSnapshot(): Promise<AccountSnapshot> {
    const now = this.clock().toISOString();
    return {
      environment: this.environment,
      account_ref: `paper:${this.environment}`,
      balances: [],
      request_started_at: now,
      received_at: now,
      source_timestamp: null,
      payload_hash: hashCanonical({ note: "virtual funds are kernel-owned; the paper venue holds no balances" }),
    };
  }

  async submitOnce(command: ArmedCommand): Promise<ExecutionResult> {
    this.state.submissions += 1;
    if (this.state.orders[command.client_order_id] !== undefined) {
      this.persist();
      return { kind: "REJECTED_CONFIRMED", code: "DUPLICATE_CLIENT_ORDER_ID", detail: "client order id already used" };
    }
    let book: PaperBook | null;
    try {
      book = await this.readBook(command.symbol);
    } catch (error) {
      this.persist();
      return {
        kind: "REJECTED_CONFIRMED",
        code: "BOOK_UNAVAILABLE",
        detail: `paper venue could not read a book for ${command.symbol}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (book === null) {
      this.persist();
      return { kind: "REJECTED_CONFIRMED", code: "UNKNOWN_SYMBOL", detail: `no paper book for ${command.symbol}` };
    }
    const levels = command.side === "BUY" ? book.asks : book.bids;
    const limit = dec(command.limit_price);
    let remaining = dec(command.quantity);
    const fills: NormalizedFill[] = [];
    let executedBase = ZERO;
    let executedQuote = ZERO;
    const now = this.clock();
    this.state.sequence += 1;
    const exchangeOrderId = `paper-${this.state.sequence}`;

    for (let index = 0; index < levels.length && isPositive(remaining); index += 1) {
      const level = levels[index];
      if (level === undefined) break;
      const price = dec(level.price);
      const crosses = command.side === "BUY" ? lte(price, limit) : gte(price, limit);
      if (!crosses) break;
      const key = `${book.book_id}:${command.side}:${index}`;
      const used = dec(this.state.consumed[key] ?? "0");
      const available = sub(dec(level.quantity), used);
      if (!isPositive(available)) continue;
      const take = min(available, remaining);
      this.state.consumed[key] = toDecimalString(add(used, take));
      remaining = sub(remaining, take);
      const quote = mul(take, price);
      executedBase = add(executedBase, take);
      executedQuote = add(executedQuote, quote);
      fills.push({
        fill_id: `${command.client_order_id}-f${fills.length + 1}`,
        order: { client_order_id: command.client_order_id, exchange_order_id: exchangeOrderId, symbol: command.symbol },
        symbol: command.symbol,
        side: command.side,
        base_qty: toDecimalString(take),
        price: toDecimalString(price),
        quote_qty: toDecimalString(quote),
        commission_asset: this.faults.commissionAssetFor?.get(command.client_order_id) ?? this.feeAsset,
        commission_qty: toDecimalString(feeReserve(quote, this.feeRate)),
        event_time: now.toISOString(),
        raw_hash: hashCanonical({
          take: toDecimalString(take),
          price: toDecimalString(price),
          index,
          book: book.book_hash,
        }),
      });
    }

    const status: NormalizedOrder["status"] = isPositive(remaining) ? "EXPIRED" : "FILLED";
    if (this.faults.overstateExecutedFor?.has(command.client_order_id)) executedBase = add(executedBase, dec("0.001"));
    const order: NormalizedOrder = {
      environment: this.environment,
      client_order_id: command.client_order_id,
      exchange_order_id: exchangeOrderId,
      symbol: command.symbol,
      side: command.side,
      order_type: command.order_type,
      status,
      quantity: command.quantity,
      limit_price: command.limit_price,
      executed_base: toDecimalString(executedBase),
      executed_quote: toDecimalString(executedQuote),
      last_observed_at: now.toISOString(),
      source_timestamp: now.toISOString(),
      raw_hash: hashCanonical({
        status,
        executed_base: toDecimalString(executedBase),
        executed_quote: toDecimalString(executedQuote),
        book: book.book_hash,
        simulator: PAPER_SIMULATOR_VERSION,
      }),
    };
    this.state.orders[command.client_order_id] = {
      order,
      fills,
      book_id: book.book_id,
      book_hash: book.book_hash,
      accepted_at: now.toISOString(),
    };
    // The venue's memory is durable before the response leaves: a dropped response changes nothing here.
    this.persist();

    if (this.faults.dropResponseFor?.has(command.client_order_id)) {
      throw new Error("paper fault: response dropped after the venue accepted the order");
    }
    return { kind: "ACCEPTED", order };
  }

  async queryOrder(identity: OrderIdentity): Promise<OrderQueryResult> {
    if (this.environment === "REPLAY" && this.faults.queryUnavailableFor?.has(identity.client_order_id)) {
      return {
        kind: "QUERY_FAILED",
        detail: "SYNTHETIC FAULT SCENARIO: order queries unavailable until kernel restart",
      };
    }
    const entry = this.state.orders[identity.client_order_id];
    if (entry === undefined) return { kind: "NOT_FOUND", detail: "no paper order with that client order id" };
    if (identity.symbol !== entry.order.symbol) {
      return { kind: "NOT_FOUND", detail: "client order id belongs to a different symbol" };
    }
    return { kind: "FOUND", order: { ...entry.order, last_observed_at: this.clock().toISOString() } };
  }

  async listRelevantFills(cursor: FillCursor): Promise<FillPage> {
    const all = Object.values(this.state.orders).flatMap((o) => o.fills);
    const after = cursor.since_fill_id;
    const start = after === null ? 0 : all.findIndex((f) => f.fill_id === after) + 1;
    return { fills: all.slice(start), next_cursor: null, received_at: this.clock().toISOString() };
  }

  async cancelKnownOrder(command: AuthorizedCancelCommand): Promise<CancelResult> {
    const entry = this.state.orders[command.order.client_order_id];
    if (entry === undefined) return { kind: "NOT_FOUND", order: null, detail: "no such paper order" };
    return { kind: "ALREADY_TERMINAL", order: entry.order, detail: "IOC paper orders are terminal on submission" };
  }
}
