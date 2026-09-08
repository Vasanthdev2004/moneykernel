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
    normalized_request: {
      account_id: "account_fixture_01",
      agent_id: "agent_alpha_01",
      lease_id: "lease_alpha_01",
      symbol: "SOLUSDT",
      side: "BUY",
      order_type: "LIMIT_IOC",
      size: { kind: "QUOTE_NOTIONAL", quote_asset: "USDT", amount: "80" },
      limit_price: "100",
      observation_ids: ["snapshot_fixture_sol_01"],
      strategy_run_id: null,
    },
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

  const receiptFor = (
    normalized_request: unknown = material.normalized_request,
    input_refs: unknown = material.input_refs,
  ) => ({
    schema_version: "1",
    decision_id: "receipt_01",
    intent_id: "intent_01",
    proposal_id: "proposal_01",
    ...material,
    normalized_request,
    input_refs,
    decision_fingerprint: decisionFingerprint(material),
  });

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

  it("canonicalizes equivalent financial encodings before parsing and hashing", () => {
    const equivalent = {
      ...material.normalized_request,
      size: { ...material.normalized_request.size, amount: "080.000" },
      limit_price: "0100.00",
    };
    expect(decisionFingerprint({ ...material, normalized_request: equivalent })).toBe(decisionFingerprint(material));
    const receipt = DecisionReceiptSchema.parse(receiptFor(equivalent));
    expect(receipt.normalized_request).toEqual(material.normalized_request);
    expect(verifyReceiptFingerprint(receiptFor(equivalent))).toBe(true);
  });

  it.each([
    { ...material.normalized_request, size: { ...material.normalized_request.size, amount: 80.01 } },
    { ...material.normalized_request, limit_price: 100.01 },
    { ...material.normalized_request, size: { ...material.normalized_request.size, amount: "8e1" } },
    { ...material.normalized_request, override_policy: true },
    { ...material.normalized_request, size: { ...material.normalized_request.size, override_policy: true } },
    { ...material.normalized_request, side: "SELL" },
    { ...material.normalized_request, size: { kind: "BASE_QUANTITY", base_asset: "SOL", amount: "1" } },
  ])("rejects malformed normalized request %# before hashing or verifying", (normalized_request) => {
    expect(DecisionReceiptSchema.safeParse(receiptFor(normalized_request)).success).toBe(false);
    expect(() => decisionFingerprint({ ...material, normalized_request })).toThrow();
    expect(verifyReceiptFingerprint(receiptFor(normalized_request))).toBe(false);
  });

  it("requires one content hash for each snapshot reference", () => {
    const { snapshot_hashes: _hashes, ...withoutHashes } = material.input_refs;
    const malformedRefs = [
      withoutHashes,
      { ...material.input_refs, snapshot_hashes: [] },
      { ...material.input_refs, snapshot_hashes: ["a".repeat(64), "b".repeat(64)] },
      { ...material.input_refs, snapshot_hashes: ["invalid"] },
    ];
    for (const input_refs of malformedRefs) {
      expect(DecisionReceiptSchema.safeParse(receiptFor(material.normalized_request, input_refs)).success).toBe(false);
      expect(() => decisionFingerprint({ ...material, input_refs })).toThrow();
      expect(verifyReceiptFingerprint(receiptFor(material.normalized_request, input_refs))).toBe(false);
    }
    expect(
      DecisionReceiptSchema.safeParse(
        receiptFor(material.normalized_request, {
          ...material.input_refs,
          snapshot_ids: [],
          snapshot_hashes: [],
        }),
      ).success,
    ).toBe(true);
  });

  it("returns false for malformed external receipts and validly shaped tampering", () => {
    for (const receipt of [null, undefined, [], {}, { ...receiptFor(), unexpected: true }]) {
      expect(verifyReceiptFingerprint(receipt)).toBe(false);
    }
    const changedRequest = {
      ...material.normalized_request,
      size: { ...material.normalized_request.size, amount: "81" },
    };
    expect(verifyReceiptFingerprint(receiptFor(changedRequest))).toBe(false);
    expect(
      verifyReceiptFingerprint(
        receiptFor(material.normalized_request, {
          ...material.input_refs,
          snapshot_hashes: ["b".repeat(64)],
        }),
      ),
    ).toBe(false);
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
