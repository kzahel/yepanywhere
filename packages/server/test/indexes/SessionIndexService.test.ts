import { randomUUID } from "node:crypto";
import {
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
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionIndexService } from "../../src/indexes/SessionIndexService.js";
import { SessionReader } from "../../src/sessions/reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { SessionSummary } from "../../src/supervisor/types.js";
import { EventBus } from "../../src/watcher/EventBus.js";

describe("SessionIndexService", () => {
  let testDir: string;
  let dataDir: string;
  let projectsDir: string;
  let sessionDir: string;
  let service: SessionIndexService;
  let reader: SessionReader;
  let projectId: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `claude-index-test-${randomUUID()}`);
    dataDir = join(testDir, "indexes");
    projectsDir = join(testDir, "projects");
    sessionDir = join(projectsDir, "test-project");

    await mkdir(dataDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    service = new SessionIndexService({ dataDir, projectsDir });
    await service.initialize();

    reader = new SessionReader({ sessionDir });
    projectId = toUrlProjectId("/test/project");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function createSession(
    sessionId: string,
    content: string,
  ): Promise<void> {
    const jsonl = JSON.stringify({
      type: "user",
      message: { content },
      uuid: `msg-${sessionId}`,
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(sessionDir, `${sessionId}.jsonl`), `${jsonl}\n`);
  }

  describe("initialization", () => {
    it("creates data directory on initialize", async () => {
      const newDataDir = join(testDir, "new-indexes");
      const newService = new SessionIndexService({
        dataDir: newDataDir,
        projectsDir,
      });

      await newService.initialize();

      const stats = await stat(newDataDir);
      expect(stats.isDirectory()).toBe(true);
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
    it("gracefully handles malformed index file", async () => {
      await createSession("session-1", "Test content");

      // Write corrupt index
      const indexPath = service.getIndexPath(sessionDir);
      await mkdir(join(testDir, "indexes"), { recursive: true });
      await writeFile(indexPath, "not valid json{{{");

      // Should still work - starts fresh
      const sessions = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.title).toBe("Test content");
    });

    it("handles index with wrong version", async () => {
      await createSession("session-1", "Test content");

      const indexPath = service.getIndexPath(sessionDir);
      await mkdir(join(testDir, "indexes"), { recursive: true });
      await writeFile(
        indexPath,
        JSON.stringify({
          version: 999,
          projectId,
          sessions: {},
        }),
      );

      // Should start fresh due to version mismatch
      const sessions = await service.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions).toHaveLength(1);
    });
  });

  describe("index file location", () => {
    it("encodes sessionDir path correctly", () => {
      const nestedSessionDir = join(projectsDir, "host", "nested", "path");
      const indexPath = service.getIndexPath(nestedSessionDir);

      // Should encode slashes as %2F
      expect(indexPath).toContain("%2F");
      expect(indexPath).toContain("host%2Fnested%2Fpath.json");
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
  });

  describe("fast path", () => {
    it("serves cached summaries between validations and refreshes on invalidation", async () => {
      const fastService = new SessionIndexService({
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

    it("refreshes loaded codex scopes in the background on codex file-change events", async () => {
      const eventBus = new EventBus();
      const codexService = new SessionIndexService({
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

      let readDelayMs = 0;
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
          if (readDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, readDelayMs));
          }
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

      readDelayMs = 200;
      const start = Date.now();
      const deferred = await codexService.getSessionsWithCache(
        codexSessionDir,
        projectId,
        codexReader,
      );
      const durationMs = Date.now() - start;
      expect(durationMs).toBeLessThan(150);
      expect(deferred[0]?.title).toBe("Original title");

      await new Promise((resolve) => setTimeout(resolve, 300));

      const refreshed = await codexService.getSessionsWithCache(
        codexSessionDir,
        projectId,
        codexReader,
      );
      expect(refreshed[0]?.title).toBe("Updated title");
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
      const newService = new SessionIndexService({ dataDir, projectsDir });
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

    it("writes index atomically without leftover temp files", async () => {
      await createSession("session-1", "Atomic session");

      await service.getSessionsWithCache(sessionDir, projectId, reader);

      const files = await readdir(dataDir);
      const tempFiles = files.filter((file) => file.includes(".tmp-"));
      expect(tempFiles).toHaveLength(0);
    });

    it("cleans stale lock directories before writing", async () => {
      const lockService = new SessionIndexService({
        dataDir,
        projectsDir,
        writeLockTimeoutMs: 500,
        writeLockStaleMs: 50,
      });
      await lockService.initialize();
      await createSession("session-1", "Lock session");

      const indexPath = lockService.getIndexPath(sessionDir);
      const lockPath = `${indexPath}.lock`;
      await mkdir(dirname(indexPath), { recursive: true });
      await mkdir(lockPath, { recursive: true });
      const staleTime = new Date(Date.now() - 1000);
      await utimes(lockPath, staleTime, staleTime);

      const sessions = await lockService.getSessionsWithCache(
        sessionDir,
        projectId,
        reader,
      );
      expect(sessions).toHaveLength(1);

      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
