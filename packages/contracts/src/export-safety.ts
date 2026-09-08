/** Credential shapes are checked before export or diagnostic rendering; findings never include matched values. */
const SECRET_PATTERNS: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["anthropic key", /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai key", /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ["aws access key", /AKIA[0-9A-Z]{16}/],
  ["binance-style key assignment", /BINANCE_[A-Z_]*(?:KEY|SECRET)"?\s*[:=]\s*['"]?[A-Za-z0-9]{32,}/],
  [
    "generic secret assignment",
    /(?:api[_-]?key|api[_-]?secret|access[_-]?token)"?\s*[:=]\s*['"][A-Za-z0-9_-]{24,}['"]/i,
  ],
  ["agent or operator bearer token", /\bmk[ao]_[A-Za-z0-9_-]{20,}\b/],
  ["bootstrap secret value", /bootstrap_secret"?\s*[:=]\s*['"]?[^'",\s{}]{8,}/i],
  ["token_hash key", /"token_hash"\s*:/],
];

function credentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    ["token", "secret", "tokenhash", "authorization", "privatekey", "csrf", "csrftoken"].includes(normalized) ||
    /(?:apikey|apisecret|accesstoken|sessiontoken|password|bootstrapsecret|clientsecret)$/.test(normalized)
  );
}

/**
 * Fail closed when a bundle contains credential keys, known credential shapes,
 * or exact configured secret values. Never redact signed audit/receipt material:
 * an unsafe archive must be withheld instead. Arbitrary unknown secrets cannot
 * be inferred from ordinary prose by an offline scanner.
 */
export function exportSecretFindings(value: unknown, knownSecrets: ReadonlyArray<string> = []): string[] {
  const findings = new Set<string>();
  const secrets = knownSecrets.filter((secret) => secret.length > 0);
  const inspectText = (text: string) => {
    for (const [label, pattern] of SECRET_PATTERNS) if (pattern.test(text)) findings.add(label);
    if (secrets.some((secret) => text.includes(secret))) findings.add("configured credential value");
  };
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === "string") inspectText(item);
    else if (item !== null && typeof item === "object" && !visited.has(item)) {
      visited.add(item);
      for (const [key, nested] of Object.entries(item)) {
        if (credentialKey(key)) findings.add(key.toLowerCase() === "token_hash" ? "token_hash key" : "credential key");
        inspectText(key);
        pending.push(nested);
      }
    }
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) findings.add("unserializable export");
    else inspectText(serialized);
  } catch {
    findings.add("unserializable export");
  }
  return [...findings];
}
