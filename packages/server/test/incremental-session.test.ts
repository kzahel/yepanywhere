import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MockClaudeSDK } from "../src/sdk/mock.js";
import { encodeProjectId } from "../src/supervisor/types.js";

/**
 * Tests for incremental session loading via afterMessageId parameter.
 *
 * This allows clients to fetch only new messages instead of the entire session,
 * which is more efficient for live-updating external sessions.
 */
describe("Incremental Session Loading", () => {
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

  describe("afterMessageId parameter", () => {
    it("returns all messages when afterMessageId is not provided", async () => {
      const msg1Id = randomUUID();
      const msg2Id = randomUUID();
      const msg3Id = randomUUID();

      await writeFile(
        join(projectDir, "session.jsonl"),
        `${[
          JSON.stringify({
            type: "user",
            uuid: msg1Id,
            parentUuid: null,
            cwd: projectPath,
            message: { content: "First" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: msg2Id,
            parentUuid: msg1Id,
            message: { content: "Second" },
          }),
          JSON.stringify({
            type: "user",
            uuid: msg3Id,
            parentUuid: msg2Id,
            message: { content: "Third" },
          }),
        ].join("\n")}\n`,
      );

      const app = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(
        `/api/projects/${projectId}/sessions/session`,
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.messages).toHaveLength(3);
    });

    it("returns only messages after the specified ID", async () => {
      const msg1Id = randomUUID();
      const msg2Id = randomUUID();
      const msg3Id = randomUUID();

      await writeFile(
        join(projectDir, "session.jsonl"),
        `${[
          JSON.stringify({
            type: "user",
            uuid: msg1Id,
            parentUuid: null,
            cwd: projectPath,
            message: { content: "First" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: msg2Id,
            parentUuid: msg1Id,
            message: { content: "Second" },
          }),
          JSON.stringify({
            type: "user",
            uuid: msg3Id,
            parentUuid: msg2Id,
            message: { content: "Third" },
          }),
        ].join("\n")}\n`,
      );

      const app = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(
        `/api/projects/${projectId}/sessions/session?afterMessageId=${msg1Id}`,
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.messages).toHaveLength(2);
      expect(json.messages[0].id).toBe(msg2Id);
      expect(json.messages[1].id).toBe(msg3Id);
    });

    it("returns empty array when afterMessageId is the last message", async () => {
      const msg1Id = randomUUID();
      const msg2Id = randomUUID();

      await writeFile(
        join(projectDir, "session.jsonl"),
        `${[
          JSON.stringify({
            type: "user",
            uuid: msg1Id,
            parentUuid: null,
            cwd: projectPath,
            message: { content: "First" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: msg2Id,
            parentUuid: msg1Id,
            message: { content: "Second" },
          }),
        ].join("\n")}\n`,
      );

      const app = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(
        `/api/projects/${projectId}/sessions/session?afterMessageId=${msg2Id}`,
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.messages).toHaveLength(0);
    });

    it("returns all messages when afterMessageId is not found", async () => {
      const msg1Id = randomUUID();

      await writeFile(
        join(projectDir, "session.jsonl"),
        `${JSON.stringify({
          type: "user",
          uuid: msg1Id,
          parentUuid: null,
          cwd: projectPath,
          message: { content: "First" },
        })}\n`,
      );

      const app = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(
        `/api/projects/${projectId}/sessions/session?afterMessageId=nonexistent`,
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      // Falls back to all messages when ID not found
      expect(json.messages).toHaveLength(1);
    });

    it("works correctly with internal message types interspersed", async () => {
      const msg1Id = randomUUID();
      const msg2Id = randomUUID();

      await writeFile(
        join(projectDir, "session.jsonl"),
        `${[
          JSON.stringify({ type: "queue-operation", operation: "dequeue" }),
          JSON.stringify({
            type: "user",
            uuid: msg1Id,
            parentUuid: null,
            cwd: projectPath,
            message: { content: "First" },
          }),
          JSON.stringify({ type: "file-history-snapshot", snapshot: {} }),
          JSON.stringify({
            type: "assistant",
            uuid: msg2Id,
            parentUuid: msg1Id,
            message: { content: "Second" },
          }),
        ].join("\n")}\n`,
      );

      const app = createApp({ sdk: mockSdk, projectsDir: testDir });
      const res = await app.request(
        `/api/projects/${projectId}/sessions/session?afterMessageId=${msg1Id}`,
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      // Internal types (queue-operation, file-history-snapshot) are filtered out
      // Only returns the assistant message after msg1Id
      expect(json.messages).toHaveLength(1);
      expect(json.messages[0].id).toBe(msg2Id);
      expect(json.messages[0].role).toBe("assistant");
    });
  });
});
