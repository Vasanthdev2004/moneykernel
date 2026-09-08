import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMigrationFiles, MIGRATIONS_DIR } from "@moneykernel/persistence";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
function tempDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mk-migrations-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("listMigrationFiles (prd.md 14.6)", () => {
  it("parses versions and names in order with content checksums", () => {
    const dir = tempDir({ "0002_second.sql": "select 2;", "0001_first.sql": "select 1;", "notes.txt": "ignored" });
    const files = listMigrationFiles(dir);
    expect(files.map((f) => [f.version, f.name])).toEqual([
      [1, "first"],
      [2, "second"],
    ]);
    expect(files[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(files[0]?.checksum).not.toBe(files[1]?.checksum);
  });

  it("rejects gaps, duplicates, and malformed names", () => {
    expect(() => listMigrationFiles(tempDir({ "0001_a.sql": "", "0003_c.sql": "" }))).toThrow(/sequence/);
    expect(() => listMigrationFiles(tempDir({ "0001_a.sql": "", "0001_b.sql": "" }))).toThrow(/sequence/);
    expect(() => listMigrationFiles(tempDir({ "0002_only.sql": "" }))).toThrow(/sequence/);
    expect(() => listMigrationFiles(tempDir({ "first.sql": "" }))).toThrow(/NNNN_snake_name/);
  });

  it("the checked-in migrations form a valid sequence", () => {
    const files = listMigrationFiles(MIGRATIONS_DIR);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0]?.name).toBe("initial_schema");
  });
});
