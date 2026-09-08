import { HEX64_RE } from "@moneykernel/contracts";
import { describe, expect, it } from "vitest";
import {
  BINANCE_PUBLIC_DATA_BASE_URL,
  BinancePublicRestMarketAdapter,
} from "../../../packages/integrations/src/binance/public-rest-market-adapter.ts";

/**
 * Online smoke test against the public Binance market-data host. Skipped
 * unless MK_ONLINE_TESTS=1 so the default suite never touches the network.
 * Public read only: no credentials exist in this test or in the adapter.
 */
const ONLINE = process.env.MK_ONLINE_TESTS === "1";

describe.skipIf(!ONLINE)("Binance public REST adapter (online, MK_ONLINE_TESTS=1)", () => {
  const symbol = "SOLUSDT";
  let sequence = 0;
  const adapter = new BinancePublicRestMarketAdapter({
    source: "BINANCE_PUBLIC_REST",
    baseUrl: BINANCE_PUBLIC_DATA_BASE_URL,
    clock: () => new Date(),
    newId: (prefix) => `${prefix}-${++sequence}`,
  });

  it("pings the host and reports reads available, writes blocked", async () => {
    const manifest = await adapter.discoverCapabilities();
    expect(manifest.environment).toBe("SHADOW");
    expect(manifest.capabilities.read_market_context?.status).toBe("AVAILABLE");
    expect(manifest.capabilities.order_write?.status).toBe("BLOCKED");
  });

  it(`reads ${symbol} depth`, async () => {
    const snapshot = await adapter.getSnapshot(symbol);
    expect(snapshot.symbol).toBe(symbol);
    expect(snapshot.source).toBe("BINANCE_PUBLIC_REST");
    expect(snapshot.source_timestamp).toBeNull();
    expect(snapshot.bids.length).toBeGreaterThan(0);
    expect(snapshot.asks.length).toBeGreaterThan(0);
    expect(snapshot.payload_hash).toMatch(HEX64_RE);
    expect(Date.parse(snapshot.received_at)).toBeGreaterThanOrEqual(Date.parse(snapshot.request_started_at));
    console.log(
      `[online] ${symbol} depth received_at=${snapshot.received_at} best_bid=${snapshot.bids[0]?.price} best_ask=${snapshot.asks[0]?.price}`,
    );
  });

  it(`reads ${symbol} rules`, async () => {
    const rules = await adapter.getSymbolRules(symbol);
    expect(rules.symbol).toBe(symbol);
    expect(rules.base_asset).toBe("SOL");
    expect(rules.quote_asset).toBe("USDT");
    expect(rules.status).toBe("TRADING");
    expect(rules.tick_size).toMatch(/^\d+(\.\d+)?$/);
    expect(rules.step_size).toMatch(/^\d+(\.\d+)?$/);
    expect(rules.min_notional).toMatch(/^\d+(\.\d+)?$/);
    expect(rules.payload_hash).toMatch(HEX64_RE);
    console.log(
      `[online] ${symbol} rules received_at=${rules.received_at} tick_size=${rules.tick_size} step_size=${rules.step_size} min_notional=${rules.min_notional} unsupported=${JSON.stringify(rules.unsupported_filters)}`,
    );
  });
});
