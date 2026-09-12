// biome-ignore-all lint/complexity/useLiteralKeys: Bracket access exercises private production adapter seams while retaining their actual parameter types; no visibility-erasing assertion.
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import { observedDisplayCases } from "./observed-tool-display-specimens.js";
import { createHash } from "node:crypto";
import type {
  ClaudeSessionEntry,
  UnifiedSession,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { z } from "zod";
import { displayFixtures } from "../../../client/src/components/renderers/tools/__fixtures__/displayFixtures.js";
import { prepareDisplay } from "../../../client/src/components/renderers/tools/prepareDisplay.js";
import {
  toolDisplayContracts,
  type ToolDisplayName,
} from "../../../client/src/components/renderers/tools/toolDisplayContracts.js";
import type { ToolCallItem } from "@yep-anywhere/shared/transcript/items";
import { ClaudeProvider } from "../../src/sdk/providers/claude.js";
import { CodexOSSProvider } from "../../src/sdk/providers/codex-oss.js";
import { CodexProvider } from "../../src/sdk/providers/codex.js";
import type { LoadedSession } from "../../src/sessions/types.js";
import {
  runPersistedPipeline,
  runStreamPipeline,
} from "./render-parity-harness.js";

const timestamp = "2026-09-10T00:00:00.000Z";
const projectId = z
  .string()
  .transform((value) => value as UrlProjectId)
  .parse("L3RtcA");
function loaded(data: UnifiedSession): LoadedSession {
  return {
    transcriptSnapshotUpdatedAt: timestamp,
    summary: {
      id: "display-corpus",
      projectId,
      title: "Tool display corpus",
      fullTitle: "Tool display corpus",
      createdAt: timestamp,
      updatedAt: timestamp,
      messageCount: 2,
      ownership: { owner: "none" },
      provider: data.provider,
    },
    data,
  };
}
export interface NativeDisplayCase {
  id: string;
  provider:
    | "claude"
    | "codex"
    | "codex-oss"
    | "gemini"
    | "opencode"
    | "grok"
    | "pi";
  rawOutput?: unknown;
  provenance?: string;
  expectedKind?: "rich" | "partial" | "raw";
  expectedOperation?:
    | "renderToolResult"
    | "renderInline"
    | "renderCollapsedPreview";
  commandItem?: boolean;
  tool: ToolDisplayName;
  input: unknown;
  result: unknown;
  text: string;
  isError?: boolean;
  nativeName?: string;
  custom?: boolean;
}
const claudeTools = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "TodoWrite",
  "Task",
  "WebSearch",
  "WebFetch",
  "AskUserQuestion",
  "ExitPlanMode",
  "BashOutput",
  "TaskOutput",
  "KillShell",
  "TaskCreate",
  "TaskUpdate",
] as const;
const codexTools = [
  "Web",
  "UpdatePlan",
  "WriteStdin",
  "create_goal",
  "get_goal",
  "update_goal",
  "ViewImage",
  "spawn_agent",
  "Exec",
] as const;
const syntheticOnly = new Set([
  "Write/file",
  "Edit/augmented",
  "Edit/changes",
  "Edit/target",
  "Edit/patch",
  "TaskCreate/snapshot",
  "TaskUpdate/snapshot",
]);
export const nativeDisplayCases: NativeDisplayCase[] = [];
for (const tool of claudeTools) {
  for (const [variant, fixture] of Object.entries(displayFixtures[tool])) {
    if (syntheticOnly.has(`${tool}/${variant}`)) continue;
    nativeDisplayCases.push({
      id: `claude/${tool}/${variant}`,
      provider: "claude",
      tool,
      ...fixture,
    });
  }
}
for (const tool of codexTools) {
  for (const [variant, fixture] of Object.entries(displayFixtures[tool])) {
    nativeDisplayCases.push({
      id: `codex/${tool}/${variant}`,
      provider: "codex",
      tool,
      ...fixture,
      ...(tool === "Web"
        ? {
            custom: true,
            input:
              'text(await tools.web__run({search_query:[{q:"display contracts"}]}));',
            result:
              "Script completed\nWall time 0.8 seconds\nOutput:\nContract documentation (https://example.com/contract)\n\uE200cite\uE202turn1view0\uE201 [wordlim: 200] Content type: text/html; Total lines: 1\nL0: Checked values",
          }
        : tool === "Exec"
          ? {
              custom: true,
              input:
                'const a = tools.exec_command({cmd:"printf contract"}); const b = tools.exec_command({cmd:"printf second"}); text(await a); text(await b);',
            }
          : {}),
      ...(tool === "ViewImage" ? { result: "Image displayed" } : {}),
      nativeName:
        (
          {
            Web: "exec",
            UpdatePlan: "update_plan",
            WriteStdin: "write_stdin",
            ViewImage: "view_image",
            Exec: "exec",
          } as Record<string, string>
        )[tool] ?? tool,
    });
  }
}
nativeDisplayCases.push(
  {
    id: "claude/Write/rejected",
    provider: "claude",
    tool: "Write",
    input: { content: "validation-test" },
    result:
      "InputValidationError: Write failed: The required parameter `file_path` is missing",
    text: "file_path",
    isError: true,
  },
  {
    id: "claude/Write/file",
    provider: "claude",
    tool: "Write",
    input: { file_path: "/tmp/contract.js", content: "contract content" },
    result: {
      type: "text",
      file: {
        filePath: "/tmp/contract.js",
        content: "contract content",
        numLines: 1,
        startLine: 1,
        totalLines: 1,
      },
    },
    text: "contract content",
  },
  {
    id: "codex/Edit/patch",
    provider: "codex",
    tool: "Edit",
    nativeName: "apply_patch",
    custom: true,
    input:
      "*** Begin Patch\n*** Update File: /tmp/contract.ts\n@@\n-before\n+after\n*** End Patch",
    result: "Success. Updated the following files:\nM /tmp/contract.js",
    text: "after",
  },
);

export async function runNativeDisplayCase(fixture: NativeDisplayCase) {
  const callId = `display-${fixture.id}`;
  if (fixture.provider === "claude") {
    const { use, result, entries } = claudeDisplayRecords(fixture);
    const provider = new ClaudeProvider();
    return {
      live: await runStreamPipeline([
        provider["convertMessage"](use),
        provider["convertMessage"](result),
      ]),
      durable: await readClaudeDisplayEntries(entries),
    };
  }
  if (fixture.provider === "gemini") return runGeminiPair(fixture);
  if (fixture.provider === "opencode") return runOpenCodePair(fixture);
  if (fixture.provider === "grok") return runGrokPair(fixture);
  if (fixture.provider === "pi") return runPiPair(fixture);
  const provider = new CodexProvider();
  const state = provider["createLiveEventState"]();
  const name = fixture.nativeName ?? fixture.tool;
  const use = fixture.custom
    ? {
        type: "custom_tool_call" as const,
        name,
        call_id: callId,
        input: z.string().parse(fixture.input),
      }
    : {
        type: "function_call" as const,
        name,
        call_id: callId,
        arguments: JSON.stringify(fixture.input),
      };
  const result = {
    type: fixture.custom
      ? ("custom_tool_call_output" as const)
      : ("function_call_output" as const),
    call_id: callId,
    output:
      typeof fixture.result === "string"
        ? fixture.result
        : JSON.stringify(fixture.result),
  };
  const messages =
    fixture.provider === "codex-oss"
      ? new CodexOSSProvider()["convertItemToSDKMessages"](
          {
            type: "command_execution",
            id: callId,
            command: z.object({ command: z.string() }).parse(fixture.input)
              .command,
            aggregated_output: z.string().parse(fixture.rawOutput),
            exit_code: 0,
            status: "completed",
          },
          "display-corpus",
          `${callId}-message`,
          true,
        )
      : fixture.commandItem
        ? provider["convertNotificationToSDKMessages"](
            {
              method: "item/completed",
              params: {
                threadId: "display-corpus",
                turnId: "display-turn",
                item: {
                  id: callId,
                  type: "commandExecution",
                  command: z.object({ cmd: z.string() }).parse(fixture.input)
                    .cmd,
                  status: "completed",
                  aggregatedOutput: z.string().parse(fixture.result),
                  exitCode: 0,
                },
              },
            },
            "display-corpus",
            new Map(),
            state,
          )
        : [use, result].flatMap((item) =>
            provider["convertNotificationToSDKMessages"](
              {
                method: "rawResponseItem/completed",
                params: {
                  threadId: "display-corpus",
                  turnId: "display-turn",
                  item,
                },
              },
              "display-corpus",
              new Map(),
              state,
            ),
          );
  const live = await runStreamPipeline(messages);
  const entries: import("@yep-anywhere/shared").CodexSessionEntry[] = [
    use,
    result,
  ].map((payload) => ({ type: "response_item", timestamp, payload }));
  if (fixture.provider === "codex-oss") {
    entries.splice(1, 0, {
      type: "event_msg",
      timestamp,
      payload: {
        type: "exec_command_end",
        call_id: callId,
        aggregated_output: fixture.rawOutput,
        exit_code: 0,
        status: "completed",
      },
    });
  }
  const durable = await runPersistedPipeline(
    loaded({ provider: "codex", session: { entries } }),
  );
  return { live, durable };
}
export function preparedNativeRecord(item: ToolCallItem) {
  const contract:
    | import("../../../client/src/components/renderers/tools/prepareDisplay.js").DisplayContract<
        z.ZodType,
        z.ZodType
      >
    | undefined = Object.entries(toolDisplayContracts).find(
    ([name]) => name === item.toolName,
  )?.[1];
  if (!contract)
    throw new Error(`Unregistered native fixture tool ${item.toolName}`);
  const prepared = prepareDisplay(contract, {
    input: item.toolInput,
    result: item.toolResult?.structured ?? item.toolResult?.content,
    status: item.status,
    isError: item.toolResult?.isError,
  });
  return {
    kind: prepared.kind,
    status: prepared.status,
    isError: prepared.isError,
    input: prepared.input.success ? prepared.input.data : undefined,
    result: prepared.result?.success ? prepared.result.data : undefined,
    partial: prepared.partialResult?.success
      ? prepared.partialResult.data
      : undefined,
  };
}

import { GeminiProvider } from "../../src/sdk/providers/gemini.js";
import { OpenCodeProvider } from "../../src/sdk/providers/opencode.js";
import { GrokACPProvider } from "../../src/sdk/providers/grok-acp.js";
import { GrokSessionReader } from "../../src/sessions/grok-reader.js";

const renamedCases = [
  {
    tool: "Read",
    gemini: "read_file",
    opencode: "read",
    input: { file_path: "/tmp/contract.js" },
  },
  {
    tool: "Edit",
    gemini: "replace",
    opencode: "edit",
    input: {
      file_path: "/tmp/contract.js",
      old_string: "before",
      new_string: "after",
    },
  },
  {
    tool: "Write",
    gemini: "write_file",
    opencode: "write",
    input: { file_path: "/tmp/contract.js", content: "contract content" },
  },
  {
    tool: "Glob",
    gemini: "glob",
    opencode: "glob",
    input: { pattern: "*.js" },
  },
  {
    tool: "Grep",
    gemini: "search_file_content",
    opencode: "grep",
    input: { pattern: "contract" },
  },
  {
    tool: "Bash",
    gemini: "run_shell_command",
    opencode: "bash",
    input: { command: "printf contract" },
  },
] as const;
for (const fixture of renamedCases) {
  for (const provider of ["gemini", "opencode"] as const) {
    const renames: Record<string, string> =
      provider === "opencode"
        ? {
            file_path: "filePath",
            old_string: "oldString",
            new_string: "newString",
          }
        : { old_string: "old_content", new_string: "new_content" };
    const input = Object.fromEntries(
      Object.entries(fixture.input).map(([key, value]) => [
        renames[key] ?? key,
        value,
      ]),
    );
    nativeDisplayCases.push({
      id: `${provider}/${fixture.tool}/plain-text`,
      provider,
      tool: fixture.tool,
      nativeName: fixture[provider],
      input,
      result: "Contract text output",
      text: "Contract text output",
    });
  }
}
for (const [tool, nativeName, input] of [
  [
    "TodoWrite",
    "todowrite",
    {
      todos: [
        {
          content: "Verify contracts",
          status: "in_progress",
          activeForm: "Verifying contracts",
        },
      ],
    },
  ],
  [
    "Task",
    "task",
    {
      prompt: "Inspect contracts",
      description: "Contract agent",
      subagent_type: "general",
    },
  ],
  [
    "WebFetch",
    "webfetch",
    { url: "https://example.com", prompt: "Inspect contracts" },
  ],
  ["WebSearch", "websearch", { query: "contracts" }],
  [
    "AskUserQuestion",
    "question",
    displayFixtures.AskUserQuestion.standard.input,
  ],
  [
    "Edit",
    "apply_patch",
    {
      patchText:
        "*** Begin Patch\n*** Update File: /tmp/contract.ts\n@@\n-before\n+after\n*** End Patch",
    },
  ],
] as const)
  nativeDisplayCases.push({
    id: `opencode/${nativeName}/plain-text`,
    provider: "opencode",
    tool,
    nativeName,
    input,
    result: "Contract text output",
    text: "Contract text output",
  });

async function runGeminiPair(fixture: NativeDisplayCase) {
  const callId = `display-${fixture.id}`;
  const provider = new GeminiProvider();
  const nativeName = fixture.nativeName ?? fixture.tool;
  const input = z.record(z.string(), z.unknown()).parse(fixture.input);
  const output = z.string().parse(fixture.result);
  const messages = [
    provider["convertEventToSDKMessage"](
      {
        type: "tool_use",
        timestamp,
        tool_name: nativeName,
        tool_id: callId,
        parameters: input,
      },
      "display-corpus",
    ),
    provider["convertEventToSDKMessage"](
      {
        type: "tool_result",
        timestamp,
        tool_id: callId,
        status: fixture.isError ? "error" : "success",
        output,
        ...(fixture.isError ? { error: output } : {}),
      },
      "display-corpus",
    ),
  ].filter((message) => message !== null);
  const live = await runStreamPipeline(messages);
  const durable = await runPersistedPipeline(
    loaded({
      provider: "gemini",
      session: {
        sessionId: "display-corpus",
        projectHash: "fixture",
        startTime: timestamp,
        lastUpdated: timestamp,
        messages: [
          {
            id: `${callId}-message`,
            timestamp,
            type: "gemini",
            content: "",
            toolCalls: [
              {
                id: callId,
                name: nativeName,
                args: input,
                status: fixture.isError ? "error" : "success",
                result: [
                  {
                    functionResponse: {
                      id: callId,
                      name: nativeName,
                      response: { output },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    }),
  );
  return { live, durable };
}
async function runOpenCodePair(fixture: NativeDisplayCase) {
  const callId = `display-${fixture.id}`;
  const provider = new OpenCodeProvider();
  const state: Parameters<OpenCodeProvider["convertSSEEventToSDKMessage"]>[2] =
    {
      messageRolesById: new Map(),
      partMessageIdsById: new Map(),
      partTypesById: new Map(),
      partTextById: new Map(),
      partSentLengthsById: new Map(),
      toolUseEmitted: new Set(),
      toolResultEmitted: new Set(),
      stepUsageByPartId: new Map(),
      sawAssistantContent: false,
      usedPostBodyFallback: false,
    };
  const part = {
    id: `${callId}-part`,
    messageID: `${callId}-message`,
    sessionID: "display-corpus",
    type: "tool",
    tool: fixture.nativeName ?? fixture.tool,
    callID: callId,
    state: {
      status: "completed",
      input: fixture.input,
      output: fixture.result,
    },
  };
  const live = await runStreamPipeline(
    provider["convertSSEEventToSDKMessage"](
      { type: "message.part.updated", properties: { part } },
      "display-corpus",
      state,
    ),
  );
  const durable = await runPersistedPipeline(
    loaded({
      provider: "opencode",
      session: {
        messages: [
          {
            message: {
              id: `${callId}-message`,
              sessionID: "display-corpus",
              role: "assistant",
              time: { created: 0 },
            },
            parts: [part],
          },
        ],
      },
    }),
  );
  return { live, durable };
}
async function runGrokPair(fixture: NativeDisplayCase) {
  const callId = `display-${fixture.id}`;
  const provider = new GrokACPProvider();
  const states: Parameters<GrokACPProvider["convertUpdateToSDKMessage"]>[2] =
    new Map();
  const updates = [
    {
      sessionUpdate: "tool_call" as const,
      toolCallId: callId,
      title: fixture.nativeName ?? fixture.tool,
      rawInput: fixture.input,
    },
    {
      sessionUpdate: "tool_call_update" as const,
      toolCallId: callId,
      status: "completed" as const,
      rawOutput: fixture.rawOutput,
    },
  ];
  const messages = updates
    .map((update) =>
      provider["convertUpdateToSDKMessage"](update, "display-corpus", states, {
        commands: [],
      }),
    )
    .filter((message) => message !== null);
  const reader = new GrokSessionReader();
  const raw = updates
    .map((update) =>
      JSON.stringify({
        timestamp,
        params: { sessionId: "display-corpus", update },
      }),
    )
    .join("\n");
  const stored = reader["parseUpdatesMessages"](raw);
  const live = await runStreamPipeline(messages);
  const durable = await runPersistedPipeline(
    loaded({ provider: "grok", session: { messages: stored } }),
  );
  return { live, durable };
}
nativeDisplayCases.push({
  id: "grok/Write/file",
  provider: "grok",
  tool: "Write",
  nativeName: "Write",
  input: {
    variant: "Write",
    file_path: "/tmp/contract.js",
    content: "contract content",
  },
  rawOutput: {
    type: "SearchReplace",
    EditsApplied: {
      absolute_path: "/tmp/contract.js",
      new_string: "contract content",
    },
  },
  result: "Contract text output",
  text: "contract content",
});

import { PiProvider } from "../../src/sdk/providers/pi.js";
import { PiSessionReader } from "../../src/sessions/pi-reader.js";
async function runPiPair(fixture: NativeDisplayCase) {
  const callId = `display-${fixture.id}`;
  const provider = new PiProvider();
  const state: Parameters<PiProvider["mapEvent"]>[2] = {
    currentAssistantId: null,
    text: "",
    thinking: "",
    lastUsage: null,
    lastCostUsd: null,
    terminalEvent: "agent_settled",
    toolStates: new Map(),
  };
  const output = {
    content: [{ type: "text", text: "Contract text output" }],
    details: { exitCode: 0 },
  };
  const messages = [
    {
      type: "tool_execution_start",
      toolName: fixture.nativeName,
      toolCallId: callId,
      args: fixture.input,
    },
    {
      type: "tool_execution_end",
      toolName: fixture.nativeName,
      toolCallId: callId,
      result: output,
      isError: false,
    },
  ].flatMap((event) => provider["mapEvent"](event, "display-corpus", state));
  const reader = new PiSessionReader();
  const toolStates: Parameters<PiSessionReader["mapNode"]>[2] = new Map();
  const nodes = [
    {
      id: `${callId}-use`,
      type: "message",
      timestamp,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: callId,
            name: fixture.nativeName,
            arguments: fixture.input,
          },
        ],
      },
    },
    {
      id: `${callId}-result`,
      type: "message",
      timestamp,
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: fixture.nativeName,
        ...output,
        isError: false,
      },
    },
  ];
  const stored = nodes
    .map((node, index) => reader["mapNode"](node, index, toolStates))
    .filter((message) => message !== null);
  return {
    live: await runStreamPipeline(messages),
    durable: await runPersistedPipeline(
      loaded({ provider: "pi", session: { messages: stored } }),
    ),
  };
}
for (const [tool, nativeName, input, text] of [
  ["Read", "read", { path: "/tmp/contract.js" }, "Contract text output"],
  [
    "Write",
    "write",
    { path: "/tmp/contract.js", content: "contract content" },
    "contract content",
  ],
  [
    "Edit",
    "edit",
    {
      path: "/tmp/contract.js",
      edits: [{ oldText: "before", newText: "after" }],
    },
    "after",
  ],
  ["Bash", "bash", { command: "printf contract" }, "Contract text output"],
  ["Grep", "grep", { pattern: "contract" }, "Contract text output"],
] as const)
  nativeDisplayCases.push({
    id: `pi/${tool}/native`,
    provider: "pi",
    tool,
    nativeName,
    input,
    result: "Contract text output",
    text,
  });
nativeDisplayCases.push({
  id: "gemini/Write/rejected",
  provider: "gemini",
  tool: "Write",
  nativeName: "write_file",
  input: { content: "validation-test" },
  result: "Missing file_path",
  text: "file_path",
  isError: true,
});

for (const [tool, cmd, result, text] of [
  ["Read", "cat /tmp/contract.ts", "contract content", "contract content"],
  [
    "Grep",
    "rg -n contract /tmp/contract.ts",
    "1:contract match",
    "contract match",
  ],
  [
    "Write",
    "cat > /tmp/contract.ts <<'EOF'\ncontract content\nEOF",
    "",
    "contract content",
  ],
  ["Bash", "printf contract", "contract output", "contract output"],
] as const)
  nativeDisplayCases.push({
    id: `codex/${tool}/shell`,
    provider: "codex",
    tool,
    nativeName: "exec_command",
    input: { cmd },
    result: `Chunk ID: fixture\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\n${result}`,
    text,
  });

for (const fixture of nativeDisplayCases.filter(
  (value) =>
    value.provider === "codex" &&
    value.id.endsWith("/shell") &&
    value.tool !== "Bash",
)) {
  nativeDisplayCases.push({
    ...fixture,
    id: fixture.id.replace("/shell", "/command-item"),
    commandItem: true,
    result: String(fixture.result).split("Output:\n")[1] ?? "",
  });
}

export function claudeDisplayRecords(fixture: NativeDisplayCase) {
  const callId = `display-${fixture.id}`;
  const hash = createHash("sha256").update(fixture.id).digest("hex");
  const useUuid =
    `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4000-8000-${hash.slice(12, 24)}` as const;
  const resultUuid =
    `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4000-8001-${hash.slice(12, 24)}` as const;
  const use = {
    type: "assistant",
    uuid: useUuid,
    session_id: "display-corpus",
    parent_tool_use_id: null,
    message: {
      id: "native-use",
      type: "message",
      role: "assistant",
      model: "fixture",
      container: null,
      context_management: null,
      diagnostics: null,
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 0,
        },
        inference_geo: null,
        iterations: null,
        output_tokens_details: null,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: null,
        speed: null,
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [
        {
          type: "tool_use",
          id: callId,
          name: fixture.tool,
          input: z.record(z.string(), z.unknown()).parse(fixture.input),
        },
      ],
    },
  } satisfies Parameters<ClaudeProvider["convertMessage"]>[0];
  const result = {
    type: "user",
    uuid: resultUuid,
    session_id: "display-corpus",
    parent_tool_use_id: null,
    tool_use_result: fixture.result,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: callId,
          content:
            typeof fixture.result === "string"
              ? fixture.result
              : "Tool completed",
          is_error: fixture.isError ?? false,
        },
      ],
    },
  } satisfies Parameters<ClaudeProvider["convertMessage"]>[0];
  const entries: ClaudeSessionEntry[] = [
    {
      type: "assistant",
      isSidechain: false,
      userType: "external",
      cwd: "/tmp",
      version: "2.1.258",
      uuid: use.uuid,
      parentUuid: null,
      timestamp,
      sessionId: "display-corpus",
      message: use.message,
    },
    {
      type: "user",
      isSidechain: false,
      userType: "external",
      cwd: "/tmp",
      version: "2.1.258",
      uuid: result.uuid,
      parentUuid: use.uuid,
      timestamp,
      sessionId: "display-corpus",
      message: result.message,
      toolUseResult: fixture.result,
    },
  ];
  return { use, result, entries };
}

/** Exercise the real JSONL reader, including DAG selection and parsing. */
export async function readClaudeDisplayEntries(entries: ClaudeSessionEntry[]) {
  const directory = await mkdtemp(join(tmpdir(), "ya-display-reader-"));
  try {
    await writeFile(
      join(directory, "display-corpus.jsonl"),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const reader = new ClaudeSessionReader({ sessionDir: directory });
    const session = await reader.getSession("display-corpus", projectId);
    if (!session) throw new Error("Native Claude specimen was not read");
    return await runPersistedPipeline(session);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

nativeDisplayCases.push(...observedDisplayCases);
