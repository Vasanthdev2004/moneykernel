import { defineConfig } from "@playwright/test";

// Browser tests drive the real kernel (REPLAY, fresh account alias per run) through the Vite dev server,
// which proxies /v1 and /health to the kernel on 127.0.0.1:8080 (prd.md 20.1 e2e layer, 22.2 test:e2e).
try {
  process.loadEnvFile(".env");
} catch {
  // no local .env; the documented defaults apply
}

const alias = process.env.E2E_ACCOUNT_ALIAS ?? `e2e-${Date.now().toString(36)}`;
process.env.E2E_ACCOUNT_ALIAS = alias;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "node --env-file-if-exists=.env apps/kernel/src/server.ts",
      url: "http://127.0.0.1:8080/health/live",
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        MONEYKERNEL_MODE: "REPLAY",
        MONEYKERNEL_ACCOUNT_ALIAS: alias,
        MONEYKERNEL_STATE_DIR: ".moneykernel/e2e",
        PORT: "8080",
        HOST: "127.0.0.1",
        LOG_LEVEL: "warn",
      },
    },
    {
      command: "pnpm --filter @moneykernel/web dev",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
