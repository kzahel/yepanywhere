import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../setup/create-app.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { encodeProjectId } from "../../src/supervisor/types.js";
import { SessionIndexService } from "../../src/indexes/SessionIndexService.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { EventBus } from "../../src/watcher/EventBus.js";

describe("session detail compact-tail pagination", () => {
  const projectPath = "/home/user/myproject";
  const projectId = encodeProjectId(projectPath);
  let testDir: string;
  let codexSessionsDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `compact-tail-test-${randomUUID()}`);
    codexSessionsDir = join(testDir, "codex-sessions");
    const encodedPath = projectPath.replace(/[/\\:]/g, "-");
    await mkdir(join(testDir, "localhost", encodedPath), { recursive: true });
    await mkdir(codexSessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeSession(name: string) {
    const encodedPath = projectPath.replace(/[/\\:]/g, "-");
    const sessionDir = join(testDir, "localhost", encodedPath);
    const timestamp = (second: number) =>
      `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;
    const entries = [
      {
        type: "user",
        cwd: projectPath,
        sessionId: name,
        uuid: "u1",
        timestamp: timestamp(1),
        message: { role: "user", content: "OLDISSUE-101" },
      },
      {
        type: "assistant",
        cwd: projectPath,
        sessionId: name,
        uuid: "a1",
        parentUuid: "u1",
        timestamp: timestamp(2),
        message: { role: "assistant", content: "a1" },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        cwd: projectPath,
        sessionId: name,
        uuid: "cb1",
        logicalParentUuid: "a1",
        timestamp: timestamp(3),
        content: "Conversation compacted",
      },
      {
        type: "user",
        cwd: projectPath,
        sessionId: name,
        uuid: "u2",
        parentUuid: "cb1",
        timestamp: timestamp(4),
        message: { role: "user", content: "u2" },
      },
      {
        type: "assistant",
        cwd: projectPath,
        sessionId: name,
        uuid: "a2",
        parentUuid: "u2",
        timestamp: timestamp(5),
        message: { role: "assistant", content: "a2" },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        cwd: projectPath,
        sessionId: name,
        uuid: "cb2",
        logicalParentUuid: "a2",
        timestamp: timestamp(6),
        content: "Conversation compacted",
      },
      {
        type: "user",
        cwd: projectPath,
        sessionId: name,
        uuid: "u3",
        parentUuid: "cb2",
        timestamp: timestamp(7),
        message: { role: "user", content: "NEWISSUE-303" },
      },
    ];

    await writeFile(
      join(sessionDir, `${name}.jsonl`),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
  }

  it("keeps Codex incremental catch-up bounded without losing older anchors", async () => {
    const sessionId = "codex-incremental";
    const timestamp = "2026-09-08T00:00:00.000Z";
    const row = (id: string) => ({
      type: "response_item",
      timestamp,
      payload: {
        type: "message",
        role: "assistant",
        id,
        content: [{ type: "output_text", text: id }],
      },
    });
    const sessionPath = join(codexSessionsDir, `rollout-${sessionId}.jsonl`);
    await writeFile(
      sessionPath,
      `${[
        {
          type: "session_meta",
          timestamp,
          payload: { id: sessionId, cwd: projectPath, timestamp },
        },
        {
          type: "event_msg",
          timestamp,
          payload: { type: "user_message", message: "Start" },
        },
        row("old"),
        {
          type: "world_state",
          timestamp,
          payload: {
            full: true,
            state: { filler: "x".repeat(5 * 1024 * 1024) },
          },
        },
        ...[1, 2, 3].flatMap((i) => [
          {
            type: "compacted",
            timestamp,
            payload: { message: `compact ${i}` },
          },
          row(`msg-${i}`),
        ]),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );
    const database = new DiscoverySqliteService({
      dataDir: join(testDir, "summary-data"),
    });
    const eventBus = new EventBus();
    const index = new SessionIndexService({
      database: database.getDatabase(),
      eventBus,
      dataDir: join(testDir, "indexes"),
      projectsDir: testDir,
    });
    const { app, scanner, readerFactory, disposeSessionReaders } = createApp({
      provider: new ScriptedClaudeProvider(),
      projectsDir: testDir,
      codexSessionsDir,
      sessionIndexService: index,
    });
    try {
      const project = await scanner.getProject(projectId);
      if (!project) throw new Error("Expected Codex project");
      const reader = readerFactory(project);
      expect(reader).toBeInstanceOf(CodexSessionReader);
      const codex = reader as CodexSessionReader;
      const reads = vi.spyOn(
        CodexSessionReader.prototype as unknown as {
          readFileRange(
            path: string,
            start: number,
            length: number,
          ): Promise<Buffer>;
        },
        "readFileRange",
      );
      const request = async (query: string) => {
        const response = await app.request(
          `/api/projects/${projectId}/sessions/${sessionId}?${query}`,
          {
            headers: { "X-Yep-Anywhere": "true" },
          },
        );
        expect(response.status).toBe(200);
        return response.json();
      };
      const initial = await request("tailCompactions=2");
      expect(initial.messages.map((m: { uuid: string }) => m.uuid)).toContain(
        "msg-3",
      );
      expect(
        await index.getCachedSessionSummary(
          codexSessionsDir,
          projectId,
          sessionId,
          codex,
        ),
      ).not.toBeNull();
      reads.mockClear();
      const current = await request("afterMessageId=msg-3");
      expect(current.messages).toEqual([]);
      expect(reads.mock.calls.length).toBeGreaterThan(0);
      expect(
        reads.mock.calls.every(
          ([, start, length]) => start > 0 || length <= 1024,
        ),
      ).toBe(true);
      await appendFile(sessionPath, `${JSON.stringify(row("appended"))}\n`);
      eventBus.emit({
        type: "file-change",
        provider: "codex",
        fileType: "session",
        changeType: "modify",
        relativePath: `rollout-${sessionId}.jsonl`,
        path: sessionPath,
        nativeStorageScope: codexSessionsDir,
        timestamp: new Date().toISOString(),
      });
      reads.mockClear();
      const appended = await request("afterMessageId=msg-3&tailCompactions=1");
      expect(appended.messages.map((m: { uuid: string }) => m.uuid)).toEqual([
        "appended",
      ]);
      expect(reads.mock.calls.length).toBeGreaterThan(0);
      expect(
        reads.mock.calls.every(
          ([, start, length]) => start > 0 || length <= 1024,
        ),
      ).toBe(true);
      const old = await request("afterMessageId=old");
      expect(old.messages.map((m: { uuid: string }) => m.uuid)).toContain(
        "msg-1",
      );
      const missing = await request("afterMessageId=missing&tailCompactions=1");
      expect(
        missing.messages.map((m: { uuid: string }) => m.uuid),
      ).not.toContain("msg-2");
      expect(missing.pagination.hasOlderMessages).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await disposeSessionReaders();
      index.dispose();
      database.close();
    }
  });

  it("captures only the delivered persisted issue window, then older history on demand", async () => {
    const sessionId = "issue-paging";
    await writeSession(sessionId);
    const dataDir = join(testDir, "app-data");
    const settings = new ServerSettingsService({ dataDir });
    await settings.initialize();
    await settings.updateSettings({
      issueAssociations: {
        enabled: true,
        scope: "viewed",
        recentDays: 7,
        aggressiveMatching: true,
      },
    });
    const { app, disposeSessionReaders } = createApp({
      provider: new ScriptedClaudeProvider(),
      projectsDir: testDir,
      codexSessionsDir,
      dataDir,
      serverSettingsService: settings,
    });
    const path = `/api/projects/${projectId}/sessions/${sessionId}`;
    const found = async () =>
      (await (await app.request("/api/issues")).json()).items.map(
        (item: { key: string }) => item.key,
      );
    try {
      expect((await app.request(path)).status).toBe(200);
      await vi.waitFor(async () =>
        expect(await found()).toEqual(["NEWISSUE-303"]),
      );
      expect((await app.request(`${path}?fullHistory=1`)).status).toBe(200);
      await vi.waitFor(async () =>
        expect(await found()).toContain("OLDISSUE-101"),
      );
    } finally {
      await disposeSessionReaders();
    }
  });
  it("defaults exactly two compact boundaries to a compact tail", async () => {
    const sessionId = "sess-compact-exact";
    await writeSession(sessionId);
    const { app } = createApp({
      provider: new ScriptedClaudeProvider(),
      projectsDir: testDir,
      codexSessionsDir,
    });

    const res = await app.request(
      `/api/projects/${projectId}/sessions/${sessionId}`,
      { headers: { "X-Yep-Anywhere": "true" } },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(
      json.messages.map((message: { uuid?: string }) => message.uuid),
    ).toEqual(["cb1", "u2", "a2", "cb2", "u3"]);
    expect(json.pagination).toMatchObject({
      hasOlderMessages: true,
      returnedMessageCount: 5,
      totalCompactions: 2,
      truncatedBeforeMessageId: "cb1",
    });
  });
});
