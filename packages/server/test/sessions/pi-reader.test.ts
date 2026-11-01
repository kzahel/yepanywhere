import { parseNativeSessionId } from "@yep-anywhere/shared";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiProvider } from "../../src/sdk/providers/pi.js";
import { augmentEditToolUses } from "../../src/sessions/persisted-augments.js";
import { PiSessionReader } from "../../src/sessions/pi-reader.js";
import type { Message } from "../../src/supervisor/types.js";

const projectId = "pi-project" as UrlProjectId;
const sessionId = "019pi-render-fixture";

function jsonLine(value: unknown): string {
  return JSON.stringify(value);
}

function textResult(text: string) {
  return [{ type: "text", text }];
}

function toolUseBlocks(messages: Message[]) {
  return messages.flatMap((message) => {
    const content = message.message?.content;
    if (!Array.isArray(content)) return [];
    return content.filter((block) => block.type === "tool_use");
  });
}

function toolResultMessages(messages: Message[]) {
  return messages.filter((message) => {
    const content = message.message?.content;
    return (
      Array.isArray(content) &&
      content.some((block) => block.type === "tool_result")
    );
  });
}

describe("PiSessionReader", () => {
  let testDir: string;
  let sessionsDir: string;
  let projectPath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `pi-reader-test-${randomUUID()}`);
    sessionsDir = join(testDir, "sessions");
    projectPath = join(testDir, "project");
    await mkdir(projectPath, { recursive: true });
    await mkdir(join(sessionsDir, "--fixture--"), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("reloads pi JSONL actions in the same canonical shape as the live view", async () => {
    const jsonl = [
      jsonLine({
        type: "session",
        version: 3,
        id: sessionId,
        cwd: projectPath,
        timestamp: "2026-06-22T00:00:00.000Z",
      }),
      jsonLine({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-06-22T00:00:01.000Z",
        message: { role: "user", content: "inspect files" },
      }),
      jsonLine({
        type: "message",
        id: "a-read",
        parentId: "u1",
        timestamp: "2026-06-22T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "read-1",
              name: "read",
              arguments: { path: "src/a.ts", offset: 2, limit: 2 },
            },
          ],
          provider: "anthropic",
          model: "claude-sonnet-4-5",
        },
      }),
      jsonLine({
        type: "message",
        id: "r-read",
        parentId: "a-read",
        timestamp: "2026-06-22T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          content: textResult("line2\nline3"),
          isError: false,
        },
      }),
      jsonLine({
        type: "message",
        id: "a-bash",
        parentId: "r-read",
        timestamp: "2026-06-22T00:00:04.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "bash-1",
              name: "bash",
              arguments: { command: "printf 'ok\\n'", timeout: 10 },
            },
          ],
        },
      }),
      jsonLine({
        type: "message",
        id: "r-bash",
        parentId: "a-bash",
        timestamp: "2026-06-22T00:00:05.000Z",
        message: {
          role: "toolResult",
          toolCallId: "bash-1",
          toolName: "bash",
          content: textResult("ok\n"),
          isError: false,
        },
      }),
      jsonLine({
        type: "message",
        id: "a-apply-patch",
        parentId: "r-bash",
        timestamp: "2026-06-22T00:00:06.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "apply-1",
              name: "apply_patch",
              arguments: {
                patch:
                  "*** Begin Patch\n*** Update File: src/b.ts\n@@\n-old\n+new\n*** End Patch",
              },
            },
          ],
        },
      }),
      jsonLine({
        type: "message",
        id: "r-apply-patch",
        parentId: "a-apply-patch",
        timestamp: "2026-06-22T00:00:07.000Z",
        message: {
          role: "toolResult",
          toolCallId: "apply-1",
          toolName: "apply_patch",
          content: textResult("Patch applied successfully."),
          isError: false,
        },
      }),
      jsonLine({
        type: "message",
        id: "a-edit",
        parentId: "r-apply-patch",
        timestamp: "2026-06-22T00:00:08.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "edit-1",
              name: "edit",
              arguments: {
                path: "src/a.ts",
                edits: [
                  { oldText: "one", newText: "two" },
                  { oldText: "red", newText: "blue" },
                ],
              },
            },
          ],
        },
      }),
      jsonLine({
        type: "message",
        id: "r-edit",
        parentId: "a-edit",
        timestamp: "2026-06-22T00:00:09.000Z",
        message: {
          role: "toolResult",
          toolCallId: "edit-1",
          toolName: "edit",
          content: textResult("Successfully replaced 2 block(s) in src/a.ts."),
          details: {
            patch:
              "--- src/a.ts\n+++ src/a.ts\n@@ -1,2 +1,2 @@\n-one\n-red\n+two\n+blue",
          },
          isError: false,
        },
      }),
      jsonLine({
        type: "message",
        id: "a-edit-error",
        parentId: "r-edit",
        timestamp: "2026-06-22T00:00:10.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "edit-err",
              name: "edit",
              arguments: {
                path: "src/a.ts",
                edits: [{ oldText: "missing", newText: "replacement" }],
              },
            },
          ],
        },
      }),
      jsonLine({
        type: "message",
        id: "r-edit-error",
        parentId: "a-edit-error",
        timestamp: "2026-06-22T00:00:11.000Z",
        message: {
          role: "toolResult",
          toolCallId: "edit-err",
          toolName: "edit",
          content: textResult("Could not find edits[0] in src/a.ts."),
          details: {},
          isError: true,
        },
      }),
    ].join("\n");

    await writeFile(
      join(
        sessionsDir,
        "--fixture--",
        `2026-06-22T00-00-00-000Z_${sessionId}.jsonl`,
      ),
      `${jsonl}\n`,
    );

    const reader = new PiSessionReader({ sessionsDir, projectPath });
    const loaded = await reader.getSession(sessionId, projectId);
    expect(loaded?.summary).toMatchObject({
      id: sessionId,
      provider: "pi",
      messageCount: 11,
      title: "inspect files",
    });

    const messages = loaded?.data.session.messages as Message[];
    await augmentEditToolUses(messages);

    const uses = toolUseBlocks(messages);
    expect(
      uses.map((block) => ({ name: block.name, input: block.input })),
    ).toEqual([
      {
        name: "Read",
        input: { file_path: "src/a.ts", offset: 2, limit: 2 },
      },
      { name: "Bash", input: { command: "printf 'ok\\n'", timeout: 10 } },
      {
        name: "Edit",
        input: expect.objectContaining({
          patch:
            "*** Begin Patch\n*** Update File: src/b.ts\n@@\n-old\n+new\n*** End Patch",
          rawPatch:
            "*** Begin Patch\n*** Update File: src/b.ts\n@@\n-old\n+new\n*** End Patch",
          _rawPatch:
            "*** Begin Patch\n*** Update File: src/b.ts\n@@\n-old\n+new\n*** End Patch",
          _structuredPatch: expect.any(Array),
        }),
      },
      {
        name: "Edit",
        input: expect.objectContaining({
          file_path: "src/a.ts",
          edits: [
            { oldText: "one", newText: "two" },
            { oldText: "red", newText: "blue" },
          ],
          _rawPatch:
            "--- src/a.ts\n+++ src/a.ts\n@@ -1,2 +1,2 @@\n-one\n-red\n+two\n+blue",
          _structuredPatch: expect.any(Array),
        }),
      },
      {
        name: "Edit",
        input: expect.objectContaining({
          file_path: "src/a.ts",
          old_string: "missing",
          new_string: "replacement",
        }),
      },
    ]);

    const results = toolResultMessages(messages);
    expect(results.map((message) => message.toolUseResult)).toEqual([
      {
        type: "text",
        file: {
          filePath: "src/a.ts",
          content: "line2\nline3",
          numLines: 2,
          startLine: 2,
          totalLines: 3,
        },
      },
      { stdout: "ok\n", stderr: "", interrupted: false, isImage: false },
      expect.objectContaining({
        filePath: "",
        structuredPatch: [],
        piText: "Patch applied successfully.",
      }),
      expect.objectContaining({
        filePath: "src/a.ts",
        structuredPatch: [],
        piText: "Successfully replaced 2 block(s) in src/a.ts.",
      }),
      "Could not find edits[0] in src/a.ts.",
    ]);
  });

  it("shows a turn refused over its thinking level once, with its refusal after the prompt", async () => {
    const retrySessionId = "019pi-effort-retry";
    const refusal =
      "400 Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low.";
    const jsonl = [
      jsonLine({
        type: "session",
        version: 3,
        id: retrySessionId,
        cwd: projectPath,
        timestamp: "2026-09-27T00:00:00.000Z",
      }),
      // The refused turn, left on an abandoned branch by the set-aside.
      jsonLine({
        type: "message",
        id: "u-refused",
        parentId: null,
        timestamp: "2026-09-27T00:00:01.000Z",
        message: { role: "user", content: "ping" },
      }),
      jsonLine({
        type: "message",
        id: "a-refused",
        parentId: "u-refused",
        timestamp: "2026-09-27T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: refusal,
        },
      }),
      // What the set-aside and the resend append to the active branch.
      jsonLine({
        type: "custom",
        id: "c-retry",
        parentId: null,
        timestamp: "2026-09-27T00:00:03.000Z",
        customType: "yep-anywhere.effort-retry",
        data: { refusedLevel: "high", retryLevel: "medium", error: refusal },
      }),
      jsonLine({
        type: "thinking_level_change",
        id: "t-medium",
        parentId: "c-retry",
        timestamp: "2026-09-27T00:00:04.000Z",
        thinkingLevel: "medium",
      }),
      jsonLine({
        type: "message",
        id: "u-resent",
        parentId: "t-medium",
        timestamp: "2026-09-27T00:00:05.000Z",
        message: { role: "user", content: "ping" },
      }),
      jsonLine({
        type: "message",
        id: "a-answer",
        parentId: "u-resent",
        timestamp: "2026-09-27T00:00:06.000Z",
        message: { role: "assistant", content: textResult("pong") },
      }),
    ].join("\n");
    await writeFile(
      join(
        sessionsDir,
        "--fixture--",
        `2026-09-27T00-00-00-000Z_${retrySessionId}.jsonl`,
      ),
      `${jsonl}\n`,
    );

    const reader = new PiSessionReader({ sessionsDir, projectPath });
    const loaded = await reader.getSession(retrySessionId, projectId);
    const messages =
      loaded?.data.provider === "pi" ? loaded.data.session.messages : [];
    expect(
      messages.map((message) => [message.uuid, message.message?.content]),
    ).toEqual([
      ["u-resent", "ping"],
      [
        "c-retry",
        `_This model refused thinking level **high**, so the turn was retried at **medium**._\n\n> ${refusal}`,
      ],
      ["a-answer", [{ type: "text", text: "pong" }]],
    ]);
  });

  it("uses visible assistant text, not hidden thinking, for lastAgentText", async () => {
    const visibleSessionId = "019pi-visible-last-agent";
    const jsonl = [
      jsonLine({
        type: "session",
        version: 3,
        id: visibleSessionId,
        cwd: projectPath,
        timestamp: "2026-06-22T00:00:00.000Z",
      }),
      jsonLine({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-06-22T00:00:01.000Z",
        message: { role: "user", content: "inspect files" },
      }),
      jsonLine({
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-06-22T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "visible result" }],
        },
      }),
      jsonLine({
        type: "message",
        id: "a2",
        parentId: "a1",
        timestamp: "2026-06-22T00:00:03.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "hidden reasoning that should not drive previews",
            },
          ],
        },
      }),
    ].join("\n");
    await writeFile(
      join(
        sessionsDir,
        "--fixture--",
        `2026-06-22T00-00-00-000Z_${visibleSessionId}.jsonl`,
      ),
      `${jsonl}\n`,
    );

    const reader = new PiSessionReader({ sessionsDir, projectPath });
    const summary = await reader.getSessionSummary(visibleSessionId, projectId);
    expect(summary?.lastAgentText).toBe("visible result");
    expect(await reader.getLastAgentExcerpt(visibleSessionId)).toBe(
      "visible result",
    );
  });

  it("forks a pi session file at a retained message anchor", async () => {
    const sourceSessionId = "019pi-source-session";
    const sourcePath = join(
      sessionsDir,
      "--fixture--",
      `2026-06-22T00-00-00-000Z_${sourceSessionId}.jsonl`,
    );
    const jsonl = [
      jsonLine({
        type: "session",
        version: 3,
        id: sourceSessionId,
        cwd: projectPath,
        timestamp: "2026-06-22T00:00:00.000Z",
      }),
      jsonLine({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-06-22T00:00:01.000Z",
        message: { role: "user", content: "first" },
      }),
      jsonLine({
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-06-22T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "one" }],
        },
      }),
      jsonLine({
        type: "message",
        id: "u2",
        parentId: "a1",
        timestamp: "2026-06-22T00:00:03.000Z",
        message: { role: "user", content: "second" },
      }),
      jsonLine({
        type: "message",
        id: "a2",
        parentId: "u2",
        timestamp: "2026-06-22T00:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "two" }],
        },
      }),
      jsonLine({
        type: "message",
        id: "u3",
        parentId: "a2",
        timestamp: "2026-06-22T00:00:05.000Z",
        message: { role: "user", content: "third" },
      }),
      jsonLine({
        type: "message",
        id: "a3",
        parentId: "u3",
        timestamp: "2026-06-22T00:00:06.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "three" }],
        },
      }),
    ].join("\n");
    await writeFile(sourcePath, `${jsonl}\n`);

    const provider = new PiProvider({ sessionsDir });
    const fork = await provider.forkSession({
      nativeSessionId: parseNativeSessionId(sourceSessionId),
      cwd: projectPath,
      upToMessageId: "a2",
      title: "Forked pi session",
    });

    expect(fork.nativeSessionId).not.toBe(sourceSessionId);
    const files = await readdir(join(sessionsDir, "--fixture--"));
    const forkFile = files.find((file) =>
      file.endsWith(`_${fork.nativeSessionId}.jsonl`),
    );
    expect(forkFile).toBeTruthy();

    const forkRaw = await readFile(
      join(sessionsDir, "--fixture--", forkFile ?? ""),
      "utf-8",
    );
    const forkEntries = forkRaw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(forkEntries[0]).toMatchObject({
      type: "session",
      id: fork.nativeSessionId,
      cwd: projectPath,
      parentSession: sourcePath,
    });
    expect(
      forkEntries.slice(1).map((entry) => ({
        type: entry.type,
        id: entry.id,
        parentId: entry.parentId,
      })),
    ).toEqual([
      { type: "message", id: "u1", parentId: null },
      { type: "message", id: "a1", parentId: "u1" },
      { type: "message", id: "u2", parentId: "a1" },
      { type: "message", id: "a2", parentId: "u2" },
    ]);

    const reader = new PiSessionReader({ sessionsDir, projectPath });
    const loaded = await reader.getSession(fork.nativeSessionId, projectId);
    expect(loaded?.summary).toMatchObject({
      id: fork.nativeSessionId,
      provider: "pi",
      messageCount: 4,
      title: "first",
    });
  });
});
