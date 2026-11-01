import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeSession } from "../../src/sessions/normalization.js";

const projectId = "test-project" as UrlProjectId;

/**
 * Build a fake `spawn` that writes the given stdout to the file fd the reader
 * passes in `options.stdio[1]`, then emits `close`. This mirrors the real
 * file-fd capture path (opencode is a Bun binary whose large piped stdout is
 * truncated on exit, so the reader redirects child stdout to a real file).
 */
function makeSpawnMock(resolveStdout: (args: string[]) => string | null) {
  return vi.fn(
    (
      _file: string,
      args: string[],
      options: { stdio?: unknown[] } | undefined,
    ) => {
      const child = new EventEmitter() as EventEmitter & {
        kill: ReturnType<typeof vi.fn>;
      };
      child.kill = vi.fn();
      const fd = options?.stdio?.[1];
      const stdout = resolveStdout(args);
      queueMicrotask(() => {
        if (stdout !== null && typeof fd === "number") {
          try {
            writeSync(fd, stdout);
          } catch {
            // fall through to non-zero exit below if the fd is gone
          }
          child.emit("close", 0);
        } else {
          child.emit("close", 1);
        }
      });
      return child as unknown as ChildProcess;
    },
  );
}

describe("OpenCodeSessionReader", () => {
  let testDir: string;
  let projectPath: string;
  let databasePath: string;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDir = join(tmpdir(), `opencode-reader-test-${randomUUID()}`);
    projectPath = join(testDir, "project");
    databasePath = join(testDir, "opencode.db");
    await mkdir(projectPath, { recursive: true });
    await writeFile(databasePath, "sqlite placeholder");

    spawnMock = makeSpawnMock((args) => {
      if (args[0] === "export") {
        // Real opencode prints "Exporting session:" to stderr; the reader only
        // captures stdout, so write JSON only here.
        return JSON.stringify(makeExport(args[1] ?? "ses_cli", projectPath));
      }
      if (args.join(" ") === "session list --format json --max-count 200") {
        return JSON.stringify([
          {
            id: "ses_cli",
            title: "Yep Anywhere Session",
            directory: projectPath,
            created: 1000,
            updated: 4000,
          },
        ]);
      }
      return null;
    });

    vi.doMock("node:child_process", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: spawnMock,
      };
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    await rm(testDir, { recursive: true, force: true });
  });

  it("loads OpenCode 1.15 CLI exports when file storage is absent", async () => {
    const { OpenCodeSessionReader } = await import(
      "../../src/sessions/opencode-reader.js"
    );
    const reader = new OpenCodeSessionReader({
      storageDir: join(testDir, "missing-storage"),
      databasePath,
      opencodePath: "/fake/opencode",
      projectPath,
    });

    const loaded = await reader.getSession("ses_cli", projectId);
    expect(loaded?.summary).toMatchObject({
      id: "ses_cli",
      provider: "opencode",
      model: "local-glm/Qwen/Qwen3.6-27B",
      fullTitle: "present?",
      messageCount: 2,
    });

    const normalized = normalizeSession(loaded!);
    expect(normalized.messages).toHaveLength(2);
    expect(normalized.messages[0]).toMatchObject({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "present?" }] },
    });
    expect(normalized.messages[1]).toMatchObject({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Present." }],
      },
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "/fake/opencode",
      ["export", "ses_cli"],
      expect.objectContaining({ cwd: projectPath }),
    );
  });

  it("reads a large export in full (no pipe truncation / buffer cap)", async () => {
    // Guards the file-fd capture: a >256KB export must come back whole. A pipe
    // capture (old execFile path) truncated opencode's Bun stdout mid-string.
    const bigText = "x".repeat(600_000);
    spawnMock = makeSpawnMock((args) => {
      if (args[0] !== "export") return null;
      const exported = makeExport(args[1] ?? "ses_cli", projectPath);
      exported.messages[1].parts[0].text = bigText;
      return JSON.stringify(exported);
    });
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("node:child_process")>();
      return { ...actual, spawn: spawnMock };
    });
    vi.resetModules();

    const { OpenCodeSessionReader } = await import(
      "../../src/sessions/opencode-reader.js"
    );
    const reader = new OpenCodeSessionReader({
      storageDir: join(testDir, "missing-storage"),
      databasePath,
      opencodePath: "/fake/opencode",
      projectPath,
    });

    const loaded = await reader.getSession("ses_cli", projectId);
    const normalized = normalizeSession(loaded!);
    expect(normalized.messages).toHaveLength(2);
    expect(normalized.messages[1]).toMatchObject({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: bigText }],
      },
    });
  });

  it("preserves the provider prefix on the model (provider/model)", async () => {
    // Reload must yield `github-copilot/claude-opus-4.8`, not the bare
    // modelID — the OpenCode provider rejects a model without a provider
    // prefix ("must use provider/model format").
    spawnMock = makeSpawnMock((args) => {
      if (args[0] !== "export") return null;
      const exported = makeExport(args[1] ?? "ses_cli", projectPath);
      exported.info.model = {
        id: "claude-opus-4.8",
        providerID: "github-copilot",
        variant: "high",
      };
      return JSON.stringify(exported);
    });
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("node:child_process")>();
      return { ...actual, spawn: spawnMock };
    });
    vi.resetModules();

    const { OpenCodeSessionReader } = await import(
      "../../src/sessions/opencode-reader.js"
    );
    const reader = new OpenCodeSessionReader({
      storageDir: join(testDir, "missing-storage"),
      databasePath,
      opencodePath: "/fake/opencode",
      projectPath,
    });

    const loaded = await reader.getSession("ses_cli", projectId);
    expect(loaded?.summary.model).toBe("github-copilot/claude-opus-4.8");
  });

  it("enumerates CLI sessions with the OpenCode database as index anchor", async () => {
    const { OpenCodeSessionReader } = await import(
      "../../src/sessions/opencode-reader.js"
    );
    const reader = new OpenCodeSessionReader({
      storageDir: join(testDir, "missing-storage"),
      databasePath,
      opencodePath: "/fake/opencode",
      projectPath,
    });

    await expect(reader.listSessionFiles("/unused")).resolves.toEqual([
      { sessionId: "ses_cli", filePath: databasePath, sharedFilePath: true },
    ]);
  });

  it("does not reuse ambient CLI list results for a bound private native root", async () => {
    const { OpenCodeSessionReader } = await import(
      "../../src/sessions/opencode-reader.js"
    );
    const options = {
      storageDir: join(testDir, "missing-storage"),
      databasePath,
      opencodePath: "/fake/opencode",
      projectPath,
    };
    const ambient = new OpenCodeSessionReader(options);
    const bound = new OpenCodeSessionReader({
      ...options,
      nativeStorageScope: join(testDir, "private-native-root"),
    });
    try {
      expect(await ambient.listSessionFiles("unused")).toHaveLength(1);
      spawnMock.mockClear();
      expect(await bound.listSessionFiles("unused")).toEqual([]);
      expect(await bound.getSession("ses_cli", projectId)).toBeNull();
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      ambient.close();
      bound.close();
    }
  });

  it("probes CLI-session freshness from one cached session list, never export", async () => {
    const { OpenCodeSessionReader } = await import(
      "../../src/sessions/opencode-reader.js"
    );
    const reader = new OpenCodeSessionReader({
      storageDir: join(testDir, "missing-storage"),
      databasePath,
      opencodePath: "/fake/opencode",
      projectPath,
    });

    const changed = await reader.getSessionSummaryIfChanged(
      "ses_cli",
      projectId,
      -1,
      -1,
    );
    // Summary comes from the list row (updated: 4000), not an export.
    expect(changed?.summary.id).toBe("ses_cli");
    expect(changed?.mtime).toBe(4000);

    await expect(
      reader.getSessionSummaryIfChanged(
        "ses_cli",
        projectId,
        changed?.mtime ?? 0,
        changed?.size ?? 0,
      ),
    ).resolves.toBeNull();

    const spawnedArgs = spawnMock.mock.calls.map(
      (call) => (call[1] as string[])[0],
    );
    // One `session list` spawn serves both probes (shared TTL cache); the
    // per-session `export` spawn must not run during validation.
    expect(spawnedArgs).toEqual(["session"]);
  });

  it("does not load an exported session from a different project", async () => {
    spawnMock = makeSpawnMock((args) =>
      JSON.stringify(makeExport(args[1] ?? "ses_cli", join(testDir, "other"))),
    );
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("node:child_process")>();
      return { ...actual, spawn: spawnMock };
    });
    vi.resetModules();

    const { OpenCodeSessionReader } = await import(
      "../../src/sessions/opencode-reader.js"
    );
    const reader = new OpenCodeSessionReader({
      storageDir: join(testDir, "missing-storage"),
      databasePath,
      opencodePath: "/fake/opencode",
      projectPath,
    });

    await expect(reader.getSession("ses_cli", projectId)).resolves.toBeNull();
  });

  it("nests file-tree parentID children under the parent session", async () => {
    const storageDir = join(testDir, "storage");
    const openCodeProjectId = "prj-file";
    const parentId = "ses_file_parent";
    const childId = "ses_file_child";
    await mkdir(join(storageDir, "project"), { recursive: true });
    await mkdir(join(storageDir, "session", openCodeProjectId), {
      recursive: true,
    });
    await mkdir(join(storageDir, "message", parentId), { recursive: true });
    await mkdir(join(storageDir, "message", childId), { recursive: true });
    await mkdir(join(storageDir, "part", "msg_parent"), { recursive: true });
    await mkdir(join(storageDir, "part", "msg_child"), { recursive: true });
    await writeFile(
      join(storageDir, "project", `${openCodeProjectId}.json`),
      JSON.stringify({ id: openCodeProjectId, worktree: projectPath }),
    );
    await writeFile(
      join(storageDir, "session", openCodeProjectId, `${parentId}.json`),
      JSON.stringify({
        id: parentId,
        projectID: openCodeProjectId,
        title: "Parent file session",
        time: { created: 1_000, updated: 4_000 },
      }),
    );
    await writeFile(
      join(storageDir, "session", openCodeProjectId, `${childId}.json`),
      JSON.stringify({
        id: childId,
        projectID: openCodeProjectId,
        parentID: parentId,
        title: "Review the tree (@build subagent)",
        time: { created: 2_000, updated: 5_000 },
      }),
    );
    await writeFile(
      join(storageDir, "message", parentId, "msg_parent.json"),
      JSON.stringify({
        id: "msg_parent",
        sessionID: parentId,
        role: "user",
        time: { created: 1_000 },
      }),
    );
    await writeFile(
      join(storageDir, "part", "msg_parent", "prt_task.json"),
      JSON.stringify({
        id: "prt_task",
        type: "tool",
        tool: "task",
        callID: "call_file_task",
        state: {
          status: "completed",
          metadata: { sessionId: childId },
        },
      }),
    );
    await writeFile(
      join(storageDir, "message", childId, "msg_child.json"),
      JSON.stringify({
        id: "msg_child",
        sessionID: childId,
        role: "assistant",
        time: { created: 2_000 },
      }),
    );
    await writeFile(
      join(storageDir, "part", "msg_child", "prt_text.json"),
      JSON.stringify({
        id: "prt_text",
        type: "text",
        text: "File child",
      }),
    );

    const { OpenCodeSessionReader } = await import(
      "../../src/sessions/opencode-reader.js"
    );
    const reader = new OpenCodeSessionReader({
      storageDir,
      databasePath,
      opencodePath: "/fake/opencode",
      projectPath,
    });

    const listed = await reader.listSessions(projectId);
    expect(listed.map((session) => session.id)).toContain(parentId);
    expect(listed.map((session) => session.id)).not.toContain(childId);
    await expect(reader.listProviderChildSessions(parentId)).resolves.toEqual([
      {
        id: childId,
        parentSessionId: parentId,
        title: "Review the tree (@build subagent)",
        agentType: "build",
        updatedAt: new Date(5_000).toISOString(),
      },
    ]);
    await expect(reader.getAgentMappings(parentId)).resolves.toEqual([
      { toolUseId: "call_file_task", agentId: childId },
      { toolUseId: "prt_task", agentId: childId },
    ]);
    const agent = await reader.getAgentSession(childId, parentId);
    expect(agent?.messages[0]).toMatchObject({
      type: "assistant",
      isSubagent: true,
    });
  });
});

function makeExport(sessionId: string, directory: string) {
  return {
    info: {
      id: sessionId,
      directory,
      title: "Yep Anywhere Session",
      model: {
        id: "Qwen/Qwen3.6-27B",
        providerID: "local-glm",
        variant: "default",
      },
      time: {
        created: 1000,
        updated: 4000,
      },
    },
    messages: [
      {
        info: {
          id: "msg_user",
          sessionID: sessionId,
          role: "user",
          time: { created: 1000 },
        },
        parts: [
          {
            id: "part_user",
            sessionID: sessionId,
            messageID: "msg_user",
            type: "text",
            text: "present?",
          },
        ],
      },
      {
        info: {
          id: "msg_assistant",
          sessionID: sessionId,
          role: "assistant",
          modelID: "Qwen/Qwen3.6-27B",
          time: { created: 2000, completed: 4000 },
          tokens: {
            input: 128,
            output: 12,
            cache: { read: 32 },
          },
        },
        parts: [
          {
            id: "part_assistant",
            sessionID: sessionId,
            messageID: "msg_assistant",
            type: "text",
            text: "Present.",
          },
        ],
      },
    ],
  };
}
