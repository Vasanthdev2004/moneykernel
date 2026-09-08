import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

/**
 * Scenario fixtures (fixtures/scenarios/*.json, prd.md 27). Parsed strictly
 * enough to drive the fixture market adapter and the seeding service; extra
 * descriptive fields pass through untouched.
 */
const Decimal = z.string().regex(/^-?\d+(\.\d+)?$/);

export const FixtureSymbolRulesSchema = z.looseObject({
  symbol: z.string(),
  base_asset: z.string(),
  quote_asset: z.string(),
  status: z.enum(["TRADING", "HALT", "BREAK", "UNKNOWN"]),
  tick_size: Decimal,
  min_price: Decimal.nullable().optional(),
  max_price: Decimal.nullable().optional(),
  step_size: Decimal,
  min_qty: Decimal,
  max_qty: Decimal,
  min_notional: Decimal,
  max_notional: Decimal.nullable(),
  base_precision: z.number().int(),
  quote_precision: z.number().int(),
  unsupported_filters: z.array(z.string()),
});

export const FixtureMarketSnapshotSchema = z.looseObject({
  snapshot_id: z.string(),
  symbol: z.string(),
  source: z.literal("SYNTHETIC_FIXTURE"),
  source_timestamp: z.string(),
  bids: z.array(z.object({ price: Decimal, quantity: Decimal })),
  asks: z.array(z.object({ price: Decimal, quantity: Decimal })),
  last_price: Decimal.nullable(),
});

export const FixtureLeaseSchema = z.looseObject({
  lease_id: z.string(),
  acquisition_budget_quote: Decimal,
  max_submission_attempts: z.number().int().nonnegative(),
  allowed_symbols: z.array(z.string()),
  allowed_sides: z.array(z.enum(["BUY", "SELL"])),
  allowed_order_types: z.array(z.literal("LIMIT_IOC")),
  assigned_inventory: z.record(z.string(), Decimal).optional(),
  starts_at: z.string(),
  expires_at: z.string(),
});

export const FixtureAgentSchema = z.looseObject({
  agent_id: z.string(),
  name: z.string(),
  strategy_kind: z.string(),
  lease: FixtureLeaseSchema,
});

export const ScenarioSchema = z.looseObject({
  scenario_id: z.string(),
  prd_reference: z.string().optional(),
  description: z.string().optional(),
  environment: z.enum(["REPLAY", "SHADOW", "TESTNET"]),
  virtual_clock_start: z.string(),
  policy: z.record(z.string(), z.unknown()).optional(),
  policy_overrides: z.record(z.string(), z.unknown()).optional(),
  symbol_rules: z.record(z.string(), FixtureSymbolRulesSchema).optional(),
  symbol_rules_ref: z.string().optional(),
  market_snapshots: z.array(FixtureMarketSnapshotSchema).optional(),
  market_snapshots_ref: z.string().optional(),
  marks: z.record(z.string(), Decimal).optional(),
  account: z.looseObject({
    alias: z.string(),
    quote_asset: z.string(),
    balances: z.record(z.string(), Decimal),
    inventory_allocations: z.record(z.string(), z.record(z.string(), Decimal)).default({}),
  }),
  agents: z.array(FixtureAgentSchema).default([]),
});

export type Scenario = z.infer<typeof ScenarioSchema>;
export type FixtureSymbolRules = z.infer<typeof FixtureSymbolRulesSchema>;
export type FixtureMarketSnapshot = z.infer<typeof FixtureMarketSnapshotSchema>;

export class ScenarioLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioLoadError";
  }
}

/** Accepts a scenario id (file stem) or a path. */
export function resolveScenarioPath(idOrPath: string, fixturesDir: string): string {
  if (idOrPath.endsWith(".json") && existsSync(idOrPath)) return idOrPath;
  const candidate = join(fixturesDir, `${idOrPath}.json`);
  if (existsSync(candidate)) return candidate;
  throw new ScenarioLoadError(`scenario not found: ${idOrPath} (looked in ${fixturesDir})`);
}

/** Loads a scenario and resolves `*_ref` fields against sibling scenario files. */
export function loadScenario(idOrPath: string, fixturesDir: string): Scenario {
  const path = resolveScenarioPath(idOrPath, fixturesDir);
  const parsed = ScenarioSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new ScenarioLoadError(
      `invalid scenario ${basename(path)}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const scenario = parsed.data;
  const siblingDir = dirname(path);
  if (scenario.symbol_rules === undefined && scenario.symbol_rules_ref !== undefined) {
    scenario.symbol_rules = loadScenario(scenario.symbol_rules_ref, siblingDir).symbol_rules;
  }
  if (scenario.market_snapshots === undefined && scenario.market_snapshots_ref !== undefined) {
    const referenced = loadScenario(scenario.market_snapshots_ref, siblingDir);
    scenario.market_snapshots = referenced.market_snapshots;
    scenario.marks = scenario.marks ?? referenced.marks;
  }
  return scenario;
}
