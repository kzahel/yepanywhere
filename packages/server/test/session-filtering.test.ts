import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MockClaudeSDK } from "../src/sdk/mock.js";
import { encodeProjectId } from "../src/supervisor/types.js";

/**
 * Tests for session filtering behavior.
 *
 * Claude Code creates various types of .jsonl files that shouldn't be shown
 * as user-facing sessions:
 * - agent-*.jsonl: Subagent sidechain sessions (Task tool warmups)
 * - Empty files: Placeholder files with no content
 * - Metadata-only files: Files with only internal message types
 *
 * See docs/research/session-filtering.md for details.
 */
describe("Session Filtering", () => {
  let mockSdk: MockClaudeSDK;
  let testDir: string;
  let projectDir: string;
  let projectId: string;
  const projectPath = "/home/user/testproject";

  beforeEach(async () => {
    mockSdk = new MockClaudeSDK();
    testDir = join(tmpdir(), `claude-test-${randomUUID()}`);
    const encodedPath = projectPath.replaceAll("/", "-");
    projectDir = join(testDir, "localhost", encodedPath);
    projectId = encodeProjectId(projectPath);

    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("File-level filtering", () => {
    it("excludes agent-* files from session list", async () => {
      // Create a valid session
      await writeFile(
        join(projectDir, "valid-session.jsonl"),
        `${JSON.stringify({
          type: "user",
          cwd: projectPath,
          message: { content: "Hello" },
        })}\n`,
      );

      // Create an agent warmup session (should be excluded)
      await writeFile(
        join(projectDir, "agent-abc123.jsonl"),
        `${JSON.stringify({
          type: "user",
          cwd: projectPath,
          message: { content: "Warmup" },
          isSidechain: true,
          agentId: "abc123",
        })}\n`,
      );

      const app = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(`/api/projects/${projectId}/sessions`);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.sessions).toHaveLength(1);
      expect(json.sessions[0].id).toBe("valid-session");
    });

    it("excludes agent-* files from session count", async () => {
      // Create valid sessions
      await writeFile(
        join(projectDir, "sess-1.jsonl"),
        `${JSON.stringify({
          type: "user",
          cwd: projectPath,
          message: { content: "Hello 1" },
        })}\n`,
      );
      await writeFile(
        join(projectDir, "sess-2.jsonl"),
        `${JSON.stringify({
          type: "user",
          cwd: projectPath,
          message: { content: "Hello 2" },
        })}\n`,
      );

      // Create multiple agent sessions (should be excluded from count)
      for (let i = 0; i < 5; i++) {
        await writeFile(
          join(projectDir, `agent-${i}.jsonl`),
          `${JSON.stringify({
            type: "user",
            cwd: projectPath,
            message: { content: "Warmup" },
          })}\n`,
        );
      }

      const app = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request("/api/projects");
      const json = await res.json();

      expect(res.status).toBe(200);
      const project = json.projects.find(
        (p: { path: string }) => p.path === projectPath,
      );
      expect(project).toBeDefined();
      // Count should be 2, not 7
      expect(project.sessionCount).toBe(2);
    });
  });

  describe("Content-level filtering", () => {
    it("excludes empty files from session list", async () => {
      // Create a valid session
      await writeFile(
        join(projectDir, "valid-session.jsonl"),
        `${JSON.stringify({
          type: "user",
          cwd: projectPath,
          message: { content: "Hello" },
        })}\n`,
      );

      // Create an empty file
      await writeFile(join(projectDir, "empty-session.jsonl"), "");

      // Create a whitespace-only file
      await writeFile(
        join(projectDir, "whitespace-session.jsonl"),
        "   \n\n  ",
      );

      const app = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(`/api/projects/${projectId}/sessions`);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.sessions).toHaveLength(1);
      expect(json.sessions[0].id).toBe("valid-session");
    });

    it("excludes metadata-only files from session list", async () => {
      // Create a valid session
      await writeFile(
        join(projectDir, "valid-session.jsonl"),
        `${JSON.stringify({
          type: "user",
          cwd: projectPath,
          message: { content: "Hello" },
        })}\n`,
      );

      // Create a file with only file-history-snapshot entries
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

      // Create a file with only queue-operation entries
      await writeFile(
        join(projectDir, "queue-only.jsonl"),
        `${JSON.stringify({
          type: "queue-operation",
          operation: "dequeue",
          timestamp: new Date().toISOString(),
        })}\n`,
      );

      const app = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(`/api/projects/${projectId}/sessions`);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.sessions).toHaveLength(1);
      expect(json.sessions[0].id).toBe("valid-session");
    });

    it("counts only user/assistant messages in messageCount", async () => {
      // Create a session with mixed message types
      await writeFile(
        join(projectDir, "mixed-session.jsonl"),
        `${[
          // Internal messages (should not be counted)
          JSON.stringify({ type: "queue-operation", operation: "dequeue" }),
          JSON.stringify({ type: "file-history-snapshot", snapshot: {} }),
          // User message (should be counted)
          JSON.stringify({
            type: "user",
            cwd: projectPath,
            message: { content: "Hello" },
          }),
          // Assistant message (should be counted)
          JSON.stringify({
            type: "assistant",
            message: { content: "Hi there!" },
          }),
          // More internal messages
          JSON.stringify({ type: "file-history-snapshot", snapshot: {} }),
        ].join("\n")}\n`,
      );

      const app = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(`/api/projects/${projectId}/sessions`);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.sessions).toHaveLength(1);
      // Should count only user + assistant = 2, not all 5 lines
      expect(json.sessions[0].messageCount).toBe(2);
    });
  });

  describe("Title extraction", () => {
    it("extracts title from first user message", async () => {
      await writeFile(
        join(projectDir, "session.jsonl"),
        `${[
          JSON.stringify({ type: "queue-operation", operation: "dequeue" }),
          JSON.stringify({
            type: "user",
            cwd: projectPath,
            message: { content: "Help me debug this issue" },
          }),
          JSON.stringify({
            type: "assistant",
            message: { content: "Sure!" },
          }),
        ].join("\n")}\n`,
      );

      const app = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(`/api/projects/${projectId}/sessions`);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.sessions[0].title).toBe("Help me debug this issue");
    });

    it("truncates long titles to 50 characters", async () => {
      const longMessage =
        "This is a very long message that should be truncated because it exceeds the maximum title length";

      await writeFile(
        join(projectDir, "session.jsonl"),
        `${JSON.stringify({
          type: "user",
          cwd: projectPath,
          message: { content: longMessage },
        })}\n`,
      );

      const app = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(`/api/projects/${projectId}/sessions`);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.sessions[0].title.length).toBeLessThanOrEqual(50);
      expect(json.sessions[0].title).toContain("...");
    });

    it("returns null title when no user message found", async () => {
      // Session with only assistant message (unusual but possible)
      await writeFile(
        join(projectDir, "session.jsonl"),
        `${JSON.stringify({
          type: "assistant",
          cwd: projectPath,
          message: { content: "Hello!" },
        })}\n`,
      );

      const app = createApp({ sdk: mockSdk, projectsDir: testDir });
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
          JSON.stringify({
            type: "user",
            cwd: projectPath,
            message: { content: "Valid message" },
          }),
          "{ broken json",
        ].join("\n")}\n`,
      );

      const app = createApp({ sdk: mockSdk, projectsDir: testDir });
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
        `${JSON.stringify({
          type: "assistant",
          cwd: projectPath,
          message: { content: "Continuing from where we left off..." },
        })}\n`,
      );

      const app = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(`/api/projects/${projectId}/sessions`);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.sessions).toHaveLength(1);
    });
  });
});
