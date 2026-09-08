import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type EvaluationInput, evaluate } from "@moneykernel/domain";
import { afterAll, describe, expect, it } from "vitest";
import {
  CHECK_NAMES,
  formatReport,
  type VerificationCheck,
  type VerificationReport,
  verifyRunExport,
} from "../../../scripts/verify-receipt.ts";
import { buildBundle, COMMAND_ID, FILL_ID, fingerprintOnlyReceipt, RECEIPT_ID } from "./bundle-fixture.ts";

const SCRIPT = fileURLToPath(new URL("../../../scripts/verify-receipt.ts", import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "moneykernel-verify-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function check(report: VerificationReport, name: (typeof CHECK_NAMES)[number]): VerificationCheck {
  const found = report.checks.find((c) => c.name === name);
  if (found === undefined) throw new Error(`report has no ${name} check`);
  return found;
}

function at<T>(items: ReadonlyArray<T>, index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture has no item at index ${index}`);
  return item;
}

function writeJson(name: string, value: unknown): string {
  const path = join(workDir, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), "utf8");
  return path;
}

const runCli = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

describe("verifyRunExport: a consistent export (prd.md 23.4)", () => {
  it("(a) passes every check, in the documented order, with a truthful summary", () => {
    const report = verifyRunExport(buildBundle());
    expect(report.checks.map((c) => c.name)).toEqual([...CHECK_NAMES]);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.summary).toEqual({
      events: 10,
      receipts: 1,
      replayed: 1,
      fingerprint_only: 0,
      commands: 1,
      fills: 1,
    });
    const text = formatReport(report);
    expect(text).toContain("ok    event_chain");
    expect(text).toContain("verify:receipt: passed");
    expect(text).not.toContain("FAIL");
  });

  it("stops at the schema check for input that is not an export bundle", () => {
    for (const input of [undefined, "garbage", 42, { schema_version: "1" }]) {
      const report = verifyRunExport(input);
      expect(report.ok).toBe(false);
      expect(report.checks.map((c) => c.name)).toEqual(["schema"]);
      expect(check(report, "schema").detail).toContain("remaining checks skipped");
      expect(report.summary.receipts).toBe(0);
    }
    const report = verifyRunExport({ ...buildBundle(), environment: "MAINNET" });
    expect(check(report, "schema").detail).toContain("$.environment");
  });
});

describe("audit integrity (prd.md 14.5)", () => {
  it("(b) T-54: editing one exported event payload fails the chain at that sequence", () => {
    const bundle = buildBundle();
    const event = at(bundle.audit_events, 4);
    event.payload = { ...event.payload, outcome: "ALLOW_PROPOSAL" };
    const report = verifyRunExport(bundle);
    const chain = check(report, "event_chain");
    expect(chain.ok).toBe(false);
    expect(chain.detail).toContain(`first_bad_seq=${event.account_seq}`);
    expect(chain.detail).toContain("payload_hash mismatch");
    expect(report.ok).toBe(false);
    // Receipts are independent evidence: the edit to the event log leaves them intact.
    expect(check(report, "receipt_fingerprints").ok).toBe(true);
    expect(check(report, "decision_replay").ok).toBe(true);
  });

  it("verifies against a retained checkpoint supplied out of band and against the checkpoint count", () => {
    const bundle = buildBundle();
    const genesis = verifyRunExport(bundle, { checkpointHash: null });
    expect(check(genesis, "event_chain").ok).toBe(true);
    const wrong = verifyRunExport(bundle, { checkpointHash: "0".repeat(64) });
    expect(check(wrong, "event_chain").ok).toBe(false);
    expect(check(wrong, "event_chain").detail).toContain("first_bad_seq=1");
    expect(check(wrong, "event_chain").detail).toContain("previous_hash mismatch");
    bundle.checkpoint.event_count = 9;
    const miscounted = verifyRunExport(bundle);
    expect(check(miscounted, "event_chain").ok).toBe(false);
    expect(check(miscounted, "event_chain").detail).toContain("checkpoint.event_count=9");
  });

  it("(c) editing a receipt's outcome fails both the fingerprint and the replay", () => {
    const bundle = buildBundle();
    at(bundle.receipts, 0).outcome = "ALLOW_PROPOSAL";
    const report = verifyRunExport(bundle);
    const fingerprints = check(report, "receipt_fingerprints");
    expect(fingerprints.ok).toBe(false);
    expect(fingerprints.detail).toContain(RECEIPT_ID);
    const replay = check(report, "decision_replay");
    expect(replay.ok).toBe(false);
    expect(replay.detail).toContain(RECEIPT_ID);
    expect(replay.detail).toContain("outcome COUNTERPROPOSE != recorded ALLOW_PROPOSAL");
    expect(check(report, "event_chain").ok).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("(d) T-55: an edited archived context replays to a different candidate while the fingerprint still holds", () => {
    const bundle = buildBundle();
    const receipt = at(bundle.receipts, 0);
    const context = receipt.evaluation_input as EvaluationInput;
    context.resources.quote_owned = "60";
    const replayed = evaluate(context);
    expect(replayed.candidate?.quantity).not.toBe("0.27");
    const report = verifyRunExport(bundle);
    expect(check(report, "receipt_fingerprints").ok).toBe(true);
    const replay = check(report, "decision_replay");
    expect(replay.ok).toBe(false);
    expect(replay.detail).toContain(RECEIPT_ID);
    expect(report.summary.replayed).toBe(1);
  });

  it("(e) counts a receipt without archived context as fingerprint-only rather than failing it", () => {
    const bundle = buildBundle();
    const extra = fingerprintOnlyReceipt();
    bundle.intents.push(extra.intent);
    bundle.receipts.push(extra.receipt);
    const report = verifyRunExport(bundle);
    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({ receipts: 2, replayed: 1, fingerprint_only: 1 });
    const replay = check(report, "decision_replay");
    expect(replay.ok).toBe(true);
    expect(replay.detail).toContain("1 fingerprint-only: context not archived (receipt predates migration 0005)");
    expect(check(report, "receipt_fingerprints").count).toBe(2);
  });

  it("reports dangling references between receipts, proposals, commands, orders, fills, and ledger", () => {
    const bundle = buildBundle();
    at(bundle.fills, 0).order_id = "order_missing";
    at(bundle.ledger_entries, 1).source_fill_id = "fill_missing";
    const report = verifyRunExport(bundle);
    const linkage = check(report, "receipt_linkage");
    expect(linkage.ok).toBe(false);
    expect(linkage.detail).toContain(`fill ${FILL_ID} -> order order_missing`);
    expect(linkage.detail).toContain("ledger_entry ledger_02 -> fill fill_missing");
  });
});

describe("numerical agreement and conservation (prd.md 23.4, 14.3)", () => {
  it("(f) a changed fill quantity breaks the agreement between order, fills, holds, and ledger", () => {
    const bundle = buildBundle();
    at(bundle.fills, 0).quote_qty = "26";
    const report = verifyRunExport(bundle);
    const agreement = check(report, "numerical_agreement");
    expect(agreement.ok).toBe(false);
    expect(agreement.detail).toContain(`command ${COMMAND_ID}`);
    expect(agreement.detail).toContain("executed_quote");
    expect(check(report, "ledger_conservation").ok).toBe(true);
  });

  it("flags a command whose armed payload, holds, or order status no longer match the candidate", () => {
    const payloadEdited = buildBundle();
    const command = at(payloadEdited.commands, 0);
    command.exact_payload = { ...(command.exact_payload as Record<string, unknown>), quantity: "0.271" };
    expect(check(verifyRunExport(payloadEdited), "numerical_agreement").detail).toContain("exact_payload.quantity");

    const holdOpen = buildBundle();
    at(holdOpen.reservations, 0).state = "ARMED";
    expect(check(verifyRunExport(holdOpen), "numerical_agreement").detail).toContain("still HELD or ARMED");

    const holdShort = buildBundle();
    at(holdShort.reservations, 0).amount = "27";
    expect(check(verifyRunExport(holdShort), "numerical_agreement").detail).toContain(
      "CONSUMED QUOTE holds 27 != executed 27.027",
    );

    const notTerminal = buildBundle();
    at(notTerminal.orders, 0).status = "PARTIALLY_FILLED";
    expect(check(verifyRunExport(notTerminal), "numerical_agreement").detail).toContain("not terminal");

    const doubleJournaled = buildBundle();
    doubleJournaled.ledger_entries.push({ ...at(doubleJournaled.ledger_entries, 1), id: "ledger_05", sequence: 5 });
    const twice = verifyRunExport(doubleJournaled);
    expect(check(twice, "numerical_agreement").detail).toContain(`fill ${FILL_ID}: 2 FILL_BASE`);
    expect(check(twice, "ledger_conservation").ok).toBe(false);
  });

  it("(g) removing a ledger entry breaks conservation for that asset", () => {
    const bundle = buildBundle();
    bundle.ledger_entries = bundle.ledger_entries.filter((entry) => entry.category !== "FILL_FEE");
    const report = verifyRunExport(bundle);
    const conservation = check(report, "ledger_conservation");
    expect(conservation.ok).toBe(false);
    expect(conservation.detail).toContain("USDT: ledger sum 973 != balance 972.973");
    // A missing fee entry is legal per fill (fees can be zero), so agreement itself still holds.
    expect(check(report, "numerical_agreement").ok).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("attribution must sum to the account balance", () => {
    const bundle = buildBundle();
    at(bundle.allocations, 1).owned_quantity = "0.2";
    const report = verifyRunExport(bundle);
    expect(check(report, "ledger_conservation").detail).toContain("SOL: allocations 0.2 != balance 0.27");
  });
});

describe("secret and sanitization checks (T-58)", () => {
  it("(h) rejects a token_hash on an agent row or a bearer token anywhere without echoing the value", () => {
    const hashed = buildBundle();
    const tokenHash = "f".repeat(64);
    at(hashed.agents, 0).token_hash = tokenHash;
    const hashedReport = verifyRunExport(hashed);
    const hashedScan = check(hashedReport, "secret_scan");
    expect(hashedScan.ok).toBe(false);
    expect(hashedScan.detail).toContain("token_hash");
    expect(JSON.stringify(hashedReport)).not.toContain(tokenHash);
    expect(formatReport(hashedReport)).not.toContain(tokenHash);

    const leaked = buildBundle();
    const token = `mka_${"Q".repeat(40)}`;
    at(leaked.leases, 0).note = token;
    const leakedReport = verifyRunExport(leaked);
    const leakedScan = check(leakedReport, "secret_scan");
    expect(leakedScan.ok).toBe(false);
    expect(leakedScan.detail).toContain("bearer token");
    expect(leakedScan.detail).toContain("values withheld");
    expect(JSON.stringify(leakedReport)).not.toContain(token);
    expect(formatReport(leakedReport)).not.toContain(token);
    expect(leakedReport.ok).toBe(false);
  });

  it("rejects provider-key shapes and credential keys inside an archived context", () => {
    const keyed = buildBundle();
    at(keyed.agents, 0).note = `sk-ant-${"x".repeat(40)}`;
    expect(check(verifyRunExport(keyed), "secret_scan").detail).toContain("anthropic key");

    const contextLeak = buildBundle();
    const context = at(contextLeak.receipts, 0).evaluation_input as Record<string, unknown>;
    context.agent = { ...(context.agent as Record<string, unknown>), token: "not-a-real-token" };
    const report = verifyRunExport(contextLeak);
    const sanitization = check(report, "sanitization");
    expect(sanitization.ok).toBe(false);
    expect(sanitization.detail).toContain(RECEIPT_ID);
    expect(sanitization.detail).not.toContain("not-a-real-token");
  });

  it("requires the provenance, top-level, and account environments to agree", () => {
    const bundle = buildBundle();
    bundle.provenance.execution_mode = "TESTNET";
    const report = verifyRunExport(bundle);
    expect(check(report, "sanitization").ok).toBe(false);
    expect(check(report, "sanitization").detail).toContain("execution_mode TESTNET");
  });
});

describe("CLI: node scripts/verify-receipt.ts (prd.md 22.2)", () => {
  it("(i) exits 2 for an unparseable file and 0 with a passing report for the consistent export", {
    timeout: 60_000,
  }, () => {
    const broken = runCli(writeJson("not-json.json", "{ this is not an export"));
    expect(broken.status).toBe(2);
    expect(broken.stdout).not.toContain("verify:receipt:");
    expect(broken.stderr).toContain("not valid JSON");

    const missing = runCli(join(workDir, "does-not-exist.json"));
    expect(missing.status).toBe(2);

    const exportFile = writeJson("run-export.json", buildBundle());
    const passed = runCli(exportFile);
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain("verify:receipt: passed");
    expect(passed.stdout).toContain("ok    decision_replay");

    const asJson = runCli(exportFile, "--json");
    expect(asJson.status).toBe(0);
    const report = JSON.parse(asJson.stdout) as VerificationReport;
    expect(report.ok).toBe(true);
    expect(report.summary.events).toBe(10);
  });

  it("exits 1 when a check fails and 2 for a bundle outside the export contract or a bad checkpoint", {
    timeout: 60_000,
  }, () => {
    const tampered = buildBundle();
    at(tampered.fills, 0).quote_qty = "26";
    const failed = runCli(writeJson("tampered.json", tampered));
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("FAIL  numerical_agreement");
    expect(failed.stdout).toContain("verify:receipt: FAILED");

    const invalid = runCli(writeJson("not-a-bundle.json", { schema_version: "2" }));
    expect(invalid.status).toBe(2);
    expect(invalid.stdout).toContain("FAIL  schema");

    const badCheckpoint = runCli(writeJson("run-export-2.json", buildBundle()), "--checkpoint", "not-hex");
    expect(badCheckpoint.status).toBe(2);
  });
});
