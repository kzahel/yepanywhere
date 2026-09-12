import { describe, expect, it } from "vitest";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import { annotateBackgroundCommands } from "@yep-anywhere/shared/transcript/shellFolding";

/**
 * Grok names its background-command poll and kill tools differently from the
 * Claude-shaped originals, and one poll can wait on a whole set of tasks.
 * Every launch below is a completed Bash call that backgrounded its command,
 * so the row stays present-tense until a poll or kill reports the outcome.
 */
function grokLaunch(id: string, taskId: string, command: string): RenderItem {
  return {
    type: "tool_call",
    id,
    toolName: "Bash",
    toolInput: { command, run_in_background: true },
    status: "complete",
    toolResult: {
      content: "",
      structured: {
        stdout: "",
        stderr: "",
        interrupted: false,
        isImage: false,
        backgroundTaskId: taskId,
      },
    },
  } as RenderItem;
}

function grokPoll(id: string, tasks: unknown[]): RenderItem {
  return {
    type: "tool_call",
    id,
    toolName: "get_command_or_subagent_output",
    toolInput: { task_id: "ignored" },
    status: "complete",
    toolResult: {
      content: "",
      structured: {
        retrieval_status: "completed",
        task: tasks[0],
        tasks,
      },
    },
  } as RenderItem;
}

function backgroundStatus(items: RenderItem[], id: string): unknown {
  const item = items.find(
    (entry) => entry.type === "tool_call" && entry.id === id,
  );
  if (item?.type !== "tool_call") return undefined;
  return (item.toolInput as Record<string, unknown>)._backgroundTaskStatus;
}

describe("annotateBackgroundCommands with Grok tool names", () => {
  it("keeps a launch running until its poll reports an outcome", () => {
    const items = [grokLaunch("bash-1", "task-1", "pnpm lint")];
    expect(backgroundStatus(annotateBackgroundCommands(items), "bash-1")).toBe(
      "running",
    );
  });

  it("ends a launch that Grok's own poll tool reports finished", () => {
    const items = [
      grokLaunch("bash-1", "task-1", "pnpm lint"),
      grokPoll("poll-1", [{ task_id: "task-1", status: "completed" }]),
    ];
    expect(backgroundStatus(annotateBackgroundCommands(items), "bash-1")).toBe(
      "completed",
    );
  });

  it("ends every launch a multi-task wait reports, not just the first", () => {
    const items = [
      grokLaunch("bash-1", "task-1", "pnpm lint"),
      grokLaunch("bash-2", "task-2", "pnpm typecheck"),
      grokLaunch("bash-3", "task-3", "pnpm test"),
      grokPoll("poll-1", [
        { task_id: "task-1", status: "completed" },
        { task_id: "task-2", status: "failed" },
        { task_id: "task-3", status: "running" },
      ]),
    ];

    const annotated = annotateBackgroundCommands(items);
    expect(backgroundStatus(annotated, "bash-1")).toBe("completed");
    expect(backgroundStatus(annotated, "bash-2")).toBe("completed");
    // Still going, so this one honestly keeps its present-tense header.
    expect(backgroundStatus(annotated, "bash-3")).toBe("running");
  });

  it("ends a launch that Grok's own kill tool terminated", () => {
    const items: RenderItem[] = [
      grokLaunch("bash-1", "task-1", "sleep 600"),
      {
        type: "tool_call",
        id: "kill-1",
        toolName: "kill_command_or_subagent",
        toolInput: { task_id: "task-1", shell_id: "task-1" },
        status: "complete",
        toolResult: {
          content: "",
          structured: {
            task_id: "task-1",
            shell_id: "task-1",
            message: "killed",
          },
        },
      } as RenderItem,
    ];
    expect(backgroundStatus(annotateBackgroundCommands(items), "bash-1")).toBe(
      "completed",
    );
  });

  it("ends a launch whose polled task was cancelled", () => {
    const items = [
      grokLaunch("bash-1", "task-1", "pnpm test"),
      grokPoll("poll-1", [{ task_id: "task-1", status: "cancelled" }]),
    ];
    expect(backgroundStatus(annotateBackgroundCommands(items), "bash-1")).toBe(
      "completed",
    );
  });
});
