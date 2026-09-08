import { defineConfig } from "@playwright/test";

// Demo rehearsal (prd.md 21.2 G7, 23.2, 26): the spec starts and restarts its own kernel processes, one fresh
// REPLAY account per scene, and drives the operator through the real console served by Vite. Run it three
// times in a row with `pnpm demo:rehearse` (repeat-each 3). E2E_KERNEL_PORT/E2E_WEB_PORT isolate concurrent checkouts.
try {
  process.loadEnvFile(".env");
} catch {
  // no local .env; the documented defaults apply
}
if (!process.env.OPERATOR_BOOTSTRAP_SECRET) {
  throw new Error("OPERATOR_BOOTSTRAP_SECRET is required to run the rehearsal");
}

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a valid TCP port`);
  return value;
}
const kernelPort = port("E2E_KERNEL_PORT", 8080);
const webPort = port("E2E_WEB_PORT", 5173);
const webOrigin = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "tests/rehearsal",
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: webOrigin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `pnpm --filter @moneykernel/web dev --port ${webPort}`,
    url: webOrigin,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { E2E_KERNEL_PORT: String(kernelPort), E2E_WEB_PORT: String(webPort) },
  },
});
