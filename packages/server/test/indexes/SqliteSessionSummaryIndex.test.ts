import {
  mkdtemp,
  mkdir,
  rm,
  stat,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { toUrlProjectId } from "@yep-anywhere/shared";
import {
  SessionIndexService,
  type SessionIndexState,
} from "../../src/indexes/SessionIndexService.js";
import { SqliteSessionSummaryIndex } from "../../src/indexes/SqliteSessionSummaryIndex.js";
import { SessionReader } from "../../src/sessions/reader.js";
import {
  DISCOVERY_MIGRATIONS,
  DiscoverySqliteService,
  migrateDiscoveryDatabase,
} from "../../src/storage/discovery-sqlite.js";
import { loadSqliteDriver } from "../../src/storage/sqlite.js";
import { storedRows } from "../storage/sqlite-rows.js";

it("reads a dirty append's durable facts after database reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ya-summary-sql-"));
  const dataDir = join(dir, "indexes");
  const sessionDir = join(dir, "projects", "project");
  const projectId = toUrlProjectId("/project");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(dataDir);
  const file = join(sessionDir, "session.jsonl");
  await writeFile(
    file,
    `${JSON.stringify({ type: "user", uuid: "first", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Original title" } })}\n`,
  );
  const stats = await stat(file);
  const persisted: SessionIndexState = {
    version: 5,
    projectId,
    sessions: {
      session: {
        title: "Original title",
        fullTitle: "Original title",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: stats.mtime.toISOString(),
        messageCount: 1,
        indexedBytes: stats.size,
        fileMtime: stats.mtimeMs,
        provider: "claude",
      },
    },
  };
  let database = new DiscoverySqliteService({ dataDir: dir });
  new SqliteSessionSummaryIndex(database.getDatabase()).save(
    sessionDir,
    persisted,
  );
  let service = new SessionIndexService({
    dataDir,
    projectsDir: join(dir, "projects"),
    database: database.getDatabase(),
  });
  const reader = new SessionReader({ sessionDir });
  const parse = vi.spyOn(reader, "getSessionSummary");
  try {
    expect(
      (
        await service.getCachedSessionSummary(
          sessionDir,
          projectId,
          "session",
          reader,
        )
      )?.title,
    ).toBe("Original title");
    service.dispose();
    database.close();
    database = new DiscoverySqliteService({ dataDir: dir });
    service = new SessionIndexService({
      dataDir,
      projectsDir: join(dir, "projects"),
      database: database.getDatabase(),
    });
    await appendFile(
      file,
      `${JSON.stringify({ type: "assistant", uuid: "next", message: { role: "assistant", content: [] } })}\n`,
    );
    service.invalidateSession(sessionDir, "session");
    expect(
      await service.getCachedSessionSummary(
        sessionDir,
        projectId,
        "session",
        reader,
      ),
    ).toBeNull();
    const hint = await service.getCachedSessionSummary(
      sessionDir,
      projectId,
      "session",
      reader,
      { acceptAppendedFile: true },
    );
    expect(hint).toMatchObject({ title: "Original title", messageCount: 1 });
    expect(parse).not.toHaveBeenCalled();
    // A rewrite cannot reuse the indexed prefix, even for tail reads.
    await writeFile(file, "short\n");
    expect(
      await service.getCachedSessionSummary(
        sessionDir,
        projectId,
        "session",
        reader,
        { acceptAppendedFile: true },
      ),
    ).toBeNull();
  } finally {
    service.dispose();
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("isolates native scopes and atomically preserves previous summaries when a publication fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ya-summary-atomic-"));
  const database = new DiscoverySqliteService({ dataDir: dir });
  const db = database.getDatabase();
  const store = new SqliteSessionSummaryIndex(db);
  const summary = {
    title: "before",
    fullTitle: "before",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    indexedBytes: 100,
    fileMtime: 1,
    provider: "codex" as const,
  };
  const index: SessionIndexState = {
    version: 5,
    projectId: "project",
    sessions: { same: summary },
  };
  try {
    store.save("root-a", index);
    store.save("root-b", {
      ...index,
      sessions: { same: { ...summary, title: "other root" } },
    });
    db.exec(
      "CREATE TRIGGER reject_summary BEFORE INSERT ON session_summary_index WHEN NEW.session_id = 'reject' BEGIN SELECT RAISE(ABORT, 'interrupted publication'); END",
    );
    expect(() =>
      store.save("root-a", {
        ...index,
        sessions: { same: { ...summary, title: "after" }, reject: summary },
      }),
    ).toThrow("interrupted publication");
    expect(store.get("root-a", "project", "same", 5)?.title).toBe("before");
    expect(store.get("root-b", "project", "same", 5)?.title).toBe("other root");
    expect(store.get("root-a", "project", "reject", 5)).toBeNull();
    expect(() =>
      store.save("new-root", { ...index, sessions: { reject: summary } }),
    ).toThrow("interrupted publication");
    expect(store.read("new-root")).toBeUndefined();
    store.save("empty", { ...index, sessions: {} });
    expect(store.read("empty")?.sessions).toEqual({});
  } finally {
    store.dispose();
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const longTitle = `${'é😀 \\ "quoted" '.repeat(3000)}end`;
function summaryOf(fullTitle: string | null, extra: object = {}) {
  return {
    title: fullTitle === null ? null : fullTitle.slice(0, 120),
    fullTitle,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    messageCount: 3,
    contextUsage: { inputTokens: 1234, percentage: 0.6170000000000001 },
    indexedBytes: 4096,
    fileMtime: 1731111111111.1235,
    provider: "codex" as const,
    ...extra,
  };
}

it("moves full titles into their own column and reads every summary back as written", () => {
  const db = loadSqliteDriver()!.open(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    migrateDiscoveryDatabase(db, DISCOVERY_MIGRATIONS.slice(0, 29));
    const written = {
      long: JSON.stringify(summaryOf(longTitle, { model: "gpt-5" })),
      short: JSON.stringify(summaryOf("say ok")),
      untitled: JSON.stringify(summaryOf(null)),
      empty: JSON.stringify({ ...summaryOf(""), isEmpty: true }),
      // A text column would replace the lone surrogate, and node:sqlite
      // cuts text at a NUL; both titles stay in the JSON.
      lone: JSON.stringify(summaryOf("cut \ud83d")),
      nul: JSON.stringify(summaryOf("before\u0000after")),
    };
    db.exec(
      "INSERT INTO session_summary_scopes VALUES ('scope-a','project',5), ('scope-b','project',5)",
    );
    const insert = db.prepare(
      "INSERT INTO session_summary_index (scope, session_id, summary) VALUES (?, ?, ?)",
    );
    for (const [id, text] of Object.entries(written))
      insert.run("scope-a", id, text);
    // Rows that are not JSON objects are dropped, and so is a row whose
    // scope is gone, which would otherwise fail the rebuild's foreign key.
    insert.run("scope-b", "broken", "not json{");
    insert.run("scope-b", "list", "[]");
    insert.run("scope-b", "kept", written.short);
    db.exec("PRAGMA foreign_keys=OFF");
    insert.run("scope-gone", "orphan", written.short);
    db.exec("PRAGMA foreign_keys=ON");
    insert.finalize();

    migrateDiscoveryDatabase(db);

    expect(
      storedRows(
        db,
        "SELECT session_id, full_title, instr(summary, 'fullTitle') AS embedded FROM session_summary_index WHERE scope = 'scope-a' ORDER BY session_id",
      ),
    ).toEqual([
      { session_id: "empty", full_title: "", embedded: 0 },
      { session_id: "lone", full_title: null, embedded: 24 },
      { session_id: "long", full_title: longTitle, embedded: 0 },
      { session_id: "nul", full_title: null, embedded: 31 },
      { session_id: "short", full_title: "say ok", embedded: 0 },
      { session_id: "untitled", full_title: null, embedded: 0 },
    ]);
    const store = new SqliteSessionSummaryIndex(db);
    try {
      const sessions = store.read("scope-a")?.sessions ?? {};
      for (const [id, text] of Object.entries(written))
        expect(JSON.stringify(sessions[id])).toBe(text);
      expect(Object.keys(store.read("scope-b")?.sessions ?? {})).toEqual([
        "kept",
      ]);
      expect(
        storedRows(
          db,
          "SELECT count(*) AS n FROM session_summary_index WHERE scope = 'scope-gone'",
        )[0]?.n,
      ).toBe(0);
      expect(store.get("scope-a", "project", "long", 5)?.fullTitle).toBe(
        longTitle,
      );
    } finally {
      store.dispose();
    }
  } finally {
    db.close();
  }
});

it("rewrites a summary only when its fields or its full title change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ya-summary-title-"));
  const database = new DiscoverySqliteService({ dataDir: dir });
  const db = database.getDatabase();
  const store = new SqliteSessionSummaryIndex(db);
  const index = (fullTitle: string | null): SessionIndexState => ({
    version: 5,
    projectId: "project",
    sessions: { one: summaryOf(fullTitle), two: summaryOf("two") },
  });
  const changes = () =>
    Number(storedRows(db, "SELECT total_changes() AS n")[0]?.n);
  try {
    store.save("scope", index(longTitle));
    let before = changes();
    store.save("scope", index(longTitle));
    expect(changes()).toBe(before);
    // Same 120-character title and other fields; only the full title moves.
    store.save("scope", index(`${longTitle}!`));
    expect(changes()).toBe(before + 1);
    expect(store.get("scope", "project", "one", 5)?.fullTitle).toBe(
      `${longTitle}!`,
    );
    before = changes();
    store.save("scope", index(null));
    expect(changes()).toBe(before + 1);
    expect(store.get("scope", "project", "one", 5)?.fullTitle).toBeNull();
    for (const title of ["cut \udc00", "before\u0000after"]) {
      store.save("scope", index(title));
      expect(store.get("scope", "project", "one", 5)?.fullTitle).toBe(title);
    }
    store.saveSummary("scope", index("one"), "one");
    expect(store.read("scope")?.sessions.one).toEqual(summaryOf("one"));
  } finally {
    store.dispose();
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not rewrite a scope it loads back unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ya-summary-load-"));
  const sessionDir = join(dir, "projects", "project");
  const projectId = toUrlProjectId("/project");
  await mkdir(sessionDir, { recursive: true });
  const file = join(sessionDir, "session.jsonl");
  await writeFile(
    file,
    `${JSON.stringify({ type: "user", uuid: "first", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Stored title" } })}\n`,
  );
  const stats = await stat(file);
  const state = (version: number) =>
    ({
      version,
      projectId,
      sessions: {
        session: {
          ...summaryOf("Stored title", { provider: "claude" }),
          indexedBytes: stats.size,
          fileMtime: stats.mtimeMs,
          updatedAt: stats.mtime.toISOString(),
        },
      },
    }) as SessionIndexState;
  const database = new DiscoverySqliteService({ dataDir: dir });
  const save = vi.spyOn(SqliteSessionSummaryIndex.prototype, "save");
  const open = () =>
    new SessionIndexService({
      dataDir: join(dir, "indexes"),
      projectsDir: join(dir, "projects"),
      database: database.getDatabase(),
    });
  const reader = new SessionReader({ sessionDir });
  try {
    new SqliteSessionSummaryIndex(database.getDatabase()).save(
      sessionDir,
      state(5),
    );
    save.mockClear();
    let service = open();
    expect(
      (await service.getSessionsWithCache(sessionDir, projectId, reader))[0]
        ?.title,
    ).toBe("Stored title");
    expect(save).not.toHaveBeenCalled();
    service.dispose();
    // An older compatible version is stored again under the current one.
    new SqliteSessionSummaryIndex(database.getDatabase()).save(
      sessionDir,
      state(3),
    );
    save.mockClear();
    service = open();
    await service.getSessionsWithCache(sessionDir, projectId, reader);
    expect(save).toHaveBeenCalledTimes(1);
    service.dispose();
  } finally {
    save.mockRestore();
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
