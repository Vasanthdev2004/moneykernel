import { defineConfig } from "@playwright/test";

// Browser tests drive the real kernel (REPLAY, fresh account alias per run) through the Vite dev server,
// which proxies /v1 and /health to the isolated kernel (prd.md 20.1 e2e layer, 22.2 test:e2e).
try {
  process.loadEnvFile(".env");
} catch {
  // no local .env; the documented defaults apply
}

const alias = process.env.E2E_ACCOUNT_ALIAS ?? `e2e-${Date.now().toString(36)}`;
process.env.E2E_ACCOUNT_ALIAS = alias;

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a valid TCP port`);
  return value;
}
const kernelPort = port("E2E_KERNEL_PORT", 8080);
const webPort = port("E2E_WEB_PORT", 5173);
const kernelOrigin = `http://127.0.0.1:${kernelPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: webOrigin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "node --env-file-if-exists=.env apps/kernel/src/server.ts",
      url: `${kernelOrigin}/health/live`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        MONEYKERNEL_MODE: "REPLAY",
        MONEYKERNEL_ACCOUNT_ALIAS: alias,
        MONEYKERNEL_STATE_DIR: ".moneykernel/e2e",
        PORT: String(kernelPort),
        HOST: "127.0.0.1",
        LOG_LEVEL: "warn",
      },
    },
    {
      command: `pnpm --filter @moneykernel/web dev --port ${webPort}`,
      url: webOrigin,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { E2E_KERNEL_PORT: String(kernelPort), E2E_WEB_PORT: String(webPort) },
    },
  ],
});
