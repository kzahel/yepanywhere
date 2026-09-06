import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import { CodexProvider } from "../../src/sdk/providers/codex.js";
import { createApp } from "../setup/create-app.js";

describe("Codex native compaction delivery", () => {
  let root: string;
  let projectPath: string;
  let projectId: string;
  let server: ReturnType<typeof createApp>;
  const sessionId = "compact-session";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ya-native-compact-"));
    projectPath = join(root, "project");
    projectId = encodeProjectId(projectPath);
    await mkdir(projectPath);
    await writeFile(join(root, "goal.json"), "null");
    const sessionsDir = join(root, "sessions");
    await mkdir(sessionsDir);
    await writeFile(
      join(sessionsDir, "rollout-compact-session.jsonl"),
      `${JSON.stringify({
        type: "session_meta",
        timestamp: "2026-09-06T06:00:00.000Z",
        payload: {
          id: sessionId,
          cwd: projectPath,
          timestamp: "2026-09-06T06:00:00.000Z",
          source: "vscode",
          cli_version: "0.153.4",
        },
      })}\n`,
    );
    const scriptPath = join(root, "codex.mjs");
    await copyFile(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../fixtures/codex/native-commands.mjs",
      ),
      scriptPath,
    );
    let codexPath = scriptPath;
    if (process.platform === "win32") {
      codexPath = join(root, "codex.cmd");
      await writeFile(
        codexPath,
        `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      );
    } else {
      await chmod(scriptPath, 0o755);
    }
    server = createApp({
      provider: new CodexProvider({ codexPath }),
      codexSessionsDir: sessionsDir,
      projectsDir: join(root, "claude"),
      dataDir: join(root, "data"),
    });
  });

  afterEach(async () => {
    for (const process of server.supervisor.getAllProcesses())
      await process.abort();
    await server.disposeSessionReaders();
    await rm(root, { recursive: true });
  });

  async function requests() {
    const text = await readFile(join(root, "requests.jsonl"), "utf8");
    return text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  function resume(message: string) {
    return server.app.request(
      `/api/projects/${projectId}/sessions/${sessionId}/resume`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({
          message,
          provider: "codex",
          tempId: "compact-send",
        }),
      },
    );
  }

  function sendCompact(path: "resume" | "direct" | "deferred") {
    if (path === "resume") return resume("/compact");
    return server.app.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Yep-Anywhere": "true" },
      body: JSON.stringify({
        message: "/compact",
        deferred: path === "deferred",
      }),
    });
  }

  it.each([null, "paused"])(
    "keeps an initial goal query idle with goal status %s",
    async (goalStatus) => {
      if (goalStatus) {
        await writeFile(
          join(root, "goal.json"),
          JSON.stringify({
            threadId: sessionId,
            objective: "Keep the paused goal",
            status: goalStatus,
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1,
            updatedAt: 1,
          }),
        );
      }
      const response = await resume("/goal");
      expect(response.status).toBe(200);
      const process = server.supervisor.getProcessForSession(sessionId);
      expect(process?.state.type).toBe("idle");
      expect(
        (await requests()).filter((r) => r.method === "turn/start"),
      ).toEqual([]);
      const deferred = process?.deferMessage(
        { text: "next work" },
        { promoteIfReady: true },
      );
      expect(deferred).toMatchObject({ success: true, promoted: true });
      await expect
        .poll(
          async () =>
            (await requests()).filter((r) => r.method === "turn/start").length,
        )
        .toBe(1);
    },
  );

  it("observes a goal-started turn before any assistant output", async () => {
    const response = await resume("/goal Work autonomously");
    expect(response.status).toBe(200);
    const process = server.supervisor.getProcessForSession(sessionId);
    await expect.poll(() => process?.state.type).toBe("in-turn");
    expect(
      process?.getMessageHistory().some((m) => m.type === "assistant"),
    ).toBe(false);
    expect((await requests()).filter((r) => r.method === "turn/start")).toEqual(
      [],
    );
  });

  it.each([null, "paused"])(
    "resumes directly into native compaction with goal status %s",
    async (goalStatus) => {
      if (goalStatus)
        await writeFile(
          join(root, "goal.json"),
          JSON.stringify({
            threadId: sessionId,
            objective: "Keep the paused goal",
            status: goalStatus,
            tokenBudget: null,
            tokensUsed: 12,
            timeUsedSeconds: 3,
            createdAt: 1,
            updatedAt: 1,
          }),
        );
      const response = await resume("/compact");
      expect(await response.json()).not.toHaveProperty("error");
      expect(response.status).toBe(200);
      expect(
        server.supervisor.getProcessForSession(sessionId)?.getMessageHistory(),
      ).toContainEqual(
        expect.objectContaining({
          type: "system",
          subtype: "local_command",
          tempId: "compact-send",
        }),
      );
      await expect
        .poll(
          async () =>
            (await requests()).filter(
              (r) => r.method === "thread/compact/start",
            ).length,
        )
        .toBe(1);
      const process = server.supervisor.getProcessForSession(sessionId);
      expect(process).toBeDefined();
      await expect
        .poll(() =>
          process
            ?.getMessageHistory()
            .some(
              (m) => m.type === "system" && m.subtype === "compact_boundary",
            ),
        )
        .toBe(true);
      expect(process?.getMessageHistory()).toContainEqual(
        expect.objectContaining({ type: "system", status: "compacting" }),
      );
      await expect.poll(() => process?.state.type).toBe("idle");
      expect(
        (await requests()).filter((r) => r.method === "turn/start"),
      ).toEqual([]);
      expect(
        (await requests()).filter((r) => r.method === "thread/goal/set"),
      ).toEqual([]);
      if (goalStatus)
        expect(await process?.supportedCommands()).toContainEqual(
          expect.objectContaining({
            name: "goal",
            providerDetails: {
              codex: { goalObjective: "Keep the paused goal", goalStatus },
            },
          }),
        );
    },
  );

  it.each(["resume", "direct", "deferred"] as const)(
    "compacts an idle session through %s delivery",
    async (path) => {
      expect((await resume("hello")).status).toBe(200);
      const process = server.supervisor.getProcessForSession(sessionId);
      await expect.poll(() => process?.state.type).toBe("idle");
      expect((await sendCompact(path)).status).toBe(200);
      await expect
        .poll(() =>
          process
            ?.getMessageHistory()
            .some(
              (m) => m.type === "system" && m.subtype === "compact_boundary",
            ),
        )
        .toBe(true);
      expect(
        (await requests()).filter((r) => r.method === "thread/compact/start"),
      ).toHaveLength(1);
      expect(
        (await requests()).filter((r) => r.method === "turn/start"),
      ).toHaveLength(1);
      expect(process?.getDeferredQueueSummary()).toEqual([]);
    },
  );

  it.each(["pause", "resume"])(
    "applies goal %s during work without another turn",
    async (action) => {
      await writeFile(
        join(root, "goal.json"),
        JSON.stringify({
          threadId: sessionId,
          objective: "Preserve current work",
          status: action === "pause" ? "active" : "paused",
          tokenBudget: null,
          tokensUsed: 12,
          timeUsedSeconds: 3,
          createdAt: 1,
          updatedAt: 1,
        }),
      );
      expect((await resume("hold")).status).toBe(200);
      const process = server.supervisor.getProcessForSession(sessionId);
      await expect
        .poll(async () =>
          (await requests()).some((r) => r.method === "turn/start"),
        )
        .toBe(true);
      const response = await server.app.request(
        `/api/sessions/${sessionId}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({ message: `/goal ${action}`, deferred: true }),
        },
      );
      expect(response.status).toBe(200);
      expect(process?.state.type).toBe("in-turn");
      expect(process?.getDeferredQueueSummary()).toEqual([]);
      expect(await process?.supportedCommands()).toContainEqual(
        expect.objectContaining({
          name: "goal",
          providerDetails: {
            codex: {
              goalObjective: "Preserve current work",
              goalStatus: action === "pause" ? "paused" : "active",
            },
          },
        }),
      );
      const log = await requests();
      expect(log.filter((r) => r.method === "thread/goal/set")).toHaveLength(1);
      expect(log.filter((r) => r.method === "turn/start")).toHaveLength(1);
      expect(log.filter((r) => r.method === "turn/interrupt")).toEqual([]);
    },
  );

  it.each(["resume", "direct", "deferred"] as const)(
    "rejects %s compaction during a turn without replacing the process",
    async (path) => {
      expect((await resume("hold")).status).toBe(200);
      const process = server.supervisor.getProcessForSession(sessionId);
      await expect
        .poll(async () =>
          (await requests()).some((r) => r.method === "turn/start"),
        )
        .toBe(true);
      const response = await sendCompact(path);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "Cannot compact while a turn is in progress",
      });
      expect(server.supervisor.getProcessForSession(sessionId)).toBe(process);
      expect(process?.isTerminated).toBe(false);
      expect(process?.getDeferredQueueSummary()).toEqual([]);
      expect(
        (await requests()).filter((r) => r.method === "thread/compact/start"),
      ).toEqual([]);
      expect(
        (await requests()).filter((r) => r.method === "turn/start"),
      ).toHaveLength(1);
    },
  );
});
