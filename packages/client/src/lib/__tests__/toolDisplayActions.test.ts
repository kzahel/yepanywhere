import { describe, expect, it } from "vitest";
import type { Message } from "../../types.js";
import { compileTranscriptProjection } from "@yep-anywhere/shared/transcript/compiler";

describe("tool display-action preprocessing", () => {
  it("carries derived actions without changing tool-call structure", () => {
    const displayActions = [
      {
        kind: "read" as const,
        path: "CLAUDE.md",
        absolutePath: "/repo/CLAUDE.md",
        name: "CLAUDE.md",
        startLine: 1,
        endLine: 20,
      },
      {
        kind: "search" as const,
        query: "normalization",
        path: "packages/server",
      },
    ];
    const messages: Message[] = [
      {
        type: "assistant",
        uuid: "tool-message",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "compound exploration" },
              _displayActions: displayActions,
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "result-message",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "combined output",
            },
          ],
        },
      },
    ];

    expect(compileTranscriptProjection(messages)).toMatchObject([
      {
        type: "tool_call",
        id: "tool-1",
        toolName: "Bash",
        displayActions,
        status: "complete",
        toolResult: { content: "combined output", isError: false },
      },
    ]);
  });

  it("refreshes actions when a reconnect replaces a tool snapshot", () => {
    const messages: Message[] = [
      {
        type: "assistant",
        uuid: "stream-snapshot",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "cat CLAUDE.md" },
            },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "rollout-snapshot",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "cat CLAUDE.md" },
              _displayActions: [
                { kind: "read", path: "CLAUDE.md", name: "CLAUDE.md" },
              ],
            },
          ],
        },
      },
    ];

    const items = compileTranscriptProjection(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      displayActions: [{ kind: "read", path: "CLAUDE.md", name: "CLAUDE.md" }],
    });
  });
});
