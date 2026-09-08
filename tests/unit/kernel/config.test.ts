import { describe, expect, it } from "vitest";
import { ConfigError, FORBIDDEN_ENV_KEYS, loadConfig, redactedConfig } from "../../../apps/kernel/src/config.ts";

const base = {
  DATABASE_URL: "postgresql://moneykernel:secret-password@localhost:5432/moneykernel",
  OPERATOR_BOOTSTRAP_SECRET: "a-sufficiently-long-operator-secret",
};

describe("loadConfig (prd.md 22.1)", () => {
  it("defaults to REPLAY on loopback with the model disabled", () => {
    const config = loadConfig(base);
    expect(config.environment).toBe("REPLAY");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8080);
    expect(config.modelProvider).toBe("disabled");
    expect(config.testnet).toBeNull();
    expect(config.enablePublicMutations).toBe(false);
    expect(config.warnings).toEqual([]);
  });

  it.each(FORBIDDEN_ENV_KEYS)("T-48 / INV-13: rejects the forbidden option %s even when empty", (key) => {
    expect(() => loadConfig({ ...base, [key]: "" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, [key]: "true" })).toThrow(key);
  });

  it("requires a DATABASE_URL and an operator secret", () => {
    expect(() => loadConfig({ OPERATOR_BOOTSTRAP_SECRET: base.OPERATOR_BOOTSTRAP_SECRET })).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, DATABASE_URL: "mysql://x" })).toThrow(ConfigError);
  });

  it("TESTNET mode requires dedicated Testnet credentials", () => {
    expect(() => loadConfig({ ...base, MONEYKERNEL_MODE: "TESTNET" })).toThrow(ConfigError);
    const config = loadConfig({
      ...base,
      MONEYKERNEL_MODE: "TESTNET",
      BINANCE_TESTNET_API_KEY: "k",
      BINANCE_TESTNET_API_SECRET: "s",
    });
    expect(config.testnet).toEqual({ apiKey: "k", apiSecret: "s" });
  });

  it("LIVE is not a mode", () => {
    expect(() => loadConfig({ ...base, MONEYKERNEL_MODE: "LIVE" })).toThrow(ConfigError);
  });

  it("warns when Testnet credentials are set outside TESTNET and ignores them", () => {
    const config = loadConfig({ ...base, BINANCE_TESTNET_API_KEY: "k", BINANCE_TESTNET_API_SECRET: "s" });
    expect(config.testnet).toBeNull();
    expect(config.warnings.join(" ")).toMatch(/ignored/);
  });

  it("a live model provider requires an id and a key", () => {
    expect(() => loadConfig({ ...base, MODEL_PROVIDER: "anthropic" })).toThrow(ConfigError);
    const config = loadConfig({
      ...base,
      MODEL_PROVIDER: "anthropic",
      MODEL_ID: "claude-sonnet-5",
      MODEL_API_KEY: "x",
    });
    expect(config.modelProvider).toBe("anthropic");
  });

  it("placeholder operator secret is a warning in development and an error in production", () => {
    const dev = loadConfig({ ...base, OPERATOR_BOOTSTRAP_SECRET: "GENERATE_A_RANDOM_SECRET" });
    expect(dev.warnings.join(" ")).toMatch(/placeholder/);
    expect(() =>
      loadConfig({ ...base, NODE_ENV: "production", OPERATOR_BOOTSTRAP_SECRET: "GENERATE_A_RANDOM_SECRET" }),
    ).toThrow(ConfigError);
  });

  it("configuration hash ignores secrets and changes with the mode", () => {
    const a = loadConfig(base);
    const b = loadConfig({ ...base, OPERATOR_BOOTSTRAP_SECRET: "another-sufficiently-long-secret" });
    const c = loadConfig({ ...base, MONEYKERNEL_MODE: "SHADOW" });
    expect(a.configurationHash).toBe(b.configurationHash);
    expect(a.configurationHash).not.toBe(c.configurationHash);
  });

  it("redactedConfig never contains secrets", () => {
    const config = loadConfig({ ...base, MODEL_PROVIDER: "openai", MODEL_ID: "gpt", MODEL_API_KEY: "sk-secret-value" });
    const text = JSON.stringify(redactedConfig(config));
    expect(text).not.toContain("sk-secret-value");
    expect(text).not.toContain("secret-password");
    expect(text).not.toContain(base.OPERATOR_BOOTSTRAP_SECRET);
    expect(text).toContain('"has_model_api_key":true');
  });
});
