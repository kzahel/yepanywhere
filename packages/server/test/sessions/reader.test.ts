import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileTranscriptProjection } from "@yep-anywhere/shared/transcript/compiler";
import { normalizeSession } from "../../src/sessions/normalization.js";
import { SessionReader } from "../../src/sessions/reader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures", "agents");

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

      const summary = await reader.getSessionSummary(
        sessionId,
        "test-project" as UrlProjectId,
      );
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

    it("formats Claude command wrappers as the original slash command", async () => {
      const sessionId = "test-session-command";
      const commandMessage =
        "<command-message>harsh-review</command-message>\n" +
        "<command-name>/harsh-review</command-name>\n" +
        "<command-args>HEAD - check title cleanup</command-args>";
      const jsonl = JSON.stringify({
        type: "user",
        message: {
          content: commandMessage,
        },
        uuid: "msg-1",
        timestamp: new Date().toISOString(),
      });
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(sessionId, "test-project");
      expect(summary?.title).toBe("/harsh-review HEAD - check title cleanup");
      expect(summary?.fullTitle).toBe(
        "/harsh-review HEAD - check title cleanup",
      );
    });

    it("uses a session-opening slash command after Claude meta rows", async () => {
      const sessionId = "test-session-meta-command";
      const jsonl = [
        JSON.stringify({
          type: "user",
          isMeta: true,
          message: {
            content:
              "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>",
          },
          uuid: "meta-1",
          timestamp: "2026-07-24T17:15:43.435Z",
        }),
        JSON.stringify({
          type: "user",
          message: {
            content:
              "<command-name>/effort</command-name>\n" +
              "<command-message>effort</command-message>\n" +
              "<command-args></command-args>",
          },
          uuid: "command-1",
          parentUuid: "meta-1",
          timestamp: "2026-07-24T17:15:43.435Z",
        }),
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(sessionId, "test-project");
      expect(summary?.title).toBe("/effort");
      expect(summary?.fullTitle).toBe("/effort");
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

      const summary = await reader.getSessionSummary(
        sessionId,
        "test-project" as UrlProjectId,
      );
      expect(summary?.title).toBe("Help me refactor these files");
    });
  });

  describe("DAG handling", () => {
    it("summarizes the timestamp-selected active branch", async () => {
      const summaryReader = new SessionReader({
        sessionDir: testDir,
        getContextWindow: () => 10000,
      });
      const sessionId = "summary-active-branch";
      const jsonl = [
        JSON.stringify({
          type: "user",
          uuid: "root",
          parentUuid: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { content: "Original title", role: "user" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "dead-a",
          parentUuid: "root",
          timestamp: "2026-01-01T00:01:00.000Z",
          message: {
            content: [{ type: "text", text: "Dead branch response" }],
            model: "claude-haiku-4-5-20251101",
            usage: { input_tokens: 1000, output_tokens: 10 },
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "dead-u",
          parentUuid: "dead-a",
          timestamp: "2026-01-01T00:02:00.000Z",
          message: { content: "Dead branch follow-up", role: "user" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "active-a",
          parentUuid: "root",
          timestamp: "2026-01-01T00:10:00.000Z",
          message: {
            content: [{ type: "text", text: "Active branch answer" }],
            model: "qwen3-coder-128k:latest",
            usage: {
              input_tokens: 2000,
              cache_read_input_tokens: 30,
              cache_creation_input_tokens: 70,
              output_tokens: 20,
            },
          },
        }),
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await summaryReader.getSessionSummary(
        sessionId,
        "test-project" as UrlProjectId,
      );

      expect(summary?.title).toBe("Original title");
      expect(summary?.messageCount).toBe(2);
      expect(summary?.provider).toBe("claude-ollama");
      expect(summary?.model).toBe("qwen3-coder-128k:latest");
      expect(summary?.lastAgentText).toBe("Active branch answer");
      expect(summary?.updatedAt).toBe("2026-01-01T00:10:00.000Z");
      expect(summary?.contextUsage).toMatchObject({
        inputTokens: 2100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 70,
        contextWindow: 10000,
        percentage: 21,
      });
    });

    it("ignores non-conversation tail timestamps for summary freshness", async () => {
      const sessionId = "summary-internal-tail";
      const jsonl = [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { content: "Start", role: "user" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: "2026-01-01T00:01:00.000Z",
          message: {
            content: [{ type: "text", text: "Done" }],
            model: "claude-opus-4-5-20251101",
          },
        }),
        JSON.stringify({
          type: "system",
          subtype: "api_error",
          uuid: "s1",
          parentUuid: "a1",
          timestamp: "2026-01-01T00:30:00.000Z",
        }),
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(
        sessionId,
        "test-project" as UrlProjectId,
      );

      expect(summary?.updatedAt).toBe("2026-01-01T00:01:00.000Z");
    });

    it("advances summary freshness when meaningful content is appended", async () => {
      const sessionId = "summary-content-append";
      const filePath = join(testDir, `${sessionId}.jsonl`);
      const entries = [
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { content: "Start", role: "user" },
        },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: "2026-01-01T00:01:00.000Z",
          message: {
            content: [{ type: "text", text: "First answer" }],
            model: "claude-opus-4-5-20251101",
          },
        },
      ];
      await writeFile(
        filePath,
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );

      const before = await reader.getSessionSummary(
        sessionId,
        "test-project" as UrlProjectId,
      );
      expect(before?.updatedAt).toBe("2026-01-01T00:01:00.000Z");

      entries.push({
        type: "user",
        uuid: "u2",
        parentUuid: "a1",
        timestamp: "2026-01-01T00:02:00.000Z",
        message: { content: "Follow-up", role: "user" },
      });
      await writeFile(
        filePath,
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );

      const after = await reader.getSessionSummary(
        sessionId,
        "test-project" as UrlProjectId,
      );
      expect(after?.updatedAt).toBe("2026-01-01T00:02:00.000Z");
    });

    it("bridges progress-parented continuation in summaries", async () => {
      const sessionId = "summary-progress-parent";
      const jsonl = [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { content: "Start", role: "user" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: "2026-01-01T00:01:00.000Z",
          message: {
            content: [{ type: "tool_use", id: "tool-1", name: "Task" }],
            model: "claude-opus-4-5-20251101",
            usage: { input_tokens: 100, output_tokens: 5 },
          },
        }),
        JSON.stringify({
          type: "progress",
          uuid: "p1",
          parentUuid: "a1",
          timestamp: "2026-01-01T00:02:00.000Z",
          data: {},
          toolUseID: "tool-1",
          parentToolUseID: "tool-1",
        }),
        JSON.stringify({
          type: "user",
          uuid: "u2",
          parentUuid: "p1",
          timestamp: "2026-01-01T00:03:00.000Z",
          message: { content: "Continue", role: "user" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a2",
          parentUuid: "u2",
          timestamp: "2026-01-01T00:04:00.000Z",
          message: {
            content: [{ type: "text", text: "Final answer" }],
            model: "claude-opus-4-5-20251101",
            usage: { input_tokens: 200, output_tokens: 10 },
          },
        }),
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(
        sessionId,
        "test-project" as UrlProjectId,
      );

      expect(summary?.messageCount).toBe(4);
      expect(summary?.lastAgentText).toBe("Final answer");
    });

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

      const loadedSession = await reader.getSession(
        sessionId,
        "test-project" as UrlProjectId,
      );
      const session = loadedSession ? normalizeSession(loadedSession) : null;

      expect(session?.messages).toHaveLength(3); // a, d, e (not b, c)
      expect(session?.messages.map((m) => m.uuid)).toEqual(["a", "d", "e"]);
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

      const loadedSession = await reader.getSession(
        sessionId,
        "test-project" as UrlProjectId,
        undefined,
        {
          includeOrphans: true,
        },
      );
      const session = loadedSession ? normalizeSession(loadedSession) : null;

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

      const loadedSession = await reader.getSession(
        sessionId,
        "test-project" as UrlProjectId,
        undefined,
        {
          includeOrphans: true,
        },
      );
      const session = loadedSession ? normalizeSession(loadedSession) : null;

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

      const loadedSession = await reader.getSession(
        sessionId,
        "test-project",
        undefined,
        {
          includeOrphans: true,
        },
      );
      const session = loadedSession ? normalizeSession(loadedSession) : null;

      expect(session?.messages).toHaveLength(2);
      // tool-2 is orphaned but tool-1 is not
      expect(session?.messages[0]?.orphanedToolUseIds).toEqual(["tool-2"]);
    });

    it("finds tool_results on sibling branches for parallel tool calls", async () => {
      // This tests the parallel tool call structure observed in real sessions.
      // When Claude makes parallel tool calls, the SDK writes them as a chain
      // where each tool_use is a child of the previous one. Tool_results are
      // written as children of their corresponding tool_use, creating branches.
      //
      // Structure:
      //   tool_use #1 (Read file A)
      //   ├── tool_use #2 (Read file B)
      //   │   └── tool_result for B → continues to tip
      //   └── tool_result for A (sibling branch, no children - "dead branch")
      //
      // The tool_result for A is on a dead branch but is still valid!
      const sessionId = "dag-parallel-tools";
      const jsonl = [
        JSON.stringify({
          type: "assistant",
          uuid: "tool-use-1",
          parentUuid: null,
          message: {
            content: [
              { type: "tool_use", id: "read-file-a", name: "Read", input: {} },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "tool-use-2",
          parentUuid: "tool-use-1",
          message: {
            content: [
              { type: "tool_use", id: "read-file-b", name: "Read", input: {} },
            ],
          },
        }),
        // Tool result for file A - has same parent as tool-use-2, creating a branch
        JSON.stringify({
          type: "user",
          uuid: "result-a",
          parentUuid: "tool-use-1",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "read-file-a",
                content: "contents of file A",
              },
            ],
          },
        }),
        // Tool result for file B - child of tool-use-2, on the "winning" branch
        JSON.stringify({
          type: "user",
          uuid: "result-b",
          parentUuid: "tool-use-2",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "read-file-b",
                content: "contents of file B",
              },
            ],
          },
        }),
        // Conversation continues from result-b
        JSON.stringify({
          type: "assistant",
          uuid: "response",
          parentUuid: "result-b",
          message: {
            content: [{ type: "text", text: "Here are the file contents..." }],
          },
        }),
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const loadedSession = await reader.getSession(
        sessionId,
        "test-project" as UrlProjectId,
        undefined,
        { includeOrphans: true },
      );
      const session = loadedSession ? normalizeSession(loadedSession) : null;

      // Active branch: tool-use-1 -> tool-use-2 -> result-b -> response
      // result-a is on a sibling branch but is now INCLUDED in the output
      // (inserted after its parent tool-use-1) so the client can pair it
      expect(session?.messages).toHaveLength(5);
      expect(session?.messages.map((m) => m.uuid)).toEqual([
        "tool-use-1",
        "result-a", // sibling tool result, inserted after parent
        "tool-use-2",
        "result-b",
        "response",
      ]);

      // CRITICAL: Both tool_uses should NOT be marked as orphaned
      // because we scan ALL messages for tool_results, not just the active branch
      expect(session?.messages[0]?.orphanedToolUseIds).toBeUndefined();
      expect(session?.messages[2]?.orphanedToolUseIds).toBeUndefined(); // tool-use-2 is now at index 2
    });

    it("renders completed branch before later progress-resumed conversation", async () => {
      const sessionId = "dag-progress-resume-order";
      const jsonl = [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          parentUuid: null,
          message: { content: "test 123. hello." },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          message: {
            content: [
              { type: "text", text: "Hello! How can I help you today?" },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "u2",
          parentUuid: "a1",
          message: {
            content: "edit a sample file in the repo just for testing.",
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "thinking",
          parentUuid: "u2",
          message: {
            content: [{ type: "thinking", thinking: "Let me think briefly." }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "read-msg",
          parentUuid: "thinking",
          message: {
            content: [
              {
                type: "text",
                text: "Let me find a small file to make a test edit on.",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "read-tool",
          parentUuid: "read-msg",
          message: {
            content: [
              { type: "tool_use", id: "read-id", name: "Read", input: {} },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "read-result",
          parentUuid: "read-tool",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "read-id",
                content: "read done",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "edit-msg",
          parentUuid: "read-result",
          message: {
            content: [
              { type: "tool_use", id: "edit-id", name: "Edit", input: {} },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "edit-result",
          parentUuid: "edit-msg",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "edit-id",
                content: "edit done",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "edit-final",
          parentUuid: "edit-result",
          message: {
            content: [
              {
                type: "text",
                text: "Done — added a `<!-- test edit -->` comment on line 6 of `README.md`.",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "progress",
          uuid: "p1",
          parentUuid: "read-tool",
        }),
        JSON.stringify({
          type: "progress",
          uuid: "p2",
          parentUuid: "p1",
        }),
        JSON.stringify({
          type: "user",
          uuid: "thanks",
          parentUuid: "p2",
          message: { content: "very good. thank you." },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "welcome",
          parentUuid: "thanks",
          message: { content: [{ type: "text", text: "You're welcome!" }] },
        }),
        JSON.stringify({
          type: "user",
          uuid: "launch",
          parentUuid: "welcome",
          message: {
            content:
              "please launch a subagent that will remove that test edit by editing it out.",
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "agent-msg",
          parentUuid: "launch",
          message: {
            content: [
              { type: "tool_use", id: "agent-id", name: "Agent", input: {} },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "agent-result",
          parentUuid: "agent-msg",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "agent-id",
                content: "agent done",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "removed",
          parentUuid: "agent-result",
          message: {
            content: [
              {
                type: "text",
                text: "Done — the test edit has been removed. README.md is back to its original state.",
              },
            ],
          },
        }),
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const loadedSession = await reader.getSession(
        sessionId,
        "test-project" as UrlProjectId,
      );
      const session = loadedSession ? normalizeSession(loadedSession) : null;
      const renderItems = session
        ? compileTranscriptProjection(session.messages)
        : [];

      expect(session?.messages.map((message) => message.uuid)).toEqual([
        "u1",
        "a1",
        "u2",
        "thinking",
        "read-msg",
        "read-tool",
        "read-result",
        "edit-msg",
        "edit-result",
        "edit-final",
        "thanks",
        "welcome",
        "launch",
        "agent-msg",
        "agent-result",
        "removed",
      ]);

      expect(
        renderItems.map((item) =>
          item.type === "tool_call"
            ? `${item.type}:${item.toolName}`
            : item.type === "text"
              ? `${item.type}:${item.text}`
              : item.type === "user_prompt"
                ? `${item.type}:${typeof item.content === "string" ? item.content : ""}`
                : item.type,
        ),
      ).toEqual([
        "user_prompt:test 123. hello.",
        "text:Hello! How can I help you today?",
        "user_prompt:edit a sample file in the repo just for testing.",
        "thinking",
        "text:Let me find a small file to make a test edit on.",
        "tool_call:Read",
        "tool_call:Edit",
        "text:Done — added a `<!-- test edit -->` comment on line 6 of `README.md`.",
        "user_prompt:very good. thank you.",
        "text:You're welcome!",
        "user_prompt:please launch a subagent that will remove that test edit by editing it out.",
        "tool_call:Agent",
        "text:Done — the test edit has been removed. README.md is back to its original state.",
      ]);
    });
  });

  describe("getAgentSession", () => {
    it("reads agent JSONL file and returns messages", async () => {
      // Copy fixture to test directory
      const fixtureContent = await readFile(
        join(fixturesDir, "agent-completed.jsonl"),
        "utf-8",
      );
      await writeFile(join(testDir, "agent-test123.jsonl"), fixtureContent);

      const result = await reader.getAgentSession("test123");

      // Should have messages (system, user, assistant messages + result)
      expect(result.messages.length).toBeGreaterThan(0);
      expect(result.status).toBe("completed");
    });

    it("returns empty for missing agent file", async () => {
      const result = await reader.getAgentSession("nonexistent");

      expect(result.messages).toHaveLength(0);
      expect(result.status).toBe("pending");
    });

    it("infers completed status from result message", async () => {
      const fixtureContent = await readFile(
        join(fixturesDir, "agent-completed.jsonl"),
        "utf-8",
      );
      await writeFile(
        join(testDir, "agent-completed-test.jsonl"),
        fixtureContent,
      );

      const result = await reader.getAgentSession("completed-test");

      expect(result.status).toBe("completed");
    });

    it("infers failed status from error result", async () => {
      const fixtureContent = await readFile(
        join(fixturesDir, "agent-failed.jsonl"),
        "utf-8",
      );
      await writeFile(join(testDir, "agent-failed-test.jsonl"), fixtureContent);

      const result = await reader.getAgentSession("failed-test");

      expect(result.status).toBe("failed");
    });

    it("infers running status from incomplete session", async () => {
      const fixtureContent = await readFile(
        join(fixturesDir, "agent-running.jsonl"),
        "utf-8",
      );
      await writeFile(
        join(testDir, "agent-running-test.jsonl"),
        fixtureContent,
      );

      const result = await reader.getAgentSession("running-test");

      expect(result.status).toBe("running");
    });

    it("returns pending for empty agent file", async () => {
      await writeFile(join(testDir, "agent-empty.jsonl"), "");

      const result = await reader.getAgentSession("empty");

      expect(result.messages).toHaveLength(0);
      expect(result.status).toBe("pending");
    });

    it("applies DAG filtering to agent messages", async () => {
      // Create agent with branching structure
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
          message: { content: "Dead branch" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "c",
          parentUuid: "a",
          message: { content: "Active branch" },
        }),
        JSON.stringify({
          type: "result",
          uuid: "d",
          parentUuid: "c",
        }),
      ].join("\n");
      await writeFile(join(testDir, "agent-dag-test.jsonl"), jsonl);

      const result = await reader.getAgentSession("dag-test");

      // Should only have a, c, d (not b - dead branch)
      expect(result.messages).toHaveLength(3);
      expect(result.messages.map((m) => m.uuid)).toEqual(["a", "c", "d"]);
      expect(result.status).toBe("completed");
    });

    it("includes completed sibling tool branches in agent sessions for reload rendering", async () => {
      const jsonl = [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          parentUuid: null,
          message: { content: "Apply the refactor." },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "edit-1-msg",
          parentUuid: "user-1",
          message: {
            content: [
              {
                type: "tool_use",
                id: "edit-1",
                name: "Edit",
                input: {
                  file_path: "src/a.ts",
                  old_string: "a",
                  new_string: "b",
                },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "edit-2-msg",
          parentUuid: "edit-1-msg",
          message: {
            content: [
              {
                type: "tool_use",
                id: "edit-2",
                name: "Edit",
                input: {
                  file_path: "src/b.ts",
                  old_string: "x",
                  new_string: "y",
                },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "edit-1-result",
          parentUuid: "edit-1-msg",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "edit-1",
                content: "File modified.",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "edit-2-result",
          parentUuid: "edit-2-msg",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "edit-2",
                content: "File modified.",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-final",
          parentUuid: "edit-1-result",
          message: {
            content: [{ type: "text", text: "Applied both edits." }],
          },
        }),
        JSON.stringify({
          type: "result",
          uuid: "agent-result",
          parentUuid: "assistant-final",
        }),
      ].join("\n");
      await writeFile(join(testDir, "agent-render-branches.jsonl"), jsonl);

      const result = await reader.getAgentSession("render-branches");

      expect(result.messages.map((m) => m.uuid)).toEqual([
        "user-1",
        "edit-1-msg",
        "edit-2-msg",
        "edit-2-result",
        "edit-1-result",
        "assistant-final",
        "agent-result",
      ]);

      const renderItems = compileTranscriptProjection(result.messages);
      const editCalls = renderItems.filter(
        (item) => item.type === "tool_call" && item.toolName === "Edit",
      );

      expect(editCalls).toHaveLength(2);
      expect(result.status).toBe("completed");
    });
  });

  describe("getAgentMappings", () => {
    it("returns mappings of toolUseId to agentId", async () => {
      // Create agent files with parent_tool_use_id
      const agent1 = [
        JSON.stringify({
          type: "system",
          uuid: "sys-1",
          parent_tool_use_id: "tool-use-abc",
        }),
        JSON.stringify({
          type: "user",
          uuid: "msg-1",
          message: { content: "Hello" },
        }),
      ].join("\n");
      await writeFile(join(testDir, "agent-abc123.jsonl"), agent1);

      const agent2 = [
        JSON.stringify({
          type: "system",
          uuid: "sys-2",
          parent_tool_use_id: "tool-use-def",
        }),
        JSON.stringify({
          type: "user",
          uuid: "msg-2",
          message: { content: "World" },
        }),
      ].join("\n");
      await writeFile(join(testDir, "agent-def456.jsonl"), agent2);

      const mappings = await reader.getAgentMappings();

      expect(mappings).toHaveLength(2);
      expect(mappings).toContainEqual({
        toolUseId: "tool-use-abc",
        agentId: "abc123",
      });
      expect(mappings).toContainEqual({
        toolUseId: "tool-use-def",
        agentId: "def456",
      });
    });

    it("returns empty array when no agent files exist", async () => {
      const mappings = await reader.getAgentMappings();
      expect(mappings).toHaveLength(0);
    });

    it("includes agents without parent_tool_use_id using agentId as placeholder", async () => {
      // Agent file without parent_tool_use_id (new SDK format)
      const agent1 = [
        JSON.stringify({
          type: "system",
          uuid: "sys-1",
        }),
        JSON.stringify({
          type: "user",
          uuid: "msg-1",
          message: { content: "Hello" },
        }),
      ].join("\n");
      await writeFile(join(testDir, "agent-noparent.jsonl"), agent1);

      // Agent file with parent_tool_use_id (legacy format)
      const agent2 = [
        JSON.stringify({
          type: "system",
          uuid: "sys-2",
          parent_tool_use_id: "tool-use-xyz",
        }),
      ].join("\n");
      await writeFile(join(testDir, "agent-hasparent.jsonl"), agent2);

      const mappings = await reader.getAgentMappings();

      expect(mappings).toHaveLength(2);
      expect(mappings).toContainEqual({
        toolUseId: "tool-use-xyz",
        agentId: "hasparent",
      });
      // New SDK: agentId used as placeholder toolUseId
      expect(mappings).toContainEqual({
        toolUseId: "noparent",
        agentId: "noparent",
      });
    });

    it("handles empty agent files", async () => {
      await writeFile(join(testDir, "agent-empty.jsonl"), "");

      const mappings = await reader.getAgentMappings();
      expect(mappings).toHaveLength(0);
    });

    it("ignores non-agent JSONL files", async () => {
      // Create a regular session file
      const session = [
        JSON.stringify({
          type: "user",
          uuid: "msg-1",
          parent_tool_use_id: "should-be-ignored",
          message: { content: "Hello" },
        }),
      ].join("\n");
      await writeFile(join(testDir, "session123.jsonl"), session);

      const mappings = await reader.getAgentMappings();
      expect(mappings).toHaveLength(0);
    });

    it("finds parent_tool_use_id even if not on first line", async () => {
      // parent_tool_use_id on third line
      const agent = [
        JSON.stringify({
          type: "system",
          uuid: "sys-1",
        }),
        JSON.stringify({
          type: "config",
          uuid: "cfg-1",
        }),
        JSON.stringify({
          type: "init",
          uuid: "init-1",
          parent_tool_use_id: "tool-use-later",
        }),
      ].join("\n");
      await writeFile(join(testDir, "agent-later.jsonl"), agent);

      const mappings = await reader.getAgentMappings();

      expect(mappings).toHaveLength(1);
      expect(mappings[0]).toEqual({
        toolUseId: "tool-use-later",
        agentId: "later",
      });
    });
  });

  describe("getAgentMappings — SDK 0.2.76+ (subagents/ dir)", () => {
    it("finds current SDK children under their parent session", async () => {
      const parentSessionId = "parent-session";
      const subagentsDir = join(testDir, parentSessionId, "subagents");
      const otherSubagentsDir = join(testDir, "other-parent", "subagents");
      await mkdir(subagentsDir, { recursive: true });
      await mkdir(otherSubagentsDir, { recursive: true });

      const agent = JSON.stringify({
        type: "user",
        uuid: "msg-current",
        agentId: "current1",
        isSidechain: true,
        sessionId: parentSessionId,
        message: { content: "Investigate the bug" },
      });
      await writeFile(join(subagentsDir, "agent-current1.jsonl"), agent);
      await writeFile(
        join(subagentsDir, "agent-current1.meta.json"),
        JSON.stringify({
          agentType: "general-purpose",
          description: "Audit the restart guard",
          toolUseId: "toolu-launch-current",
          spawnDepth: 1,
        }),
      );
      await writeFile(
        join(otherSubagentsDir, "agent-other1.jsonl"),
        agent.replaceAll("current1", "other1"),
      );

      await expect(reader.getAgentMappings(parentSessionId)).resolves.toEqual([
        {
          toolUseId: "toolu-launch-current",
          agentId: "current1",
          agentType: "general-purpose",
          description: "Audit the restart guard",
          spawnDepth: 1,
        },
      ]);
      await expect(
        reader.listProviderChildSessions(parentSessionId),
      ).resolves.toEqual([
        expect.objectContaining({
          id: "current1",
          parentSessionId,
          title: "Audit the restart guard",
          agentType: "general-purpose",
          toolUseId: "toolu-launch-current",
          spawnDepth: 1,
          updatedAt: expect.any(String),
        }),
      ]);
    });

    it("finds agent files in subagents/ directory", async () => {
      const subagentsDir = join(testDir, "subagents");
      await mkdir(subagentsDir, { recursive: true });

      // New SDK format: no parent_tool_use_id, has agentId and isSidechain
      const agent = [
        JSON.stringify({
          type: "user",
          uuid: "msg-1",
          agentId: "abc123",
          isSidechain: true,
          sessionId: "parent-session",
          message: { content: "Hello" },
        }),
      ].join("\n");
      await writeFile(join(subagentsDir, "agent-abc123.jsonl"), agent);

      const mappings = await reader.getAgentMappings();
      expect(mappings).toHaveLength(1);
      // New SDK: uses agentId as placeholder toolUseId
      expect(mappings[0]).toEqual({
        toolUseId: "abc123",
        agentId: "abc123",
      });
    });

    it("reads agentType from meta.json", async () => {
      const subagentsDir = join(testDir, "subagents");
      await mkdir(subagentsDir, { recursive: true });

      const agent = [
        JSON.stringify({
          type: "user",
          uuid: "msg-1",
          agentId: "explore1",
          isSidechain: true,
          message: { content: "Hello" },
        }),
      ].join("\n");
      await writeFile(join(subagentsDir, "agent-explore1.jsonl"), agent);
      await writeFile(
        join(subagentsDir, "agent-explore1.meta.json"),
        JSON.stringify({ agentType: "Explore" }),
      );

      const mappings = await reader.getAgentMappings();
      expect(mappings).toHaveLength(1);
      expect(mappings[0]).toEqual({
        toolUseId: "explore1",
        agentId: "explore1",
        agentType: "Explore",
      });
    });

    it("deduplicates across subagents/ and root dirs", async () => {
      const subagentsDir = join(testDir, "subagents");
      await mkdir(subagentsDir, { recursive: true });

      const agentContent = JSON.stringify({
        type: "user",
        uuid: "msg-1",
        agentId: "dedup1",
        isSidechain: true,
        message: { content: "Hello" },
      });

      // Same agent in both locations
      await writeFile(join(subagentsDir, "agent-dedup1.jsonl"), agentContent);
      await writeFile(join(testDir, "agent-dedup1.jsonl"), agentContent);

      const mappings = await reader.getAgentMappings();
      expect(mappings).toHaveLength(1);
    });

    it("returns agentType with legacy parent_tool_use_id mapping", async () => {
      const subagentsDir = join(testDir, "subagents");
      await mkdir(subagentsDir, { recursive: true });

      const agent = [
        JSON.stringify({
          type: "system",
          uuid: "sys-1",
          parent_tool_use_id: "tool-use-legacy",
        }),
      ].join("\n");
      await writeFile(join(subagentsDir, "agent-legacy1.jsonl"), agent);
      await writeFile(
        join(subagentsDir, "agent-legacy1.meta.json"),
        JSON.stringify({ agentType: "Plan" }),
      );

      const mappings = await reader.getAgentMappings();
      expect(mappings).toHaveLength(1);
      expect(mappings[0]).toEqual({
        toolUseId: "tool-use-legacy",
        agentId: "legacy1",
        agentType: "Plan",
      });
    });
  });

  describe("getAgentSession — SDK 0.2.76+ (subagents/ dir)", () => {
    it("loads a current SDK child from its parent session directory", async () => {
      const parentSessionId = "parent-session";
      const subagentsDir = join(testDir, parentSessionId, "subagents");
      await mkdir(subagentsDir, { recursive: true });
      await writeFile(
        join(subagentsDir, "agent-current1.jsonl"),
        [
          JSON.stringify({
            type: "user",
            uuid: "msg-1",
            agentId: "current1",
            isSidechain: true,
            sessionId: parentSessionId,
            message: { content: "Research task" },
          }),
          JSON.stringify({
            type: "result",
            uuid: "msg-2",
            parentUuid: "msg-1",
          }),
        ].join("\n"),
      );

      const session = await reader.getAgentSession("current1", parentSessionId);
      expect(session.messages).toHaveLength(2);
      expect(session.status).toBe("completed");
    });

    it("loads agent from subagents/ directory", async () => {
      const subagentsDir = join(testDir, "subagents");
      await mkdir(subagentsDir, { recursive: true });

      const agent = [
        JSON.stringify({
          type: "user",
          uuid: "msg-1",
          agentId: "sub1",
          isSidechain: true,
          message: { content: "Research task" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "msg-2",
          parentUuid: "msg-1",
          agentId: "sub1",
          isSidechain: true,
          message: { content: [{ type: "text", text: "Found info" }] },
        }),
        JSON.stringify({
          type: "result",
          uuid: "msg-3",
          parentUuid: "msg-2",
        }),
      ].join("\n");
      await writeFile(join(subagentsDir, "agent-sub1.jsonl"), agent);

      const session = await reader.getAgentSession("sub1");
      expect(session.messages).toHaveLength(3);
      expect(session.status).toBe("completed");
    });

    it("reads agentType from meta.json", async () => {
      const subagentsDir = join(testDir, "subagents");
      await mkdir(subagentsDir, { recursive: true });

      const agent = [
        JSON.stringify({
          type: "user",
          uuid: "msg-1",
          message: { content: "Task" },
        }),
        JSON.stringify({
          type: "result",
          uuid: "msg-2",
          parentUuid: "msg-1",
        }),
      ].join("\n");
      await writeFile(join(subagentsDir, "agent-typed1.jsonl"), agent);
      await writeFile(
        join(subagentsDir, "agent-typed1.meta.json"),
        JSON.stringify({ agentType: "Explore" }),
      );

      const session = await reader.getAgentSession("typed1");
      expect(session.status).toBe("completed");
      expect(session.agentType).toBe("Explore");
    });

    it("returns undefined agentType when no meta.json", async () => {
      const subagentsDir = join(testDir, "subagents");
      await mkdir(subagentsDir, { recursive: true });

      const agent = JSON.stringify({
        type: "user",
        uuid: "msg-1",
        message: { content: "Task" },
      });
      await writeFile(join(subagentsDir, "agent-notype.jsonl"), agent);

      const session = await reader.getAgentSession("notype");
      expect(session.agentType).toBeUndefined();
    });

    it("prefers subagents/ over root dir", async () => {
      const subagentsDir = join(testDir, "subagents");
      await mkdir(subagentsDir, { recursive: true });

      // Root dir has different content
      await writeFile(
        join(testDir, "agent-pref1.jsonl"),
        JSON.stringify({
          type: "user",
          uuid: "root-msg",
          message: { content: "Root version" },
        }),
      );
      // subagents/ dir has different content
      await writeFile(
        join(subagentsDir, "agent-pref1.jsonl"),
        [
          JSON.stringify({
            type: "user",
            uuid: "sub-msg",
            message: { content: "Subagents version" },
          }),
          JSON.stringify({
            type: "result",
            uuid: "sub-result",
            parentUuid: "sub-msg",
          }),
        ].join("\n"),
      );

      const session = await reader.getAgentSession("pref1");
      // Should load from subagents/ (checked first)
      expect(session.messages).toHaveLength(2);
      expect(session.status).toBe("completed");
    });
  });

  describe("context usage with compaction", () => {
    /** Helper to create an assistant message with usage data */
    function assistantMsg(
      uuid: string,
      parentUuid: string | null,
      inputTokens: number,
      cacheRead = 0,
      cacheCreate = 0,
    ) {
      return JSON.stringify({
        type: "assistant",
        uuid,
        parentUuid,
        message: {
          content: [{ type: "text", text: "response" }],
          model: "claude-opus-4-5-20251101",
          usage: {
            input_tokens: inputTokens,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheCreate,
            output_tokens: 100,
          },
        },
        timestamp: new Date().toISOString(),
      });
    }

    /** Helper to create a user message */
    function userMsg(uuid: string, parentUuid: string | null) {
      return JSON.stringify({
        type: "user",
        uuid,
        parentUuid,
        message: { content: "question" },
        timestamp: new Date().toISOString(),
      });
    }

    /** Helper to create a compact_boundary entry */
    function compactBoundary(
      uuid: string,
      logicalParentUuid: string,
      preTokens: number,
    ) {
      return JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        uuid,
        parentUuid: null,
        logicalParentUuid,
        content: "Conversation compacted",
        compactMetadata: { trigger: "auto", preTokens },
        timestamp: new Date().toISOString(),
      });
    }

    /** Helper to create a compact summary user message */
    function compactSummary(uuid: string, parentUuid: string) {
      return JSON.stringify({
        type: "user",
        uuid,
        parentUuid,
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: { content: "Summary of previous conversation..." },
        timestamp: new Date().toISOString(),
      });
    }

    it("reports correct percentage without compaction", async () => {
      const sessionId = "ctx-no-compact";
      const jsonl = [
        userMsg("u1", null),
        // 80K tokens out of 200K = 40%
        assistantMsg("a1", "u1", 1, 60000, 20000),
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(
        sessionId,
        "test-project" as UrlProjectId,
      );
      expect(summary?.contextUsage?.percentage).toBe(40);
      expect(summary?.contextUsage?.inputTokens).toBe(80001);
    });

    it("reports provider usage after compaction by default", async () => {
      const sessionId = "ctx-single-compact";
      // Pre-compaction: assistant at 160K tokens
      // Compaction triggers at preTokens=167K (overhead = 167K - 160K = 7K)
      // Post-compaction: assistant at 50K tokens
      const jsonl = [
        userMsg("u1", null),
        assistantMsg("a1", "u1", 1, 150000, 10000), // 160001 tokens
        compactBoundary("cb1", "a1", 167000),
        compactSummary("summary1", "cb1"),
        assistantMsg("a2", "summary1", 1, 40000, 10000), // 50001 tokens raw
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(
        sessionId,
        "test-project" as UrlProjectId,
      );
      expect(summary?.contextUsage?.inputTokens).toBe(50001);
      expect(summary?.contextUsage?.percentage).toBe(25);

      const manualCompactionSummary = await reader.getSessionSummary(
        sessionId,
        "test-project" as UrlProjectId,
        { contextUsageMode: "manual-compaction" },
      );
      // The YA-owned manual guard keeps the conservative preTokens margin.
      expect(manualCompactionSummary?.contextUsage?.inputTokens).toBe(57000);
      expect(manualCompactionSummary?.contextUsage?.percentage).toBe(28);
    });

    it("uses only the latest compaction for the manual safety margin", async () => {
      const sessionId = "ctx-multi-compact";
      // First compaction: assistant at 160K, preTokens=167K (overhead=7K)
      // After first compaction: assistant grows to 89K
      // Second compaction: preTokens=168K (new overhead = 168K - 89K = 79K)
      // After second compaction: assistant at 50K reported.
      const jsonl = [
        userMsg("u1", null),
        assistantMsg("a1", "u1", 1, 150000, 10000), // 160001
        compactBoundary("cb1", "a1", 167000),
        compactSummary("s1", "cb1"),
        assistantMsg("a2", "s1", 1, 79000, 10000), // 89001 raw
        userMsg("u2", "a2"),
        assistantMsg("a3", "u2", 1, 79000, 10000), // 89001
        compactBoundary("cb2", "a3", 168000),
        compactSummary("s2", "cb2"),
        assistantMsg("a4", "s2", 1, 40000, 10000), // 50001 raw
      ].join("\n");
      await writeFile(join(testDir, `${sessionId}.jsonl`), `${jsonl}\n`);

      const summary = await reader.getSessionSummary(
        sessionId,
        "test-project" as UrlProjectId,
      );
      expect(summary?.contextUsage?.inputTokens).toBe(50001);
      expect(summary?.contextUsage?.percentage).toBe(25);

      const manualCompactionSummary = await reader.getSessionSummary(
        sessionId,
        "test-project" as UrlProjectId,
        { contextUsageMode: "manual-compaction" },
      );
      expect(manualCompactionSummary?.contextUsage?.inputTokens).toBe(129000);
      expect(manualCompactionSummary?.contextUsage?.percentage).toBe(65);
    });
  });
});
