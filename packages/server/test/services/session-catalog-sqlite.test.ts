import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CATALOG_TITLE_PREFIX_LENGTH,
  SessionCatalogSqliteStore,
} from "../../src/services/session-catalog-sqlite.js";
import type { SessionCatalogRow } from "../../src/sessions/catalog-types.js";
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
      tombstonesPurged: 0,
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
  it("drops a tombstone's text and purges tombstones at the horizon", () => {
    const long = `${"z".repeat(CATALOG_TITLE_PREFIX_LENGTH)}tail`;
    store.writeGeneration(
      state(1),
      [row("a", { title: long }), row("b", { title: long }), row("c")],
      [],
    );
    const texts = () =>
      database.prepare("SELECT count(*) AS n FROM session_catalog_text").get();
    expect(texts()).toEqual({ n: 2 });
    store.writeGeneration(state(2), [row("b", { title: long }), row("c")], []);
    expect(texts()).toEqual({ n: 1 });
    const removed = store.applyChanges(
      state(3),
      2,
      [{ type: "delete", key: row("b") }],
      [],
    );
    expect(removed.rowsTombstoned).toBe(1);
    expect(texts()).toEqual({ n: 0 });
    store.applyChanges(state(4), 3, [{ type: "delete", key: row("c") }], []);
    // Tombstones at or below the horizon go; a later one stays.
    const purged = store.applyChanges(state(5), 4, [], [], 3);
    expect(purged.tombstonesPurged).toBe(2);
    expect(store.readState()?.tombstoneHorizon).toBe(3);
    expect(changedGen("a")).toBeUndefined();
    expect(changedGen("b")).toBeUndefined();
    expect(changedGen("c")).toEqual({ changed_gen: 4, deleted: 1 });
    // A horizon never moves back.
    store.applyChanges(state(6), 5, [], [], 2);
    expect(store.readState()?.tombstoneHorizon).toBe(3);
  });
});
