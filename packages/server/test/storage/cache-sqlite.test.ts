import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type CacheSchemaStep,
  openCacheDatabase,
} from "../../src/storage/cache-sqlite.js";
import {
  discoveryMigrationPrefix,
  migrateDiscoveryDatabase,
} from "../../src/storage/discovery-sqlite.js";
import { loadSqliteDriver } from "../../src/storage/sqlite.js";

const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "ya-sqlite-cache-"));
  return {
    dir,
    file: join(dir, "cache.sqlite"),
    [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const V1: CacheSchemaStep = {
  version: 1,
  sql: "CREATE TABLE facts(id TEXT PRIMARY KEY)",
  rebuild: true,
};
const ADD_COLUMN: CacheSchemaStep = {
  version: 2,
  sql: "ALTER TABLE facts ADD COLUMN size INTEGER",
};
const V2_REBUILD: CacheSchemaStep = {
  version: 2,
  sql: "CREATE TABLE facts(id TEXT PRIMARY KEY, size INTEGER)",
  rebuild: true,
};

/** Open at `steps`, returning the stored rows and why the file was replaced. */
function reopen(dir: string, steps: readonly CacheSchemaStep[]) {
  const onReset = vi.fn();
  const database = openCacheDatabase({ dataDir: dir, steps, onReset });
  try {
    const select = database.prepare("SELECT * FROM facts");
    const rows = select.all();
    select.finalize();
    return { rows, reset: onReset.mock.calls.map(([reason]) => reason) };
  } finally {
    database.close();
  }
}

function seed(dir: string) {
  const database = openCacheDatabase({ dataDir: dir, steps: [V1] });
  database.exec("INSERT INTO facts(id) VALUES ('kept')");
  database.close();
}

describe("rebuildable cache storage", () => {
  it("keeps rows across a plain step and discards them at a rebuild step", () => {
    using migrated = dataDir();
    seed(migrated.dir);
    expect(reopen(migrated.dir, [V1, ADD_COLUMN])).toEqual({
      rows: [{ id: "kept", size: null }],
      reset: [],
    });

    using rebuilt = dataDir();
    seed(rebuilt.dir);
    const result = reopen(rebuilt.dir, [V1, V2_REBUILD]);
    expect(result.rows).toEqual([]);
    expect(result.reset).toEqual([
      expect.stringContaining("schema 2 starts from an empty cache"),
    ]);
    // History before the latest rebuild is optional: the same file reopens.
    expect(reopen(rebuilt.dir, [V2_REBUILD]).reset).toEqual([]);
  });

  it("replaces a file it cannot use instead of refusing to start", () => {
    using newer = dataDir();
    seed(newer.dir);
    reopen(newer.dir, [V1, ADD_COLUMN]);
    expect(reopen(newer.dir, [V1]).reset).toEqual([
      expect.stringContaining("newer than this build"),
    ]);

    using corrupt = dataDir();
    writeFileSync(corrupt.file, "not a database, and long enough to be read");
    expect(reopen(corrupt.dir, [V1])).toMatchObject({ rows: [] });

    using failing = dataDir();
    seed(failing.dir);
    const broken = { version: 2, sql: "ALTER TABLE missing ADD COLUMN x" };
    expect(() =>
      openCacheDatabase({
        dataDir: failing.dir,
        steps: [V1, broken],
        onReset: () => {},
      }),
    ).toThrow(/Cannot rebuild/);
  });

  it("never deletes a file another connection has locked", () => {
    using data = dataDir();
    seed(data.dir);
    const holder = loadSqliteDriver()!.open(data.file);
    holder.exec("BEGIN EXCLUSIVE");
    try {
      const onReset = vi.fn();
      expect(() =>
        openCacheDatabase({ dataDir: data.dir, steps: [V1], onReset }),
      ).toThrow(/locked/);
      expect(onReset).not.toHaveBeenCalled();
      expect(existsSync(data.file)).toBe(true);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(reopen(data.dir, [V1]).rows).toEqual([{ id: "kept" }]);
  });

  it("removes the Claude transcript tables from the discovery database", () => {
    using data = dataDir();
    const database = loadSqliteDriver()!.open(join(data.dir, "d.sqlite"));
    try {
      migrateDiscoveryDatabase(database, discoveryMigrationPrefix(37));
      database.exec(
        "INSERT INTO claude_transcript_tasks(generation,state) VALUES ('g','{}')",
      );
      migrateDiscoveryDatabase(database);
      const select = database.prepare(
        "SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'claude_transcript_%'",
      );
      expect(select.get<{ n: number }>()).toEqual({ n: 0 });
      select.finalize();
    } finally {
      database.close();
    }
  });
});
