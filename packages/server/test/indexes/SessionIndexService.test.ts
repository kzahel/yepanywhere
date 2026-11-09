import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { toUrlProjectId, type UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionIndexService,
  type SessionIndexState,
} from "../../src/indexes/SessionIndexService.js";
import { SqliteSessionSummaryIndex } from "../../src/indexes/SqliteSessionSummaryIndex.js";
import { getLogger } from "../../src/logging/logger.js";
import { GrokSessionReader } from "../../src/sessions/grok-reader.js";
import { SessionReader } from "../../src/sessions/reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { SessionSummary } from "../../src/supervisor/types.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import {
  closeTestDiscoveryDatabases,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";

describe("SessionIndexService", () => {
  let testDir: string;
  let dataDir: string;
  let projectsDir: string;
  let sessionDir: string;
  let service: SessionIndexService;
  let reader: SessionReader;
  let projectId: UrlProjectId;

  beforeEach(async () => {
    testDir = join(tmpdir(), `claude-index-test-${randomUUID()}`);
    dataDir = join(testDir, "indexes");
    projectsDir = join(testDir, "projects");
    sessionDir = join(projectsDir, "test-project");

    await mkdir(dataDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    service = new SessionIndexService({
      database: openTestDiscoveryDatabase(testDir),
      dataDir,
      projectsDir,
    });
    await service.initialize();

    reader = new SessionReader({ sessionDir });
    projectId = toUrlProjectId("/test/project");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeTestDiscoveryDatabases();
    await rm(testDir, { recursive: true, force: true });
  });

  /** Use the persisted summary store on its own connection, as another process would. */
  function withSummaryStore<T>(
    use: (store: SqliteSessionSummaryIndex) => T,
  ): T {
    const store = new SqliteSessionSummaryIndex(
      openTestDiscoveryDatabase(testDir),
    );
    try {
      return use(store);
    } finally {
      store.dispose();
    }
  }

  function readPersistedIndex(scope = sessionDir) {
    return withSummaryStore((store) => store.read(scope));
  }

  /** Seed a persisted scope, including versions an older build wrote. */
  function persistIndex(
    index: { version: number; projectId: string; sessions: object },
    scope = sessionDir,
  ): void {
    withSummaryStore((store) =>
      store.save(scope, index as unknown as SessionIndexState),
    );
  }

  async function createSession(
    sessionId: string,
    content: string,
    timestamp = new Date(),
  ): Promise<void> {
    const jsonl = JSON.stringify({
      type: "user",
      message: { content },
      uuid: `msg-${sessionId}`,
      timestamp: timestamp.toISOString(),
    });
    await writeFile(join(sessionDir, `${sessionId}.jsonl`), `${jsonl}\n`);
  }

  async function waitForCondition(
    predicate: () => boolean,
    message: string,
    timeoutMs = 500,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(message);
  }

  describe("initialization", () => {
    it("creates data directory on initialize", async () => {
      const newDataDir = join(testDir, "new-indexes");
      const newService = new SessionIndexService({
        database: openTestDiscoveryDatabase(testDir),
        dataDir: newDataDir,
        projectsDir,
      });

      await newService.initialize();

      const stats = await stat(newDataDir);
      expect(stats.isDirectory()).toBe(true);
    });

    it("removes only legacy JSON summary scopes beside live index state", async () => {
      const indexesDir = join(testDir, "legacy-indexes");
      await mkdir(join(indexesDir, "git-untracked"), { recursive: true });
      const scope = JSON.stringify({ version: 3, projectId, sessions: {} });
      await writeFile(join(indexesDir, "-Users-me-project.json"), scope);
      await writeFile(join(indexesDir, "ext-0123456789abcdef.json"), scope);
      await writeFile(
        join(indexesDir, "ext-0123456789abcdef.json.tmp-1-2-3"),
        "{",
      );
      await mkdir(join(indexesDir, "-Users-me-project.json.lock"));
      // Scope-shaped, but the project scanner owns this name.
      await writeFile(join(indexesDir, "project-scanner-cache.json"), scope);
      await writeFile(join(indexesDir, "git-untracked", "repo.json"), scope);
      await writeFile(
        join(indexesDir, "notes.json"),
        JSON.stringify({ version: 1, notes: [] }),
      );
      const cleaningService = new SessionIndexService({
        database: openTestDiscoveryDatabase(testDir),
        dataDir: indexesDir,
        projectsDir,
      });

      await cleaningService.initialize();
      await (cleaningService as unknown as { legacyCleanup: Promise<void> })
        .legacyCleanup;

      expect((await readdir(indexesDir)).sort()).toEqual([
        "git-untracked",
        "notes.json",
        "project-scanner-cache.json",
      ]);
      expect(await readdir(join(indexesDir, "git-untracked"))).toEqual([
        "repo.json",
      ]);
    });
  });

  describe("cache hit", () => {
    it("returns cached data when mtime/size match", async () => {
      await createSession("session-1", "Hello world");

      // First call - populates cache
      const sessions1 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions1).toHaveLength(1);
      expect(sessions1[0]?.id).toBe("session-1");

      // Second call - should use cache (same mtime/size)
      const sessions2 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions2).toHaveLength(1);
      expect(sessions2[0]?.id).toBe("session-1");
    });

    it("returns a single cached summary when mtime/size match", async () => {
      await createSession("session-1", "Hello world");
      const getSessionSummary = vi.spyOn(reader, "getSessionSummary");

      const first = await service.getSessionSummaryWithCache(
        sessionDir,
        projectId,
        "session-1",
        reader,
      );

      expect(first?.id).toBe("session-1");
      expect(first?.title).toBe("Hello world");
      expect(getSessionSummary).toHaveBeenCalledTimes(1);

      const second = await service.getSessionSummaryWithCache(
        sessionDir,
        projectId,
        "session-1",
        reader,
      );

      expect(second?.id).toBe("session-1");
      expect(second?.title).toBe("Hello world");
      expect(getSessionSummary).toHaveBeenCalledTimes(1);
    });

    it("returns fresh cached summaries without parsing", async () => {
      await createSession("session-1", "Hello world");
      const getSessionSummary = vi.spyOn(reader, "getSessionSummary");

      await service.getSessionSummaryWithCache(
        sessionDir,
        projectId,
        "session-1",
        reader,
      );
      expect(getSessionSummary).toHaveBeenCalledTimes(1);

      const cached = await service.getCachedSessionSummary(
        sessionDir,
        projectId,
        "session-1",
        reader,
      );

      expect(cached?.id).toBe("session-1");
      expect(cached?.title).toBe("Hello world");
      expect(getSessionSummary).toHaveBeenCalledTimes(1);

      await createSession("session-1", "Changed content");

      const changed = await service.getCachedSessionSummary(
        sessionDir,
        projectId,
        "session-1",
        reader,
      );

      expect(changed).toBeNull();
      expect(getSessionSummary).toHaveBeenCalledTimes(1);
    });

    it("returns an indexed prefix summary when the file only grew", async () => {
      await createSession("session-1", "Hello world");
      const getSessionSummary = vi.spyOn(reader, "getSessionSummary");

      await service.getSessionSummaryWithCache(
        sessionDir,
        projectId,
        "session-1",
        reader,
      );
      expect(getSessionSummary).toHaveBeenCalledTimes(1);

      const filePath = join(sessionDir, "session-1.jsonl");
      await appendFile(
        filePath,
        `${JSON.stringify({
          type: "user",
          message: { content: "appended while live" },
          uuid: "msg-session-1-later",
          timestamp: new Date().toISOString(),
        })}\n`,
      );

      // Default: an appended file is not the file that was indexed.
      expect(
        await service.getCachedSessionSummary(
          sessionDir,
          projectId,
          "session-1",
          reader,
        ),
      ).toBeNull();

      // Opted in: the indexed bytes are still an accurate prefix.
      const appended = await service.getCachedSessionSummary(
        sessionDir,
        projectId,
        "session-1",
        reader,
        { acceptAppendedFile: true },
      );
      expect(appended?.id).toBe("session-1");
      expect(appended?.title).toBe("Hello world");
      expect(getSessionSummary).toHaveBeenCalledTimes(1);
    });

    it("rejects an in-place rewrite even when appended files are accepted", async () => {
      await createSession("session-1", "Hello world");

      await service.getSessionSummaryWithCache(
        sessionDir,
        projectId,
        "session-1",
        reader,
      );

      // Same byte length, different bytes: the index describes other content.
      await createSession("session-1", "HELLO WORLD");
      const rewrittenAt = new Date(Date.now() + 1000);
      await utimes(
        join(sessionDir, "session-1.jsonl"),
        rewrittenAt,
        rewrittenAt,
      );

      expect(
        await service.getCachedSessionSummary(
          sessionDir,
          projectId,
          "session-1",
          reader,
          { acceptAppendedFile: true },
        ),
      ).toBeNull();
    });

    it("revalidates persisted empty Claude summaries without a transcript change", async () => {
      const sessionId = "setup-only";
      const filePath = join(sessionDir, `${sessionId}.jsonl`);
      await writeFile(
        filePath,
        JSON.stringify({ type: "mode", mode: "normal", sessionId }),
      );
      const stats = await stat(filePath);
      persistIndex({
        version: 3,
        projectId,
        sessions: {
          [sessionId]: {
            title: null,
            fullTitle: null,
            createdAt: stats.mtime.toISOString(),
            updatedAt: stats.mtime.toISOString(),
            messageCount: 0,
            indexedBytes: stats.size,
            fileMtime: stats.mtimeMs,
            isEmpty: true,
            provider: "claude",
          },
        },
      });
      expect(
        await service.getSessionSummaryWithCache(
          sessionDir,
          projectId,
          sessionId,
          reader,
        ),
      ).toMatchObject({ id: sessionId, messageCount: 0, title: null });
      expect(
        readPersistedIndex()?.sessions[sessionId]?.isEmpty,
      ).toBeUndefined();
    });

    it("keeps an empty Claude summary this version indexed itself", async () => {
      const sessionId = "unreadable";
      await createSession(sessionId, "Cannot be summarized");
      const firstRun = new SessionIndexService({
        database: openTestDiscoveryDatabase(testDir),
        dataDir,
        projectsDir,
        fullValidationIntervalMs: 60000,
      });
      await firstRun.initialize();
      const firstReader = new SessionReader({ sessionDir });
      vi.spyOn(firstReader, "getSessionSummary").mockResolvedValue(null);
      expect(
        await firstRun.getSessionsWithCache(sessionDir, projectId, firstReader),
      ).toEqual([]);
      expect(readPersistedIndex()?.sessions[sessionId]?.isEmpty).toBe(true);

      const secondRun = new SessionIndexService({
        database: openTestDiscoveryDatabase(testDir),
        dataDir,
        projectsDir,
        fullValidationIntervalMs: 60000,
      });
      await secondRun.initialize();
      const secondReader = new SessionReader({ sessionDir });
      const parseSpy = vi
        .spyOn(secondReader, "getSessionSummary")
        .mockResolvedValue(null);

      await secondRun.getSessionsWithCache(sessionDir, projectId, secondReader);

      // The entry the first run wrote means what it says, so loading it again
      // must not delete it and re-parse the transcript.
      expect(parseSpy).not.toHaveBeenCalled();
    });

    it("repairs persisted Claude titles captured from meta rows", async () => {
      const sessionId = "meta-command";
      const filePath = join(sessionDir, `${sessionId}.jsonl`);
      await writeFile(
        filePath,
        `${[
          JSON.stringify({
            type: "user",
            isMeta: true,
            message: {
              content:
                "<local-command-caveat>Caveat: local command messages follow.</local-command-caveat>",
            },
            uuid: "meta-1",
            timestamp: "2026-07-24T17:15:43.435Z",
          }),
          JSON.stringify({
            type: "user",
            message: {
              content:
                "<command-name>/effort</command-name>\n" +
                "<command-message>effort</command-message>\n" +
                "<command-args></command-args>",
            },
            uuid: "command-1",
            parentUuid: "meta-1",
            timestamp: "2026-07-24T17:15:43.435Z",
          }),
        ].join("\n")}\n`,
      );
      const fileStats = await stat(filePath);
      const getSessionSummary = vi.spyOn(reader, "getSessionSummary");
      persistIndex({
        version: 3,
        projectId,
        sessions: {
          [sessionId]: {
            title:
              "<local-command-caveat>Caveat: local command messages follow.</local-command-caveat>",
            fullTitle:
              "<local-command-caveat>Caveat: local command messages follow.</local-command-caveat>",
            createdAt: "2026-07-24T17:15:43.435Z",
            updatedAt: "2026-07-24T17:15:43.435Z",
            messageCount: 2,
            indexedBytes: fileStats.size,
            fileMtime: fileStats.mtimeMs,
            provider: "claude",
          },
        },
      });

      const sessions = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );

      expect(sessions[0]?.title).toBe("/effort");
      expect(getSessionSummary).toHaveBeenCalledTimes(1);
    });
  });

  describe("cache miss", () => {
    it("re-parses file when mtime changes", async () => {
      await createSession("session-1", "Original content");

      // First call
      const sessions1 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions1[0]?.title).toBe("Original content");

      // Wait a bit and modify the file
      await new Promise((resolve) => setTimeout(resolve, 10));

      const newJsonl = JSON.stringify({
        type: "user",
        message: { content: "Updated content" },
        uuid: "msg-updated",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(sessionDir, "session-1.jsonl"), `${newJsonl}\n`);

      // Second call - should detect change and re-parse
      const sessions2 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions2[0]?.title).toBe("Updated content");
    });

    it("re-parses file when size changes", async () => {
      // Create session with proper DAG structure
      const userJsonl = JSON.stringify({
        type: "user",
        message: { content: "Short" },
        uuid: "msg-1",
        parentUuid: null,
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(sessionDir, "session-1.jsonl"), `${userJsonl}\n`);

      // First call
      const sessions1 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions1[0]?.messageCount).toBe(1);

      // Append to file (changes size) - properly linked to parent
      const additionalJsonl = JSON.stringify({
        type: "assistant",
        message: { content: "Response" },
        uuid: "msg-2",
        parentUuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      const filePath = join(sessionDir, "session-1.jsonl");
      const existing = await readFile(filePath, "utf-8");
      await writeFile(filePath, `${existing}${additionalJsonl}\n`);

      // Second call - should detect size change
      const sessions2 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions2[0]?.messageCount).toBe(2);
    });
  });

  describe("new files", () => {
    it("adds new sessions to index", async () => {
      await createSession("session-1", "First session");

      const sessions1 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions1).toHaveLength(1);

      // Add a new session
      await createSession("session-2", "Second session");

      const sessions2 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions2).toHaveLength(2);
      expect(sessions2.map((s) => s.id).sort()).toEqual([
        "session-1",
        "session-2",
      ]);
    });
  });

  describe("deleted files", () => {
    it("removes deleted sessions from cache", async () => {
      await createSession("session-1", "First session");
      await createSession("session-2", "Second session");

      const sessions1 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions1).toHaveLength(2);

      // Delete session-2
      await rm(join(sessionDir, "session-2.jsonl"));

      const sessions2 = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions2).toHaveLength(1);
      expect(sessions2[0]?.id).toBe("session-1");
    });
  });

  describe("corrupt index", () => {
    it("gracefully handles a malformed persisted summary", async () => {
      const warn = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      await createSession("session-1", "Test content");

      persistIndex({
        version: 5,
        projectId,
        sessions: { "session-1": { title: "replaced below" } },
      });
      const corrupt = openTestDiscoveryDatabase(testDir).prepare(
        "UPDATE session_summary_index SET summary = ? WHERE scope = ?",
      );
      corrupt.run("not valid json{{{", sessionDir);
      corrupt.finalize();

      // Should still work - starts fresh
      const sessions = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.title).toBe("Test content");
      expect(warn).toHaveBeenCalledWith(
        { err: expect.any(SyntaxError) },
        `[SessionIndexService] Failed to load index for ${sessionDir}, starting fresh`,
      );
    });

    it("handles index with wrong version", async () => {
      await createSession("session-1", "Test content");

      persistIndex({ version: 999, projectId, sessions: {} });

      // Should start fresh due to version mismatch
      const sessions = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions).toHaveLength(1);
    });

    it("reuses the structurally compatible unshipped version 4 index", async () => {
      await createSession("session-1", "Content that should not be reparsed");
      const fileStats = await stat(join(sessionDir, "session-1.jsonl"));
      const getSessionSummary = vi.spyOn(reader, "getSessionSummary");

      persistIndex({
        version: 4,
        projectId,
        sessions: {
          "session-1": {
            title: "Pre-release cached title",
            fullTitle: "Pre-release cached title",
            createdAt: new Date(fileStats.mtimeMs).toISOString(),
            updatedAt: new Date(fileStats.mtimeMs).toISOString(),
            messageCount: 1,
            indexedBytes: fileStats.size,
            fileMtime: fileStats.mtimeMs,
            provider: "claude",
          },
        },
      });

      const sessions = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );

      expect(sessions[0]?.title).toBe("Pre-release cached title");
      expect(getSessionSummary).not.toHaveBeenCalled();
    });

    it("normalizes legacy cached parent links into fork provenance", async () => {
      await createSession("session-1", "Content that should not be reparsed");
      const fileStats = await stat(join(sessionDir, "session-1.jsonl"));
      const getSessionSummary = vi.spyOn(reader, "getSessionSummary");

      persistIndex({
        version: 3,
        projectId,
        sessions: {
          "session-1": {
            title: "Legacy cached fork",
            fullTitle: "Legacy cached fork",
            createdAt: new Date(fileStats.mtimeMs).toISOString(),
            updatedAt: new Date(fileStats.mtimeMs).toISOString(),
            messageCount: 1,
            indexedBytes: fileStats.size,
            fileMtime: fileStats.mtimeMs,
            provider: "codex",
            parentSessionId: "source-session",
          },
        },
      });

      const sessions = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );

      expect(sessions[0]).toMatchObject({
        forkedFromSessionId: "source-session",
      });
      expect(sessions[0]?.parentSessionId).toBeUndefined();
      expect(getSessionSummary).not.toHaveBeenCalled();
    });
  });

  describe("concurrent operations", () => {
    it("handles multiple concurrent cache updates", async () => {
      // Create multiple sessions
      await Promise.all([
        createSession("session-1", "Content 1"),
        createSession("session-2", "Content 2"),
        createSession("session-3", "Content 3"),
      ]);

      // Make concurrent requests
      const [result1, result2, result3] = await Promise.all([
        service.getSessionsWithCache(sessionDir, projectId, reader),
        service.getSessionsWithCache(sessionDir, projectId, reader),
        service.getSessionsWithCache(sessionDir, projectId, reader),
      ]);

      // All should return same data
      expect(result1.length).toBe(3);
      expect(result2.length).toBe(3);
      expect(result3.length).toBe(3);
      expect(service.getDebugStats().requests).toBe(1);
    });

    it("preserves invalidation that arrives during incremental validation", async () => {
      const revisionService = new SessionIndexService({
        database: openTestDiscoveryDatabase(join(testDir, "revision-indexes")),
        dataDir: join(testDir, "revision-indexes"),
        projectsDir,
        fullValidationIntervalMs: 60000,
      });
      await revisionService.initialize();
      await Promise.all([
        createSession("session-a", "Session A"),
        createSession("session-b", "Session B"),
      ]);
      expect(
        await revisionService.getSessionsWithCache(
          sessionDir,
          projectId,
          reader,
        ),
      ).toHaveLength(2);

      let signalParseStarted: (() => void) | null = null;
      const parseStarted = new Promise<void>((resolve) => {
        signalParseStarted = resolve;
      });
      let releaseParse: (() => void) | null = null;
      const parseGate = new Promise<void>((resolve) => {
        releaseParse = resolve;
      });
      const originalSummary = reader.getSessionSummary.bind(reader);
      vi.spyOn(reader, "getSessionSummary").mockImplementation(
        async (sessionId, currentProjectId, options) => {
          if (sessionId === "session-a") {
            signalParseStarted?.();
            await parseGate;
          }
          return originalSummary(sessionId, currentProjectId, options);
        },
      );

      revisionService.invalidateSession(sessionDir, "session-a");
      const refresh = revisionService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      await parseStarted;
      revisionService.invalidateSession(sessionDir, "session-b");
      releaseParse?.();

      expect((await refresh).map((session) => session.id)).toEqual([
        "session-a",
      ]);
      expect(
        (
          await revisionService.getSessionsWithCache(
            sessionDir,
            projectId,
            reader,
          )
        )
          .map((session) => session.id)
          .sort(),
      ).toEqual(["session-a", "session-b"]);
    });

    it("preserves invalidation that arrives during full validation", async () => {
      const revisionService = new SessionIndexService({
        database: openTestDiscoveryDatabase(
          join(testDir, "full-revision-indexes"),
        ),
        dataDir: join(testDir, "full-revision-indexes"),
        projectsDir,
        fullValidationIntervalMs: 60000,
      });
      await revisionService.initialize();
      await createSession("session-a", "Session A");

      let signalParseStarted: (() => void) | null = null;
      const parseStarted = new Promise<void>((resolve) => {
        signalParseStarted = resolve;
      });
      let releaseParse: (() => void) | null = null;
      const parseGate = new Promise<void>((resolve) => {
        releaseParse = resolve;
      });
      const originalSummary = reader.getSessionSummary.bind(reader);
      vi.spyOn(reader, "getSessionSummary").mockImplementation(
        async (sessionId, currentProjectId, options) => {
          if (sessionId === "session-a") {
            signalParseStarted?.();
            await parseGate;
          }
          return originalSummary(sessionId, currentProjectId, options);
        },
      );

      const initialScan = revisionService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      await parseStarted;
      await createSession("session-b", "Session B");
      revisionService.invalidateSession(sessionDir, "session-b");
      releaseParse?.();

      expect((await initialScan).map((session) => session.id)).toEqual([
        "session-a",
      ]);
      expect(
        (
          await revisionService.getSessionsWithCache(
            sessionDir,
            projectId,
            reader,
          )
        )
          .map((session) => session.id)
          .sort(),
      ).toEqual(["session-a", "session-b"]);
    });

    it("limits concurrent summary parses across validation scopes", async () => {
      const queuedService = new SessionIndexService({
        database: openTestDiscoveryDatabase(join(testDir, "queued-indexes")),
        dataDir: join(testDir, "queued-indexes"),
        projectsDir,
        summaryParseConcurrency: 1,
      });
      await queuedService.initialize();

      const dirA = join(projectsDir, "queued-a");
      const dirB = join(projectsDir, "queued-b");
      await mkdir(dirA, { recursive: true });
      await mkdir(dirB, { recursive: true });
      const fileA = join(dirA, "session-a.jsonl");
      const fileB = join(dirB, "session-b.jsonl");
      await writeFile(fileA, "A\n");
      await writeFile(fileB, "B\n");

      let activeParses = 0;
      let maxActiveParses = 0;
      let parseStarts = 0;
      let releaseFirstParse: (() => void) | null = null;
      const firstParseHeld = new Promise<void>((resolve) => {
        releaseFirstParse = resolve;
      });
      let firstParseStarted: (() => void) | null = null;
      const firstParseStartedPromise = new Promise<void>((resolve) => {
        firstParseStarted = resolve;
      });

      const createQueuedReader = (
        dir: string,
        sessionId: string,
        filePath: string,
      ): ISessionReader => ({
        listSessionFiles: async () => [{ sessionId, filePath }],
        getSessionSummary: async (
          currentSessionId: string,
          currentProjectId: string,
        ): Promise<SessionSummary> => {
          parseStarts += 1;
          activeParses += 1;
          maxActiveParses = Math.max(maxActiveParses, activeParses);
          if (parseStarts === 1) {
            firstParseStarted?.();
            await firstParseHeld;
          }
          const fileStats = await stat(filePath);
          activeParses -= 1;
          return {
            id: currentSessionId,
            projectId: currentProjectId,
            title: currentSessionId,
            fullTitle: currentSessionId,
            createdAt: new Date(fileStats.mtimeMs).toISOString(),
            updatedAt: new Date(fileStats.mtimeMs).toISOString(),
            messageCount: 1,
            ownership: { owner: "none" },
            provider: "claude",
          };
        },
        getAgentMappings: async () => [],
        getAgentSession: async () => null,
        getIndexScopeKey: () => dir,
      });

      const requestA = queuedService.getSessionsWithCache(
        dirA,
        toUrlProjectId("/queued/a"),
        createQueuedReader(dirA, "session-a", fileA),
      );
      const requestB = queuedService.getSessionsWithCache(
        dirB,
        toUrlProjectId("/queued/b"),
        createQueuedReader(dirB, "session-b", fileB),
      );

      await firstParseStartedPromise;
      await waitForCondition(
        () => queuedService.getWarmupStatus().queuedParses === 1,
        "second summary parse did not queue behind the active parse",
      );

      const activeStatus = queuedService.getWarmupStatus();
      expect(activeStatus.summaryParseConcurrency).toBe(1);
      expect(activeStatus.activeParses).toBe(1);
      expect(activeStatus.queuedParses).toBe(1);
      expect(activeStatus.activeJobs).toHaveLength(2);

      releaseFirstParse?.();
      const [sessionsA, sessionsB] = await Promise.all([requestA, requestB]);

      expect(sessionsA.map((session) => session.id)).toEqual(["session-a"]);
      expect(sessionsB.map((session) => session.id)).toEqual(["session-b"]);
      expect(parseStarts).toBe(2);
      expect(maxActiveParses).toBe(1);

      const completedStatus = queuedService.getWarmupStatus();
      expect(completedStatus.activeParses).toBe(0);
      expect(completedStatus.queuedParses).toBe(0);
      expect(completedStatus.activeJobs).toHaveLength(0);
      expect(completedStatus.recentJobs).toHaveLength(2);
      expect(
        completedStatus.recentJobs.every((job) => job.status === "completed"),
      ).toBe(true);
    });
  });

  describe("shared-file validation", () => {
    it("validates shared-container sessions via the reader, not file stats", async () => {
      // Models an OpenCode-style reader: every session anchors to one shared
      // database file, and change detection is a cheap row-level check.
      const rows = new Map<
        string,
        { mtime: number; size: number; title: string }
      >([["ses-shared", { mtime: 1000, size: 2, title: "row v1" }]]);
      const summaryFor = (
        id: string,
        row: { mtime: number; size: number; title: string },
      ): SessionSummary => ({
        id,
        projectId: projectId as UrlProjectId,
        title: row.title,
        fullTitle: row.title,
        createdAt: new Date(row.mtime).toISOString(),
        updatedAt: new Date(row.mtime).toISOString(),
        messageCount: row.size,
        ownership: { owner: "none" },
        provider: "opencode",
      });
      const getSessionSummary = vi.fn();
      const getSessionSummaryIfChanged = vi.fn(
        async (
          id: string,
          _projectId: string,
          cachedMtime: number,
          cachedSize: number,
        ) => {
          const row = rows.get(id);
          if (!row) return null;
          if (row.mtime === cachedMtime && row.size === cachedSize) {
            return null;
          }
          return {
            summary: summaryFor(id, row),
            mtime: row.mtime,
            size: row.size,
          };
        },
      );
      const sharedReader = {
        listSessionFiles: async () =>
          Array.from(rows.keys()).map((sessionId) => ({
            sessionId,
            filePath: "/nonexistent/opencode.db",
            sharedFilePath: true,
          })),
        getSessionSummary,
        getSessionSummaryIfChanged,
        getAgentMappings: async () => [],
        getAgentSession: async () => null,
        getIndexScopeKey: () => "shared-file-test",
      } as unknown as ISessionReader;

      const first = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        sharedReader,
      );
      expect(first.map((s) => s.title)).toEqual(["row v1"]);

      // Unchanged rows: the next full validation must be pure cache hits —
      // no summary parses, and no stat of the shared container file.
      const second = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        sharedReader,
      );
      expect(second.map((s) => s.title)).toEqual(["row v1"]);
      expect(getSessionSummaryIfChanged).toHaveBeenLastCalledWith(
        "ses-shared",
        projectId,
        1000,
        2,
      );
      expect(getSessionSummary).not.toHaveBeenCalled();

      // A changed row re-summarizes through the same cheap check.
      rows.set("ses-shared", { mtime: 2000, size: 3, title: "row v2" });
      const third = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        sharedReader,
      );
      expect(third.map((s) => s.title)).toEqual(["row v2"]);
      expect(getSessionSummary).not.toHaveBeenCalled();
    });
  });

  describe("fast path", () => {
    it("serves cached summaries between validations and refreshes on invalidation", async () => {
      const fastService = new SessionIndexService({
        database: openTestDiscoveryDatabase(testDir),
        dataDir,
        projectsDir,
        fullValidationIntervalMs: 60000,
      });
      await fastService.initialize();

      await createSession("session-1", "Original content");

      const first = await fastService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(first[0]?.title).toBe("Original content");

      // Update file content without invalidating.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const updatedJsonl = JSON.stringify({
        type: "user",
        message: { content: "Updated content" },
        uuid: "msg-updated",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(sessionDir, "session-1.jsonl"), `${updatedJsonl}\n`);

      // Fast path should still serve cached summary until invalidated.
      const second = await fastService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(second[0]?.title).toBe("Original content");

      fastService.invalidateSession(sessionDir, "session-1");
      const third = await fastService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(third[0]?.title).toBe("Updated content");
    });
  });

  describe("stale-while-revalidate", () => {
    async function overwriteSession(
      sessionId: string,
      content: string,
    ): Promise<void> {
      const jsonl = JSON.stringify({
        type: "user",
        message: { content },
        uuid: `msg-${sessionId}-updated`,
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(sessionDir, `${sessionId}.jsonl`), `${jsonl}\n`);
    }

    it("serves stale summaries after the TTL and emits session-updated from the background walk", async () => {
      const eventBus = new EventBus();
      const events: Array<{
        type: string;
        sessionId?: string;
        title?: string | null;
      }> = [];
      eventBus.subscribe((event) => {
        if (event.type === "session-updated") {
          events.push({
            type: event.type,
            sessionId: event.sessionId,
            title: event.title,
          });
        }
      });
      const swrService = new SessionIndexService({
        database: openTestDiscoveryDatabase(testDir),
        dataDir,
        projectsDir,
        eventBus,
        fullValidationIntervalMs: 40,
      });
      await swrService.initialize();

      await createSession("session-1", "Original content");
      const first = await swrService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(first[0]?.title).toBe("Original content");

      // Change the file without watcher events, then let the TTL lapse.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await overwriteSession("session-1", "Updated content in background");

      // TTL expired: the response is the stale cached summary, not a blocking
      // re-validation.
      const second = await swrService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(second[0]?.title).toBe("Original content");

      await waitForCondition(
        () =>
          events.some(
            (e) =>
              e.sessionId === "session-1" &&
              e.title === "Updated content in background",
          ),
        "expected background validation to emit session-updated",
      );

      // The background walk refreshed the index: next call serves it fresh.
      const third = await swrService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(third[0]?.title).toBe("Updated content in background");
    });

    it("emits session-created for sessions found only by the background walk", async () => {
      const eventBus = new EventBus();
      const created: string[] = [];
      eventBus.subscribe((event) => {
        if (event.type === "session-created") {
          created.push(event.session.id);
        }
      });
      const swrService = new SessionIndexService({
        database: openTestDiscoveryDatabase(testDir),
        dataDir,
        projectsDir,
        eventBus,
        fullValidationIntervalMs: 40,
      });
      await swrService.initialize();

      await createSession("session-1", "First session");
      await swrService.getSessionsWithCache(sessionDir, projectId, reader);

      await new Promise((resolve) => setTimeout(resolve, 50));
      await createSession("session-2", "Second session");

      // Stale serve: the new file is not in the response yet.
      const stale = await swrService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(stale.map((s) => s.id)).toEqual(["session-1"]);

      await waitForCondition(
        () => created.includes("session-2"),
        "expected background validation to emit session-created",
      );

      const fresh = await swrService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(fresh.map((s) => s.id).sort()).toEqual(["session-1", "session-2"]);
    });

    it("does not emit for sessions the background walk found unchanged", async () => {
      const eventBus = new EventBus();
      const updated: string[] = [];
      const created: string[] = [];
      eventBus.subscribe((event) => {
        if (event.type === "session-updated") {
          updated.push(event.sessionId);
        }
        if (event.type === "session-created") {
          created.push(event.session.id);
        }
      });
      const swrService = new SessionIndexService({
        database: openTestDiscoveryDatabase(testDir),
        dataDir,
        projectsDir,
        eventBus,
        fullValidationIntervalMs: 40,
      });
      await swrService.initialize();

      await createSession("session-1", "Unchanged content");
      await createSession("session-2", "Original content");
      await swrService.getSessionsWithCache(sessionDir, projectId, reader);

      await new Promise((resolve) => setTimeout(resolve, 50));
      await overwriteSession("session-2", "Changed in background");

      await swrService.getSessionsWithCache(sessionDir, projectId, reader);
      await waitForCondition(
        () => updated.includes("session-2"),
        "expected background validation to emit for the changed session",
      );

      // Pins the invariant emitBackgroundIndexChanges relies on: the walk
      // reassigns only changed rows, so untouched sessions keep identity and
      // must produce no events (a map-rebuilding refactor would fail this by
      // spamming session-updated for every session).
      expect(updated).toEqual(["session-2"]);
      expect(created).toEqual([]);
    });

    it("serves a persisted index immediately after a service restart", async () => {
      const firstRun = new SessionIndexService({
        database: openTestDiscoveryDatabase(testDir),
        dataDir,
        projectsDir,
        fullValidationIntervalMs: 60000,
      });
      await firstRun.initialize();
      await createSession("session-1", "Persisted content");
      await firstRun.getSessionsWithCache(sessionDir, projectId, reader);
      // The first validation persists the index before returning.
      expect(readPersistedIndex()?.sessions["session-1"]?.title).toBe(
        "Persisted content",
      );

      const secondRun = new SessionIndexService({
        database: openTestDiscoveryDatabase(testDir),
        dataDir,
        projectsDir,
        fullValidationIntervalMs: 60000,
      });
      await secondRun.initialize();
      const freshReader = new SessionReader({ sessionDir });
      const parseSpy = vi.spyOn(freshReader, "getSessionSummary");

      const sessions = await secondRun.getSessionsWithCache(
        sessionDir,
        projectId,
        freshReader,
      );
      expect(sessions[0]?.title).toBe("Persisted content");
      // Served from the persisted index without a blocking re-parse.
      expect(parseSpy).not.toHaveBeenCalled();
    });

    it("persists an empty index so restarts serve the scope without blocking", async () => {
      const firstRun = new SessionIndexService({
        database: openTestDiscoveryDatabase(testDir),
        dataDir,
        projectsDir,
        fullValidationIntervalMs: 60000,
      });
      await firstRun.initialize();
      // No session files in the scope: validation finds nothing to change,
      // but the index must still be persisted.
      const empty = await firstRun.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(empty).toEqual([]);
      expect(readPersistedIndex()?.sessions).toEqual({});

      const secondRun = new SessionIndexService({
        database: openTestDiscoveryDatabase(testDir),
        dataDir,
        projectsDir,
        fullValidationIntervalMs: 60000,
      });
      await secondRun.initialize();
      const sessions = await secondRun.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions).toEqual([]);
      // Served via stale-while-revalidate (a fast hit), not a blocking scan.
      // The background walk may or may not have run yet, so only the
      // synchronous fast-hit count is asserted.
      expect(secondRun.getDebugStats().fastHits).toBe(1);
    });

    it("still blocks on first-ever scans with no usable index", async () => {
      const swrService = new SessionIndexService({
        database: openTestDiscoveryDatabase(testDir),
        dataDir,
        projectsDir,
        fullValidationIntervalMs: 60000,
      });
      await swrService.initialize();

      await createSession("session-1", "Cold scan content");
      const sessions = await swrService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions[0]?.title).toBe("Cold scan content");
    });
  });

  describe("invalidation", () => {
    it("invalidateSession removes session from memory cache", async () => {
      await createSession("session-1", "Original");

      // Populate cache
      await service.getSessionsWithCache(sessionDir, projectId, reader);

      // Invalidate
      service.invalidateSession(sessionDir, "session-1");

      // Update file content
      const newJsonl = JSON.stringify({
        type: "user",
        message: { content: "Updated" },
        uuid: "msg-new",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(sessionDir, "session-1.jsonl"), `${newJsonl}\n`);

      // Should re-parse due to invalidation
      const sessions = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions[0]?.title).toBe("Updated");
    });

    it("clearCache removes all cached data for directory", async () => {
      await createSession("session-1", "Test");

      // Populate cache
      await service.getSessionsWithCache(sessionDir, projectId, reader);

      // Clear cache
      service.clearCache(sessionDir);

      // Next call should rebuild from disk
      const sessions = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions).toHaveLength(1);
    });

    it("invalidates loaded codex scopes on codex file-change events", async () => {
      const eventBus = new EventBus();
      const codexService = new SessionIndexService({
        database: openTestDiscoveryDatabase(testDir),
        dataDir,
        projectsDir,
        eventBus,
        fullValidationIntervalMs: 60000,
      });
      await codexService.initialize();

      const codexSessionDir = join(testDir, "codex-sessions");
      await mkdir(codexSessionDir, { recursive: true });
      const codexFile = join(codexSessionDir, "session-1.jsonl");
      await writeFile(codexFile, "Original title\n");

      const codexReader: ISessionReader = {
        getIndexScopeKey: (sessionDir) => `codex::${sessionDir}::/tmp/project`,
        listSessionFiles: async (sessionDir) => [
          {
            sessionId: "session-1",
            filePath: join(sessionDir, "session-1.jsonl"),
          },
        ],
        getSessionSummary: async (
          sessionId: string,
          projectId: string,
        ): Promise<SessionSummary> => {
          const title = (await readFile(codexFile, "utf-8")).trim();
          const stats = await stat(codexFile);
          return {
            id: sessionId,
            projectId,
            title,
            fullTitle: title,
            createdAt: new Date(stats.mtimeMs).toISOString(),
            updatedAt: new Date(stats.mtimeMs).toISOString(),
            messageCount: 1,
            ownership: { owner: "none" },
            provider: "codex",
          };
        },
        getAgentMappings: async () => [],
        getAgentSession: async () => null,
      };

      const first = await codexService.getSessionsWithCache(
        codexSessionDir,
        projectId,
        codexReader,
      );
      expect(first[0]?.title).toBe("Original title");

      await writeFile(codexFile, "Updated title\n");

      // Without an invalidation event, fast path should keep serving stale data.
      const stale = await codexService.getSessionsWithCache(
        codexSessionDir,
        projectId,
        codexReader,
      );
      expect(stale[0]?.title).toBe("Original title");

      eventBus.emit({
        type: "file-change",
        provider: "codex",
        path: codexFile,
        relativePath: "2025/03/28/session-1.jsonl",
        changeType: "modify",
        timestamp: new Date().toISOString(),
        fileType: "session",
      });

      const refreshed = await codexService.getSessionsWithCache(
        codexSessionDir,
        projectId,
        codexReader,
      );
      expect(refreshed[0]?.title).toBe("Updated title");
    });

    it("targets loaded codex scopes by rollout session id", async () => {
      const eventBus = new EventBus();
      const codexService = new SessionIndexService({
        database: openTestDiscoveryDatabase(testDir),
        dataDir,
        projectsDir,
        eventBus,
        fullValidationIntervalMs: 60000,
      });
      await codexService.initialize();

      const codexSessionDir = join(testDir, "codex-sessions");
      const projectAPath = "/tmp/codex-project-a";
      const projectBPath = "/tmp/codex-project-b";
      const projectAId = toUrlProjectId(projectAPath);
      const projectBId = toUrlProjectId(projectBPath);
      const sessionA = randomUUID();
      const sessionB = randomUUID();
      const relativeA = `2026/07/01/rollout-2026-07-01T09-00-00-${sessionA}.jsonl`;
      const relativeB = `2026/07/01/rollout-2026-07-01T09-01-00-${sessionB}.jsonl`;
      const fileA = join(codexSessionDir, ...relativeA.split("/"));
      const fileB = join(codexSessionDir, ...relativeB.split("/"));

      const writeCodexFile = async (filePath: string, title: string) => {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, `${title}\n`);
      };
      await writeCodexFile(fileA, "Project A original");
      await writeCodexFile(fileB, "Project B original");

      const makeCodexReader = (
        projectPath: string,
        sessionId: string,
        filePath: string,
      ): ISessionReader => {
        const getSummary = async (
          requestedSessionId: string,
          requestedProjectId: UrlProjectId,
        ): Promise<SessionSummary> => {
          const title = (await readFile(filePath, "utf-8")).trim();
          const stats = await stat(filePath);
          return {
            id: requestedSessionId,
            projectId: requestedProjectId,
            title,
            fullTitle: title,
            createdAt: new Date(stats.mtimeMs).toISOString(),
            updatedAt: new Date(stats.mtimeMs).toISOString(),
            messageCount: 1,
            ownership: { owner: "none" },
            provider: "codex",
          };
        };

        return {
          getIndexScopeKey: (sessionDir) =>
            `codex::${sessionDir}::${projectPath}`,
          listSessionFiles: async () => [{ sessionId, filePath }],
          getSessionSummary: getSummary,
          getSessionSummaryIfChanged: async (
            requestedSessionId: string,
            requestedProjectId: UrlProjectId,
            cachedMtime: number,
            cachedSize: number,
          ) => {
            const stats = await stat(filePath);
            if (stats.mtimeMs === cachedMtime && stats.size === cachedSize) {
              return null;
            }
            return {
              summary: await getSummary(requestedSessionId, requestedProjectId),
              mtime: stats.mtimeMs,
              size: stats.size,
            };
          },
          getSessionFilePath: async () => filePath,
          listSessions: async (requestedProjectId: UrlProjectId) => [
            await getSummary(sessionId, requestedProjectId),
          ],
          getSession: async () => null,
          getAgentMappings: async () => [],
          getAgentSession: async () => null,
        };
      };

      const readerA = makeCodexReader(projectAPath, sessionA, fileA);
      const readerB = makeCodexReader(projectBPath, sessionB, fileB);

      const firstA = await codexService.getSessionsWithCache(
        codexSessionDir,
        projectAId,
        readerA,
      );
      const firstB = await codexService.getSessionsWithCache(
        codexSessionDir,
        projectBId,
        readerB,
      );
      expect(firstA[0]?.title).toBe("Project A original");
      expect(firstB[0]?.title).toBe("Project B original");

      await writeCodexFile(fileA, "Project A updated");
      await writeCodexFile(fileB, "Project B updated");

      const staleA = await codexService.getSessionsWithCache(
        codexSessionDir,
        projectAId,
        readerA,
      );
      const staleB = await codexService.getSessionsWithCache(
        codexSessionDir,
        projectBId,
        readerB,
      );
      expect(staleA[0]?.title).toBe("Project A original");
      expect(staleB[0]?.title).toBe("Project B original");

      eventBus.emit({
        type: "file-change",
        provider: "codex",
        path: fileA,
        relativePath: relativeA,
        changeType: "modify",
        timestamp: new Date().toISOString(),
        fileType: "session",
      });

      const refreshedA = await codexService.getSessionsWithCache(
        codexSessionDir,
        projectAId,
        readerA,
      );
      const stillCachedB = await codexService.getSessionsWithCache(
        codexSessionDir,
        projectBId,
        readerB,
      );
      expect(refreshedA[0]?.title).toBe("Project A updated");
      expect(stillCachedB[0]?.title).toBe("Project B original");
    });
  });

  describe("logical provider scopes", () => {
    it("keeps Grok session indexes scoped by project path", async () => {
      const grokSessionsDir = join(testDir, "grok-sessions");
      const projectAPath = "/tmp/grok-project-a";
      const projectBPath = "/tmp/grok-project-b";

      const writeGrokSummary = async (
        projectPath: string,
        sessionId: string,
        title: string,
      ) => {
        const sessionPath = join(
          grokSessionsDir,
          encodeURIComponent(projectPath),
          sessionId,
        );
        await mkdir(sessionPath, { recursive: true });
        await writeFile(
          join(sessionPath, "summary.json"),
          JSON.stringify({
            info: { id: sessionId, cwd: projectPath },
            created_at: "2026-05-28T17:00:00.000Z",
            updated_at: "2026-05-28T17:01:00.000Z",
            generated_title: title,
            session_summary: title,
            num_messages: 1,
            current_model_id: "grok-build",
          }),
        );
      };

      await writeGrokSummary(projectAPath, "grok-a", "Project A Grok");
      await writeGrokSummary(projectBPath, "grok-b", "Project B Grok");

      const grokService = new SessionIndexService({
        database: openTestDiscoveryDatabase(join(testDir, "grok-indexes")),
        dataDir: join(testDir, "grok-indexes"),
        projectsDir,
        fullValidationIntervalMs: 60000,
      });
      await grokService.initialize();

      const projectAId = toUrlProjectId(projectAPath);
      const projectBId = toUrlProjectId(projectBPath);
      const projectAReader = new GrokSessionReader({
        sessionsDir: grokSessionsDir,
        projectPath: projectAPath,
      });
      const projectBReader = new GrokSessionReader({
        sessionsDir: grokSessionsDir,
        projectPath: projectBPath,
      });

      const projectASessions = await grokService.getSessionsWithCache(
        grokSessionsDir,
        projectAId,
        projectAReader,
      );
      expect(projectASessions.map((session) => session.id)).toEqual(["grok-a"]);

      const projectBSessions = await grokService.getSessionsWithCache(
        grokSessionsDir,
        projectBId,
        projectBReader,
      );
      expect(projectBSessions.map((session) => session.id)).toEqual(["grok-b"]);
      expect(projectBSessions[0]?.projectId).toBe(projectBId);
    });
  });

  describe("active window", () => {
    it("filters cached summaries by activeAfter without deleting archive entries", async () => {
      const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await createSession("session-old", "Old session", oldTime);
      await createSession("session-new", "New session");
      await utimes(join(sessionDir, "session-old.jsonl"), oldTime, oldTime);

      const activeAfterMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const active = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
        { activeAfterMs },
      );

      expect(active.map((session) => session.id)).toEqual(["session-new"]);

      const archive = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(archive.map((session) => session.id).sort()).toEqual([
        "session-new",
        "session-old",
      ]);
    });

    it("does not prune archive rows when provider enumeration is active-window filtered", async () => {
      await createSession("session-old", "Old session");
      await createSession("session-new", "New session");

      const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await utimes(join(sessionDir, "session-old.jsonl"), oldTime, oldTime);

      await service.getSessionsWithCache(sessionDir, projectId, reader);

      const filteringReader: ISessionReader = {
        listSessions: (projectId) => reader.listSessions(projectId),
        getSessionSummary: (sessionId, projectId) =>
          reader.getSessionSummary(sessionId, projectId),
        getSession: (sessionId, projectId, afterMessageId, options) =>
          reader.getSession(sessionId, projectId, afterMessageId, options),
        getSessionSummaryIfChanged: (
          sessionId,
          projectId,
          cachedMtime,
          cachedSize,
        ) =>
          reader.getSessionSummaryIfChanged(
            sessionId,
            projectId,
            cachedMtime,
            cachedSize,
          ),
        getAgentMappings: () => reader.getAgentMappings(),
        getAgentSession: (agentId) => reader.getAgentSession(agentId),
        listSessionFiles: async (_sessionDir, options) => {
          const files = await readdir(sessionDir);
          const entries: { sessionId: string; filePath: string }[] = [];
          for (const file of files) {
            if (!file.endsWith(".jsonl") || file.startsWith("agent-")) {
              continue;
            }
            const filePath = join(sessionDir, file);
            const stats = await stat(filePath);
            if (
              options?.activeAfterMs !== undefined &&
              stats.mtimeMs < options.activeAfterMs
            ) {
              continue;
            }
            entries.push({
              sessionId: file.replace(".jsonl", ""),
              filePath,
            });
          }
          return entries;
        },
      };

      const activeAfterMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const active = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        filteringReader,
        { activeAfterMs },
      );
      expect(active.map((session) => session.id)).toEqual(["session-new"]);

      const archive = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(archive.map((session) => session.id).sort()).toEqual([
        "session-new",
        "session-old",
      ]);
    });
  });

  describe("sorting", () => {
    it("returns sessions sorted by updatedAt descending", async () => {
      // Create sessions with different timestamps
      await createSession("session-old", "Old session");
      await new Promise((resolve) => setTimeout(resolve, 10));
      await createSession("session-new", "New session");

      const sessions = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );

      // Newest should be first
      expect(sessions[0]?.id).toBe("session-new");
      expect(sessions[1]?.id).toBe("session-old");
    });
  });

  describe("agent files", () => {
    it("excludes agent-* files from session list", async () => {
      await createSession("session-1", "Regular session");

      // Create an agent file
      const agentJsonl = JSON.stringify({
        type: "user",
        message: { content: "Agent content" },
        uuid: "msg-agent",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(sessionDir, "agent-12345.jsonl"), `${agentJsonl}\n`);

      const sessions = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );

      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe("session-1");
    });
  });

  describe("persistence", () => {
    it("persists index to disk and reloads", async () => {
      await createSession("session-1", "Persistent session");

      // First service instance
      await service.getSessionsWithCache(sessionDir, projectId, reader);

      // Create new service instance (simulates server restart)
      const newService = new SessionIndexService({
        database: openTestDiscoveryDatabase(testDir),
        dataDir,
        projectsDir,
      });
      await newService.initialize();

      // Should load cached data from disk
      const sessions = await newService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.title).toBe("Persistent session");
    });

    it("preserves forkedFromSessionId on fast path and after restart", async () => {
      const lineageService = new SessionIndexService({
        database: openTestDiscoveryDatabase(testDir),
        dataDir,
        projectsDir,
        fullValidationIntervalMs: 60000,
      });
      await lineageService.initialize();

      const forkFile = join(sessionDir, "fork-session.jsonl");
      await writeFile(forkFile, "Fork summary\n");
      const forkStats = await stat(forkFile);
      let parseCount = 0;
      const lineageReader: ISessionReader = {
        listSessions: async () => [],
        listSessionFiles: async () => [
          { sessionId: "fork-session", filePath: forkFile },
        ],
        getSessionSummary: async (
          sessionId: string,
          projectId: string,
        ): Promise<SessionSummary> => {
          parseCount += 1;
          return {
            id: sessionId,
            projectId,
            title: "Fork summary",
            fullTitle: "Fork summary",
            createdAt: new Date(forkStats.mtimeMs).toISOString(),
            updatedAt: new Date(forkStats.mtimeMs).toISOString(),
            messageCount: 2,
            ownership: { owner: "none" },
            provider: "codex",
            forkedFromSessionId: "source-session",
          };
        },
        getSession: async () => null,
        getSessionSummaryIfChanged: async () => null,
        getAgentMappings: async () => [],
        getAgentSession: async () => null,
      };

      const first = await lineageService.getSessionsWithCache(
        sessionDir,
        projectId,
        lineageReader,
      );
      expect(first[0]?.forkedFromSessionId).toBe("source-session");
      expect(parseCount).toBe(1);

      const fastPath = await lineageService.getSessionsWithCache(
        sessionDir,
        projectId,
        lineageReader,
      );
      expect(fastPath[0]?.forkedFromSessionId).toBe("source-session");
      expect(parseCount).toBe(1);

      const restartedService = new SessionIndexService({
        database: openTestDiscoveryDatabase(testDir),
        dataDir,
        projectsDir,
        fullValidationIntervalMs: 60000,
      });
      await restartedService.initialize();
      const afterRestart = await restartedService.getSessionsWithCache(
        sessionDir,
        projectId,
        lineageReader,
      );
      expect(afterRestart[0]?.forkedFromSessionId).toBe("source-session");
      expect(parseCount).toBe(1);
    });
  });

  it("evicts the least recently used scope with its bookkeeping", async () => {
    const lruService = new SessionIndexService({
      database: openTestDiscoveryDatabase(testDir),
      dataDir,
      projectsDir,
      maxCacheSize: 2,
    });
    await lruService.initialize();
    const dirs = ["a", "b", "c"].map((name) => join(projectsDir, name));
    for (const dir of dirs) await mkdir(dir, { recursive: true });
    const list = (dir: string) =>
      lruService.getSessionsWithCache(
        dir,
        projectId,
        new SessionReader({ sessionDir: dir }),
      );
    const internals = lruService as unknown as {
      indexCache: Map<string, unknown>;
      persistedIndexScopes: Set<string>;
      lastFullValidationAt: Map<string, number>;
    };

    await list(dirs[0]!);
    await list(dirs[1]!);
    await list(dirs[0]!);
    await list(dirs[2]!);

    expect([...internals.indexCache.keys()]).toEqual([dirs[0], dirs[2]]);
    expect(internals.persistedIndexScopes.has(dirs[1]!)).toBe(false);
    expect(
      [...internals.lastFullValidationAt.keys()].some((key) =>
        key.startsWith(`${dirs[1]}::`),
      ),
    ).toBe(false);
  });
});
