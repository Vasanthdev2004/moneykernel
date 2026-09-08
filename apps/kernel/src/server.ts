import { buildApp } from "./app.ts";
import { boot } from "./boot.ts";
import { ConfigError, loadConfig, redactedConfig } from "./config.ts";

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

  let closing = false;
  const close = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "shutting down");
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
