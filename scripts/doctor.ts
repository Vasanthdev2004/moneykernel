/**
 * pnpm doctor — WP-01 completion evidence (prd.md 21.4): supported runtime,
 * database, selected mode, and no unexpected secrets. Exit 0 only when every
 * required check passes. Run with: node --env-file-if-exists=.env scripts/doctor.ts
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, migrationStatus } from "@moneykernel/persistence";
import { ConfigError, loadConfig, redactedConfig } from "../apps/kernel/src/config.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type Check = { name: string; ok: boolean; required: boolean; detail: string };
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string, required = true): void => {
  checks.push({ name, ok, required, detail });
};

const quoteArg = (arg: string): string =>
  /^[A-Za-z0-9_./:={}\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;

/** Runs a fixed, non-user-controlled command line through the platform shell (pnpm and docker are shims on Windows). */
function run(command: string, args: string[]): string | null {
  try {
    return execSync([command, ...args].map(quoteArg).join(" "), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// Runtime
const wanted = readFileSync(join(ROOT, ".nvmrc"), "utf8").trim();
const [wantMajor, wantMinor] = wanted.split(".").map(Number);
const [haveMajor, haveMinor] = process.versions.node.split(".").map(Number);
add(
  "node",
  haveMajor === wantMajor && (haveMinor ?? 0) >= (wantMinor ?? 0),
  `have ${process.versions.node}, .nvmrc wants ${wanted} (same major, minor >=)`,
);
const pnpmVersion = run("pnpm", ["--version"]);
add("pnpm", pnpmVersion !== null, pnpmVersion ? `pnpm ${pnpmVersion}` : "pnpm not on PATH");
const dockerVersion = run("docker", ["info", "--format", "{{.ServerVersion}}"]);
add(
  "docker_engine",
  dockerVersion !== null && dockerVersion.length > 0,
  dockerVersion ? `engine ${dockerVersion}` : "engine not reachable (needed for the compose database)",
  false,
);

// Configuration and mode
let config: ReturnType<typeof loadConfig> | null = null;
try {
  config = loadConfig();
  add(
    "configuration",
    true,
    `mode=${config.environment} alias=${config.accountAlias} hash=${config.configurationHash.slice(0, 12)}`,
  );
  for (const warning of config.warnings) add("configuration_warning", true, warning, false);
} catch (error) {
  add("configuration", false, error instanceof ConfigError ? error.problems.join("; ") : String(error));
}

// Secrets hygiene
const envTracked = run("git", ["-C", ROOT, "ls-files", "--error-unmatch", ".env"]);
add(
  "env_not_tracked",
  envTracked === null,
  envTracked === null ? ".env is not tracked by git" : ".env IS TRACKED BY GIT; remove it from the index immediately",
);
add(".env.example", existsSync(join(ROOT, ".env.example")), ".env.example present", false);

const trackedFiles = (run("git", ["-C", ROOT, "ls-files"]) ?? "").split(/\r?\n/).filter(Boolean);
const secretPatterns: Array<[string, RegExp]> = [
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["anthropic key", /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai key", /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ["aws access key", /AKIA[0-9A-Z]{16}/],
  ["binance-style key assignment", /BINANCE_[A-Z_]*(?:KEY|SECRET)\s*=\s*['"]?[A-Za-z0-9]{32,}/],
  ["generic secret assignment", /(?:api[_-]?key|api[_-]?secret|access[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_-]{24,}['"]/i],
];
const hits: string[] = [];
for (const file of trackedFiles) {
  if (file === "pnpm-lock.yaml" || file.endsWith(".png") || file.endsWith(".ico")) continue;
  let text: string;
  try {
    text = readFileSync(join(ROOT, file), "utf8");
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [label, pattern] of secretPatterns) {
      if (pattern.test(line)) hits.push(`${file}:${index + 1} (${label})`);
    }
  });
}
add(
  "tracked_secret_scan",
  hits.length === 0,
  hits.length === 0 ? `${trackedFiles.length} tracked files scanned, no secret-like values` : hits.join(", "),
);

// Database and migrations
if (config !== null) {
  const pool = createPool(config.databaseUrl, { applicationName: "moneykernel-doctor", max: 1 });
  try {
    const version = await pool.query<{ v: string }>("SELECT version() AS v");
    add("database", true, version.rows[0]?.v.split(",")[0] ?? "connected");
    const status = await migrationStatus(pool);
    const ok = status.pending.length === 0 && status.drift.length === 0;
    add(
      "migrations",
      ok,
      ok
        ? `${status.applied.length} applied, none pending`
        : `${status.pending.length} pending, ${status.drift.length} drifted (run pnpm db:migrate)`,
    );
  } catch (error) {
    add("database", false, error instanceof Error ? error.message : String(error));
  } finally {
    await pool.end();
  }
}

// Report
const width = Math.max(...checks.map((c) => c.name.length));
for (const check of checks) {
  const mark = check.ok ? "ok  " : check.required ? "FAIL" : "warn";
  console.log(`${mark}  ${check.name.padEnd(width)}  ${check.detail}`);
}
if (config !== null) console.log(`\nconfiguration (redacted): ${JSON.stringify(redactedConfig(config))}`);
const failed = checks.filter((c) => c.required && !c.ok);
console.log(
  failed.length === 0 ? "\ndoctor: all required checks passed" : `\ndoctor: ${failed.length} required check(s) failed`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
