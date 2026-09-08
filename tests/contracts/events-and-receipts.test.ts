import {
  type AuditEvent,
  computeEventHash,
  type DecisionReceipt,
  DecisionReceiptSchema,
  decisionFingerprint,
  REASON_CODES,
  REASON_TEMPLATES,
  renderReason,
  verifyEventChain,
  verifyReceiptFingerprint,
} from "@moneykernel/contracts";
import { describe, expect, it } from "vitest";

function buildChain(count: number, checkpoint: string | null = null): AuditEvent[] {
  const events: AuditEvent[] = [];
  let previous = checkpoint;
  for (let seq = 1; seq <= count; seq++) {
    const payload = { seq, note: `event ${seq}` };
    const occurred_at = `2026-09-08T12:00:0${seq % 10}Z`;
    const hashes = computeEventHash({
      previous_hash: previous,
      account_seq: seq,
      type: "INTENT_RECEIVED",
      payload,
      occurred_at,
    });
    events.push({
      id: `evt_${seq}`,
      account_id: "acct_test",
      account_seq: seq,
      type: "INTENT_RECEIVED",
      payload,
      payload_hash: hashes.payload_hash,
      previous_hash: previous,
      event_hash: hashes.event_hash,
      occurred_at,
    });
    previous = hashes.event_hash;
  }
  return events;
}

describe("event hash chain (prd.md 14.5, T-54)", () => {
  it("verifies an intact chain from genesis and from a checkpoint", () => {
    const chain = buildChain(5);
    expect(verifyEventChain(chain, null)).toEqual({ ok: true, length: 5 });
    const tail = chain.slice(2);
    expect(verifyEventChain(tail, chain[1]?.event_hash ?? null).ok).toBe(true);
  });

  it("detects an edited payload", () => {
    const chain = buildChain(4);
    const tampered = chain.map((e) => (e.account_seq === 3 ? { ...e, payload: { ...e.payload, note: "edited" } } : e));
    const result = verifyEventChain(tampered, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.first_bad_seq).toBe(3);
      expect(result.reason).toBe("payload_hash mismatch");
    }
  });

  it("detects a removed event as a sequence gap", () => {
    const chain = buildChain(4);
    const result = verifyEventChain([chain[0], chain[1], chain[3]] as AuditEvent[], null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.first_bad_seq).toBe(4);
  });

  it("detects a relinked previous_hash", () => {
    const chain = buildChain(3);
    const forged = chain.map((e) => (e.account_seq === 2 ? { ...e, previous_hash: "0".repeat(64) } : e));
    const result = verifyEventChain(forged, null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("previous_hash mismatch");
  });
});

describe("decision fingerprint (prd.md 15.6, T-55)", () => {
  const material = {
    engine_version: "0.1.0",
    normalized_request: { symbol: "SOLUSDT", side: "BUY", amount: "80", limit_price: "100" },
    input_refs: {
      policy_version: 1,
      lease_revision: 1,
      account_epoch: 1,
      ledger_version: 1,
      snapshot_ids: ["snapshot_fixture_sol_01"],
      snapshot_hashes: ["a".repeat(64)],
    },
    outcome: "COUNTERPROPOSE" as const,
    reason_codes: ["SYMBOL_EXPOSURE_LIMIT" as const],
    checks: [{ rule: "LEASE_BUDGET", result: "PASS" as const, observed: "27.027", limit: "40", unit: "USDT" }],
    evaluated_at: "2026-09-08T12:00:00Z",
  };

  it("is identical for identical canonical material and ignores display ids", () => {
    const fp = decisionFingerprint(material);
    const receipt: DecisionReceipt = DecisionReceiptSchema.parse({
      schema_version: "1",
      decision_id: "receipt_01",
      intent_id: "intent_01",
      proposal_id: "proposal_01",
      ...material,
      decision_fingerprint: fp,
    });
    expect(verifyReceiptFingerprint(receipt)).toBe(true);
    expect(verifyReceiptFingerprint({ ...receipt, decision_id: "receipt_99", intent_id: "intent_99" })).toBe(true);
  });

  it("changes when any material input changes", () => {
    const fp = decisionFingerprint(material);
    expect(decisionFingerprint({ ...material, evaluated_at: "2026-09-08T12:00:01Z" })).not.toBe(fp);
    expect(decisionFingerprint({ ...material, outcome: "DENY" })).not.toBe(fp);
    expect(
      decisionFingerprint({
        ...material,
        input_refs: { ...material.input_refs, snapshot_hashes: ["b".repeat(64)] },
      }),
    ).not.toBe(fp);
  });
});

describe("reason codes (prd.md 15.7)", () => {
  it("every code has a deterministic template", () => {
    for (const code of REASON_CODES) {
      expect(typeof REASON_TEMPLATES[code]).toBe("string");
      expect(REASON_TEMPLATES[code].length).toBeGreaterThan(10);
    }
  });

  it("renders placeholders verbatim and marks missing ones visibly", () => {
    expect(renderReason("LEASE_BUDGET", { observed: "27.027", limit: "40", unit: "USDT" })).toBe(
      "Requested commitment 27.027 USDT exceeds remaining lease acquisition budget 40 USDT.",
    );
    expect(renderReason("SYMBOL_NOT_ALLOWED")).toBe("Symbol ? is not in the lease allowlist.");
  });
});
