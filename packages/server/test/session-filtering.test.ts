import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { ProjectScanner } from "../src/projects/scanner.js";
import { createProjectsRoutes } from "../src/routes/projects.js";
import { ClaudeSessionReader } from "../src/sessions/reader.js";
import { OpenCodeSessionReader } from "../src/sessions/opencode-reader.js";
import type { ISessionReader } from "../src/sessions/types.js";
import { encodeProjectId } from "../src/supervisor/types.js";

/**
 * Messages without UUIDs are skipped by the DAG builder.
 */
function createMessage(
  type: "user" | "assistant",
  content: string,
  parentUuid?: string | null,
  extraFields: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type,
    uuid: randomUUID(),
    parentUuid: parentUuid ?? null,
    message: { content },
    ...extraFields,
  });
}

/**
 * Claude Code creates various types of .jsonl files that shouldn't be shown
 * as user-facing sessions:
 * - agent-*.jsonl: Subagent sidechain sessions (Task tool warmups)
 * - Empty files: Placeholder files with no content
 *
 * Metadata-only transcripts remain real sessions with zero conversation messages.
 * See topics/session-summary-fidelity.md for the reader contract.
 */
describe("Session Filtering", () => {
  let app: Hono;
  let scanner: ProjectScanner;
  let readers: Map<string, ISessionReader>;
  let testDir: string;
  let projectDir: string;
  let projectId: string;
  const projectPath = "/home/user/testproject";

  beforeEach(async () => {
    testDir = join(tmpdir(), `claude-test-${randomUUID()}`);
    const encodedPath = projectPath.replaceAll("/", "-");
    projectDir = join(testDir, "localhost", encodedPath);
    projectId = encodeProjectId(projectPath);

    await mkdir(projectDir, { recursive: true });
    // This contract belongs to the real scanner, transcript readers and HTTP
    // project routes. A full app also starts unrelated databases, provider
    // discovery and recurring supervisor work for each filtering assertion.
    scanner = new ProjectScanner({
      projectsDir: testDir,
      enableCodex: false,
      enableGemini: false,
    });
    readers = new Map();
    app = new Hono();
    app.route(
      "/api/projects",
      createProjectsRoutes({
        scanner,
        grokSessionsDir: join(testDir, "empty-grok"),
        piSessionsDir: join(testDir, "empty-pi"),
        readerFactory: (project) => {
          const key = `${project.provider}:${project.sessionDir}`;
          let reader = readers.get(key);
          if (!reader) {
            reader =
              project.provider === "opencode"
                ? new OpenCodeSessionReader({
                    projectPath: project.path,
                    storageDir: join(testDir, "empty-opencode/storage"),
                    databasePath: join(testDir, "empty-opencode/opencode.db"),
                    opencodePath: join(testDir, "empty-opencode/bin/opencode"),
                  })
                : new ClaudeSessionReader({ sessionDir: project.sessionDir });
            readers.set(key, reader);
          }
          return reader;
        },
      }),
    );
  });

  afterEach(async () => {
    await scanner.dispose();
    await Promise.all(
      Array.from(readers.values(), (reader) => reader.close?.()),
    );
    await rm(testDir, { recursive: true, force: true });
  });

  describe("File-level filtering", () => {
    it("excludes agent-* files from session list", async () => {
      await writeFile(
        join(projectDir, "valid-session.jsonl"),
        `${createMessage("user", "Hello", null, { cwd: projectPath })}\n`,
      );

      await writeFile(
        join(projectDir, "agent-abc123.jsonl"),
        `${createMessage("user", "Warmup", null, {
          cwd: projectPath,
          isSidechain: true,
          agentId: "abc123",
        })}\n`,
      );

      const res = await app.request(`/api/projects/${projectId}/sessions`);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.sessions).toHaveLength(1);
      expect(json.sessions[0].id).toBe("valid-session");
    });

    it("excludes agent-* files from session count", async () => {
      await writeFile(
        join(projectDir, "sess-1.jsonl"),
        `${createMessage("user", "Hello 1", null, { cwd: projectPath })}\n`,
      );
      await writeFile(
        join(projectDir, "sess-2.jsonl"),
        `${createMessage("user", "Hello 2", null, { cwd: projectPath })}\n`,
      );

      for (let i = 0; i < 5; i++) {
        await writeFile(
          join(projectDir, `agent-${i}.jsonl`),
          `${createMessage("user", "Warmup", null, { cwd: projectPath })}\n`,
        );
      }

      const res = await app.request("/api/projects");
      const json = await res.json();

      expect(res.status).toBe(200);
      const project = json.projects.find(
        (p: { path: string }) => p.path === projectPath,
      );
      expect(project).toBeDefined();
      expect(project.sessionCount).toBe(2);
    });
  });

  describe("Content-level filtering", () => {
    it("excludes empty files from session list", async () => {
      await writeFile(
        join(projectDir, "valid-session.jsonl"),
        `${createMessage("user", "Hello", null, { cwd: projectPath })}\n`,
      );

      await writeFile(join(projectDir, "empty-session.jsonl"), "");

      await writeFile(
        join(projectDir, "whitespace-session.jsonl"),
        "   \n\n  ",
      );

      const res = await app.request(`/api/projects/${projectId}/sessions`);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.sessions).toHaveLength(1);
      expect(json.sessions[0].id).toBe("valid-session");
    });

    it("includes metadata-only transcripts as sessions without conversation messages", async () => {
      await writeFile(
        join(projectDir, "valid-session.jsonl"),
        `${createMessage("user", "Hello", null, { cwd: projectPath })}\n`,
      );

      await writeFile(
        join(projectDir, "metadata-only.jsonl"),
        `${[
          JSON.stringify({
            type: "file-history-snapshot",
            messageId: "abc",
            snapshot: {},
          }),
          JSON.stringify({
            type: "file-history-snapshot",
            messageId: "def",
            snapshot: {},
          }),
        ].join("\n")}\n`,
      );

      await writeFile(
        join(projectDir, "queue-only.jsonl"),
        `${JSON.stringify({
          type: "queue-operation",
          operation: "dequeue",
          timestamp: new Date().toISOString(),
        })}\n`,
      );

      const res = await app.request(`/api/projects/${projectId}/sessions`);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.sessions).toHaveLength(3);
      for (const id of ["metadata-only", "queue-only"]) {
        expect(
          json.sessions.find((session: { id: string }) => session.id === id),
        ).toMatchObject({ id, title: null, messageCount: 0 });
      }
    });

    it("counts only user/assistant messages in messageCount", async () => {
      const userUuid = randomUUID();
      const assistantUuid = randomUUID();
      await writeFile(
        join(projectDir, "mixed-session.jsonl"),
        `${[
          // Internal messages (should not be counted, no uuid)
          JSON.stringify({ type: "queue-operation", operation: "dequeue" }),
          JSON.stringify({ type: "file-history-snapshot", snapshot: {} }),
          JSON.stringify({
            type: "user",
            uuid: userUuid,
            parentUuid: null,
            cwd: projectPath,
            message: { content: "Hello" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: assistantUuid,
            parentUuid: userUuid,
            message: { content: "Hi there!" },
          }),
          JSON.stringify({ type: "file-history-snapshot", snapshot: {} }),
        ].join("\n")}\n`,
      );

      const res = await app.request(`/api/projects/${projectId}/sessions`);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.sessions).toHaveLength(1);
      expect(json.sessions[0].messageCount).toBe(2);
    });
  });

  describe("Title extraction", () => {
    it("extracts title from first user message", async () => {
      const userUuid = randomUUID();
      const assistantUuid = randomUUID();
      await writeFile(
        join(projectDir, "session.jsonl"),
        `${[
          JSON.stringify({ type: "queue-operation", operation: "dequeue" }),
          JSON.stringify({
            type: "user",
            uuid: userUuid,
            parentUuid: null,
            cwd: projectPath,
            message: { content: "Help me debug this issue" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: assistantUuid,
            parentUuid: userUuid,
            message: { content: "Sure!" },
          }),
        ].join("\n")}\n`,
      );

      const res = await app.request(`/api/projects/${projectId}/sessions`);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.sessions[0].title).toBe("Help me debug this issue");
    });

    it("truncates long titles to 120 characters", async () => {
      const longMessage =
        "This is a very long message that should be truncated because it exceeds the maximum title length which is now 120 characters so we need an even longer test string here";

      await writeFile(
        join(projectDir, "session.jsonl"),
        `${createMessage("user", longMessage, null, { cwd: projectPath })}\n`,
      );

      const res = await app.request(`/api/projects/${projectId}/sessions`);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.sessions[0].title.length).toBeLessThanOrEqual(120);
      expect(json.sessions[0].title).toContain("...");
    });

    it("returns null title when no user message found", async () => {
      await writeFile(
        join(projectDir, "session.jsonl"),
        `${createMessage("assistant", "Hello!", null, { cwd: projectPath })}\n`,
      );

      const res = await app.request(`/api/projects/${projectId}/sessions`);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.sessions[0].title).toBeNull();
    });
  });

  describe("Edge cases", () => {
    it("handles malformed JSON lines gracefully", async () => {
      await writeFile(
        join(projectDir, "session.jsonl"),
        `${[
          "this is not json",
          createMessage("user", "Valid message", null, { cwd: projectPath }),
          "{ broken json",
        ].join("\n")}\n`,
      );

      const res = await app.request(`/api/projects/${projectId}/sessions`);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.sessions).toHaveLength(1);
      expect(json.sessions[0].title).toBe("Valid message");
    });

    it("includes sessions with only assistant messages", async () => {
      // Edge case: session might start with assistant if resumed mid-conversation
      await writeFile(
        join(projectDir, "session.jsonl"),
        `${createMessage("assistant", "Continuing from where we left off...", null, { cwd: projectPath })}\n`,
      );

      const res = await app.request(`/api/projects/${projectId}/sessions`);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.sessions).toHaveLength(1);
    });
  });
});
