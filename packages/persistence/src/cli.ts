// pnpm db:migrate | pnpm db:status  (node --env-file-if-exists=.env packages/persistence/src/cli.ts up|status)
import { createPool } from "./db.ts";
import { MigrationDriftError, migrate, migrationStatus } from "./migrate.ts";

const [command] = process.argv.slice(2);
const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.length === 0) {
  console.error("DATABASE_URL is not set (copy .env.example to .env)");
  process.exitCode = 2;
} else if (command !== "up" && command !== "status") {
  console.error("usage: cli.ts up | status");
  process.exitCode = 2;
} else {
  const pool = createPool(databaseUrl, { applicationName: "moneykernel-migrate", max: 2 });
  try {
    if (command === "up") {
      const result = await migrate(pool);
      for (const file of result.applied) console.log(`applied ${String(file.version).padStart(4, "0")}_${file.name}`);
      console.log(`migrations: ${result.applied.length} applied, ${result.skipped} already present`);
    } else {
      const status = await migrationStatus(pool);
      for (const a of status.applied)
        console.log(`applied ${String(a.version).padStart(4, "0")}_${a.name} at ${a.applied_at.toISOString()}`);
      for (const p of status.pending) console.log(`pending ${String(p.version).padStart(4, "0")}_${p.name}`);
      for (const d of status.drift)
        console.log(`DRIFT   version ${d.version}: recorded ${d.expected} file ${d.actual}`);
      console.log(
        `migrations: ${status.applied.length} applied, ${status.pending.length} pending, ${status.drift.length} drifted`,
      );
      if (status.pending.length > 0 || status.drift.length > 0) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof MigrationDriftError ? error.message : error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
