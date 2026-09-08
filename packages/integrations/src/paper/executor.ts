import {
  type AccountSnapshot,
  type ArmedCommand,
  type AuthorizedCancelCommand,
  type CancelResult,
  type Environment,
  type ExecutionAdapter,
  type ExecutionResult,
  type FillCursor,
  type FillPage,
  hashCanonical,
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

export type PaperFaults = {
  /** Client order ids whose accepted response is dropped after the fill is recorded (prd.md 27.4). */
  dropResponseFor?: Set<string>;
};

export type PaperExecutorOptions = {
  environment: Environment;
  feeRate: string;
  feeAsset: string;
  faults?: PaperFaults;
};

type PaperOrder = { order: NormalizedOrder; fills: NormalizedFill[] };

/**
 * Deterministic paper executor (prd.md 13.7): walks the scenario book within
 * the order's limit, applies the fixture fee model, and expires the unfilled
 * IOC remainder. Liquidity consumed by earlier paper orders on the same
 * fixture book stays consumed, so repeated orders do not assume infinite
 * depth. Paper results are a demonstration model, not a backtest.
 */
export class PaperExecutionAdapter implements ExecutionAdapter {
  readonly environment: Environment;
  readonly simulatorVersion = "paper-1";
  private readonly scenario: Scenario;
  private readonly clock: () => Date;
  private readonly feeRate: Dec;
  private readonly feeAsset: string;
  private readonly faults: PaperFaults;
  private readonly orders = new Map<string, PaperOrder>();
  private readonly consumed = new Map<string, Dec>();
  private sequence = 0;
  private submissions = 0;

  constructor(scenario: Scenario, clock: () => Date, options: PaperExecutorOptions) {
    this.scenario = scenario;
    this.clock = clock;
    this.environment = options.environment;
    this.feeRate = dec(options.feeRate);
    this.feeAsset = options.feeAsset;
    this.faults = options.faults ?? {};
  }

  /** Number of submitOnce invocations, for tests that assert exactly-once submission. */
  get submitCount(): number {
    return this.submissions;
  }

  async getAccountSnapshot(): Promise<AccountSnapshot> {
    const now = this.clock().toISOString();
    return {
      environment: this.environment,
      account_ref: `paper:${this.scenario.scenario_id}`,
      balances: [],
      request_started_at: now,
      received_at: now,
      source_timestamp: null,
      payload_hash: hashCanonical({ note: "virtual funds are kernel-owned; the paper venue holds no balances" }),
    };
  }

  async submitOnce(command: ArmedCommand): Promise<ExecutionResult> {
    this.submissions += 1;
    if (this.orders.has(command.client_order_id)) {
      return { kind: "REJECTED_CONFIRMED", code: "DUPLICATE_CLIENT_ORDER_ID", detail: "client order id already used" };
    }
    const book = (this.scenario.market_snapshots ?? []).find((s) => s.symbol === command.symbol);
    if (book === undefined) {
      return { kind: "REJECTED_CONFIRMED", code: "UNKNOWN_SYMBOL", detail: `no paper book for ${command.symbol}` };
    }
    const levels = command.side === "BUY" ? book.asks : book.bids;
    const limit = dec(command.limit_price);
    let remaining = dec(command.quantity);
    const fills: NormalizedFill[] = [];
    let executedBase = ZERO;
    let executedQuote = ZERO;
    const now = this.clock();

    for (let index = 0; index < levels.length && isPositive(remaining); index += 1) {
      const level = levels[index];
      if (level === undefined) break;
      const price = dec(level.price);
      const crosses = command.side === "BUY" ? lte(price, limit) : gte(price, limit);
      if (!crosses) break;
      const key = `${command.symbol}:${command.side}:${index}`;
      const used = this.consumed.get(key) ?? ZERO;
      const available = sub(dec(level.quantity), used);
      if (!isPositive(available)) continue;
      const take = min(available, remaining);
      this.consumed.set(key, add(used, take));
      remaining = sub(remaining, take);
      const quote = mul(take, price);
      executedBase = add(executedBase, take);
      executedQuote = add(executedQuote, quote);
      this.sequence += 1;
      fills.push({
        fill_id: `${command.client_order_id}-f${fills.length + 1}`,
        order: {
          client_order_id: command.client_order_id,
          exchange_order_id: `paper-${this.sequence}`,
          symbol: command.symbol,
        },
        symbol: command.symbol,
        side: command.side,
        base_qty: toDecimalString(take),
        price: toDecimalString(price),
        quote_qty: toDecimalString(quote),
        commission_asset: this.feeAsset,
        commission_qty: toDecimalString(feeReserve(quote, this.feeRate)),
        event_time: now.toISOString(),
        raw_hash: hashCanonical({ take: toDecimalString(take), price: toDecimalString(price), index }),
      });
    }

    const status: NormalizedOrder["status"] = isPositive(remaining) ? "EXPIRED" : "FILLED";
    const order: NormalizedOrder = {
      environment: this.environment,
      client_order_id: command.client_order_id,
      exchange_order_id: `paper-${command.client_order_id.slice(-12)}`,
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
      }),
    };
    this.orders.set(command.client_order_id, { order, fills });

    if (this.faults.dropResponseFor?.has(command.client_order_id)) {
      throw new Error("paper fault: response dropped after the venue accepted the order");
    }
    return { kind: "ACCEPTED", order };
  }

  async queryOrder(identity: OrderIdentity): Promise<OrderQueryResult> {
    const entry = this.orders.get(identity.client_order_id);
    if (entry === undefined) return { kind: "NOT_FOUND", detail: "no paper order with that client order id" };
    return { kind: "FOUND", order: { ...entry.order, last_observed_at: this.clock().toISOString() } };
  }

  async listRelevantFills(cursor: FillCursor): Promise<FillPage> {
    const all = [...this.orders.values()].flatMap((o) => o.fills);
    const after = cursor.since_fill_id;
    const start = after === null ? 0 : all.findIndex((f) => f.fill_id === after) + 1;
    return { fills: all.slice(start), next_cursor: null, received_at: this.clock().toISOString() };
  }

  async cancelKnownOrder(command: AuthorizedCancelCommand): Promise<CancelResult> {
    const entry = this.orders.get(command.order.client_order_id);
    if (entry === undefined) return { kind: "NOT_FOUND", order: null, detail: "no such paper order" };
    return { kind: "ALREADY_TERMINAL", order: entry.order, detail: "IOC paper orders are terminal on submission" };
  }
}
