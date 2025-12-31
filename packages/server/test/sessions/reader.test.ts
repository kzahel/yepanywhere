import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionReader } from "../../src/sessions/reader.js";

describe("SessionReader", () => {
  let testDir: string;
  let reader: SessionReader;

  beforeEach(async () => {
    testDir = join(tmpdir(), `claude-reader-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    reader = new SessionReader({ sessionDir: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("title extraction", () => {
    it("skips ide_opened_file blocks and uses actual message", async () => {
      const sessionId = "test-session-1";
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<ide_opened_file>The user opened the file /path/to/file.ts in the IDE. This may or may not be related.</ide_opened_file>",
            },
            {
              type: "text",
              text: "What does this function do?",
            },
          ],
        },
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(sessionId, "test-project");
      expect(summary?.title).toBe("What does this function do?");
    });

    it("skips ide_selection blocks and uses actual message", async () => {
      const sessionId = "test-session-2";
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<ide_selection>The user selected lines 1-10 from /path/file.ts:\nfunction foo() { }</ide_selection>",
            },
            {
              type: "text",
              text: "Can you explain this code?",
            },
          ],
        },
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(sessionId, "test-project");
      expect(summary?.title).toBe("Can you explain this code?");
    });

    it("handles messages with only IDE metadata", async () => {
      const sessionId = "test-session-3";
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<ide_opened_file>The user opened the file /path/to/file.ts in the IDE.</ide_opened_file>",
            },
          ],
        },
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(sessionId, "test-project");
      // When all blocks are IDE metadata, title is null (empty content)
      expect(summary?.title).toBeNull();
    });

    it("handles mixed IDE metadata and regular text in single block", async () => {
      const sessionId = "test-session-4";
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content:
            "<ide_opened_file>The user opened file.ts in the IDE.</ide_opened_file>What is this?",
        },
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(sessionId, "test-project");
      expect(summary?.title).toBe("What is this?");
    });

    it("truncates long titles to 120 chars with ellipsis", async () => {
      const sessionId = "test-session-5";
      const longMessage =
        "This is a very long message that should be truncated because it exceeds the maximum title length which is now 120 characters so we need an even longer test string here";
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content: longMessage,
        },
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(sessionId, "test-project");
      expect(summary?.title?.length).toBe(120);
      expect(summary?.title?.endsWith("...")).toBe(true);
    });

    it("preserves short titles without truncation", async () => {
      const sessionId = "test-session-6";
      const shortMessage = "Short message";
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content: shortMessage,
        },
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(sessionId, "test-project");
      expect(summary?.title).toBe("Short message");
    });

    it("returns null title for sessions with no user messages", async () => {
      const sessionId = "test-session-7";
      const jsonl = JSON.stringify({
        type: "assistant",
        message: {
          content: "Hello!",
        },
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(sessionId, "test-project");
      expect(summary?.title).toBeNull();
    });

    it("handles multiple IDE metadata blocks followed by message", async () => {
      const sessionId = "test-session-8";
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<ide_opened_file>The user opened file1.ts in the IDE.</ide_opened_file>",
            },
            {
              type: "text",
              text: "<ide_opened_file>The user opened file2.ts in the IDE.</ide_opened_file>",
            },
            {
              type: "text",
              text: "<ide_selection>Selected code here</ide_selection>",
            },
            {
              type: "text",
              text: "Help me refactor these files",
            },
          ],
        },
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(sessionId, "test-project");
      expect(summary?.title).toBe("Help me refactor these files");
    });
  });

  describe("DAG handling", () => {
    it("returns only active branch messages, filtering dead branches", async () => {
      const sessionId = "dag-test-1";
      // Structure:
      // a -> b -> c (dead branch, earlier lineIndex)
      //   \-> d -> e (active branch, later lineIndex)
      const jsonl = [
        JSON.stringify({
          type: "user",
          uuid: "a",
          parentUuid: null,
          message: { content: "First" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "b",
          parentUuid: "a",
          message: { content: "Dead branch response" },
        }),
        JSON.stringify({
          type: "user",
          uuid: "c",
          parentUuid: "b",
          message: { content: "Dead branch follow-up" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "d",
          parentUuid: "a",
          message: { content: "Active branch response" },
        }),
        JSON.stringify({
          type: "user",
          uuid: "e",
          parentUuid: "d",
          message: { content: "Active branch follow-up" },
        }),
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const session = await reader.getSession(sessionId, "test-project");

      expect(session?.messages).toHaveLength(3); // a, d, e (not b, c)
      expect(session?.messages.map((m) => m.id)).toEqual(["a", "d", "e"]);
    });

    it("marks orphaned tool calls with orphanedToolUseIds", async () => {
      const sessionId = "dag-test-2";
      const jsonl = [
        JSON.stringify({
          type: "assistant",
          uuid: "a",
          parentUuid: null,
          message: {
            content: [
              { type: "tool_use", id: "tool-1", name: "Read", input: {} },
            ],
          },
        }),
        // No tool_result for tool-1 (orphaned - process killed)
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const session = await reader.getSession(sessionId, "test-project");

      expect(session?.messages).toHaveLength(1);
      expect(session?.messages[0]?.orphanedToolUseIds).toEqual(["tool-1"]);
    });

    it("does not mark completed tools as orphaned", async () => {
      const sessionId = "dag-test-3";
      const jsonl = [
        JSON.stringify({
          type: "assistant",
          uuid: "a",
          parentUuid: null,
          message: {
            content: [
              { type: "tool_use", id: "tool-1", name: "Read", input: {} },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "b",
          parentUuid: "a",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: "file contents",
              },
            ],
          },
        }),
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const session = await reader.getSession(sessionId, "test-project");

      expect(session?.messages).toHaveLength(2);
      // First message has tool_use but it has a result, so no orphanedToolUseIds
      expect(session?.messages[0]?.orphanedToolUseIds).toBeUndefined();
    });

    it("handles mix of completed and orphaned tools", async () => {
      const sessionId = "dag-test-4";
      const jsonl = [
        JSON.stringify({
          type: "assistant",
          uuid: "a",
          parentUuid: null,
          message: {
            content: [
              { type: "tool_use", id: "tool-1", name: "Read", input: {} },
              { type: "tool_use", id: "tool-2", name: "Bash", input: {} },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "b",
          parentUuid: "a",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: "result for tool-1",
              },
              // No result for tool-2 (orphaned)
            ],
          },
        }),
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const session = await reader.getSession(sessionId, "test-project");

      expect(session?.messages).toHaveLength(2);
      // tool-2 is orphaned but tool-1 is not
      expect(session?.messages[0]?.orphanedToolUseIds).toEqual(["tool-2"]);
    });
  });
});
