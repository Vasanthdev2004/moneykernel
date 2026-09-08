import {
  type BookLevel,
  type CapabilityManifest,
  canonicalizeDecimal,
  type DecimalString,
  hashCanonical,
  type MarketAdapter,
  type MarketSnapshot,
  type SymbolRules,
} from "@moneykernel/contracts";
import type { Scenario } from "./scenario.ts";

export const FIXTURE_PARSER_VERSION = "fixture-1";

/**
 * REPLAY market adapter (prd.md 13.1): serves the scenario's constant book
 * and symbol rules. Every read is a fresh observation stamped with the
 * injected clock, so freshness rules behave exactly as they would against a
 * live feed; `source_timestamp` stays the fixture's virtual time and the
 * source is always labelled SYNTHETIC_FIXTURE.
 */
export class FixtureMarketAdapter implements MarketAdapter {
  readonly source = "SYNTHETIC_FIXTURE" as const;
  private readonly scenario: Scenario;
  private readonly clock: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(scenario: Scenario, clock: () => Date, newId: (prefix: string) => string) {
    this.scenario = scenario;
    this.clock = clock;
    this.newId = newId;
  }

  get scenarioId(): string {
    return this.scenario.scenario_id;
  }

  symbols(): string[] {
    return Object.keys(this.scenario.symbol_rules ?? {});
  }

  async discoverCapabilities(): Promise<CapabilityManifest> {
    return {
      adapter: "fixture",
      environment: this.scenario.environment,
      checked_at: this.clock().toISOString(),
      capabilities: {
        read_market_context: { status: "AVAILABLE", detail: `scenario ${this.scenario.scenario_id}` },
        read_symbol_rules: { status: "AVAILABLE", detail: `${this.symbols().length} symbols` },
        order_write: {
          status: "UNAVAILABLE",
          detail: "market adapter only; execution goes through the paper executor",
        },
      },
    };
  }

  async getSnapshot(symbol: string): Promise<MarketSnapshot> {
    const fixture = (this.scenario.market_snapshots ?? []).find((s) => s.symbol === symbol);
    if (fixture === undefined) throw new Error(`fixture has no market snapshot for ${symbol}`);
    const now = this.clock().toISOString();
    const bids: BookLevel[] = fixture.bids.map((l) => ({
      price: canonicalizeDecimal(l.price),
      quantity: canonicalizeDecimal(l.quantity),
    }));
    const asks: BookLevel[] = fixture.asks.map((l) => ({
      price: canonicalizeDecimal(l.price),
      quantity: canonicalizeDecimal(l.quantity),
    }));
    const lastPrice: DecimalString | null =
      fixture.last_price === null ? null : canonicalizeDecimal(fixture.last_price);
    const payload = {
      symbol,
      source: this.source,
      source_timestamp: fixture.source_timestamp,
      bids,
      asks,
      last_price: lastPrice,
    };
    return {
      snapshot_id: this.newId("snap"),
      symbol,
      source: this.source,
      request_started_at: now,
      received_at: now,
      source_timestamp: fixture.source_timestamp,
      bids,
      asks,
      last_price: lastPrice,
      payload_hash: hashCanonical(payload),
      parser_version: FIXTURE_PARSER_VERSION,
    };
  }

  async getSymbolRules(symbol: string): Promise<SymbolRules> {
    const fixture = this.scenario.symbol_rules?.[symbol];
    if (fixture === undefined) throw new Error(`fixture has no symbol rules for ${symbol}`);
    const now = this.clock().toISOString();
    const rules: SymbolRules = {
      symbol,
      base_asset: fixture.base_asset,
      quote_asset: fixture.quote_asset,
      status: fixture.status,
      tick_size: canonicalizeDecimal(fixture.tick_size),
      ...(fixture.min_price === undefined
        ? {}
        : { min_price: fixture.min_price === null ? null : canonicalizeDecimal(fixture.min_price) }),
      ...(fixture.max_price === undefined
        ? {}
        : { max_price: fixture.max_price === null ? null : canonicalizeDecimal(fixture.max_price) }),
      step_size: canonicalizeDecimal(fixture.step_size),
      min_qty: canonicalizeDecimal(fixture.min_qty),
      max_qty: canonicalizeDecimal(fixture.max_qty),
      min_notional: canonicalizeDecimal(fixture.min_notional),
      max_notional: fixture.max_notional === null ? null : canonicalizeDecimal(fixture.max_notional),
      base_precision: fixture.base_precision,
      quote_precision: fixture.quote_precision,
      unsupported_filters: [...fixture.unsupported_filters],
      source: this.source,
      received_at: now,
      payload_hash: "",
    };
    rules.payload_hash = hashCanonical({ ...rules, received_at: undefined, payload_hash: undefined });
    return rules;
  }
}
