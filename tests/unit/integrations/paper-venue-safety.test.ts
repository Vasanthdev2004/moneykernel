import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ArmedCommand, canonicalizeDecimal } from "@moneykernel/contracts";
import { FilePaperVenueStore, loadScenario, PaperExecutionAdapter } from "@moneykernel/integrations";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURES_DIR } from "../../../apps/kernel/src/fixtures.ts";

const files: string[] = [];
afterEach(() => {
  for (const path of files.splice(0)) {
    if (existsSync(path)) unlinkSync(path);
    if (existsSync(`${path}.tmp`)) unlinkSync(`${path}.tmp`);
  }
});

function journal() {
  const path = join(tmpdir(), `moneykernel-g4-venue-${randomBytes(10).toString("hex")}.json`);
  files.push(path);
  return new FilePaperVenueStore(path);
}

function command(id: string): ArmedCommand {
  return {
    command_id: `cmd_${id}`,
    environment: "REPLAY",
    account_id: "paper-journal-test",
    client_order_id: id,
    symbol: "SOLUSDT",
    side: "BUY",
    order_type: "LIMIT_IOC",
    quantity: canonicalizeDecimal("0.2"),
    limit_price: canonicalizeDecimal("100"),
    armed_at: "2026-09-08T12:00:00Z",
    payload_hash: "a".repeat(64),
  };
}

function executor(store: FilePaperVenueStore, dropResponseFor = new Set<string>()) {
  return new PaperExecutionAdapter(
    { kind: "FIXTURE", scenario: loadScenario("scenario-d-lost-response", FIXTURES_DIR) },
    () => new Date("2026-09-08T12:00:00Z"),
    { environment: "REPLAY", feeRate: "0.001", feeAsset: "USDT", store, faults: { dropResponseFor } },
  );
}

describe("paper venue file durability", () => {
  it("retains a lost-response order and consumed book liquidity across a fresh adapter", async () => {
    const store = journal();
    const before = executor(store, new Set(["lost-venue-response"]));
    await expect(before.submitOnce(command("lost-venue-response"))).rejects.toThrow(/response dropped/);
    const after = executor(new FilePaperVenueStore(store.path));
    const found = await after.queryOrder({
      client_order_id: "lost-venue-response",
      exchange_order_id: null,
      symbol: "SOLUSDT",
    });
    expect(found.kind).toBe("FOUND");
    if (found.kind !== "FOUND") throw new Error("lost accepted order");
    expect(found.order).toMatchObject({ status: "EXPIRED", executed_base: "0.12", executed_quote: "12" });
    expect(after.submitCount).toBe(1);
    const fills = await after.listRelevantFills({ since_event_time: null, since_fill_id: null });
    expect(fills.fills).toHaveLength(1);
    expect(fills.fills[0]).toMatchObject({ commission_asset: "USDT", commission_qty: "0.012" });
    const next = await after.submitOnce(command("next-venue-order"));
    expect(next.kind).toBe("ACCEPTED");
    if (next.kind !== "ACCEPTED") throw new Error("paper order was refused");
    expect(next.order).toMatchObject({ status: "EXPIRED", executed_base: "0", executed_quote: "0" });
    expect(executor(new FilePaperVenueStore(store.path)).submitCount).toBe(2);
  });

  it("refuses a corrupt journal instead of starting with empty venue memory", () => {
    const store = journal();
    writeFileSync(store.path, "{interrupted journal", "utf8");
    expect(() => executor(store)).toThrow();
  });
});
