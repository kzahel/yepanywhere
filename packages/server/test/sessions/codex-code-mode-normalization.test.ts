import type { CodexSessionEntry } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { compileTranscriptProjection } from "@yep-anywhere/shared/transcript/compiler";
import { normalizeSession } from "../../src/sessions/normalization.js";
import { augmentEditToolUses } from "../../src/sessions/persisted-augments.js";
import type { LoadedSession } from "../../src/sessions/types.js";

function buildLoadedSession(entries: CodexSessionEntry[]): LoadedSession {
  return {
    summary: {
      id: "code-mode-test",
      projectId: "test-project",
      title: "Code mode",
      fullTitle: "Code mode",
      createdAt: "2026-07-10T00:00:00Z",
      updatedAt: "2026-07-10T00:00:02Z",
      messageCount: entries.length,
      status: "chat",
      provider: "codex",
      // biome-ignore lint/suspicious/noExplicitAny: minimal normalization fixture
    } as any,
    data: {
      provider: "codex",
      events: [],
      session: { entries },
      // biome-ignore lint/suspicious/noExplicitAny: minimal normalization fixture
    } as any,
  };
}

function contentBlock(
  message: ReturnType<typeof normalizeSession>["messages"][number],
) {
  const content = message.message?.content;
  return Array.isArray(content) ? content[0] : content;
}

describe("Codex code-mode persisted normalization", () => {
  it("maps a literal exec_command read and unwraps text output blocks", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2026-07-10T00:00:01Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call-read",
          name: "exec",
          input:
            'const r = await tools.exec_command({"cmd":"sed -n \'1,20p\' CLAUDE.md","workdir":"/repo"}); text(r.output);',
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-10T00:00:02Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-read",
          output: [
            {
              type: "input_text",
              text: "Script completed\nWall time 1 second\nOutput:\n",
            },
            { type: "input_text", text: "# Yep Anywhere\n" },
          ],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(contentBlock(result.messages[0])).toMatchObject({
      type: "tool_use",
      name: "Read",
      input: { file_path: "CLAUDE.md" },
    });
    expect(contentBlock(result.messages[1])).toMatchObject({
      type: "tool_result",
      content: "# Yep Anywhere\n",
    });
    expect(result.messages[1]?.toolUseResult).toMatchObject({
      file: { content: "# Yep Anywhere\n" },
    });
  });

  it("maps apply_patch and attaches a renderable diff", async () => {
    const patch =
      "*** Begin Patch\n*** Add File: /repo/demo.txt\n+new\n*** End Patch";
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2026-07-10T00:00:01Z",
        payload: {
          type: "custom_tool_call",
          call_id: "outer-call",
          name: "exec",
          input: `const patch = ${JSON.stringify(patch)}; text(await tools.apply_patch(patch));`,
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-10T00:00:01.500Z",
        payload: {
          type: "patch_apply_end",
          call_id: "exec-provider-call",
          turn_id: "turn-1",
          stdout: "Done!",
          stderr: "",
          success: true,
          status: "completed",
          changes: {
            "/repo/demo.txt": {
              type: "add",
              unified_diff: "@@ -0,0 +1 @@\n+new",
            },
          },
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-10T00:00:02Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "outer-call",
          output: [
            { type: "input_text", text: "Script completed\nOutput:\n{}" },
          ],
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    await augmentEditToolUses(result.messages);
    expect(contentBlock(result.messages[0])).toMatchObject({
      type: "tool_use",
      name: "Edit",
      input: {
        _rawPatch: patch,
        changes: [
          {
            path: "/repo/demo.txt",
            type: "add",
            unified_diff: "@@ -0,0 +1 @@\n+new",
          },
        ],
        _structuredPatch: [
          {
            oldLines: 0,
            newLines: 1,
            lines: ["+new"],
          },
        ],
      },
    });
    expect(contentBlock(result.messages[1])).toMatchObject({
      type: "tool_result",
      content: "Done!",
    });
  });

  it("recovers a nested update_plan checklist from durable exec source", () => {
    const plan = [
      {
        step: "Read the complete engine, tests, and contracts",
        status: "in_progress",
      },
      { step: "Add failing image tests", status: "pending" },
      { step: "Refactor the engine", status: "pending" },
      { step: "Normalize attachments", status: "pending" },
      { step: "Run regression tests", status: "pending" },
    ];
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2026-08-02T21:31:20.958Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call-plan",
          name: "exec",
          input: `const r = await tools.update_plan({plan:${JSON.stringify(plan)}});\ntext(r);\n`,
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-02T21:31:21.077Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-plan",
          output: [
            {
              type: "input_text",
              text: "Script completed\nWall time 0.0 seconds\nOutput:\n",
            },
            { type: "input_text", text: "{}" },
          ],
        },
      },
    ];

    const normalized = normalizeSession(buildLoadedSession(entries));
    const items = compileTranscriptProjection(normalized.messages);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool_call",
      toolName: "UpdatePlan",
      toolInput: { plan },
      toolResult: {
        content: "Plan updated",
        structured: { message: "Plan updated" },
      },
      status: "complete",
    });
  });

  it("keeps multiple nested calls as an explicit group", () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2026-07-10T00:00:01Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call-group",
          name: "exec",
          input:
            'const r = await Promise.all([tools.exec_command({"cmd":"pnpm lint"}), tools.exec_command({"cmd":"pnpm typecheck"})]); text(r.length);',
        },
      },
    ];

    const result = normalizeSession(buildLoadedSession(entries));
    expect(contentBlock(result.messages[0])).toMatchObject({
      type: "tool_use",
      name: "Exec",
      input: {
        calls: [
          { toolName: "exec_command", input: { cmd: "pnpm lint" } },
          { toolName: "exec_command", input: { cmd: "pnpm typecheck" } },
        ],
      },
    });
  });
});
