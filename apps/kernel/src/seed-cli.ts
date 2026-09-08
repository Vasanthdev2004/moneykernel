/** One-time virtual-account bootstrap for a pristine REPLAY or SHADOW namespace. */
import { loadScenario } from "@moneykernel/integrations";
import { boot } from "./boot.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { FIXTURES_DIR } from "./fixtures.ts";
import { seedScenario } from "./services/seed.ts";

const profile = process.argv[2];
if (profile === undefined) {
  console.error("usage: node src/seed-cli.ts <bootstrap-profile.json|fixture-id>");
  process.exit(2);
}

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
}

if (config.environment === "TESTNET") {
  console.error("virtual account bootstrap is allowed only in REPLAY or SHADOW");
  process.exit(1);
}

const runtime = await boot(config, { skipWriterLock: true, skipAccountBoot: true });
try {
  if (runtime.pool === null || runtime.account === null) {
    console.error("database or account unavailable; start the kernel before running bootstrap");
    process.exitCode = 1;
  } else {
    const definition = loadScenario(profile, FIXTURES_DIR);
    if (definition.environment !== config.environment) {
      throw new Error(`bootstrap profile mode ${definition.environment} does not match ${config.environment}`);
    }
    const result = await seedScenario(runtime, definition, { operatorId: "bootstrap-cli" });
    console.log(JSON.stringify({ profile: definition.scenario_id, ...result }, null, 2));
    console.error("Agent tokens above are displayed once. Store them as secrets before closing this terminal.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await runtime.shutdown();
}
