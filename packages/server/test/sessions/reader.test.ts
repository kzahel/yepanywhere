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

    it("truncates long titles to 50 chars with ellipsis", async () => {
      const sessionId = "test-session-5";
      const longMessage =
        "This is a very long message that should be truncated because it exceeds the maximum title length";
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
      expect(summary?.title?.length).toBe(50);
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
});
