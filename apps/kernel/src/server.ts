import { buildApp } from "./app.ts";
import { boot } from "./boot.ts";
import { ConfigError, loadConfig, redactedConfig } from "./config.ts";
import { dispatchOnce } from "./dispatcher/dispatch.ts";
import { sweepProposals } from "./services/proposals.ts";

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const runtime = await boot(config, { log: (message) => console.error(`[boot] ${message}`) });
  const app = buildApp(runtime);
  app.log.info({ config: redactedConfig(config) }, "configuration loaded");
  for (const check of runtime.bootChecks) {
    app.log[check.ok ? "info" : "warn"](
      { check: check.name, detail: check.detail },
      `boot check ${check.ok ? "ok" : "FAILED"}`,
    );
  }

  // Background coordination: proposal sweep (collection window, conflicts, expiry) and single-writer dispatch.
  let sweeping = false;
  let dispatching = false;
  const timers: NodeJS.Timeout[] = [];
  if (runtime.writer !== null && runtime.account !== null) {
    timers.push(
      setInterval(async () => {
        if (sweeping) return;
        sweeping = true;
        try {
          await sweepProposals(runtime, runtime.clock());
        } catch (error) {
          app.log.warn({ err: error }, "proposal sweep failed");
        } finally {
          sweeping = false;
        }
      }, 250),
    );
    timers.push(
      setInterval(async () => {
        if (dispatching) return;
        dispatching = true;
        try {
          const report = await dispatchOnce(runtime, runtime.clock());
          if (report.kind !== "IDLE") app.log.info({ report }, "dispatch");
        } catch (error) {
          app.log.error({ err: error }, "dispatch failed");
        } finally {
          dispatching = false;
        }
      }, 250),
    );
  }

  let closing = false;
  const close = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "shutting down");
    for (const timer of timers) clearInterval(timer);
    await app.close();
    await runtime.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void close("SIGINT"));
  process.on("SIGTERM", () => void close("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { mode: config.environment, account: runtime.account?.id ?? null, status: runtime.account?.status ?? null },
    "MoneyKernel kernel listening; account stays PAUSED until an operator resumes it",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
