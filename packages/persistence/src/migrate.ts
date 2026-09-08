import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { type Pool, withClient } from "./db.ts";

/**
 * Sequential SQL migrations (prd.md 14.6): checked-in files, applied in
 * version order, recorded with a checksum. The application never migrates
 * itself; readiness fails when the schema is behind or a recorded migration's
 * file has changed or is missing from this checkout (drift).
 */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const MIGRATION_LOCK_KEY = "moneykernel:migrations";

export type MigrationFile = { version: number; name: string; path: string; checksum: string };
export type AppliedMigration = { version: number; name: string; checksum: string; applied_at: Date };
export type MigrationDrift = { version: number; expected: string; actual: string };
export type MigrationStatus = { applied: AppliedMigration[]; pending: MigrationFile[]; drift: MigrationDrift[] };

export class MigrationDriftError extends Error {
  readonly drift: MigrationDrift[];
  constructor(drift: MigrationDrift[]) {
    super(
      `migration drift: ${drift.map((d) => `version ${d.version} recorded ${d.expected.slice(0, 12)} but file is ${d.actual.slice(0, 12)}`).join("; ")}`,
    );
    this.name = "MigrationDriftError";
    this.drift = drift;
  }
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export function listMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const parsed: MigrationFile[] = [];
  for (const file of files) {
    const match = FILE_RE.exec(file);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new Error(`migration file name must be NNNN_snake_name.sql: ${file}`);
    }
    const path = join(dir, file);
    parsed.push({ version: Number(match[1]), name: match[2], path, checksum: sha256(readFileSync(path)) });
  }
  parsed.sort((a, b) => a.version - b.version);
  parsed.forEach((file, index) => {
    const expected = index + 1;
    if (file.version !== expected) {
      throw new Error(`migration sequence broken at version ${file.version}: expected ${expected} (gap or duplicate)`);
    }
  });
  return parsed;
}

async function ensureBookkeeping(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

async function readApplied(client: PoolClient): Promise<AppliedMigration[]> {
  const result = await client.query<AppliedMigration>(
    "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
  );
  return result.rows;
}

function diff(
  files: MigrationFile[],
  applied: AppliedMigration[],
): { pending: MigrationFile[]; drift: MigrationDrift[] } {
  const byVersion = new Map(applied.map((a) => [a.version, a]));
  const pending: MigrationFile[] = [];
  const drift: MigrationDrift[] = [];
  for (const file of files) {
    const record = byVersion.get(file.version);
    if (record === undefined) pending.push(file);
    else if (record.checksum !== file.checksum) {
      drift.push({ version: file.version, expected: record.checksum, actual: file.checksum });
    }
    byVersion.delete(file.version);
  }
  // A newer database or an omitted migration is incompatible with this
  // checkout until explicitly accounted for; it must not look up to date.
  for (const record of byVersion.values()) {
    drift.push({ version: record.version, expected: record.checksum, actual: "missing file" });
  }
  return { pending, drift };
}

export async function migrationStatus(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<MigrationStatus> {
  const files = listMigrationFiles(dir);
  return withClient(pool, async (client) => {
    await ensureBookkeeping(client);
    const applied = await readApplied(client);
    return { applied, ...diff(files, applied) };
  });
}

/**
 * Applies every pending migration inside one transaction, serialized by a
 * transaction-scoped advisory lock so two migrators cannot race. Refuses to
 * apply anything when drift exists.
 */
export async function migrate(
  pool: Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<{ applied: MigrationFile[]; skipped: number }> {
  const files = listMigrationFiles(dir);
  return withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);
      await ensureBookkeeping(client);
      const already = await readApplied(client);
      const { pending, drift } = diff(files, already);
      if (drift.length > 0) throw new MigrationDriftError(drift);
      for (const file of pending) {
        await client.query(readFileSync(file.path, "utf8"));
        await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
          file.version,
          file.name,
          file.checksum,
        ]);
      }
      await client.query("COMMIT");
      return { applied: pending, skipped: already.length };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}
