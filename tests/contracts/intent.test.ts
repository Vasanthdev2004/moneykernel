import { TradeIntentSchema } from "@moneykernel/contracts";
import { describe, expect, it } from "vitest";

/** The synthetic fixture request from prd.md 15.3 / scenario A. */
const example = {
  schema_version: "1",
  lease_id: "lease_alpha_01",
  symbol: "SOLUSDT",
  side: "BUY",
  order_type: "LIMIT_IOC",
  size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "80" },
  limit_price: "100",
  observation_ids: ["snapshot_fixture_sol_01"],
  rationale: "Example fixture proposal; the kernel must size it independently.",
  strategy_run_id: "strategy_run_01",
};

describe("TradeIntentSchema (prd.md 15.3)", () => {
  it("accepts the PRD example and canonicalizes decimals", () => {
    const parsed = TradeIntentSchema.parse({ ...example, limit_price: "100.00" });
    expect(parsed.limit_price).toBe("100");
    expect(parsed.size).toEqual({ kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "80" });
  });

  it("accepts a SELL sized by base quantity", () => {
    const parsed = TradeIntentSchema.parse({
      ...example,
      side: "SELL",
      symbol: "BTCUSDT",
      size: { kind: "BASE_QUANTITY", base_asset: "BTC", amount: "0.0002" },
      limit_price: "100000",
    });
    expect(parsed.size.kind).toBe("BASE_QUANTITY");
  });

  it("T-06: rejects unknown fields requesting an override", () => {
    const result = TradeIntentSchema.safeParse({ ...example, override_policy: true });
    expect(result.success).toBe(false);
  });

  it("T-06: rejects unknown fields nested in size", () => {
    const result = TradeIntentSchema.safeParse({
      ...example,
      size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "80", skip_checks: true },
    });
    expect(result.success).toBe(false);
  });

  it.each(["1e3", "-80", "0", "NaN", "Infinity", "+80", "80 ", "0x50"])(
    "T-05: rejects malformed amount %j before any state mutation",
    (amount) => {
      const result = TradeIntentSchema.safeParse({ ...example, size: { ...example.size, amount } });
      expect(result.success).toBe(false);
    },
  );

  it("rejects a BUY sized by base quantity and a SELL sized by quote notional", () => {
    expect(
      TradeIntentSchema.safeParse({ ...example, size: { kind: "BASE_QUANTITY", base_asset: "SOL", amount: "1" } })
        .success,
    ).toBe(false);
    expect(TradeIntentSchema.safeParse({ ...example, side: "SELL" }).success).toBe(false);
  });

  it("T-07: rejects unsupported order types and malformed symbols", () => {
    expect(TradeIntentSchema.safeParse({ ...example, order_type: "MARKET" }).success).toBe(false);
    expect(TradeIntentSchema.safeParse({ ...example, order_type: "LIMIT" }).success).toBe(false);
    expect(TradeIntentSchema.safeParse({ ...example, symbol: "sol/usdt" }).success).toBe(false);
  });

  it("bounds observation references and rationale length", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `obs_${i}`);
    expect(TradeIntentSchema.safeParse({ ...example, observation_ids: eleven }).success).toBe(false);
    expect(TradeIntentSchema.safeParse({ ...example, rationale: "x".repeat(501) }).success).toBe(false);
    expect(TradeIntentSchema.safeParse({ ...example, rationale: "x".repeat(500) }).success).toBe(true);
  });

  it("requires schema_version 1 and never accepts an agent_id selector", () => {
    expect(TradeIntentSchema.safeParse({ ...example, schema_version: "2" }).success).toBe(false);
    expect(TradeIntentSchema.safeParse({ ...example, agent_id: "agent_other" }).success).toBe(false);
  });
});
