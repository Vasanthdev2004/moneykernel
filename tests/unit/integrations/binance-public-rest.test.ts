import { HEX64_RE, hashCanonical } from "@moneykernel/contracts";
import { describe, expect, it } from "vitest";
import {
  BINANCE_PUBLIC_DATA_BASE_URL,
  BINANCE_TESTNET_BASE_URL,
  BinancePublicRestMarketAdapter,
  PUBLIC_REST_PARSER_VERSION,
  type PublicRestMarketAdapterOptions,
} from "../../../packages/integrations/src/binance/public-rest-market-adapter.ts";

type RecordedCall = { method: string; url: string; headers: Record<string, string> };
type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

/** Records every outbound call (method, url, lower-cased headers) and answers with the handler's canned response. */
function recordingFetch(handler: Handler): { calls: RecordedCall[]; fetchImpl: typeof fetch } {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    calls.push({ method: init?.method ?? "GET", url: url.href, headers });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const DEPTH_BODY = {
  lastUpdateId: 1027024,
  bids: [
    ["100.50000000", "1.00000000"],
    ["100.40000000", "0.50000000"],
  ],
  asks: [
    ["100.60000000", "2.00000000"],
    ["100.70000000", "0.25000000"],
  ],
};

type UpstreamFilter = { filterType: string } & Record<string, unknown>;

/** Real Spot Testnet filter set for BTCUSDT (docs/gate0/spot-testnet-exchangeinfo-BTCUSDT.json). */
const BTCUSDT_FILTERS: UpstreamFilter[] = [
  { filterType: "PRICE_FILTER", minPrice: "0.01000000", maxPrice: "1000000.00000000", tickSize: "0.01000000" },
  { filterType: "LOT_SIZE", minQty: "0.00001000", maxQty: "9000.00000000", stepSize: "0.00001000" },
  { filterType: "ICEBERG_PARTS", limit: 100 },
  { filterType: "MARKET_LOT_SIZE", minQty: "0.00000000", maxQty: "141.67845966", stepSize: "0.00000000" },
  {
    filterType: "TRAILING_DELTA",
    minTrailingAboveDelta: 10,
    maxTrailingAboveDelta: 2000,
    minTrailingBelowDelta: 10,
    maxTrailingBelowDelta: 2000,
  },
  {
    filterType: "PERCENT_PRICE_BY_SIDE",
    bidMultiplierUp: "2",
    bidMultiplierDown: "0.5",
    askMultiplierUp: "2",
    askMultiplierDown: "0.5",
    avgPriceMins: 5,
  },
  {
    filterType: "NOTIONAL",
    minNotional: "5.00000000",
    applyMinToMarket: true,
    maxNotional: "9000000.00000000",
    applyMaxToMarket: false,
    avgPriceMins: 5,
  },
  { filterType: "MAX_NUM_ORDERS", maxNumOrders: 200 },
  { filterType: "MAX_NUM_ORDER_LISTS", maxNumOrderLists: 20 },
  { filterType: "MAX_NUM_ALGO_ORDERS", maxNumAlgoOrders: 5 },
  { filterType: "MAX_NUM_ORDER_AMENDS", maxNumOrderAmends: 10 },
];

function exchangeInfoBody(overrides: Record<string, unknown> = {}, filters: unknown[] = BTCUSDT_FILTERS): unknown {
  return {
    timezone: "UTC",
    serverTime: 1788845835115,
    rateLimits: [{ rateLimitType: "REQUEST_WEIGHT", interval: "MINUTE", intervalNum: 1, limit: 6000 }],
    exchangeFilters: [],
    symbols: [
      {
        symbol: "BTCUSDT",
        status: "TRADING",
        baseAsset: "BTC",
        baseAssetPrecision: 8,
        quoteAsset: "USDT",
        quotePrecision: 8,
        quoteAssetPrecision: 8,
        baseCommissionPrecision: 8,
        quoteCommissionPrecision: 8,
        orderTypes: [
          "LIMIT",
          "LIMIT_MAKER",
          "MARKET",
          "STOP_LOSS",
          "STOP_LOSS_LIMIT",
          "TAKE_PROFIT",
          "TAKE_PROFIT_LIMIT",
        ],
        icebergAllowed: true,
        ocoAllowed: true,
        isSpotTradingAllowed: true,
        isMarginTradingAllowed: false,
        filters,
        permissions: [],
        permissionSets: [["SPOT"]],
        defaultSelfTradePreventionMode: "EXPIRE_MAKER",
        allowedSelfTradePreventionModes: ["EXPIRE_TAKER", "EXPIRE_MAKER", "EXPIRE_BOTH"],
        ...overrides,
      },
    ],
  };
}

/** Routes the three allowed endpoints to canned bodies; anything else is a 404 so a stray path fails loudly. */
function cannedHandler(bodies: { depth?: unknown; exchangeInfo?: unknown; ping?: unknown } = {}): Handler {
  return (url) => {
    switch (url.pathname) {
      case "/api/v3/depth":
        return json(bodies.depth ?? DEPTH_BODY);
      case "/api/v3/exchangeInfo":
        return json(bodies.exchangeInfo ?? exchangeInfoBody());
      case "/api/v3/ping":
        return json(bodies.ping ?? {});
      default:
        return json({ code: -1, msg: `unexpected path ${url.pathname}` }, 404);
    }
  };
}

const T0 = Date.parse("2026-09-08T10:00:00.000Z");

function harness(
  handler: Handler = cannedHandler(),
  overrides: Partial<PublicRestMarketAdapterOptions> = {},
): { adapter: BinancePublicRestMarketAdapter; calls: RecordedCall[]; advance: (ms: number) => void } {
  let nowMs = T0;
  let sequence = 0;
  const { calls, fetchImpl } = recordingFetch(handler);
  const adapter = new BinancePublicRestMarketAdapter({
    source: "BINANCE_PUBLIC_REST",
    baseUrl: BINANCE_PUBLIC_DATA_BASE_URL,
    clock: () => new Date(nowMs),
    newId: (prefix) => `${prefix}-${++sequence}`,
    fetch: fetchImpl,
    ...overrides,
  });
  return {
    adapter,
    calls,
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

describe("BinancePublicRestMarketAdapter.getSnapshot (prd.md 13.4, 13.8)", () => {
  it("parses depth into canonical decimals with the public source label and a null source_timestamp", async () => {
    const { adapter, calls } = harness();
    const snapshot = await adapter.getSnapshot("BTCUSDT");

    expect(snapshot.snapshot_id).toBe("snap-1");
    expect(snapshot.symbol).toBe("BTCUSDT");
    expect(snapshot.source).toBe("BINANCE_PUBLIC_REST");
    expect(snapshot.source_timestamp).toBeNull();
    expect(snapshot.last_price).toBeNull();
    expect(snapshot.parser_version).toBe(PUBLIC_REST_PARSER_VERSION);
    expect(snapshot.request_started_at).toBe("2026-09-08T10:00:00.000Z");
    expect(snapshot.received_at).toBe("2026-09-08T10:00:00.000Z");
    expect(snapshot.bids).toEqual([
      { price: "100.5", quantity: "1" },
      { price: "100.4", quantity: "0.5" },
    ]);
    expect(snapshot.asks).toEqual([
      { price: "100.6", quantity: "2" },
      { price: "100.7", quantity: "0.25" },
    ]);
    expect(snapshot.payload_hash).toMatch(HEX64_RE);
    expect(snapshot.payload_hash).toBe(
      hashCanonical({
        symbol: "BTCUSDT",
        source: "BINANCE_PUBLIC_REST",
        last_update_id: 1027024,
        bids: snapshot.bids,
        asks: snapshot.asks,
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=20");
    expect(adapter.requestCount).toBe(1);
    expect(adapter.lastSuccessfulReadAt).toBe("2026-09-08T10:00:00.000Z");
    expect(adapter.lastError).toBeNull();
  });

  it("honours a configured depth limit and refuses one Binance does not accept", async () => {
    const { adapter, calls } = harness(cannedHandler(), { depthLimit: 5 });
    await adapter.getSnapshot("BTCUSDT");
    expect(calls[0]?.url).toContain("limit=5");
    expect(() => harness(cannedHandler(), { depthLimit: 7 })).toThrow(/depthLimit 7/);
  });

  it("rejects a malformed depth body and records the failure", async () => {
    const { adapter } = harness(cannedHandler({ depth: { lastUpdateId: 1, bids: [["1e5", "1"]], asks: [] } }));
    await expect(adapter.getSnapshot("BTCUSDT")).rejects.toThrow(/INVALID|decimal/);
    const { adapter: shapeless } = harness(cannedHandler({ depth: { bids: [], asks: [] } }));
    await expect(shapeless.getSnapshot("BTCUSDT")).rejects.toThrow(/failed validation/);
    expect(shapeless.lastError).toMatch(/failed validation/);
    expect(shapeless.lastSuccessfulReadAt).toBe("2026-09-08T10:00:00.000Z");
  });

  it("serves a cache hit as a new observation of the same content (one request, new id, same hash)", async () => {
    const { adapter, calls, advance } = harness(cannedHandler(), { cacheMs: 1500 });
    const first = await adapter.getSnapshot("BTCUSDT");
    advance(500);
    const second = await adapter.getSnapshot("BTCUSDT");

    expect(calls).toHaveLength(1);
    expect(adapter.requestCount).toBe(1);
    expect(second.snapshot_id).not.toBe(first.snapshot_id);
    expect(second.payload_hash).toBe(first.payload_hash);
    expect(second.bids).toEqual(first.bids);
    expect(second.asks).toEqual(first.asks);
    expect(second.request_started_at).toBe("2026-09-08T10:00:00.500Z");
    expect(second.received_at).toBe("2026-09-08T10:00:00.500Z");

    advance(1500);
    const third = await adapter.getSnapshot("BTCUSDT");
    expect(calls).toHaveLength(2);
    expect(third.snapshot_id).toBe("snap-3");
  });

  it("caches per symbol and not at all when cacheMs is 0", async () => {
    const { adapter, calls } = harness(cannedHandler(), { cacheMs: 1500 });
    await adapter.getSnapshot("BTCUSDT");
    await adapter.getSnapshot("ETHUSDT");
    await adapter.getSnapshot("BTCUSDT");
    expect(calls.map((c) => new URL(c.url).searchParams.get("symbol"))).toEqual(["BTCUSDT", "ETHUSDT"]);

    const uncached = harness(cannedHandler(), { cacheMs: 0 });
    await uncached.adapter.getSnapshot("BTCUSDT");
    await uncached.adapter.getSnapshot("BTCUSDT");
    expect(uncached.calls).toHaveLength(2);
  });

  it.each(["btcusdt", "B", "", "BTC-USDT", "BTC USDT", "ABCDEFGHIJKLMNOPQRSTU"])(
    "refuses invalid symbol %j before any request",
    async (symbol) => {
      const { adapter, calls } = harness();
      await expect(adapter.getSnapshot(symbol)).rejects.toThrow(/invalid symbol/);
      await expect(adapter.getSymbolRules(symbol)).rejects.toThrow(/invalid symbol/);
      expect(calls).toHaveLength(0);
      expect(adapter.requestCount).toBe(0);
    },
  );
});

describe("BinancePublicRestMarketAdapter.getSymbolRules (prd.md 9.10, 13.5)", () => {
  it("maps the real Testnet filter set with nothing unsupported", async () => {
    const { adapter, calls } = harness();
    const rules = await adapter.getSymbolRules("BTCUSDT");

    expect(calls[0]?.url).toBe("https://data-api.binance.vision/api/v3/exchangeInfo?symbol=BTCUSDT");
    expect(rules.symbol).toBe("BTCUSDT");
    expect(rules.base_asset).toBe("BTC");
    expect(rules.quote_asset).toBe("USDT");
    expect(rules.status).toBe("TRADING");
    expect(rules.tick_size).toBe("0.01");
    expect(rules.step_size).toBe("0.00001");
    expect(rules.min_qty).toBe("0.00001");
    expect(rules.max_qty).toBe("9000");
    expect(rules.min_notional).toBe("5");
    expect(rules.max_notional).toBe("9000000");
    expect(rules.base_precision).toBe(8);
    expect(rules.quote_precision).toBe(8);
    expect(rules.unsupported_filters).toEqual([]);
    expect(rules.source).toBe("BINANCE_PUBLIC_REST");
    expect(rules.received_at).toBe("2026-09-08T10:00:00.000Z");
    expect(rules.payload_hash).toMatch(HEX64_RE);
    expect(rules.payload_hash).toBe(hashCanonical({ ...rules, received_at: undefined, payload_hash: undefined }));
  });

  it("reports an unknown filter type in unsupported_filters", async () => {
    const filters = [...BTCUSDT_FILTERS, { filterType: "FOO_FILTER", fooLimit: 3 }];
    const { adapter } = harness(cannedHandler({ exchangeInfo: exchangeInfoBody({}, filters) }));
    const rules = await adapter.getSymbolRules("BTCUSDT");
    expect(rules.unsupported_filters).toEqual(["FOO_FILTER"]);
  });

  it("falls back to MIN_NOTIONAL when NOTIONAL is absent, with a null maximum", async () => {
    const filters = BTCUSDT_FILTERS.filter((f) => f.filterType !== "NOTIONAL");
    filters.push({ filterType: "MIN_NOTIONAL", minNotional: "10.00000000", applyToMarket: true, avgPriceMins: 5 });
    const { adapter } = harness(cannedHandler({ exchangeInfo: exchangeInfoBody({}, filters) }));
    const rules = await adapter.getSymbolRules("BTCUSDT");
    expect(rules.min_notional).toBe("10");
    expect(rules.max_notional).toBeNull();
    expect(rules.unsupported_filters).toEqual([]);
  });

  it("treats a NOTIONAL filter without maxNotional as unbounded above", async () => {
    const filters = BTCUSDT_FILTERS.map((f) =>
      f.filterType === "NOTIONAL" ? { filterType: "NOTIONAL", minNotional: "5.00000000", avgPriceMins: 5 } : f,
    );
    const { adapter } = harness(cannedHandler({ exchangeInfo: exchangeInfoBody({}, filters) }));
    const rules = await adapter.getSymbolRules("BTCUSDT");
    expect(rules.max_notional).toBeNull();
  });

  it.each(["PRICE_FILTER", "LOT_SIZE", "NOTIONAL"])("throws when %s is missing (rules incomplete)", async (type) => {
    const filters = BTCUSDT_FILTERS.filter((f) => f.filterType !== type);
    const { adapter } = harness(cannedHandler({ exchangeInfo: exchangeInfoBody({}, filters) }));
    await expect(adapter.getSymbolRules("BTCUSDT")).rejects.toThrow(/incomplete/);
    expect(adapter.lastError).toMatch(/incomplete/);
  });

  it.each([
    ["TRADING", "TRADING"],
    ["HALT", "HALT"],
    ["BREAK", "BREAK"],
    ["PRE_TRADING", "UNKNOWN"],
    ["END_OF_DAY", "UNKNOWN"],
  ])("maps status %s to %s", async (upstream, expected) => {
    const { adapter } = harness(cannedHandler({ exchangeInfo: exchangeInfoBody({ status: upstream }) }));
    expect((await adapter.getSymbolRules("BTCUSDT")).status).toBe(expected);
  });

  it("uses quotePrecision when quoteAssetPrecision is absent", async () => {
    const body = exchangeInfoBody({ quoteAssetPrecision: undefined, quotePrecision: 6 });
    const { adapter } = harness(cannedHandler({ exchangeInfo: body }));
    expect((await adapter.getSymbolRules("BTCUSDT")).quote_precision).toBe(6);
  });

  it("refuses a response that is not exactly the requested symbol", async () => {
    const { adapter: wrong } = harness(cannedHandler({ exchangeInfo: exchangeInfoBody({ symbol: "ETHUSDT" }) }));
    await expect(wrong.getSymbolRules("BTCUSDT")).rejects.toThrow(/returned rules for ETHUSDT/);
    const { adapter: empty } = harness(cannedHandler({ exchangeInfo: { symbols: [] } }));
    await expect(empty.getSymbolRules("BTCUSDT")).rejects.toThrow(/returned 0 symbols/);
  });
});

describe("read-only guarantees (prd.md 13.4, T-49)", () => {
  it("only ever issues unauthenticated GETs to the allowlisted host", async () => {
    const { adapter, calls } = harness();
    const manifest = await adapter.discoverCapabilities();
    await adapter.getSnapshot("BTCUSDT");
    await adapter.getSymbolRules("BTCUSDT");

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.method).toBe("GET");
      const url = new URL(call.url);
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe("data-api.binance.vision");
      expect(["/api/v3/ping", "/api/v3/depth", "/api/v3/exchangeInfo"]).toContain(url.pathname);
      expect(Object.keys(call.headers)).not.toContain("authorization");
      expect(Object.keys(call.headers)).not.toContain("x-mbx-apikey");
      expect(Object.keys(call.headers).some((h) => h.includes("api") || h.includes("auth"))).toBe(false);
    }
    expect(manifest.capabilities.order_write).toEqual({
      status: "BLOCKED",
      detail: "read-only public adapter; no credentials, no write path",
    });
  });

  it("refuses http://, foreign hosts, credentials, and paths in the constructor", () => {
    const build =
      (baseUrl: string, source: PublicRestMarketAdapterOptions["source"] = "BINANCE_PUBLIC_REST") =>
      () =>
        new BinancePublicRestMarketAdapter({ source, baseUrl, clock: () => new Date(T0), newId: (p) => p });
    expect(build("http://data-api.binance.vision")).toThrow(/only https/);
    expect(build("https://evil.example.com")).toThrow(/not one of/);
    expect(build("https://data-api.binance.vision.evil.example")).toThrow(/not one of/);
    expect(build("https://user:secret@data-api.binance.vision")).toThrow(/credentials/);
    expect(build("https://data-api.binance.vision/api/v3")).toThrow(/bare origin/);
    expect(build("not a url")).toThrow(/not a valid URL/);
    expect(build(BINANCE_TESTNET_BASE_URL, "BINANCE_PUBLIC_REST")).toThrow(/cannot be labelled/);
    expect(build(BINANCE_PUBLIC_DATA_BASE_URL, "BINANCE_TESTNET_REST")).toThrow(/cannot be labelled/);
    expect(build(BINANCE_TESTNET_BASE_URL, "BINANCE_TESTNET_REST")).not.toThrow();
    expect(build("https://api.binance.com/")).not.toThrow();
  });

  it("surfaces a rate limit with the Retry-After hint and never retries on its own", async () => {
    const { adapter, calls } = harness(() =>
      json({ code: -1003, msg: "Too many requests" }, 429, { "retry-after": "3" }),
    );
    await expect(adapter.getSnapshot("BTCUSDT")).rejects.toThrow(/binance rate limit \(HTTP 429\).*Retry-After: 3s/);
    expect(calls).toHaveLength(1);
    expect(adapter.requestCount).toBe(1);
    expect(adapter.lastError).toMatch(/rate limit/);
    expect(adapter.lastSuccessfulReadAt).toBeNull();

    const banned = harness(() => json({ code: -1003, msg: "banned" }, 418));
    await expect(banned.adapter.getSnapshot("BTCUSDT")).rejects.toThrow(/rate limit \(HTTP 418\)/);
    expect(banned.calls).toHaveLength(1);
  });

  it("reports other HTTP failures with a bounded body excerpt", async () => {
    const { adapter } = harness(() => json({ code: -1121, msg: "Invalid symbol." }, 400));
    await expect(adapter.getSnapshot("BTCUSDT")).rejects.toThrow(/HTTP 400.*Invalid symbol/);
  });

  it("aborts a hung request after timeoutMs", async () => {
    const { adapter } = harness(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
      { timeoutMs: 20 },
    );
    await expect(adapter.getSnapshot("BTCUSDT")).rejects.toThrow(/timed out after 20ms/);
    expect(adapter.lastError).toMatch(/timed out/);
  });

  it("rejects an observation whose measured latency exceeds timeoutMs (prd.md 13.8)", async () => {
    let nowMs = T0;
    const { fetchImpl } = recordingFetch(() => {
      nowMs += 6000;
      return json(DEPTH_BODY);
    });
    const adapter = new BinancePublicRestMarketAdapter({
      source: "BINANCE_PUBLIC_REST",
      baseUrl: BINANCE_PUBLIC_DATA_BASE_URL,
      clock: () => new Date(nowMs),
      newId: (p) => p,
      fetch: fetchImpl,
      timeoutMs: 5000,
    });
    await expect(adapter.getSnapshot("BTCUSDT")).rejects.toThrow(/took 6000ms/);
  });
});

describe("BinancePublicRestMarketAdapter.discoverCapabilities", () => {
  it("derives SHADOW for the public data host and marks reads available after a ping", async () => {
    const { adapter, calls } = harness();
    const manifest = await adapter.discoverCapabilities();
    expect(calls[0]?.url).toBe("https://data-api.binance.vision/api/v3/ping");
    expect(manifest.adapter).toBe("binance-public-rest");
    expect(manifest.environment).toBe("SHADOW");
    expect(manifest.checked_at).toBe("2026-09-08T10:00:00.000Z");
    expect(manifest.capabilities.read_market_context?.status).toBe("AVAILABLE");
    expect(manifest.capabilities.read_symbol_rules?.status).toBe("AVAILABLE");
    expect(manifest.capabilities.order_write?.status).toBe("BLOCKED");
  });

  it("derives TESTNET for the testnet host", async () => {
    const { adapter } = harness(cannedHandler(), { source: "BINANCE_TESTNET_REST", baseUrl: BINANCE_TESTNET_BASE_URL });
    expect(adapter.source).toBe("BINANCE_TESTNET_REST");
    expect((await adapter.discoverCapabilities()).environment).toBe("TESTNET");
    expect((await adapter.getSnapshot("BTCUSDT")).source).toBe("BINANCE_TESTNET_REST");
  });

  it("marks reads unavailable with the error detail when ping fails, without throwing", async () => {
    const { adapter } = harness(() => json({ code: -1, msg: "maintenance" }, 503));
    const manifest = await adapter.discoverCapabilities();
    expect(manifest.capabilities.read_market_context?.status).toBe("UNAVAILABLE");
    expect(manifest.capabilities.read_market_context?.detail).toMatch(/HTTP 503/);
    expect(manifest.capabilities.read_symbol_rules?.status).toBe("UNAVAILABLE");
    expect(manifest.capabilities.order_write?.status).toBe("BLOCKED");
    expect(adapter.lastError).toMatch(/HTTP 503/);
  });
});
