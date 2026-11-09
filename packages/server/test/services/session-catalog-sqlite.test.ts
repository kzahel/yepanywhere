import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionCatalogService } from "../../src/services/SessionCatalogService.js";
import { projectBucket } from "../../src/services/session-catalog-shards.js";
import {
  CATALOG_TITLE_PREFIX_LENGTH,
  SessionCatalogSqliteStore,
} from "../../src/services/session-catalog-sqlite.js";
import type {
  NativeSessionCatalogAdapter,
  SessionCatalogRow,
} from "../../src/sessions/catalog-types.js";
import type { SqliteDatabase } from "../../src/storage/sqlite.js";
import {
  closeTestDiscoveryDatabases,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";

function row(
  sessionId: string,
  extra: Partial<SessionCatalogRow> = {},
): SessionCatalogRow {
  return {
    catalogFamily: "codex",
    storeKey: "/store",
    sessionId,
    projectId: "id-alpha" as UrlProjectId,
    projectPath: "/projects/alpha",
    projectIdentityKey: "/projects/alpha",
    updatedAt: "2026-11-01T00:00:00.000Z",
    fidelity: "head",
    sourceVersion: `${sessionId}@1`,
    location: { kind: "file", path: `/store/${sessionId}.jsonl` },
    ...extra,
  };
}

/** Every optional shape a row can take, in the normalized property order. */
const VARIED_ROWS: SessionCatalogRow[] = [
  row("bare"),
  row("full", {
    nativeStorageScope: "/store",
    nativeDirectoryProjectId: "id-dir" as UrlProjectId,
    createdAt: "2026-10-01T00:00:00.000Z",
    lastHumanTurnAt: "2026-10-31T00:00:00.000Z",
    title: "short title",
    provider: "codex",
    projectName: "alpha",
    asyncQuestions: [] as unknown as SessionCatalogRow["asyncQuestions"],
    rowFormat: 3,
  }),
  row("null-title", { title: null }),
  row("empty-title", { title: "" }),
  row("long-title", {
    title: `${"x".repeat(CATALOG_TITLE_PREFIX_LENGTH)}tail`,
  }),
  row("database", {
    location: { kind: "database", path: "/db.sqlite", recordId: "r1" },
  }),
  row("provider", { location: { kind: "provider", recordId: "p1" } }),
];

function byId(rows: readonly SessionCatalogRow[]) {
  return [...rows].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

describe("SessionCatalogSqliteStore", () => {
  let dataDir: string;
  let database: SqliteDatabase;
  let store: SessionCatalogSqliteStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ya-catalog-sqlite-"));
    database = openTestDiscoveryDatabase(dataDir);
    store = new SessionCatalogSqliteStore(database);
  });
  afterEach(async () => {
    closeTestDiscoveryDatabases();
    await rm(dataDir, { recursive: true, force: true });
  });

  const state = (generation: number, epoch = "epoch-a") => ({
    epoch,
    generation,
    completedAt: "2026-11-09T00:00:00.000Z",
  });
  const changedGen = (sessionId: string) =>
    database
      .prepare(
        "SELECT changed_gen, deleted FROM session_catalog WHERE native_id = ?",
      )
      .get<{ changed_gen: number; deleted: number }>(sessionId);

  it("reads back every row shape exactly and keeps long titles out of the row", () => {
    store.writeGeneration(state(5), VARIED_ROWS, [
      { catalogFamily: "codex", storeKey: "/store" },
    ]);
    expect(byId(store.readRows())).toEqual(byId(VARIED_ROWS));
    expect(store.readSources()).toEqual([
      { catalogFamily: "codex", storeKey: "/store" },
    ]);
    expect(store.readState()).toEqual({
      epoch: "epoch-a",
      generation: 5,
      tombstoneHorizon: 5,
      completedAt: "2026-11-09T00:00:00.000Z",
    });
    const texts = database
      .prepare(
        "SELECT c.native_id, length(c.title) AS prefix FROM session_catalog_text t JOIN session_catalog c ON c.id = t.catalog_id",
      )
      .all();
    expect(texts).toEqual([
      { native_id: "long-title", prefix: CATALOG_TITLE_PREFIX_LENGTH },
    ]);
  });

  it("writes only changed rows and keeps removed rows as tombstones", () => {
    const rows = [row("a"), row("b"), row("c")];
    store.writeGeneration(state(1), rows, []);
    const result = store.writeGeneration(
      state(2),
      [row("a"), row("b", { title: "renamed" })],
      [],
    );
    expect(result).toEqual({
      rowsWritten: 1,
      rowsTombstoned: 1,
      lineageReplaced: false,
    });
    expect(changedGen("a")).toEqual({ changed_gen: 1, deleted: 0 });
    expect(changedGen("b")).toEqual({ changed_gen: 2, deleted: 0 });
    expect(changedGen("c")).toEqual({ changed_gen: 2, deleted: 1 });
    expect(store.readRows().map((entry) => entry.sessionId)).toEqual([
      "a",
      "b",
    ]);

    // An unchanged generation writes nothing; a returning row is live again.
    expect(
      store.writeGeneration(
        state(3),
        [row("a"), row("b", { title: "renamed" })],
        [],
      ).rowsWritten,
    ).toBe(0);
    store.writeGeneration(state(4), [row("a"), row("c")], []);
    expect(changedGen("c")).toEqual({ changed_gen: 4, deleted: 0 });
    expect(store.readState()?.tombstoneHorizon).toBe(1);
  });

  it("hashes a title as SQLite stores it, so a rewrite is a no-op", () => {
    const cut = [row("cut", { title: "ab\ud83d" })];
    store.writeGeneration(state(1), cut, []);
    expect(store.readRows()[0]?.title).toBe("ab\ufffd");
    expect(store.writeGeneration(state(2), cut, []).rowsWritten).toBe(0);
  });

  it("never cuts the stored title prefix inside a surrogate pair", () => {
    const title = `${"x".repeat(CATALOG_TITLE_PREFIX_LENGTH - 1)}\u{1F600}tail`;
    store.writeGeneration(state(1), [row("emoji", { title })], []);
    const prefix = database
      .prepare("SELECT title FROM session_catalog WHERE native_id = 'emoji'")
      .get<{ title: string }>()!.title;
    expect(prefix).toBe("x".repeat(CATALOG_TITLE_PREFIX_LENGTH - 1));
    expect(store.readRows()[0]?.title).toBe(title);
  });

  it("drops a long title's text when the title shrinks", () => {
    const long = `${"y".repeat(CATALOG_TITLE_PREFIX_LENGTH)}more`;
    store.writeGeneration(state(1), [row("a", { title: long })], []);
    store.writeGeneration(state(2), [row("a", { title: "short" })], []);
    expect(store.readRows()[0]?.title).toBe("short");
    expect(
      database.prepare("SELECT count(*) AS n FROM session_catalog_text").get(),
    ).toEqual({ n: 0 });
  });

  it("starts over for another epoch or an older generation", () => {
    store.writeGeneration(state(7), [row("a"), row("b")], []);
    store.writeGeneration(state(8), [row("a")], []);
    const replaced = store.writeGeneration(state(0, "epoch-b"), [row("z")], []);
    expect(replaced.lineageReplaced).toBe(true);
    // No tombstone from the old lineage survives.
    expect(
      database.prepare("SELECT native_id FROM session_catalog").all(),
    ).toEqual([{ native_id: "z" }]);
    expect(
      store.writeGeneration(state(0, "epoch-b"), [row("z")], [])
        .lineageReplaced,
    ).toBe(false);
  });

  it("diffs store coverage instead of rewriting it", () => {
    const codex = { catalogFamily: "codex" as const, storeKey: "/store" };
    const claude = { catalogFamily: "claude" as const, storeKey: "/claude" };
    store.writeGeneration(state(1), [], [codex, claude]);
    store.writeGeneration(state(2), [], [claude]);
    expect(store.readSources()).toEqual([claude]);
  });
});

describe("SessionCatalogService copy into SQLite", () => {
  let dataDir: string;
  const services: SessionCatalogService[] = [];

  function service(database?: SqliteDatabase) {
    const created = new SessionCatalogService({
      dataDir,
      ...(database ? { database } : {}),
      createEpoch: () => "epoch-files",
    });
    services.push(created);
    return created;
  }

  function adapter(rows: SessionCatalogRow[]): NativeSessionCatalogAdapter {
    return {
      catalogFamily: "codex",
      storeKey: "/store",
      scan: async () => ({ sourceVersion: "v", rows }),
    };
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ya-catalog-copy-"));
    // Read back after every write, as the second-server gate does.
    process.env.YEP_CATALOG_SQLITE_COMPARE_MS = "0";
  });
  afterEach(async () => {
    delete process.env.YEP_CATALOG_SQLITE_COMPARE_MS;
    for (const created of services.splice(0)) created.stop();
    closeTestDiscoveryDatabases();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("copies the published generation with its epoch and generation", async () => {
    const files = service();
    await files.initialize();
    await files.reconcile([adapter(VARIED_ROWS)]);
    await files.reconcile([adapter(VARIED_ROWS)]);

    const database = openTestDiscoveryDatabase(dataDir);
    const restarted = service(database);
    const snapshot = await restarted.initialize();
    const store = new SessionCatalogSqliteStore(database);
    expect(store.readState()).toMatchObject({
      epoch: "epoch-files",
      generation: 2,
    });
    expect(snapshot.catalogGeneration).toBe(2);
    expect(byId(store.readRows())).toEqual(
      byId((await restarted.readRows()).rows as SessionCatalogRow[]),
    );
    expect(store.readSources()).toEqual([
      { catalogFamily: "codex", storeKey: "/store" },
    ]);
    expect(restarted.getMetrics().sqlite).toMatchObject({
      sqliteMismatches: 0,
      lastSqliteWrite: {
        kind: "copy",
        rowsWritten: VARIED_ROWS.length,
        lineageReplaced: true,
      },
    });

    // A start that finds the same generation writes nothing.
    const again = service(openTestDiscoveryDatabase(dataDir));
    await again.initialize();
    expect(again.getMetrics().sqlite?.lastSqliteWrite).toBeNull();

    // A later start after more file-only publications writes only the change.
    const changed = VARIED_ROWS.map((entry) =>
      entry.sessionId === "bare" ? { ...entry, title: "now titled" } : entry,
    );
    await files.reconcile([adapter(changed)]);
    const later = service(openTestDiscoveryDatabase(dataDir));
    await later.initialize();
    expect(later.getMetrics().sqlite?.lastSqliteWrite).toMatchObject({
      kind: "copy",
      rowsWritten: 1,
      rowsTombstoned: 0,
      lineageReplaced: false,
    });
    expect(store.readState()?.generation).toBe(3);
  });

  it("stores a title cut inside a surrogate pair as SQLite returns it", async () => {
    const files = service();
    await files.initialize();
    await files.reconcile([adapter([row("cut", { title: "ab\ud83d" })])]);
    const database = openTestDiscoveryDatabase(dataDir);
    const restarted = service(database);
    await restarted.initialize();
    const published = (await restarted.readRows()).rows;
    expect(published[0]?.title).toBe("ab\ufffd");
    expect(new SessionCatalogSqliteStore(database).readRows()).toEqual(
      published,
    );
  });

  it("writes each publication's changes and finds the tables matching", async () => {
    const database = openTestDiscoveryDatabase(dataDir);
    const catalog = service(database);
    await catalog.initialize();
    await catalog.reconcile([adapter([row("a"), row("b"), row("c")])]);
    // Startup copied the empty generation 0, so the first publication is
    // written as changes too.
    expect(catalog.getMetrics().sqlite?.lastSqliteWrite).toMatchObject({
      kind: "changes",
      generation: 1,
      rowsWritten: 3,
    });
    await catalog.reconcile([
      adapter([row("a"), row("b", { title: "renamed" })]),
    ]);
    expect(catalog.getMetrics().sqlite).toMatchObject({
      sqliteWrites: 3,
      sqliteWriteFailures: 0,
      sqliteMismatches: 0,
      lastSqliteWrite: {
        kind: "changes",
        generation: 2,
        rowsWritten: 1,
        rowsTombstoned: 1,
      },
    });
    const store = new SessionCatalogSqliteStore(database);
    expect(store.readState()).toMatchObject({ generation: 2 });
    expect(byId(store.readRows())).toEqual(
      byId((await catalog.readRows()).rows as SessionCatalogRow[]),
    );
    store.dispose();
  });

  it("counts a mismatch the changes alone do not repair, then repairs it", async () => {
    const database = openTestDiscoveryDatabase(dataDir);
    const catalog = service(database);
    await catalog.initialize();
    await catalog.reconcile([adapter([row("a"), row("b")])]);
    // Same hash, different stored title: only a read-back can see it.
    database.exec(
      "UPDATE session_catalog SET title = 'tampered' WHERE native_id = 'a'",
    );
    await catalog.reconcile([adapter([row("a"), row("b", { title: "new" })])]);
    expect(catalog.getMetrics().sqlite).toMatchObject({
      sqliteMismatches: 1,
      sqliteRepairs: 1,
      lastSqliteMismatch: { differing: 1, missing: 0, extra: 0, generation: 2 },
    });
    const store = new SessionCatalogSqliteStore(database);
    expect(byId(store.readRows())).toEqual(
      byId((await catalog.readRows()).rows as SessionCatalogRow[]),
    );
    store.dispose();
    await catalog.reconcile([
      adapter([row("a"), row("b", { title: "newer" })]),
    ]);
    expect(catalog.getMetrics().sqlite?.sqliteMismatches).toBe(1);
  });

  it("keeps a session that moves to a lower bucket", async () => {
    // Two projects whose buckets put the move's delete after its upsert.
    const keys = Array.from(
      { length: 64 },
      (_, index) => `/projects/p${index}`,
    );
    const from = keys.find((key) => projectBucket(key, 64) > 40)!;
    const to = keys.find((key) => projectBucket(key, 64) < 10)!;
    const at = (key: string) => ({
      projectIdentityKey: key,
      projectPath: key,
    });
    process.env.YEP_CATALOG_SQLITE_COMPARE_MS = "600000";
    const database = openTestDiscoveryDatabase(dataDir);
    const catalog = service(database);
    await catalog.initialize();
    await catalog.reconcile([adapter([row("x", at(from)), row("y")])]);
    await catalog.reconcile([adapter([row("x", at(to)), row("y")])]);
    expect(catalog.getMetrics().sqlite).toMatchObject({
      sqliteMismatches: 0,
      lastSqliteWrite: { kind: "changes", rowsWritten: 1, rowsTombstoned: 0 },
    });
    const store = new SessionCatalogSqliteStore(database);
    expect(store.readRows().find((entry) => entry.sessionId === "x")).toEqual(
      row("x", at(to)),
    );
    store.dispose();
  });

  it("reads back at once when a change write's own check fails", async () => {
    process.env.YEP_CATALOG_SQLITE_COMPARE_MS = "600000";
    const database = openTestDiscoveryDatabase(dataDir);
    const catalog = service(database);
    await catalog.initialize();
    await catalog.reconcile([adapter([row("a"), row("b")])]);
    database.exec("DELETE FROM session_catalog WHERE native_id = 'a'");
    await catalog.reconcile([adapter([row("a"), row("b", { title: "new" })])]);
    expect(catalog.getMetrics().sqlite).toMatchObject({
      sqliteMismatches: 1,
      sqliteRepairs: 1,
      lastSqliteMismatch: { missing: 1 },
    });
  });

  it("recovers through a whole-generation diff after a failed write", async () => {
    const database = openTestDiscoveryDatabase(dataDir);
    const catalog = service(database);
    await catalog.initialize();
    await catalog.reconcile([adapter([row("a"), row("b")])]);
    // A failing trigger rejects the next write and leaves SQLite behind.
    database.exec(
      "CREATE TRIGGER fail_once BEFORE UPDATE ON catalog_state BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    await catalog.reconcile([adapter([row("a", { title: "t" }), row("b")])]);
    expect(catalog.getMetrics().sqlite?.sqliteWriteFailures).toBe(1);
    database.exec("DROP TRIGGER fail_once");
    await catalog.reconcile([adapter([row("a", { title: "t" })])]);
    expect(catalog.getMetrics().sqlite).toMatchObject({
      sqliteMismatches: 0,
      lastSqliteWrite: {
        kind: "generation",
        generation: 3,
        rowsWritten: 1,
        rowsTombstoned: 1,
      },
    });
  });

  it("reads change writes back at most once per interval by default", async () => {
    delete process.env.YEP_CATALOG_SQLITE_COMPARE_MS;
    const database = openTestDiscoveryDatabase(dataDir);
    const catalog = service(database);
    await catalog.initialize();
    for (const title of ["one", "two", "three"]) {
      await catalog.reconcile([adapter([row("a", { title })])]);
    }
    // Only the startup copy was read back; the changes waited.
    expect(catalog.getMetrics().sqlite).toMatchObject({
      sqliteWrites: 4,
      sqliteComparisons: 1,
      lastSqliteWrite: { kind: "changes", compareMs: null },
    });
  });

  it("diffs the whole generation when the delta is incomplete", async () => {
    const database = openTestDiscoveryDatabase(dataDir);
    const catalog = new SessionCatalogService({
      dataDir,
      database,
      createEpoch: () => "epoch-files",
      maxDeltaBytes: 1,
    });
    services.push(catalog);
    await catalog.initialize();
    await catalog.reconcile([adapter([row("a"), row("b")])]);
    await catalog.reconcile([adapter([row("a", { title: "t" }), row("b")])]);
    expect(catalog.getMetrics().sqlite).toMatchObject({
      sqliteMismatches: 0,
      lastSqliteWrite: { kind: "generation", rowsWritten: 1 },
    });
  });

  it("ends the lineage when the tables are ahead of the files", async () => {
    const files = service();
    await files.initialize();
    await files.reconcile([adapter([row("a")])]);
    const database = openTestDiscoveryDatabase(dataDir);
    const store = new SessionCatalogSqliteStore(database);
    store.writeGeneration(
      {
        epoch: "epoch-files",
        generation: 5,
        completedAt: "2026-11-09T00:00:00.000Z",
      },
      [row("a"), row("ahead")],
      [],
    );
    let epochs = 0;
    const restarted = new SessionCatalogService({
      dataDir,
      database,
      createEpoch: () => `epoch-new-${++epochs}`,
    });
    services.push(restarted);
    const snapshot = await restarted.initialize();
    expect(snapshot).toMatchObject({
      catalogEpoch: "epoch-new-1",
      catalogGeneration: 0,
    });
    expect(restarted.getMetrics().resetFailures).toBe(1);
    expect(store.readState()).toMatchObject({
      epoch: "epoch-new-1",
      generation: 0,
    });
    expect(store.readRows()).toEqual([]);
    store.dispose();
  });

  it("starts serving from the files when the copy fails", async () => {
    const files = service();
    await files.initialize();
    await files.reconcile([adapter([row("a")])]);
    const database = openTestDiscoveryDatabase(dataDir);
    const restarted = service(database);
    database.exec("DROP TABLE catalog_state");
    await restarted.initialize();
    expect(restarted.getMetrics().sqlite?.sqliteWriteFailures).toBe(1);
    expect((await restarted.readRows()).rows).toHaveLength(1);
  });
});
