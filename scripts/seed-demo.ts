/**
 * pnpm demo:seed [scenario-id]  (default: scenario-a-constrained-acquisition)
 *
 * Initializes a pristine configured REPLAY/SHADOW account exactly once:
 * policy version, virtual balances and attribution, symbol rules, agents with
 * fresh tokens, leases starting now, then initial operator resume. Run the
 * kernel first (`pnpm dev`) with a fresh MONEYKERNEL_ACCOUNT_ALIAS. Existing
 * runs cannot be reset or resumed through this command.
 *
 * Tokens are printed ONCE. They are demo credentials for virtual funds only.
 */
import { loadScenario } from "@moneykernel/integrations";
import { boot } from "../apps/kernel/src/boot.ts";
import { ConfigError, loadConfig } from "../apps/kernel/src/config.ts";
import { FIXTURES_DIR } from "../apps/kernel/src/fixtures.ts";
import { seedScenario } from "../apps/kernel/src/services/seed.ts";

const scenarioId = process.argv[2] ?? "scenario-a-constrained-acquisition";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
}

if (config.environment === "TESTNET") {
  console.error("demo:seed only works with virtual funds (REPLAY or SHADOW)");
  process.exit(1);
}

// The seed is a second process: it must not take the writer lock or bump the epoch.
const runtime = await boot(config, { skipWriterLock: true, skipAccountBoot: true, fixtureId: scenarioId });
try {
  if (runtime.pool === null || runtime.account === null) {
    console.error("database or account unavailable; start the kernel first (pnpm dev)");
    process.exitCode = 1;
  } else {
    const scenario = loadScenario(scenarioId, FIXTURES_DIR);
    const result = await seedScenario(runtime, scenario, { operatorId: "seed-script" });
    console.log(JSON.stringify({ scenario: scenario.scenario_id, ...result }, null, 2));
    console.log("\nAccount is READY. Example:");
    const first = result.agents[0];
    if (first !== undefined) {
      console.log(
        `  curl -s http://127.0.0.1:${config.port}/v1/agent/context -H "Authorization: Bearer ${first.token}"`,
      );
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await runtime.shutdown();
}
