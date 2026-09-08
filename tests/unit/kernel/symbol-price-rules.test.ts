import { resolve } from "node:path";
import { hashCanonical } from "@moneykernel/contracts";
import { FixtureMarketAdapter, loadScenario } from "@moneykernel/integrations";
import { describe, expect, it } from "vitest";
import { rulesFromSnapshot } from "../../../apps/kernel/src/services/evaluation.ts";

describe("symbol price bounds through fixtures and persisted snapshots", () => {
  it("preserves canonical price bounds in rule hashes and the evaluation view", async () => {
    const scenario = loadScenario("scenario-a-constrained-acquisition", resolve("fixtures/scenarios"));
    const fixture = scenario.symbol_rules?.SOLUSDT;
    if (fixture === undefined) throw new Error("fixture rules missing");
    fixture.min_price = "99.0100";
    fixture.max_price = "101.0200";
    const now = new Date("2026-09-08T12:00:00Z");
    const adapter = new FixtureMarketAdapter(
      scenario,
      () => now,
      (prefix) => `${prefix}_test`,
    );
    const rules = await adapter.getSymbolRules("SOLUSDT");
    expect(rules.min_price).toBe("99.01");
    expect(rules.max_price).toBe("101.02");
    expect(rules.payload_hash).toBe(hashCanonical({ ...rules, received_at: undefined, payload_hash: undefined }));
    const view = rulesFromSnapshot({
      id: "rules_test",
      account_id: "account_test",
      type: "SYMBOL_RULES",
      source: rules.source,
      source_time: null,
      received_at: now,
      payload: rules,
      payload_hash: rules.payload_hash,
      parser_version: "rules-1",
    });
    expect(view).toMatchObject({ min_price: "99.01", max_price: "101.02", payload_hash: rules.payload_hash });
  });
});
