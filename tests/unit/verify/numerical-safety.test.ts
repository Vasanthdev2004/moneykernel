import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeEventHash, type RunExport } from "@moneykernel/contracts";
import { describe, expect, it } from "vitest";
import { verifyRunExport } from "../../../scripts/verify-receipt.ts";
import { buildBundle } from "./bundle-fixture.ts";

type Row = Record<string, unknown>;
function first(rows: Row[]): Row {
  const row = rows[0];
  if (row === undefined) throw new Error("missing fixture row");
  return row;
}
function row(rows: Row[], key: string, value: string): Row {
  const found = rows.find((r) => r[key] === value);
  if (found === undefined) throw new Error(`missing fixture ${key}`);
  return found;
}
function payload(bundle: RunExport): Row {
  return first(bundle.commands).exact_payload as Row;
}
function numerical(bundle: RunExport) {
  const result = verifyRunExport(bundle).checks.find((check) => check.name === "numerical_agreement");
  if (result === undefined) throw new Error("missing numerical check");
  return result;
}
function setOwned(bundle: RunExport, asset: string, value: string): void {
  row(bundle.balances, "asset", asset).owned_quantity = value;
  row(bundle.allocations, "asset", asset).owned_quantity = value;
}

describe("offline numerical and authority safety (prd.md 11.3, 11.6, 14.3, 23.4)", () => {
  it.each([
    ["side", "SELL"],
    ["symbol", "BTCUSDT"],
    ["order_type", "MARKET"],
    ["environment", "PAPER"],
    ["account_id", "another-account"],
    ["client_order_id", "another-command"],
    ["proposal_hash", "f".repeat(64)],
  ])("rejects an armed payload with a different %s", (key, value) => {
    const bundle = buildBundle();
    payload(bundle)[key] = value;
    expect(numerical(bundle).ok).toBe(false);
  });

  it.each([
    ["proposal_id", "another-proposal"],
    ["proposal_revision", 2],
    ["proposal_hash", "f".repeat(64)],
    ["account_epoch", 2],
    ["status", "INVALIDATED"],
    ["consumed_at", null],
    ["expires_at", "2026-09-08T12:00:06Z"],
  ])("rejects approval authority changed at %s", (key, value) => {
    const bundle = buildBundle();
    first(bundle.approvals)[key] = value;
    expect(numerical(bundle).ok).toBe(false);
  });

  it("checks the exact payload even when the completed-settlement marker is removed", () => {
    const bundle = buildBundle();
    first(bundle.commands).reconciled_at = null;
    payload(bundle).quantity = "10";
    expect(numerical(bundle).detail).toContain("exact_payload.quantity");
  });

  it("rejects a BUY quote credit even if ledger totals and allocations were changed to agree", () => {
    const bundle = buildBundle();
    row(bundle.ledger_entries, "category", "FILL_QUOTE").signed_delta = "27";
    setOwned(bundle, "USDT", "1026.973");
    const report = verifyRunExport(bundle);
    expect(report.checks.find((c) => c.name === "ledger_conservation")?.ok).toBe(false);
    expect(numerical(bundle).detail).toContain("FILL_QUOTE signed_delta");
    expect(report.ok).toBe(false);
  });

  it("requires the .027 fee debit even if the final balances omit it too", () => {
    const bundle = buildBundle();
    bundle.ledger_entries = bundle.ledger_entries.filter((entry) => entry.category !== "FILL_FEE");
    setOwned(bundle, "USDT", "973");
    expect(numerical(bundle).detail).toContain("0 FILL_FEE");
    expect(verifyRunExport(bundle).ok).toBe(false);
  });

  it.each([
    ["price", "200"],
    ["symbol", "BTCUSDT"],
    ["base_qty", "-0.27"],
    ["commission_qty", "-0.027"],
  ])("rejects inconsistent fill %s", (key, value) => {
    const bundle = buildBundle();
    first(bundle.fills)[key] = value;
    expect(numerical(bundle).ok).toBe(false);
  });

  it("rejects order identity and execution beyond the approved amount", () => {
    for (const [key, value] of [
      ["symbol", "BTCUSDT"],
      ["client_order_id", "another-order"],
      ["executed_base", "1"],
    ]) {
      const bundle = buildBundle();
      first(bundle.orders)[key as string] = value;
      expect(numerical(bundle).ok).toBe(false);
    }
  });

  it.each([
    ["asset", "BTC"],
    ["agent_id", "another-agent"],
    ["source_ref", "another-trade"],
  ])("rejects a ledger entry with a different %s", (key, value) => {
    const bundle = buildBundle();
    row(bundle.ledger_entries, "category", "FILL_QUOTE")[key] = value;
    expect(numerical(bundle).ok).toBe(false);
  });

  it.each([
    ["asset", "BTC"],
    ["agent_id", "another-agent"],
    ["amount", "-27.027"],
  ])("rejects a financial hold with a different %s", (key, value) => {
    const bundle = buildBundle();
    row(bundle.reservations, "kind", "QUOTE")[key] = value;
    expect(numerical(bundle).ok).toBe(false);
  });

  it("retains one consumed attempt and the actual BUY lease cost", () => {
    const missingAttempt = buildBundle();
    missingAttempt.reservations = missingAttempt.reservations.filter((r) => r.kind !== "ATTEMPT");
    expect(numerical(missingAttempt).detail).toContain("exactly one attempt hold");
    for (const field of ["consumed_quote", "attempts_consumed"]) {
      const bundle = buildBundle();
      first(bundle.leases)[field] = field === "consumed_quote" ? "0" : 0;
      expect(numerical(bundle).ok).toBe(false);
    }
  });

  it("requires the owning lease to permit the command at arm time", () => {
    const expired = buildBundle();
    first(expired.leases).expires_at = "2026-09-08T12:00:06Z";
    expect(numerical(expired).detail).toContain("lease authority");
    const wrongSide = buildBundle();
    (first(wrongSide.leases).capability_json as Row).allowed_sides = ["SELL"];
    expect(numerical(wrongSide).detail).toContain("lease capability");
  });

  it("does not allow negative balances or offsetting negative allocations", () => {
    const bundle = buildBundle();
    row(bundle.ledger_entries, "category", "FILL_BASE").signed_delta = "-0.27";
    setOwned(bundle, "SOL", "-0.27");
    const report = verifyRunExport(bundle);
    expect(report.checks.find((c) => c.name === "ledger_conservation")?.ok).toBe(false);
  });

  it("checks outstanding holds against current account inventory", () => {
    const bundle = unfilled("ARMED");
    first(bundle.ledger_entries).signed_delta = "20";
    setOwned(bundle, "USDT", "20");
    expect(verifyRunExport(bundle).checks.find((c) => c.name === "ledger_conservation")?.detail).toContain(
      "outstanding holds exceed account inventory",
    );
  });

  it.each([
    ["SOL", "UNASSIGNED"],
    ["USDT", "agent_alpha"],
  ])("rejects moving %s to %s without attribution evidence", (asset, owner) => {
    const bundle = buildBundle();
    row(bundle.allocations, "asset", asset).agent_or_unassigned_id = owner;
    const report = verifyRunExport(bundle);
    expect(report.checks.find((c) => c.name === "event_chain")?.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "ledger_conservation")?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("binds the initial baseline journal to the recorded initial balances", () => {
    const bundle = buildBundle();
    row(bundle.ledger_entries, "category", "BASELINE").signed_delta = "2000";
    setOwned(bundle, "USDT", "1972.973");
    const report = verifyRunExport(bundle);
    expect(report.checks.find((c) => c.name === "ledger_conservation")?.detail).toContain("baseline ledger differs");
  });

  it("accepts an explicit later operator reassignment as absolute owner quantities", () => {
    const bundle = buildBundle();
    const tail = bundle.audit_events.at(-1);
    if (tail === undefined) throw new Error("missing fixture tail");
    const payload = {
      operator_id: "op_demo",
      assignments: [
        { owner: "agent_alpha", asset: "SOL", quantity: "0" },
        { owner: "UNASSIGNED", asset: "SOL", quantity: "0.27" },
      ],
    };
    const event = {
      id: "evt_reassignment",
      account_id: bundle.account.id,
      account_seq: tail.account_seq + 1,
      type: "INVENTORY_ASSIGNED" as const,
      payload,
      previous_hash: tail.event_hash,
      occurred_at: "2026-09-08T12:00:30Z",
    };
    const hashes = computeEventHash(event);
    bundle.audit_events.push({ ...event, ...hashes });
    bundle.checkpoint.event_count += 1;
    bundle.checkpoint.final_hash = hashes.event_hash;
    bundle.checkpoint.final_seq = event.account_seq;
    row(bundle.allocations, "asset", "SOL").owned_quantity = "0";
    bundle.allocations.push({ agent_or_unassigned_id: "UNASSIGNED", asset: "SOL", owned_quantity: "0.27", version: 1 });
    const report = verifyRunExport(bundle);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

/** Changes only the numerical lifecycle fixture; audit-linkage proof is tested separately. */
function unfilled(state: "READY" | "ARMED" | "OUTCOME_UNKNOWN" | "REJECTED_CONFIRMED" | "ABORTED_PRE_ARM"): RunExport {
  const bundle = buildBundle();
  const command = first(bundle.commands);
  const approval = first(bundle.approvals);
  const lease = first(bundle.leases);
  const armed = state !== "READY" && state !== "ABORTED_PRE_ARM";
  command.state = state;
  command.reconciled_at = null;
  if (!armed) command.armed_at = null;
  approval.status = armed ? "CONSUMED" : state === "READY" ? "ACTIVE" : "INVALIDATED";
  if (!armed) approval.consumed_at = null;
  lease.consumed_quote = "0";
  lease.attempts_consumed = armed ? 1 : 0;
  row(bundle.reservations, "kind", "ATTEMPT").state = armed ? "CONSUMED" : state === "READY" ? "HELD" : "RELEASED";
  row(bundle.reservations, "kind", "QUOTE").state =
    state === "ABORTED_PRE_ARM" || state === "REJECTED_CONFIRMED" ? "RELEASED" : armed ? "ARMED" : "HELD";
  bundle.orders = [];
  bundle.fills = [];
  bundle.ledger_entries = bundle.ledger_entries.filter((entry) => entry.category === "BASELINE");
  setOwned(bundle, "SOL", "0");
  setOwned(bundle, "USDT", "1000");
  return bundle;
}

describe("incomplete execution evidence remains distinct from invalid financial evidence", () => {
  it.each(["READY", "ARMED", "OUTCOME_UNKNOWN", "REJECTED_CONFIRMED", "ABORTED_PRE_ARM"] as const)(
    "accepts an internally consistent %s command without requiring a fill",
    (state) => {
      const result = numerical(unfilled(state));
      expect(result, result.detail).toMatchObject({ ok: true });
      expect(result.detail).toContain("0 reconciled commands");
    },
  );

  it("accepts a partially filled order with the unfilled reservation still armed", () => {
    const bundle = buildBundle();
    first(bundle.commands).reconciled_at = null;
    Object.assign(first(bundle.orders), { status: "PARTIALLY_FILLED", executed_base: "0.12", executed_quote: "12" });
    Object.assign(first(bundle.fills), { base_qty: "0.12", quote_qty: "12", commission_qty: "0.012" });
    row(bundle.ledger_entries, "category", "FILL_BASE").signed_delta = "0.12";
    row(bundle.ledger_entries, "category", "FILL_QUOTE").signed_delta = "-12";
    row(bundle.ledger_entries, "category", "FILL_FEE").signed_delta = "-0.012";
    const hold = row(bundle.reservations, "kind", "QUOTE");
    hold.amount = "12.012";
    bundle.reservations.push({ ...hold, id: "rsv_remaining", amount: "15.015", state: "ARMED" });
    first(bundle.leases).consumed_quote = "12.012";
    setOwned(bundle, "SOL", "0.12");
    setOwned(bundle, "USDT", "987.988");
    expect(numerical(bundle), numerical(bundle).detail).toMatchObject({ ok: true });
  });

  it("does not claim complete settlement when order totals await their fills", () => {
    const bundle = unfilled("ARMED");
    first(bundle.commands).state = "ACCEPTED";
    bundle.orders = buildBundle().orders;
    const result = numerical(bundle);
    expect(result, result.detail).toMatchObject({ ok: true });
    expect(result.detail).toContain("0 reconciled commands");
  });

  it("keeps every committed replay export numerically verifiable without rewriting it", () => {
    const directory = fileURLToPath(new URL("../../../docs/evidence/replays/", import.meta.url));
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".export.json"))) {
      const bundle = JSON.parse(readFileSync(`${directory}/${name}`, "utf8")) as RunExport;
      const result = numerical(bundle);
      expect(result, `${name}: ${result.detail}`).toMatchObject({ ok: true });
      const ledger = verifyRunExport(bundle).checks.find((c) => c.name === "ledger_conservation");
      expect(ledger, `${name}: ${ledger?.detail}`).toMatchObject({ ok: true });
    }
  });
});
