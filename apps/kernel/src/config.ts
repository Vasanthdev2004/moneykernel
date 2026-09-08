import { type Environment, EnvironmentSchema, hashCanonical } from "@moneykernel/contracts";
import { z } from "zod";

export const ENGINE_VERSION = "0.1.1";

/** Options that must never exist in v0.1 (prd.md 22.1). Presence alone is a startup failure. */
export const FORBIDDEN_ENV_KEYS = [
  "BINANCE_MAINNET_API_KEY",
  "BINANCE_MAINNET_API_SECRET",
  "LIVE",
  "SKIP_SAFETY_CHECKS",
] as const;

export const PLACEHOLDER_OPERATOR_SECRET = "GENERATE_A_RANDOM_SECRET";
const MIN_OPERATOR_SECRET_LENGTH = 16;

const BoolString = z.enum(["true", "false"]).transform((v) => v === "true");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "DATABASE_URL must be a postgresql:// URL"),
  MONEYKERNEL_MODE: EnvironmentSchema.default("REPLAY"),
  MONEYKERNEL_ACCOUNT_ALIAS: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "alias must be 1-40 lowercase alphanumerics or dashes")
    .default("demo-pool"),
  OPERATOR_BOOTSTRAP_SECRET: z.string().min(1, "OPERATOR_BOOTSTRAP_SECRET is required"),
  MCP_ENDPOINT: z.url().default("https://agent.binance.com/mcp/agentic"),
  MODEL_PROVIDER: z.enum(["disabled", "anthropic", "openai"]).default("disabled"),
  MODEL_ID: z.string().default(""),
  MODEL_API_KEY: z.string().default(""),
  BINANCE_TESTNET_API_KEY: z.string().default(""),
  BINANCE_TESTNET_API_SECRET: z.string().default(""),
  ENABLE_PUBLIC_MUTATIONS: BoolString.default(false),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** REPLAY only: scenario id under fixtures/scenarios. */
  REPLAY_FIXTURE: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,80}$/, "REPLAY_FIXTURE must be a scenario id")
    .default("scenario-a-constrained-acquisition"),
});

export type ModelProvider = "disabled" | "anthropic" | "openai";

export type KernelConfig = {
  engineVersion: string;
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  environment: Environment;
  accountAlias: string;
  quoteAsset: "USDT";
  operatorBootstrapSecret: string;
  mcpEndpoint: string;
  modelProvider: ModelProvider;
  modelId: string;
  modelApiKey: string;
  testnet: { apiKey: string; apiSecret: string } | null;
  enablePublicMutations: boolean;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  replayFixture: string;
  /** Hash of the non-secret configuration; stored on the account row and shown in status. */
  configurationHash: string;
  warnings: string[];
};

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KernelConfig {
  const problems: string[] = [];
  const warnings: string[] = [];

  for (const key of FORBIDDEN_ENV_KEYS) {
    if (env[key] !== undefined) problems.push(`${key} is forbidden in v0.1 (prd.md 22.1); remove it`);
  }

  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) problems.push(`${issue.path.join(".") || "env"}: ${issue.message}`);
    throw new ConfigError(problems);
  }
  const e = parsed.data;

  const hasTestnetKey = e.BINANCE_TESTNET_API_KEY.length > 0;
  const hasTestnetSecret = e.BINANCE_TESTNET_API_SECRET.length > 0;
  if (e.MONEYKERNEL_MODE === "TESTNET" && !(hasTestnetKey && hasTestnetSecret)) {
    problems.push("MONEYKERNEL_MODE=TESTNET requires dedicated BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_API_SECRET");
  }
  if (e.MONEYKERNEL_MODE !== "TESTNET" && (hasTestnetKey || hasTestnetSecret)) {
    warnings.push("Testnet credentials are set but MONEYKERNEL_MODE is not TESTNET; they are ignored");
  }
  if (e.MODEL_PROVIDER !== "disabled" && (e.MODEL_ID.length === 0 || e.MODEL_API_KEY.length === 0)) {
    problems.push(`MODEL_PROVIDER=${e.MODEL_PROVIDER} requires MODEL_ID and MODEL_API_KEY`);
  }
  if (e.MODEL_PROVIDER === "disabled" && e.MODEL_API_KEY.length > 0) {
    warnings.push("MODEL_API_KEY is set while MODEL_PROVIDER=disabled; it is ignored");
  }

  const weakSecret =
    e.OPERATOR_BOOTSTRAP_SECRET === PLACEHOLDER_OPERATOR_SECRET ||
    e.OPERATOR_BOOTSTRAP_SECRET.length < MIN_OPERATOR_SECRET_LENGTH;
  if (weakSecret) {
    const message = `OPERATOR_BOOTSTRAP_SECRET is the placeholder or shorter than ${MIN_OPERATOR_SECRET_LENGTH} characters`;
    if (e.NODE_ENV === "production") problems.push(message);
    else warnings.push(`${message} (allowed only outside production)`);
  }
  if (e.NODE_ENV === "production" && e.HOST !== "127.0.0.1" && e.HOST !== "localhost" && !e.ENABLE_PUBLIC_MUTATIONS) {
    warnings.push(
      `HOST=${e.HOST} exposes the API beyond loopback; mutations stay disabled (ENABLE_PUBLIC_MUTATIONS=false)`,
    );
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const configurationHash = hashCanonical({
    engine_version: ENGINE_VERSION,
    node_env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    environment: e.MONEYKERNEL_MODE,
    account_alias: e.MONEYKERNEL_ACCOUNT_ALIAS,
    quote_asset: "USDT",
    mcp_endpoint: e.MCP_ENDPOINT,
    model_provider: e.MODEL_PROVIDER,
    model_id: e.MODEL_ID,
    has_model_api_key: e.MODEL_API_KEY.length > 0,
    has_testnet_credentials: hasTestnetKey && hasTestnetSecret,
    enable_public_mutations: e.ENABLE_PUBLIC_MUTATIONS,
    log_level: e.LOG_LEVEL,
    replay_fixture: e.MONEYKERNEL_MODE === "REPLAY" ? e.REPLAY_FIXTURE : null,
  });

  return {
    engineVersion: ENGINE_VERSION,
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    environment: e.MONEYKERNEL_MODE,
    accountAlias: e.MONEYKERNEL_ACCOUNT_ALIAS,
    quoteAsset: "USDT",
    operatorBootstrapSecret: e.OPERATOR_BOOTSTRAP_SECRET,
    mcpEndpoint: e.MCP_ENDPOINT,
    modelProvider: e.MODEL_PROVIDER,
    modelId: e.MODEL_ID,
    modelApiKey: e.MODEL_API_KEY,
    testnet:
      e.MONEYKERNEL_MODE === "TESTNET"
        ? { apiKey: e.BINANCE_TESTNET_API_KEY, apiSecret: e.BINANCE_TESTNET_API_SECRET }
        : null,
    enablePublicMutations: e.ENABLE_PUBLIC_MUTATIONS,
    logLevel: e.LOG_LEVEL,
    replayFixture: e.REPLAY_FIXTURE,
    configurationHash,
    warnings,
  };
}

/** Everything safe to log or display. Secrets never leave this function. */
export function redactedConfig(config: KernelConfig): Record<string, unknown> {
  return {
    engine_version: config.engineVersion,
    node_env: config.nodeEnv,
    host: config.host,
    port: config.port,
    database: redactDatabaseUrl(config.databaseUrl),
    environment: config.environment,
    account_alias: config.accountAlias,
    quote_asset: config.quoteAsset,
    mcp_endpoint: config.mcpEndpoint,
    model_provider: config.modelProvider,
    model_id: config.modelId || null,
    has_model_api_key: config.modelApiKey.length > 0,
    has_testnet_credentials: config.testnet !== null,
    enable_public_mutations: config.enablePublicMutations,
    log_level: config.logLevel,
    replay_fixture: config.environment === "REPLAY" ? config.replayFixture : null,
    configuration_hash: config.configurationHash,
    warnings: config.warnings,
  };
}

export function redactDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "postgresql://***";
  }
}
