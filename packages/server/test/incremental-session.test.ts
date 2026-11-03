import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedClaudeProvider } from "./support/scripted-provider.js";
import { encodeProjectId } from "../src/supervisor/types.js";
import { createApp } from "./setup/create-app.js";

/**
 * Tests for incremental session loading via afterMessageId parameter.
 *
 * This allows clients to fetch only new messages instead of the entire session,
 * which is more efficient for live-updating external sessions.
 */
describe("Incremental Session Loading", () => {
  let mockSdk: ScriptedClaudeProvider;
  let testDir: string;
  let projectDir: string;
  let projectId: string;
  const projectPath = "/home/user/testproject";

  beforeEach(async () => {
    mockSdk = new ScriptedClaudeProvider();
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

      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });
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

      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });
      const res = await app.request(
        `/api/projects/${projectId}/sessions/session?afterMessageId=${msg1Id}`,
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.messages).toHaveLength(2);
      expect(json.messages[0].uuid).toBe(msg2Id);
      expect(json.messages[1].uuid).toBe(msg3Id);
    });

    it("reports that delta augmentation excludes unchanged rows", async () => {
      const userId = randomUUID();
      const assistantId = randomUUID();
      const newUserId = randomUUID();
      const newAssistantId = randomUUID();
      const sessionPath = join(projectDir, "session.jsonl");
      await writeFile(
        sessionPath,
        `${[
          JSON.stringify({
            type: "user",
            uuid: userId,
            parentUuid: null,
            cwd: projectPath,
            message: { content: "First" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: assistantId,
            parentUuid: userId,
            message: { content: `Old ${assistantId}` },
          }),
        ].join("\n")}\n`,
      );

      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });
      const initial = await app.request(
        `/api/projects/${projectId}/sessions/session`,
      );
      expect(initial.status).toBe(200);

      await appendFile(
        sessionPath,
        `${[
          JSON.stringify({
            type: "user",
            uuid: newUserId,
            parentUuid: assistantId,
            cwd: projectPath,
            message: { content: "New question" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: newAssistantId,
            parentUuid: newUserId,
            message: { content: `New ${newAssistantId}` },
          }),
        ].join("\n")}\n`,
      );

      const delta = await app.request(
        `/api/projects/${projectId}/sessions/session?afterMessageId=${assistantId}`,
      );
      const json = await delta.json();

      expect(delta.status).toBe(200);
      expect(
        json.messages.map((message: { uuid?: string }) => message.uuid),
      ).toEqual([newUserId, newAssistantId]);
      expect(delta.headers.get("Server-Timing")).toContain(
        'desc="messages=2 changed=1 cache-hit=0 cache-join=0 cache-miss=1"',
      );
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

      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });
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

      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });
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

      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });
      const res = await app.request(
        `/api/projects/${projectId}/sessions/session?afterMessageId=${msg1Id}`,
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      // Internal types (queue-operation, file-history-snapshot) are filtered out
      // Only returns the assistant message after msg1Id
      expect(json.messages).toHaveLength(1);
      expect(json.messages[0].uuid).toBe(msg2Id);
      expect(json.messages[0].type).toBe("assistant");
    });
  });

  describe("Edit input augmentation", () => {
    it("augments Codex-style apply_patch string input with structured patch data", async () => {
      const userId = randomUUID();
      const assistantId = randomUUID();
      const resultId = randomUUID();

      await writeFile(
        join(projectDir, "session.jsonl"),
        `${[
          JSON.stringify({
            type: "user",
            uuid: userId,
            parentUuid: null,
            cwd: projectPath,
            message: { content: "Apply patch" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: assistantId,
            parentUuid: userId,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tool-apply-patch",
                  name: "Edit",
                  input: [
                    "*** Begin Patch",
                    "*** Update File: src/example.ts",
                    "@@",
                    "-const x = 1;",
                    "+const x = 2;",
                    "*** End Patch",
                    "",
                  ].join("\n"),
                },
              ],
            },
          }),
          JSON.stringify({
            type: "user",
            uuid: resultId,
            parentUuid: assistantId,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-apply-patch",
                  content: "ok",
                },
              ],
            },
            toolUseResult: { ok: true },
          }),
        ].join("\n")}\n`,
      );

      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });
      const res = await app.request(
        `/api/projects/${projectId}/sessions/session`,
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      const assistantMessage = json.messages.find(
        (message: Record<string, unknown>) => message.type === "assistant",
      ) as Record<string, unknown> | undefined;
      const content = assistantMessage?.message as
        | { content?: Array<Record<string, unknown>> }
        | undefined;
      const toolUse = content?.content?.find(
        (block) => block.type === "tool_use" && block.name === "Edit",
      );
      const input = toolUse?.input as
        | {
            _rawPatch?: string;
            _structuredPatch?: unknown[];
            _diffHtml?: string;
          }
        | undefined;

      expect(input?._rawPatch).toContain("*** Begin Patch");
      expect(input?._structuredPatch?.length).toBeGreaterThan(0);
      expect(input?._diffHtml).toContain('class="line line-inserted"');
    });

    it("keeps Edit previews available on public share session reads", async () => {
      const userId = randomUUID();
      const assistantId = randomUUID();
      const resultId = randomUUID();

      await writeFile(
        join(projectDir, "session.jsonl"),
        `${[
          JSON.stringify({
            type: "user",
            uuid: userId,
            parentUuid: null,
            cwd: projectPath,
            message: { content: "Apply patch" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: assistantId,
            parentUuid: userId,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tool-apply-patch-public",
                  name: "Edit",
                  input: [
                    "*** Begin Patch",
                    "*** Update File: src/example.ts",
                    "@@",
                    "-const x = 1;",
                    "+const x = 2;",
                    "*** End Patch",
                    "",
                  ].join("\n"),
                },
              ],
            },
          }),
          JSON.stringify({
            type: "user",
            uuid: resultId,
            parentUuid: assistantId,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-apply-patch-public",
                  content: "ok",
                },
              ],
            },
            toolUseResult: { ok: true },
          }),
        ].join("\n")}\n`,
      );

      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });
      const res = await app.request(
        `/api/projects/${projectId}/sessions/session?publicShare=1`,
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      const assistantMessage = json.messages.find(
        (message: Record<string, unknown>) => message.type === "assistant",
      ) as Record<string, unknown> | undefined;
      const content = assistantMessage?.message as
        | { content?: Array<Record<string, unknown>> }
        | undefined;
      const toolUse = content?.content?.find(
        (block) => block.type === "tool_use" && block.name === "Edit",
      );
      const input = toolUse?.input as
        | {
            _rawPatch?: string;
            _structuredPatch?: unknown[];
            _diffHtml?: string;
          }
        | undefined;

      expect(input?._rawPatch).toContain("*** Begin Patch");
      expect(input?._structuredPatch?.length).toBeGreaterThan(0);
      expect(input?._diffHtml).toContain('class="line line-inserted"');
    });

    it("keeps raw patch fallback when parsing malformed patch text", async () => {
      const userId = randomUUID();
      const assistantId = randomUUID();
      const resultId = randomUUID();

      await writeFile(
        join(projectDir, "session.jsonl"),
        `${[
          JSON.stringify({
            type: "user",
            uuid: userId,
            parentUuid: null,
            cwd: projectPath,
            message: { content: "Apply malformed patch" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: assistantId,
            parentUuid: userId,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tool-malformed-patch",
                  name: "Edit",
                  input: "*** Begin Patch\nnot-a-valid-hunk\n*** End Patch\n",
                },
              ],
            },
          }),
          JSON.stringify({
            type: "user",
            uuid: resultId,
            parentUuid: assistantId,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-malformed-patch",
                  content: "ok",
                },
              ],
            },
            toolUseResult: { ok: true },
          }),
        ].join("\n")}\n`,
      );

      const { app } = createApp({ provider: mockSdk, projectsDir: testDir });
      const res = await app.request(
        `/api/projects/${projectId}/sessions/session`,
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      const assistantMessage = json.messages.find(
        (message: Record<string, unknown>) => message.type === "assistant",
      ) as Record<string, unknown> | undefined;
      const content = assistantMessage?.message as
        | { content?: Array<Record<string, unknown>> }
        | undefined;
      const toolUse = content?.content?.find(
        (block) => block.type === "tool_use" && block.name === "Edit",
      );
      const input = toolUse?.input as
        | {
            _rawPatch?: string;
            _structuredPatch?: unknown[];
            _diffHtml?: string;
          }
        | undefined;

      expect(input?._rawPatch).toContain("*** Begin Patch");
      expect(input?._structuredPatch).toBeUndefined();
      expect(input?._diffHtml).toBeUndefined();
    });
  });
});

describe("late-delivered Claude queue entries", () => {
  let mockSdk: ScriptedClaudeProvider;
  let testDir: string;
  let projectDir: string;
  let projectId: string;
  const projectPath = "/home/user/testproject";

  beforeEach(async () => {
    mockSdk = new ScriptedClaudeProvider();
    testDir = join(tmpdir(), `claude-test-${randomUUID()}`);
    const encodedPath = projectPath.replaceAll("/", "-");
    projectDir = join(testDir, "localhost", encodedPath);
    projectId = encodeProjectId(projectPath);
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeSteerSession() {
    const msg1Id = randomUUID();
    const msg2Id = randomUUID();
    const msg3Id = randomUUID();
    const msg4Id = randomUUID();

    // Mirrors the observed CLI shape: a steer while busy is persisted as a
    // queue-operation enqueue (stamped at enqueue time), later followed by a
    // remove at delivery time — never as a user row with YA's uuid.
    await writeFile(
      join(projectDir, "session.jsonl"),
      `${[
        JSON.stringify({
          type: "user",
          uuid: msg1Id,
          parentUuid: null,
          cwd: projectPath,
          timestamp: "2026-07-03T10:00:00.000Z",
          message: { content: "First" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: msg2Id,
          parentUuid: msg1Id,
          timestamp: "2026-07-03T10:00:05.000Z",
          message: { content: "Working" },
        }),
        JSON.stringify({
          type: "queue-operation",
          operation: "enqueue",
          content: "steer me",
          sessionId: "session",
          timestamp: "2026-07-03T10:00:10.000Z",
        }),
        JSON.stringify({
          type: "assistant",
          uuid: msg3Id,
          parentUuid: msg2Id,
          timestamp: "2026-07-03T10:00:20.000Z",
          message: { content: "Still working" },
        }),
        JSON.stringify({
          type: "queue-operation",
          operation: "remove",
          sessionId: "session",
          timestamp: "2026-07-03T10:00:30.000Z",
        }),
        JSON.stringify({
          type: "assistant",
          uuid: msg4Id,
          parentUuid: msg3Id,
          timestamp: "2026-07-03T10:00:35.000Z",
          message: { content: "Steered" },
        }),
      ].join("\n")}\n`,
    );

    return { msg3Id, msg4Id };
  }

  it("includes a pre-anchor queue entry delivered after the anchor row", async () => {
    const { msg3Id, msg4Id } = await writeSteerSession();

    const { app } = createApp({ provider: mockSdk, projectsDir: testDir });
    // Anchor at the mid-turn assistant row (10:00:20): positionally the
    // queue entry (enqueue position, 10:00:10) precedes it, but its delivery
    // (10:00:30) postdates it, so it must still be returned.
    const res = await app.request(
      `/api/projects/${projectId}/sessions/session?afterMessageId=${msg3Id}`,
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    const queueEntry = json.messages.find(
      (message: Record<string, unknown>) =>
        message.deferredSource === "queue-operation",
    );
    expect(queueEntry).toBeDefined();
    expect(queueEntry.content).toBe("steer me");
    expect(queueEntry.queueDeliveredAt).toBe("2026-07-03T10:00:30.000Z");
    expect(
      json.messages.some(
        (message: Record<string, unknown>) => message.uuid === msg4Id,
      ),
    ).toBe(true);
  });

  it("stops re-sending the queue entry once the anchor postdates delivery", async () => {
    const { msg4Id } = await writeSteerSession();

    const { app } = createApp({ provider: mockSdk, projectsDir: testDir });
    const res = await app.request(
      `/api/projects/${projectId}/sessions/session?afterMessageId=${msg4Id}`,
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(
      json.messages.some(
        (message: Record<string, unknown>) =>
          message.deferredSource === "queue-operation",
      ),
    ).toBe(false);
  });
});
