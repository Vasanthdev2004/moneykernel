import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "@moneykernel/integrations";
import { beforeAll, describe, expect, it } from "vitest";
import { FIXTURES_DIR } from "../../../apps/kernel/src/fixtures.ts";
import { DATABASE_URL_TEST, migrateTestDatabase, OPERATOR_SECRET, startHarness, stopHarness } from "./harness.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../../../scripts/demo-replay.ts", import.meta.url));
const scenarioId = "scenario-a-constrained-acquisition";

// Preserve OS process essentials without inheriting database or provider configuration.
const processEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.WINDIR,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
};

function run(args: string[], env: NodeJS.ProcessEnv = processEnv) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
}

beforeAll(migrateTestDatabase);

describe("replay CLI rejects unsafe arguments and closes failed runs", () => {
  it.each(["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "2junk", "1e2", ""])(
    "rejects --runs=%s before loading configuration or connecting to a database",
    (value) => {
      const result = run([scenarioId, `--runs=${value}`]);
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--runs must be a positive safe integer");
      expect(result.stderr).not.toContain("DATABASE_URL");
      expect(result.stdout).not.toContain("on account alias");
    },
  );

  it.each([
    [scenarioId, "unexpected-second-scenario"],
    [scenarioId, "--runs", "2", "--keep-alias", "must-not-be-reused"],
  ])("rejects ambiguous or repeated alias arguments before boot: %j", (...args) => {
    const result = run(args);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("use one scenario, and use --keep-alias only with --runs 1");
    expect(result.stderr).not.toContain("DATABASE_URL");
    expect(result.stdout).not.toContain("on account alias");
  });

  it("exits promptly when --keep-alias names an existing seeded account", async () => {
    const h = await startHarness(loadScenario(scenarioId, FIXTURES_DIR), scenarioId);
    // The CLI must obtain the writer itself and reach the seed refusal, rather
    // than fail because this test is still holding the writer connection.
    await stopHarness(h);
    const output = join(tmpdir(), `moneykernel-replay-rejected-${randomUUID()}`);
    const result = run([scenarioId, "--keep-alias", h.alias, "--out", output], {
      ...processEnv,
      DATABASE_URL: DATABASE_URL_TEST,
      OPERATOR_BOOTSTRAP_SECRET: OPERATOR_SECRET,
      MONEYKERNEL_MODE: "REPLAY",
      LOG_LEVEL: "silent",
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("use a fresh account alias");
    expect(existsSync(output)).toBe(false);
  });
});
