import type { PermissionMode, ToolApprovalResult } from "../sdk/types.js";

const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LSP",
  "WebFetch",
  "WebSearch",
  "Task", // Subagent exploration (legacy)
  "Agent", // Subagent exploration (SDK 0.2.76+)
  "TaskOutput", // Reading subagent results
]);

export function isAskUserQuestionTool(toolName: string): boolean {
  return toolName === ASK_USER_QUESTION_TOOL_NAME;
}

export function getModeBasedToolApproval(
  mode: PermissionMode,
  toolName: string,
  input: unknown,
  requiresUserResponse: boolean,
): ToolApprovalResult | undefined {
  if (requiresUserResponse) {
    return undefined;
  }

  switch (mode) {
    case "bypassPermissions":
      return { behavior: "allow" };
    case "plan": {
      if (READ_ONLY_TOOLS.has(toolName)) {
        return { behavior: "allow" };
      }
      if (toolName === "Write") {
        const filePath = (input as { file_path?: string })?.file_path ?? "";
        if (filePath.includes(".claude/plans/")) {
          return { behavior: "allow" };
        }
      }
      return undefined;
    }
    case "acceptEdits":
      return EDIT_TOOLS.has(toolName) || READ_ONLY_TOOLS.has(toolName)
        ? { behavior: "allow" }
        : undefined;
    default:
      return READ_ONLY_TOOLS.has(toolName) ? { behavior: "allow" } : undefined;
  }
}

export function buildAskUserQuestionPrompt(input: unknown): string {
  const questions =
    input && typeof input === "object"
      ? (input as { questions?: unknown }).questions
      : undefined;
  if (!Array.isArray(questions) || questions.length === 0) {
    return "Answer Claude's question";
  }

  const firstQuestion = questions[0];
  const firstQuestionText =
    firstQuestion && typeof firstQuestion === "object"
      ? (firstQuestion as { question?: unknown }).question
      : undefined;
  if (typeof firstQuestionText !== "string" || !firstQuestionText.trim()) {
    return questions.length === 1
      ? "Answer Claude's question"
      : `Answer Claude's ${questions.length} questions`;
  }

  const trimmed = firstQuestionText.trim();
  return questions.length === 1
    ? trimmed
    : `${trimmed} (+${questions.length - 1} more)`;
}
