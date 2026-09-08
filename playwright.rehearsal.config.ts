import { defineConfig } from "@playwright/test";

// Demo rehearsal (prd.md 21.2 G7, 23.2, 26): the spec starts and restarts its own kernel processes, one fresh
// REPLAY account per scene, and drives the operator through the real console served by Vite. Run it three
// times in a row with `pnpm demo:rehearse` (repeat-each 3). Do not run it while `pnpm test:e2e` or a `pnpm dev`
// kernel holds port 8080.
try {
  process.loadEnvFile(".env");
} catch {
  // no local .env; the documented defaults apply
}

export default defineConfig({
  testDir: "tests/rehearsal",
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "pnpm --filter @moneykernel/web dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
