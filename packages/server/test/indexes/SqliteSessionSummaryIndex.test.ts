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
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";

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
