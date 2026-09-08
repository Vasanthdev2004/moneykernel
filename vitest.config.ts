import { defineConfig } from "vitest/config";

// Tests read the same .env the kernel uses (DATABASE_URL_TEST etc.). Absent file: defaults apply.
try {
  process.loadEnvFile(".env");
} catch {
  // no local .env; tests fall back to their documented defaults
}

// Test layers follow prd.md section 20.1. Integration and fault layers hit a
// real PostgreSQL database and therefore run files serially.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts", "packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
          exclude: ["apps/web/**"],
        },
      },
      {
        test: {
          name: "property",
          include: ["tests/property/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "contracts",
          include: ["tests/contracts/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: "fault",
          include: ["tests/fault/**/*.test.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
