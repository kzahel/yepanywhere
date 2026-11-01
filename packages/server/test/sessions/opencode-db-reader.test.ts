import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import {
  loadSqliteDriver,
  openSqliteOrThrow,
} from "../../src/storage/sqlite.js";
import type { OpenCodeSessionReader } from "../../src/sessions/opencode-reader.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeSession } from "../../src/sessions/normalization.js";

const projectId = "test-project" as UrlProjectId;
const PROJECT_HASH = "8e8fabade65fcb7be147f1c1f44eeb5f36a09680";

interface MessageSpec {
  id: string;
  data: Record<string, unknown>;
  parts: { id: string; data: Record<string, unknown> }[];
}

/**
 * Build a real OpenCode 1.16+ `opencode.db` fixture with the same shape the
 * reader queries: project -> session -> message -> part, where the JSON `data`
 * blobs omit id/sessionID/messageID (those live only as columns, as in the
 * real store). Mirrors the SQLite schema in topics/opencode-backend.md.
 */
function buildDb(
  dbPath: string,
  opts: {
    worktree: string;
    sessionId: string;
    title: string;
    model: Record<string, unknown>;
    messages: MessageSpec[];
    omitTranscriptTables?: boolean;
    extraSessions?: {
      sessionId: string;
      parentId?: string;
      title: string;
      agent?: string | null;
      messages?: MessageSpec[];
    }[];
  },
): void {
  const db = openSqliteOrThrow(dbPath);
  db.exec(
    "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER, time_updated INTEGER)",
  );
  db.exec(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, title TEXT, agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER)",
  );
  db.prepare(
    "INSERT INTO project (id, worktree, time_created, time_updated) VALUES (?, ?, ?, ?)",
  ).run(PROJECT_HASH, opts.worktree, 1000, 5000);
  const insertSession = db.prepare(
    "INSERT INTO session (id, project_id, parent_id, title, agent, model, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insertSession.run(
    opts.sessionId,
    PROJECT_HASH,
    null,
    opts.title,
    null,
    JSON.stringify(opts.model),
    1000,
    5000,
  );
  for (const extra of opts.extraSessions ?? []) {
    insertSession.run(
      extra.sessionId,
      PROJECT_HASH,
      extra.parentId ?? null,
      extra.title,
      extra.agent ?? null,
      JSON.stringify(opts.model),
      2000,
      6000,
    );
  }

  if (!opts.omitTranscriptTables) {
    db.exec(
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)",
    );
    db.exec(
      "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)",
    );
    const insM = db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    );
    const insP = db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    );
    let t = 1000;
    const writeMessages = (sessionId: string, messages: MessageSpec[]) => {
      for (const m of messages) {
        insM.run(m.id, sessionId, t, t, JSON.stringify(m.data));
        for (const p of m.parts) {
          insP.run(p.id, m.id, sessionId, t, t, JSON.stringify(p.data));
          t += 1;
        }
        t += 1;
      }
    };
    writeMessages(opts.sessionId, opts.messages);
    for (const extra of opts.extraSessions ?? []) {
      writeMessages(extra.sessionId, extra.messages ?? []);
    }
  }
  db.close();
}

const richMessages: MessageSpec[] = [
  {
    id: "msg_001",
    data: { role: "user", time: { created: 1000 } },
    parts: [{ id: "prt_001a", data: { type: "text", text: "hello from db" } }],
  },
  {
    id: "msg_002",
    data: {
      role: "assistant",
      modelID: "claude-opus-4.8",
      providerID: "github-copilot",
      time: { created: 2000, completed: 3000 },
      tokens: { input: 100, output: 20, cache: { read: 50 } },
    },
    parts: [
      // empty timing-only reasoning — must be skipped by the normalizer
      { id: "prt_002a", data: { type: "reasoning", text: "" } },
      { id: "prt_002b", data: { type: "reasoning", text: "thinking aloud" } },
      {
        id: "prt_002c",
        data: {
          type: "tool",
          tool: "bash",
          callID: "call_1",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "file.txt\n",
          },
        },
      },
      { id: "prt_002d", data: { type: "text", text: "final answer" } },
    ],
  },
];

describe.skipIf(!loadSqliteDriver())(
  "OpenCodeSessionReader (direct SQLite db reader)",
  () => {
    let testDir: string;
    let projectPath: string;
    let databasePath: string;
    let spawnMock: ReturnType<typeof vi.fn>;
    const readers = new Set<OpenCodeSessionReader>();

    beforeEach(async () => {
      testDir = join(tmpdir(), `opencode-db-test-${randomUUID()}`);
      projectPath = join(testDir, "project");
      databasePath = join(testDir, "opencode.db");
      await mkdir(projectPath, { recursive: true });

      // A spawn that immediately exits non-zero (no export output). The DB-backed
      // tests assert this is never reached; the fallthrough tests rely on it
      // returning null fast (no hang) so getSession resolves to null.
      spawnMock = vi.fn(() => {
        const child = new EventEmitter() as EventEmitter & {
          kill: ReturnType<typeof vi.fn>;
        };
        child.kill = vi.fn();
        queueMicrotask(() => child.emit("close", 1));
        return child as unknown as ChildProcess;
      });
      vi.doMock("node:child_process", async (importOriginal) => {
        const actual =
          await importOriginal<typeof import("node:child_process")>();
        return { ...actual, spawn: spawnMock };
      });
    });

    afterEach(async () => {
      for (const reader of readers) reader.close();
      readers.clear();
      vi.restoreAllMocks();
      vi.resetModules();
      await rm(testDir, { recursive: true, force: true });
    });

    async function makeReader() {
      const { OpenCodeSessionReader } = await import(
        "../../src/sessions/opencode-reader.js"
      );
      const reader = new OpenCodeSessionReader({
        storageDir: join(testDir, "missing-storage"),
        databasePath,
        opencodePath: "/fake/opencode",
        projectPath,
      });
      readers.add(reader);
      return reader;
    }

    it("omits the unfinished assistant tail only while an owned turn streams it", async () => {
      const unfinishedReply: MessageSpec = {
        id: "msg_004",
        data: { role: "assistant", time: { created: 4000 } },
        parts: [
          { id: "prt_004a", data: { type: "reasoning", text: "partial" } },
        ],
      };
      buildDb(databasePath, {
        worktree: projectPath,
        sessionId: "ses_live",
        title: "live",
        model: { id: "scripted", providerID: "fake" },
        messages: [
          ...richMessages,
          {
            id: "msg_003",
            data: { role: "user", time: { created: 3500 } },
            parts: [{ id: "prt_003a", data: { type: "text", text: "again" } }],
          },
          unfinishedReply,
        ],
      });
      const reader = await makeReader();
      const ids = async (
        afterMessageId?: string,
        ownedTurnInProgress?: boolean,
      ) => {
        const loaded = await reader.getSession(
          "ses_live",
          projectId,
          afterMessageId,
          { ownedTurnInProgress },
        );
        return loaded?.data.provider === "opencode"
          ? loaded.data.session.messages.map((entry) => entry.message.id)
          : null;
      };

      // The live stream owns the unfinished row, so a mid-turn read leaves
      // the catch-up cursor before it and the completed row arrives later.
      expect(await ids(undefined, true)).toEqual([
        "msg_001",
        "msg_002",
        "msg_003",
      ]);
      expect(await ids("msg_002", true)).toEqual(["msg_003"]);
      // Without an owned turn (external owner, or a killed turn that never
      // completes), the partial row stays visible.
      expect(await ids(undefined, false)).toEqual([
        "msg_001",
        "msg_002",
        "msg_003",
        "msg_004",
      ]);
      expect(await ids("msg_003", false)).toEqual(["msg_004"]);
    });

    it("renders a TUI-owned session from the DB with no subprocess", async () => {
      buildDb(databasePath, {
        worktree: projectPath,
        sessionId: "ses_db",
        title: "Yep Anywhere Session",
        model: {
          id: "claude-opus-4.8",
          providerID: "github-copilot",
          variant: "high",
        },
        messages: richMessages,
      });

      const reader = await makeReader();
      const loaded = await reader.getSession("ses_db", projectId);

      // Acceptance: no `opencode` child process is spawned for a 1.16+ session.
      expect(spawnMock).not.toHaveBeenCalled();

      expect(loaded?.summary).toMatchObject({
        id: "ses_db",
        provider: "opencode",
        // provider prefix preserved (provider rejects a bare modelID next turn)
        model: "github-copilot/claude-opus-4.8",
        // title falls back to first user text when the stored title is the default
        fullTitle: "hello from db",
        messageCount: 2,
      });
      // context fill = input + cache.read of the last assistant message
      expect(loaded?.summary.contextUsage).toMatchObject({ inputTokens: 150 });

      const normalized = normalizeSession(loaded!);
      expect(normalized.messages).toHaveLength(3);
      expect(normalized.messages[0]).toMatchObject({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello from db" }],
        },
      });

      // Empty reasoning is dropped and the tool name is normalized. The
      // settled result is a separate user message, matching the live path and
      // preserving per-call structured results/media.
      // toMatchObject on an array checks length + each element, so a stray block
      // (e.g. the skipped empty reasoning) would fail here.
      expect(normalized.messages[1].message?.content).toMatchObject([
        { type: "thinking", thinking: "thinking aloud" },
        { type: "tool_use", name: "Bash" },
        { type: "text", text: "final answer" },
      ]);
      expect(normalized.messages[2]).toMatchObject({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: "file.txt\n",
            },
          ],
        },
      });
    });

    it("pages with afterMessageId but keeps a full-session summary", async () => {
      buildDb(databasePath, {
        worktree: projectPath,
        sessionId: "ses_db",
        title: "Yep Anywhere Session",
        model: {
          id: "claude-opus-4.8",
          providerID: "github-copilot",
          variant: "high",
        },
        messages: richMessages,
      });

      const reader = await makeReader();
      const loaded = await reader.getSession("ses_db", projectId, "msg_001");
      expect(spawnMock).not.toHaveBeenCalled();

      const normalized = normalizeSession(loaded!);
      expect(normalized.messages).toHaveLength(2);
      expect(normalized.messages[0].type).toBe("assistant");
      expect(normalized.messages[1]).toMatchObject({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "call_1" }],
        },
      });
      // summary still describes the whole session, not just the page
      expect(loaded?.summary.messageCount).toBe(2);
    });

    it("reads a large transcript intact (no truncation)", async () => {
      const bigText = "x".repeat(600_000);
      buildDb(databasePath, {
        worktree: projectPath,
        sessionId: "ses_big",
        title: "Big",
        model: { id: "claude-opus-4.8", providerID: "github-copilot" },
        messages: [
          {
            id: "msg_001",
            data: { role: "user", time: { created: 1000 } },
            parts: [{ id: "prt_001a", data: { type: "text", text: "go" } }],
          },
          {
            id: "msg_002",
            data: { role: "assistant", time: { created: 2000 } },
            parts: [{ id: "prt_002a", data: { type: "text", text: bigText } }],
          },
        ],
      });

      const reader = await makeReader();
      const loaded = await reader.getSession("ses_big", projectId);
      expect(spawnMock).not.toHaveBeenCalled();

      const normalized = normalizeSession(loaded!);
      expect(normalized.messages[1]).toMatchObject({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: bigText }],
        },
      });
    });

    it("enumerates DB sessions with the db file as the index anchor", async () => {
      buildDb(databasePath, {
        worktree: projectPath,
        sessionId: "ses_db",
        title: "Yep Anywhere Session",
        model: { id: "claude-opus-4.8", providerID: "github-copilot" },
        messages: richMessages,
      });

      const reader = await makeReader();
      await expect(reader.listSessionFiles("/unused")).resolves.toEqual([
        // sharedFilePath: the db file's stat cannot validate a single session,
        // so the index must validate via getSessionSummaryIfChanged.
        { sessionId: "ses_db", filePath: databasePath, sharedFilePath: true },
      ]);

      const summaries = await reader.listSessions(projectId);
      expect(summaries.map((s) => s.id)).toEqual(["ses_db"]);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("answers unchanged-DB-session checks terminally, with no CLI spawn", async () => {
      buildDb(databasePath, {
        worktree: projectPath,
        sessionId: "ses_db",
        title: "Yep Anywhere Session",
        model: { id: "claude-opus-4.8", providerID: "github-copilot" },
        messages: richMessages,
      });

      const reader = await makeReader();
      // Cold check (sentinel cache values): produces the summary + row keys.
      const changed = await reader.getSessionSummaryIfChanged(
        "ses_db",
        projectId,
        -1,
        -1,
      );
      expect(changed?.summary.id).toBe("ses_db");

      // Re-check with the row-derived keys: unchanged must terminate at the
      // DB answer — previously it fell through to a per-session CLI spawn on
      // every index validation.
      await expect(
        reader.getSessionSummaryIfChanged(
          "ses_db",
          projectId,
          changed?.mtime ?? 0,
          changed?.size ?? 0,
        ),
      ).resolves.toBeNull();
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("falls through when the session is not in the DB project", async () => {
      buildDb(databasePath, {
        worktree: projectPath,
        sessionId: "ses_db",
        title: "Yep Anywhere Session",
        model: { id: "claude-opus-4.8", providerID: "github-copilot" },
        messages: richMessages,
      });

      const reader = await makeReader();
      // Unknown session id: DB returns null, file tree is absent, export yields
      // nothing (spawn exits non-zero) — overall null.
      await expect(
        reader.getSession("ses_absent", projectId),
      ).resolves.toBeNull();
      expect(spawnMock).toHaveBeenCalled();
    });

    it("degrades gracefully on a pre-1.16 schema (no message/part tables)", async () => {
      buildDb(databasePath, {
        worktree: projectPath,
        sessionId: "ses_db",
        title: "Yep Anywhere Session",
        model: { id: "claude-opus-4.8", providerID: "github-copilot" },
        messages: [],
        omitTranscriptTables: true,
      });

      const reader = await makeReader();
      // getSessionRow's message-count query hits a missing table -> reader returns
      // null and the call falls through (export yields nothing here).
      await expect(reader.getSession("ses_db", projectId)).resolves.toBeNull();
    });

    it("reuses native statements through refreshes and notices a formerly absent database", async () => {
      const reader = await makeReader();
      expect(await reader.getSessionSummary("ses_db", projectId)).toBeNull();
      buildDb(databasePath, {
        worktree: projectPath,
        sessionId: "ses_db",
        title: "native statement lifetime",
        model: { id: "claude-opus-4.8", providerID: "github-copilot" },
        messages: richMessages,
      });
      for (let index = 0; index < 100; index++) {
        expect(
          (await reader.getSessionSummary("ses_db", projectId))?.title,
        ).toBe("native statement lifetime");
        expect(
          (await reader.getSession("ses_db", projectId))?.data.provider,
        ).toBe("opencode");
      }
      // The portable statement ceiling catches prepare-per-query retention
      // even on Node, where native statement reclamation would hide it.
      reader.close();
      expect(await reader.getSessionSummary("ses_db", projectId)).toBeNull();
    });

    it("does not reopen native storage or launch a fallback after retirement during proof", async () => {
      const { OpenCodeDbReader } = await import(
        "../../src/sessions/opencode-db-reader.js"
      );
      const reader = await makeReader();
      let entered = () => {};
      let release = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(OpenCodeDbReader.prototype, "getProjectId").mockImplementation(
        async () => {
          entered();
          await held;
          return PROJECT_HASH;
        },
      );
      const pending = reader.getSession("ses_db", projectId);
      await started;
      reader.close();
      release();
      expect(await pending).toBeNull();
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("does not read the DB when OPENCODE_DB_READER is disabled", async () => {
      buildDb(databasePath, {
        worktree: projectPath,
        sessionId: "ses_db",
        title: "Yep Anywhere Session",
        model: { id: "claude-opus-4.8", providerID: "github-copilot" },
        messages: richMessages,
      });

      const prev = process.env.OPENCODE_DB_READER;
      process.env.OPENCODE_DB_READER = "0";
      try {
        const reader = await makeReader();
        // With the reader disabled, the DB is never opened; the session (which
        // exists only in the DB) falls through to the CLI export path — proven by
        // the export subprocess being spawned and the overall null result.
        await expect(
          reader.getSession("ses_db", projectId),
        ).resolves.toBeNull();
        expect(spawnMock).toHaveBeenCalled();
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_DB_READER;
        else process.env.OPENCODE_DB_READER = prev;
      }
    });

    it("nests parent_id child sessions under the parent and keeps them off the list", async () => {
      const parentMessages: MessageSpec[] = [
        ...richMessages,
        {
          id: "msg_task",
          data: { role: "assistant", time: { created: 4000 } },
          parts: [
            {
              id: "prt_task",
              data: {
                type: "tool",
                tool: "task",
                callID: "call_task_1",
                state: {
                  status: "completed",
                  input: {
                    description: "Explore the tree",
                    subagent_type: "explore",
                  },
                  metadata: { sessionId: "ses_child" },
                  output: "<task_metadata>\nsession_id: ses_child\n",
                },
              },
            },
          ],
        },
      ];
      buildDb(databasePath, {
        worktree: projectPath,
        sessionId: "ses_parent",
        title: "Parent session",
        model: { id: "claude-opus-4.8", providerID: "github-copilot" },
        messages: parentMessages,
        extraSessions: [
          {
            sessionId: "ses_child",
            parentId: "ses_parent",
            title: "Explore the tree (@explore subagent)",
            agent: "explore",
            messages: [
              {
                id: "msg_child",
                data: { role: "assistant", time: { created: 5000 } },
                parts: [
                  {
                    id: "prt_child",
                    data: { type: "text", text: "Child rollout" },
                  },
                ],
              },
            ],
          },
        ],
      });

      const reader = await makeReader();
      await expect(reader.listSessions(projectId)).resolves.toEqual([
        expect.objectContaining({ id: "ses_parent" }),
      ]);
      await expect(reader.listSessionFiles("/unused")).resolves.toEqual([
        {
          sessionId: "ses_parent",
          filePath: databasePath,
          sharedFilePath: true,
        },
      ]);
      await expect(
        reader.listProviderChildSessions("ses_parent"),
      ).resolves.toEqual([
        {
          id: "ses_child",
          parentSessionId: "ses_parent",
          title: "Explore the tree (@explore subagent)",
          agentType: "explore",
          updatedAt: new Date(6000).toISOString(),
        },
      ]);
      await expect(reader.getAgentMappings("ses_parent")).resolves.toEqual([
        { toolUseId: "call_task_1", agentId: "ses_child" },
        { toolUseId: "prt_task", agentId: "ses_child" },
      ]);
      const agent = await reader.getAgentSession("ses_child", "ses_parent");
      expect(agent?.status).toBe("completed");
      expect(agent?.messages[0]).toMatchObject({
        type: "assistant",
        isSubagent: true,
      });
    });
  },
);
