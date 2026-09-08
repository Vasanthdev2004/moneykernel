import type { MarketSnapshot, SymbolRules } from "@moneykernel/contracts";
import { type Pool, recordSnapshot, withClient } from "@moneykernel/persistence";
import type { KernelRuntime } from "../boot.ts";

/**
 * Observations are recorded as immutable snapshot rows before any decision
 * references them, with request/receive timestamps and a content hash
 * (prd.md 13.8). Refreshes run outside the admission transaction (prd.md 11.3).
 */
export async function recordMarketSnapshot(pool: Pool, accountId: string, snapshot: MarketSnapshot): Promise<void> {
  await withClient(pool, (client) =>
    recordSnapshot(client, {
      id: snapshot.snapshot_id,
      accountId,
      type: "MARKET",
      source: snapshot.source,
      sourceTime: snapshot.source_timestamp === null ? null : new Date(snapshot.source_timestamp),
      receivedAt: new Date(snapshot.received_at),
      payload: {
        symbol: snapshot.symbol,
        source: snapshot.source,
        request_started_at: snapshot.request_started_at,
        source_timestamp: snapshot.source_timestamp,
        bids: snapshot.bids,
        asks: snapshot.asks,
        last_price: snapshot.last_price,
        parser_version: snapshot.parser_version,
      },
      payloadHash: snapshot.payload_hash,
      parserVersion: snapshot.parser_version,
    }),
  );
}

export async function recordSymbolRules(pool: Pool, accountId: string, id: string, rules: SymbolRules): Promise<void> {
  await withClient(pool, (client) =>
    recordSnapshot(client, {
      id,
      accountId,
      type: "SYMBOL_RULES",
      source: rules.source,
      sourceTime: null,
      receivedAt: new Date(rules.received_at),
      payload: { ...rules },
      payloadHash: rules.payload_hash,
      parserVersion: "rules-1",
    }),
  );
}

export type RefreshResult = { snapshots: MarketSnapshot[]; failures: Array<{ symbol: string; error: string }> };

/** Reads fresh marks for the given symbols through the configured market adapter and persists them. */
export async function refreshMarks(
  runtime: KernelRuntime,
  accountId: string,
  symbols: string[],
): Promise<RefreshResult> {
  const result: RefreshResult = { snapshots: [], failures: [] };
  if (runtime.market === null || runtime.pool === null) {
    for (const symbol of symbols) result.failures.push({ symbol, error: "no market adapter" });
    return result;
  }
  for (const symbol of new Set(symbols)) {
    try {
      const snapshot = await runtime.market.getSnapshot(symbol);
      await recordMarketSnapshot(runtime.pool, accountId, snapshot);
      result.snapshots.push(snapshot);
      runtime.marketHealth.last_successful_read_at = snapshot.received_at;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.marketHealth.last_error = message;
      result.failures.push({ symbol, error: message });
    }
  }
  return result;
}

export async function refreshSymbolRules(
  runtime: KernelRuntime,
  accountId: string,
  symbol: string,
  newId: (prefix: string) => string,
): Promise<{ id: string; rules: SymbolRules } | null> {
  if (runtime.market === null || runtime.pool === null) return null;
  try {
    const rules = await runtime.market.getSymbolRules(symbol);
    const id = newId("rules");
    await recordSymbolRules(runtime.pool, accountId, id, rules);
    return { id, rules };
  } catch {
    return null;
  }
}
