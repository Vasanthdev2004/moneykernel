import { exportSecretFindings } from "@moneykernel/contracts";
import { describe, expect, it } from "vitest";

describe("export credential screening", () => {
  it("rejects nested credential keys and shapes without returning their contents", () => {
    const token = `mka_${"z".repeat(40)}`;
    const payload = { rows: [{ nested: { accessToken: "ordinary-looking-secret" }, note: token }] };
    const findings = exportSecretFindings(payload);
    expect(findings).toContain("credential key");
    expect(findings).toContain("agent or operator bearer token");
    expect(JSON.stringify(findings)).not.toContain(token);
    expect(JSON.stringify(findings)).not.toContain("ordinary-looking-secret");
  });

  it("detects configured values in decoded free text, including escaped JSON characters", () => {
    const secret = 'credential-with-"quotes"-and-\\slashes';
    const findings = exportSecretFindings({ rationale: `diagnostic ${secret}` }, ["", secret]);
    expect(findings).toContain("configured credential value");
    expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it("permits ordinary financial receipts, hash values and strategy descriptions", () => {
    expect(
      exportSecretFindings({
        decision_fingerprint: "f".repeat(64),
        payload_hash: "a".repeat(64),
        strategy_kind: "SCRIPTED",
        input_tokens: 100,
        rationale: "Buy 20 USDT of SOL within the approved limits",
      }),
    ).toEqual([]);
  });
});
