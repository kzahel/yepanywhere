import {
  getCodexToolCorrelation,
  type CodexSessionEntry,
  type UnifiedSession,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { compileTranscriptProjection } from "@yep-anywhere/shared/transcript/compiler";
import type { Message as ClientMessage } from "../../../client/src/types.js";
import { CodexProvider } from "../../src/sdk/providers/codex.js";
import { normalizeSession } from "../../src/sessions/normalization.js";
import type { LoadedSession } from "../../src/sessions/types.js";

const READ_COMMAND =
  "sed -n '1,20p' CLAUDE.md && " +
  "sed -n '1,40p' DEVELOPMENT.md && " +
  "sed -n '1,60p' ARCHITECTURE.md";

type CodexProviderBridge = {
  convertItemToSDKMessages: (
    item: unknown,
    sessionId: string,
    turnId: string,
    sourceEvent: "item/started" | "item/completed",
  ) => Array<Record<string, unknown>>;
};

function buildLoadedSession(entries: CodexSessionEntry[]): LoadedSession {
  return {
    summary: {
      id: "display-action-parity",
      projectId: "test-project" as UrlProjectId,
      title: "Display action parity",
      fullTitle: "Display action parity",
      createdAt: "2026-07-10T00:00:00Z",
      updatedAt: "2026-07-10T00:00:02Z",
      messageCount: entries.length,
      status: "chat",
      provider: "codex",
    } as LoadedSession["summary"],
    data: {
      provider: "codex",
      events: [],
      session: { entries },
    } as UnifiedSession,
  };
}

function toolUseBlock(message: Record<string, unknown>) {
  const sdkMessage = message.message as
    | { content?: Array<Record<string, unknown>> }
    | undefined;
  return sdkMessage?.content?.find((block) => block.type === "tool_use");
}

function toolResultBlock(message: Record<string, unknown>) {
  const sdkMessage = message.message as
    | { content?: Array<Record<string, unknown>> }
    | undefined;
  return sdkMessage?.content?.find((block) => block.type === "tool_result");
}

describe("Codex display-action propagation parity", () => {
  it("carries the same compound action vector live and after rollout replay", () => {
    const callId = "call-three-reads";
    const liveItemId = "exec-three-reads";
    const turnId = "turn-three-reads";
    const codeModeInput = `const r = await tools.exec_command(${JSON.stringify({
      cmd: READ_COMMAND,
      workdir: "/repo",
    })}); text(r.output);`;
    const persistedMessages = normalizeSession(
      buildLoadedSession([
        {
          type: "response_item",
          timestamp: "2026-07-10T00:00:01Z",
          payload: {
            type: "custom_tool_call",
            call_id: callId,
            name: "exec",
            input: codeModeInput,
            internal_chat_message_metadata_passthrough: {
              turn_id: turnId,
            },
          },
        },
        {
          type: "response_item",
          timestamp: "2026-07-10T00:00:02Z",
          payload: {
            type: "custom_tool_call_output",
            call_id: callId,
            internal_chat_message_metadata_passthrough: {
              turn_id: turnId,
            },
            output: [
              {
                type: "input_text",
                text: "Script completed\nWall time 1 second\nOutput:\n",
              },
              { type: "input_text", text: "combined output\n" },
            ],
          },
        },
      ]),
    ).messages as unknown as Array<Record<string, unknown>>;

    const provider = new CodexProvider() as unknown as CodexProviderBridge;
    const liveMessages = provider.convertItemToSDKMessages(
      {
        id: liveItemId,
        type: "command_execution",
        command: `/bin/bash -lc ${JSON.stringify(READ_COMMAND)}`,
        cwd: "/repo",
        commandActions: [
          {
            type: "read",
            command: "provider-only oracle intentionally ignored",
            name: "wrong.md",
            path: "/wrong/oracle.md",
          },
        ],
        aggregated_output: "combined output\n",
        exit_code: 0,
        status: "completed",
      },
      "session-1",
      turnId,
      "item/completed",
    );

    const persistedToolUse = toolUseBlock(persistedMessages[0] ?? {});
    const liveToolUse = toolUseBlock(liveMessages[0] ?? {});
    expect(persistedToolUse?._displayActions).toEqual(
      liveToolUse?._displayActions,
    );
    expect(liveToolUse?._displayActions).toHaveLength(3);
    expect(liveToolUse?._displayActions).not.toContainEqual(
      expect.objectContaining({ path: "/wrong/oracle.md" }),
    );
    expect(persistedToolUse).toMatchObject({ id: callId, name: "Bash" });
    expect(liveToolUse).toMatchObject({ id: liveItemId, name: "Bash" });
    expect(getCodexToolCorrelation(persistedMessages[0])).toEqual({
      origin: "custom_tool_call",
      turnId,
      itemId: callId,
    });
    expect(getCodexToolCorrelation(liveMessages[0])).toMatchObject({
      origin: "command_execution",
      turnId,
      itemId: liveItemId,
    });
    expect(toolResultBlock(persistedMessages[1] ?? {})).toMatchObject({
      tool_use_id: callId,
    });
    expect(toolResultBlock(liveMessages[1] ?? {})).toMatchObject({
      tool_use_id: liveItemId,
      content: "combined output\n",
    });
    expect(getCodexToolCorrelation(persistedMessages[1])).toEqual({
      origin: "custom_tool_call",
      turnId,
      itemId: callId,
    });

    const persistedItem = compileTranscriptProjection(
      persistedMessages as unknown as ClientMessage[],
    ).find((item) => item.type === "tool_call");
    const liveItem = compileTranscriptProjection(
      liveMessages as unknown as ClientMessage[],
    ).find((item) => item.type === "tool_call");
    expect(persistedItem).toMatchObject({
      type: "tool_call",
      id: callId,
      toolName: "Bash",
      status: "complete",
      displayActions:
        liveItem?.type === "tool_call" ? liveItem.displayActions : [],
      toolResult: { isError: false },
    });
  });

  it("carries equivalent actions for 5.5 and 5.6 durable call shapes", () => {
    const functionCall = normalizeSession(
      buildLoadedSession([
        {
          type: "response_item",
          timestamp: "2026-07-10T00:00:01Z",
          payload: {
            type: "function_call",
            call_id: "call-55",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: READ_COMMAND, workdir: "/repo" }),
          },
        },
      ]),
    ).messages[0] as unknown as Record<string, unknown>;
    const customCall = normalizeSession(
      buildLoadedSession([
        {
          type: "response_item",
          timestamp: "2026-07-10T00:00:01Z",
          payload: {
            type: "custom_tool_call",
            call_id: "call-56",
            name: "exec",
            input: `const r = await tools.exec_command(${JSON.stringify({
              cmd: READ_COMMAND,
              workdir: "/repo",
            })}); text(r.output);`,
          },
        },
      ]),
    ).messages[0] as unknown as Record<string, unknown>;

    expect(toolUseBlock(functionCall)?._displayActions).toEqual(
      toolUseBlock(customCall)?._displayActions,
    );
  });
});
