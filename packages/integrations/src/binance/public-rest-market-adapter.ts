import {
  type BookLevel,
  type CapabilityManifest,
  canonicalizeDecimal,
  type DecimalString,
  type Environment,
  hashCanonical,
  type MarketAdapter,
  type MarketSnapshot,
  NonNegativeDecimalStringSchema,
  SYMBOL_RE,
  type SymbolRules,
  type SymbolStatus,
} from "@moneykernel/contracts";
import { z } from "zod";

export const BINANCE_PUBLIC_DATA_BASE_URL = "https://data-api.binance.vision";
export const BINANCE_TESTNET_BASE_URL = "https://testnet.binance.vision";
export const PUBLIC_REST_PARSER_VERSION = "binance-rest-1";

/** Hosts this adapter will ever talk to. Anything else is refused in the constructor, before any request. */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "data-api.binance.vision",
  "api.binance.com",
  "testnet.binance.vision",
]);

/** Which hosts may carry which provenance label; a mislabelled source would corrupt receipts (prd.md 13.4, 13.5). */
const HOSTS_BY_SOURCE: Record<PublicRestMarketAdapterOptions["source"], ReadonlySet<string>> = {
  BINANCE_PUBLIC_REST: new Set(["data-api.binance.vision", "api.binance.com"]),
  BINANCE_TESTNET_REST: new Set(["testnet.binance.vision"]),
};

const ENVIRONMENT_BY_SOURCE: Record<PublicRestMarketAdapterOptions["source"], Environment> = {
  BINANCE_PUBLIC_REST: "SHADOW",
  BINANCE_TESTNET_REST: "TESTNET",
};

/** Depth limits accepted by GET /api/v3/depth at request weight 5 or below. */
const DEPTH_LIMITS: ReadonlySet<number> = new Set([5, 10, 20, 50, 100]);

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_MS = 1500;
const DEFAULT_DEPTH_LIMIT = 20;

/**
 * Spot symbol filters the adapter recognises (Binance Spot REST exchangeInfo).
 *
 * - PRICE_FILTER, LOT_SIZE, NOTIONAL (and its predecessor MIN_NOTIONAL) are
 *   mapped into SymbolRules and enforced by the kernel evaluator.
 * - MARKET_LOT_SIZE, ICEBERG_PARTS, TRAILING_DELTA, MAX_NUM_ALGO_ORDERS,
 *   MAX_NUM_ICEBERG_ORDERS, MAX_NUM_ORDER_LISTS, MAX_NUM_ORDER_AMENDS do not
 *   apply to a single LIMIT IOC order: they govern market orders, iceberg
 *   orders, trailing stops, algo orders, order lists, and amendments, none of
 *   which the kernel can emit (prd.md 4.3).
 * - MAX_NUM_ORDERS is bounded by the kernel's single in-flight LIMIT IOC.
 * - PERCENT_PRICE and PERCENT_PRICE_BY_SIDE need the venue's reference price
 *   or weighted average over the stated window. A fresh book/drift check is
 *   not equivalent. MAX_POSITION requires account-position qualification.
 *   These applicable filters remain unsupported and block proposals.
 *
 * Any filter type outside this list is reported in `unsupported_filters` so
 * the evaluator denies with FILTER_UNSUPPORTED (prd.md 9.10) instead of
 * guessing at semantics it has not implemented.
 */
export const KNOWN_FILTER_TYPES: ReadonlySet<string> = new Set([
  "PRICE_FILTER",
  "LOT_SIZE",
  "NOTIONAL",
  "MIN_NOTIONAL",
  "MARKET_LOT_SIZE",
  "ICEBERG_PARTS",
  "TRAILING_DELTA",
  "MAX_NUM_ALGO_ORDERS",
  "MAX_NUM_ICEBERG_ORDERS",
  "MAX_NUM_ORDER_LISTS",
  "MAX_NUM_ORDER_AMENDS",
  "MAX_NUM_ORDERS",
]);

const DepthLevelSchema = z.tuple([z.string(), z.string()]);
const DepthResponseSchema = z.object({
  lastUpdateId: z.number().int(),
  bids: z.array(DepthLevelSchema),
  asks: z.array(DepthLevelSchema),
});

const FilterSchema = z.object({ filterType: z.string() }).loose();
const ExchangeInfoSymbolSchema = z
  .object({
    symbol: z.string(),
    status: z.string(),
    baseAsset: z.string(),
    quoteAsset: z.string(),
    baseAssetPrecision: z.number().int(),
    quotePrecision: z.number().int().optional(),
    quoteAssetPrecision: z.number().int().optional(),
    filters: z.array(FilterSchema),
  })
  .loose();
const ExchangeInfoResponseSchema = z.object({ symbols: z.array(ExchangeInfoSymbolSchema) });

type ExchangeFilter = z.infer<typeof FilterSchema>;
type ObservedBody = { body: unknown; requestStartedAt: string; receivedAt: string };
type CachedBook = {
  expiresAtMs: number;
  requestStartedAt: string;
  receivedAt: string;
  lastUpdateId: number;
  bids: BookLevel[];
  asks: BookLevel[];
  payloadHash: string;
};

export type PublicRestMarketAdapterOptions = {
  source: "BINANCE_PUBLIC_REST" | "BINANCE_TESTNET_REST";
  baseUrl: string;
  clock: () => Date;
  newId: (prefix: string) => string;
  fetch?: typeof fetch;
  /** Request deadline enforced with AbortController. Default 5000. */
  timeoutMs?: number;
  /** Per-symbol depth cache lifetime. Default 1500; keep it far below any policy staleness threshold. */
  cacheMs?: number;
  /** Order book levels per side; one of 5, 10, 20, 50, 100. Default 20. */
  depthLimit?: number;
};

/**
 * Public Spot REST read adapter (prd.md 13.4). READ-ONLY by construction:
 * the only HTTP method ever used is GET, the only paths are /api/v3/depth,
 * /api/v3/exchangeInfo and /api/v3/ping, the host is allowlisted in the
 * constructor, redirects are refused, and no credentials or custom auth
 * headers are ever attached. There is no write path at all (T-49).
 *
 * The adapter never retries on its own: a rate-limit response (429/418) is
 * surfaced to the caller with the venue's Retry-After hint so that backoff is
 * an operator decision, not an adapter reflex.
 */
export class BinancePublicRestMarketAdapter implements MarketAdapter {
  readonly source: "BINANCE_PUBLIC_REST" | "BINANCE_TESTNET_REST";
  private readonly origin: string;
  private readonly clock: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly depthLimit: number;
  private readonly depthCache = new Map<string, CachedBook>();
  private requests = 0;
  private lastSuccess: string | null = null;
  private lastFailure: string | null = null;

  constructor(options: PublicRestMarketAdapterOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new Error(`binance adapter refused baseUrl ${JSON.stringify(options.baseUrl)}: not a valid URL`);
    }
    if (url.protocol !== "https:") {
      throw new Error(`binance adapter refused baseUrl ${options.baseUrl}: only https:// is allowed`);
    }
    if (!ALLOWED_HOSTS.has(url.hostname)) {
      throw new Error(
        `binance adapter refused baseUrl ${options.baseUrl}: host ${url.hostname} is not one of ${[...ALLOWED_HOSTS].join(", ")}`,
      );
    }
    if (url.username !== "" || url.password !== "") {
      throw new Error(`binance adapter refused baseUrl: credentials in the URL are not allowed on a public read path`);
    }
    if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
      throw new Error(
        `binance adapter refused baseUrl ${options.baseUrl}: expected a bare origin without path or query`,
      );
    }
    if (!HOSTS_BY_SOURCE[options.source].has(url.hostname)) {
      throw new Error(
        `binance adapter refused baseUrl ${options.baseUrl}: host ${url.hostname} cannot be labelled ${options.source}`,
      );
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`binance adapter refused timeoutMs ${timeoutMs}: expected a positive integer`);
    }
    const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
    if (!Number.isInteger(cacheMs) || cacheMs < 0) {
      throw new Error(`binance adapter refused cacheMs ${cacheMs}: expected a non-negative integer`);
    }
    const depthLimit = options.depthLimit ?? DEFAULT_DEPTH_LIMIT;
    if (!DEPTH_LIMITS.has(depthLimit)) {
      throw new Error(
        `binance adapter refused depthLimit ${depthLimit}: expected one of ${[...DEPTH_LIMITS].join(", ")}`,
      );
    }
    this.source = options.source;
    this.origin = url.origin;
    this.clock = options.clock;
    this.newId = options.newId;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = timeoutMs;
    this.cacheMs = cacheMs;
    this.depthLimit = depthLimit;
  }

  /** Clock reading (ISO) of the most recent request that returned 2xx JSON, or null before the first one. */
  get lastSuccessfulReadAt(): string | null {
    return this.lastSuccess;
  }

  /** Message of the most recent failure (request, validation, or mapping), or null if none has happened. */
  get lastError(): string | null {
    return this.lastFailure;
  }

  /** Total HTTP requests attempted, including failed and rate-limited ones. Cache hits are not requests. */
  get requestCount(): number {
    return this.requests;
  }

  async discoverCapabilities(): Promise<CapabilityManifest> {
    const environment = ENVIRONMENT_BY_SOURCE[this.source];
    let reads: { status: "AVAILABLE" | "UNAVAILABLE"; detail: string };
    try {
      await this.getJson("/api/v3/ping", {});
      reads = { status: "AVAILABLE", detail: `GET ${this.origin}/api/v3/ping ok` };
    } catch (error) {
      reads = { status: "UNAVAILABLE", detail: `GET ${this.origin}/api/v3/ping failed: ${errorMessage(error)}` };
    }
    return {
      adapter: "binance-public-rest",
      environment,
      checked_at: this.clock().toISOString(),
      capabilities: {
        read_market_context: { ...reads },
        read_symbol_rules: { ...reads },
        order_write: { status: "BLOCKED", detail: "read-only public adapter; no credentials, no write path" },
      },
    };
  }

  async getSnapshot(symbol: string): Promise<MarketSnapshot> {
    assertSymbol(symbol);
    const requestStartedAt = this.clock();
    const cached = this.depthCache.get(symbol);
    if (cached !== undefined && requestStartedAt.getTime() < cached.expiresAtMs) {
      // A new snapshot ID may reference this cached book, but its age and
      // request latency still belong to the actual fetch. A cache hit must
      // never renew freshness or extend the cache's original expiry.
      return this.buildSnapshot(symbol, cached);
    }
    try {
      const observed = await this.getJson("/api/v3/depth", { symbol, limit: String(this.depthLimit) });
      const parsed = DepthResponseSchema.safeParse(observed.body);
      if (!parsed.success) {
        throw new Error(`binance depth response for ${symbol} failed validation: ${parsed.error.message}`);
      }
      const bids = parsed.data.bids.map(toBookLevel);
      const asks = parsed.data.asks.map(toBookLevel);
      const book: CachedBook = {
        expiresAtMs: Date.parse(observed.receivedAt) + this.cacheMs,
        requestStartedAt: observed.requestStartedAt,
        receivedAt: observed.receivedAt,
        lastUpdateId: parsed.data.lastUpdateId,
        bids,
        asks,
        payloadHash: hashCanonical({
          symbol,
          source: this.source,
          last_update_id: parsed.data.lastUpdateId,
          bids,
          asks,
        }),
      };
      this.depthCache.set(symbol, book);
      return this.buildSnapshot(symbol, book);
    } catch (error) {
      this.lastFailure = errorMessage(error);
      throw error;
    }
  }

  async getSymbolRules(symbol: string): Promise<SymbolRules> {
    assertSymbol(symbol);
    try {
      const observed = await this.getJson("/api/v3/exchangeInfo", { symbol });
      const parsed = ExchangeInfoResponseSchema.safeParse(observed.body);
      if (!parsed.success) {
        throw new Error(`binance exchangeInfo response for ${symbol} failed validation: ${parsed.error.message}`);
      }
      const entry = parsed.data.symbols[0];
      if (entry === undefined || parsed.data.symbols.length !== 1) {
        throw new Error(
          `binance exchangeInfo for ${symbol} returned ${parsed.data.symbols.length} symbols; expected 1`,
        );
      }
      if (entry.symbol !== symbol) {
        throw new Error(`binance exchangeInfo for ${symbol} returned rules for ${entry.symbol}`);
      }
      const quotePrecision = entry.quoteAssetPrecision ?? entry.quotePrecision;
      if (quotePrecision === undefined) {
        throw new Error(`binance exchangeInfo for ${symbol} carries neither quoteAssetPrecision nor quotePrecision`);
      }
      const filters = new Map<string, ExchangeFilter>();
      const unsupported: string[] = [];
      for (const filter of entry.filters) {
        if (!filters.has(filter.filterType)) filters.set(filter.filterType, filter);
        if (!KNOWN_FILTER_TYPES.has(filter.filterType) && !unsupported.includes(filter.filterType)) {
          unsupported.push(filter.filterType);
        }
      }
      const priceFilter = filters.get("PRICE_FILTER");
      const lotSize = filters.get("LOT_SIZE");
      const notional = filters.get("NOTIONAL");
      // NOTIONAL superseded MIN_NOTIONAL; the older filter carries no maximum.
      const notionalSource = notional ?? filters.get("MIN_NOTIONAL");
      const missing: string[] = [];
      if (priceFilter === undefined) missing.push("PRICE_FILTER");
      if (lotSize === undefined) missing.push("LOT_SIZE");
      if (notionalSource === undefined) missing.push("NOTIONAL or MIN_NOTIONAL");
      if (priceFilter === undefined || lotSize === undefined || notionalSource === undefined) {
        throw new Error(`binance exchangeInfo for ${symbol} is incomplete: missing ${missing.join(", ")}`);
      }
      const rules: SymbolRules = {
        symbol,
        base_asset: entry.baseAsset,
        quote_asset: entry.quoteAsset,
        status: mapStatus(entry.status),
        tick_size: NonNegativeDecimalStringSchema.parse(requireDecimal(priceFilter, "tickSize")),
        min_price: NonNegativeDecimalStringSchema.parse(requireDecimal(priceFilter, "minPrice")),
        max_price: NonNegativeDecimalStringSchema.parse(requireDecimal(priceFilter, "maxPrice")),
        step_size: requireDecimal(lotSize, "stepSize"),
        min_qty: requireDecimal(lotSize, "minQty"),
        max_qty: requireDecimal(lotSize, "maxQty"),
        min_notional: requireDecimal(notionalSource, "minNotional"),
        max_notional: notional === undefined ? null : optionalDecimal(notional, "maxNotional"),
        base_precision: entry.baseAssetPrecision,
        quote_precision: quotePrecision,
        unsupported_filters: unsupported,
        source: this.source,
        received_at: observed.receivedAt,
        payload_hash: "",
      };
      rules.payload_hash = hashCanonical({ ...rules, received_at: undefined, payload_hash: undefined });
      return rules;
    } catch (error) {
      this.lastFailure = errorMessage(error);
      throw error;
    }
  }

  private buildSnapshot(symbol: string, book: CachedBook): MarketSnapshot {
    return {
      snapshot_id: this.newId("snap"),
      symbol,
      source: this.source,
      request_started_at: book.requestStartedAt,
      received_at: book.receivedAt,
      // GET /api/v3/depth carries no exchange event time, so null here means
      // "local observation age only" (prd.md 13.8); the kernel must not treat
      // it as guaranteed exchange-event age.
      source_timestamp: null,
      bids: book.bids,
      asks: book.asks,
      last_price: null,
      payload_hash: book.payloadHash,
      parser_version: PUBLIC_REST_PARSER_VERSION,
    };
  }

  /**
   * The single network path of this adapter: an unauthenticated GET to one of
   * three fixed endpoints on the allowlisted origin, bounded by timeoutMs.
   */
  private async getJson(
    path: "/api/v3/depth" | "/api/v3/exchangeInfo" | "/api/v3/ping",
    params: Record<string, string>,
  ): Promise<ObservedBody> {
    const url = new URL(path, this.origin);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const label = `GET ${path}`;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`binance ${label} timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    this.requests += 1;
    const requestStartedAt = this.clock().toISOString();
    let status: number;
    let retryAfter: string | null;
    let text: string;
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
        redirect: "error",
      });
      status = response.status;
      retryAfter = response.headers.get("retry-after");
      text = await response.text();
    } catch (error) {
      // Node rejects with the abort reason we supplied; other runtimes reject with a DOMException AbortError.
      const message = controller.signal.aborted
        ? `binance ${label} timed out after ${this.timeoutMs}ms`
        : `binance ${label} failed: ${errorMessage(error)}`;
      this.lastFailure = message;
      throw new Error(message, { cause: error });
    } finally {
      clearTimeout(timer);
    }
    const receivedAt = this.clock().toISOString();
    try {
      if (status === 429 || status === 418) {
        const hint = retryAfter === null ? "" : `; Retry-After: ${retryAfter}s`;
        throw new Error(`binance rate limit (HTTP ${status}) on ${label}${hint}; not retrying automatically`);
      }
      if (status < 200 || status >= 300) {
        throw new Error(`binance ${label} failed with HTTP ${status}: ${text.slice(0, 200)}`);
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`binance ${label} returned a non-JSON body`);
      }
      const latencyMs = Date.parse(receivedAt) - Date.parse(requestStartedAt);
      if (latencyMs > this.timeoutMs) {
        throw new Error(`binance ${label} took ${latencyMs}ms, above the ${this.timeoutMs}ms limit (prd.md 13.8)`);
      }
      this.lastSuccess = receivedAt;
      return { body, requestStartedAt, receivedAt };
    } catch (error) {
      this.lastFailure = errorMessage(error);
      throw error;
    }
  }
}

function assertSymbol(symbol: string): void {
  if (typeof symbol !== "string" || !SYMBOL_RE.test(symbol)) {
    throw new Error(`invalid symbol ${JSON.stringify(symbol)}: expected 2-20 uppercase alphanumerics`);
  }
}

function toBookLevel([price, quantity]: [string, string]): BookLevel {
  return { price: canonicalizeDecimal(price), quantity: canonicalizeDecimal(quantity) };
}

function mapStatus(status: string): SymbolStatus {
  switch (status) {
    case "TRADING":
    case "HALT":
    case "BREAK":
      return status;
    default:
      return "UNKNOWN";
  }
}

function requireDecimal(filter: ExchangeFilter, key: string): DecimalString {
  const value = filter[key];
  if (typeof value !== "string") {
    throw new Error(`binance filter ${filter.filterType} is missing a decimal string ${key}`);
  }
  return canonicalizeDecimal(value);
}

function optionalDecimal(filter: ExchangeFilter, key: string): DecimalString | null {
  const value = filter[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`binance filter ${filter.filterType} has a non-string ${key}`);
  }
  return canonicalizeDecimal(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
