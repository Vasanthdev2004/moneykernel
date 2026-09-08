import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decisionFingerprint, hashCanonical, type RunExport } from "@moneykernel/contracts";
import type { EvaluationInput } from "@moneykernel/domain";
import { describe, expect, it } from "vitest";
import { formatReport, verifyRunExport } from "../../../scripts/verify-receipt.ts";
import { buildBundle, chainEvents } from "./bundle-fixture.ts";

const failed = (bundle: RunExport, name: string) => {
  const report = verifyRunExport(bundle);
  expect(report.ok).toBe(false);
  expect(report.checks.find((check) => check.name === name)?.ok).toBe(false);
};
const context = (bundle: RunExport) => bundle.receipts[0]?.evaluation_input as EvaluationInput;

describe("offline verifier trust boundaries", () => {
  it("rejects a policy-row/context rewrite against the original retained audit head", () => {
    const bundle = buildBundle();
    const policy = bundle.policy_versions[0];
    if (!policy) throw new Error("fixture policy missing");
    const stored = policy.policy as Record<string, unknown>;
    stored.max_hard_violations_per_60s = 9;
    context(bundle).policy.max_hard_violations_per_60s = 9;
    policy.hash = hashCanonical(stored);
    const report = verifyRunExport(bundle, { headCheckpointHash: bundle.audit_events.at(-1)?.event_hash });
    expect(report.checks.find((check) => check.name === "decision_replay")?.ok).toBe(true);
    expect(report.checks.find((check) => check.name === "event_chain")?.ok).toBe(true);
    expect(report.checks.find((check) => check.name === "receipt_linkage")?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });
  it.each(["policy", "snapshots", "time"])(
    "rejects altered archived %s even with unchanged receipt material",
    (change) => {
      const bundle = buildBundle();
      const input = context(bundle);
      if (change === "policy") input.policy.version = 999;
      else if (change === "time") input.now = "2026-09-08T12:00:01Z";
      else {
        for (const observation of input.observations) observation.payload_hash = "9".repeat(64);
        for (const mark of input.marks) mark.payload_hash = "8".repeat(64);
        if (input.symbol_rules) input.symbol_rules.payload_hash = "7".repeat(64);
      }
      expect(verifyRunExport(bundle).checks.find((check) => check.name === "receipt_fingerprints")?.ok).toBe(true);
      failed(bundle, "decision_replay");
    },
  );

  it("rejects unsupported export and receipt engine versions", () => {
    const bundle = buildBundle();
    bundle.engine_version = "999.0.0";
    failed(bundle, "decision_replay");
    bundle.engine_version = buildBundle().engine_version;
    const receipt = bundle.receipts[0];
    if (!receipt) throw new Error("fixture receipt missing");
    receipt.engine_version = "999.0.0";
    failed(bundle, "decision_replay");
  });

  it("binds receipts to their immutable audit fingerprint even when a new fingerprint is internally valid", () => {
    const bundle = buildBundle();
    const receipt = bundle.receipts[0];
    if (!receipt) throw new Error("fixture receipt missing");
    receipt.outcome = "ALLOW_PROPOSAL";
    receipt.decision_fingerprint = decisionFingerprint({
      engine_version: receipt.engine_version,
      normalized_request: receipt.normalized_request,
      input_refs: receipt.input_refs,
      outcome: receipt.outcome,
      reason_codes: receipt.reason_codes,
      checks: receipt.checks,
      evaluated_at: receipt.evaluated_at,
    });
    expect(verifyRunExport(bundle).checks.find((check) => check.name === "receipt_fingerprints")?.ok).toBe(true);
    failed(bundle, "receipt_linkage");
  });

  it("binds the recorded adapter payload and versioned policy to the exported rows", () => {
    const payload = buildBundle();
    const command = payload.commands[0];
    if (!command) throw new Error("fixture command missing");
    command.exact_payload = { ...(command.exact_payload as Record<string, unknown>), limit_price: "101" };
    failed(payload, "receipt_linkage");
    const policy = buildBundle();
    if (policy.policy_versions[0]) policy.policy_versions[0].hash = "0".repeat(64);
    failed(policy, "receipt_linkage");
  });

  it("rejects deleted evidence, duplicate identities and cross-account event rebinding", () => {
    const noEvents = buildBundle();
    noEvents.audit_events = [];
    noEvents.checkpoint = { previous_hash: null, event_count: 0 };
    failed(noEvents, "event_chain");
    expect(verifyRunExport(noEvents, { checkpointHash: "a".repeat(64) }).ok).toBe(false);
    const noReceipts = buildBundle();
    noReceipts.receipts = [];
    failed(noReceipts, "receipt_linkage");
    const duplicate = buildBundle();
    duplicate.commands.push({ ...duplicate.commands[0] });
    failed(duplicate, "receipt_linkage");
    const foreign = buildBundle();
    for (const event of foreign.audit_events) event.account_id = "acct_foreign";
    failed(foreign, "event_chain");
    const foreignRows = buildBundle();
    foreignRows.agents[0] = { ...foreignRows.agents[0], account_id: "acct_foreign" };
    failed(foreignRows, "receipt_linkage");
  });

  it("verifies a retained final checkpoint and rejects truncation even if declared bounds are rewritten", () => {
    const bundle = buildBundle();
    const head = bundle.audit_events.at(-1)?.event_hash;
    if (!head) throw new Error("fixture head missing");
    expect(verifyRunExport(bundle, { headCheckpointHash: head }).ok).toBe(true);
    expect(formatReport(verifyRunExport(bundle))).toContain("unanchored internal consistency only");
    bundle.audit_events.pop();
    bundle.checkpoint.event_count = bundle.audit_events.length;
    bundle.checkpoint.final_hash = bundle.audit_events.at(-1)?.event_hash ?? null;
    bundle.checkpoint.final_seq = bundle.audit_events.at(-1)?.account_seq ?? 0;
    expect(
      verifyRunExport(bundle, { headCheckpointHash: head }).checks.find((check) => check.name === "event_chain")?.ok,
    ).toBe(false);
    const rewritten = buildBundle();
    if (rewritten.audit_events[0]) rewritten.audit_events[0].payload.note = "rewritten";
    rewritten.audit_events = chainEvents(rewritten.audit_events);
    rewritten.checkpoint.final_hash = rewritten.audit_events.at(-1)?.event_hash ?? null;
    expect(
      verifyRunExport(rewritten, { headCheckpointHash: head }).checks.find((check) => check.name === "event_chain")?.ok,
    ).toBe(false);
  });

  it("does not echo a credential-shaped unknown key or credential row identity in diagnostics", () => {
    const token = `mka_${"Q".repeat(40)}`;
    const unknown = { ...buildBundle(), [token]: true };
    const invalidId = buildBundle();
    if (invalidId.agents[0]) invalidId.agents[0].id = token;
    const credential = buildBundle();
    if (credential.agents[0]) credential.agents[0].password = "DUMMY_REVIEW_PASSWORD";
    for (const bundle of [unknown, invalidId, credential]) {
      const report = verifyRunExport(bundle);
      expect(report.ok).toBe(false);
      expect(JSON.stringify(report)).not.toContain(token);
      expect(formatReport(report)).not.toContain("DUMMY_REVIEW_PASSWORD");
    }
  });

  it("returns a structured invalid-input CLI report for noncanonical JSON payloads", () => {
    const directory = mkdtempSync(join(tmpdir(), "moneykernel-trust-"));
    try {
      const bundle = buildBundle();
      if (bundle.audit_events[0]) bundle.audit_events[0].payload.value = 0.5;
      const file = join(directory, "invalid.json");
      writeFileSync(file, JSON.stringify(bundle));
      const script = fileURLToPath(new URL("../../../scripts/verify-receipt.ts", import.meta.url));
      const result = spawnSync(process.execPath, [script, file, "--json"], { encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).ok).toBe(false);
      expect(result.stderr).not.toContain("CanonicalJsonError");
      const headFile = join(directory, "valid.json");
      const valid = buildBundle();
      writeFileSync(headFile, JSON.stringify(valid));
      const retained = valid.audit_events.at(-1)?.event_hash ?? "";
      const passed = spawnSync(process.execPath, [script, headFile, "--head-checkpoint", retained, "--json"], {
        encoding: "utf8",
      });
      expect(passed.status).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
