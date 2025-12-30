import type { ToolResultData } from "../../types/renderItems";
import { toolRegistry } from "../renderers/tools";

/**
 * Get a summary string for a tool call based on its status.
 *
 * Uses the tool registry's getUseSummary and getResultSummary methods when available,
 * falling back to sensible defaults.
 */
export function getToolSummary(
  toolName: string,
  input: unknown,
  result: ToolResultData | undefined,
  status: "pending" | "complete" | "error" | "aborted",
): string {
  const renderer = toolRegistry.get(toolName);

  if (status === "pending" || status === "aborted") {
    // Show input summary while pending or aborted (no result available)
    if (renderer.getUseSummary) {
      return renderer.getUseSummary(input);
    }
    return getDefaultInputSummary(toolName, input);
  }

  // Show result summary when complete or error
  if (renderer.getResultSummary) {
    return renderer.getResultSummary(
      result?.structured,
      result?.isError ?? false,
    );
  }

  return getDefaultResultSummary(toolName, result, status);
}

/**
 * Default input summary when renderer doesn't provide one
 */
function getDefaultInputSummary(toolName: string, input: unknown): string {
  const i = input as Record<string, unknown>;

  switch (toolName) {
    case "Read":
      return getFileName(String(i.file_path || ""));
    case "Write":
      return getFileName(String(i.file_path || ""));
    case "Edit":
      return getFileName(String(i.file_path || ""));
    case "Bash":
      return truncate(String(i.command || ""), 40);
    case "Glob":
      return String(i.pattern || "*");
    case "Grep":
      return `"${i.pattern || ""}"`;
    case "Task":
      return truncate(String(i.description || ""), 30);
    case "WebSearch":
      return truncate(String(i.query || ""), 30);
    case "WebFetch":
      return truncate(String(i.url || ""), 40);
    default:
      return "...";
  }
}

/**
 * Default result summary when renderer doesn't provide one
 */
function getDefaultResultSummary(
  toolName: string,
  result: ToolResultData | undefined,
  status: "pending" | "complete" | "error",
): string {
  if (status === "error") {
    return "failed";
  }

  if (!result) {
    return "done";
  }

  // Try to extract meaningful info from content
  const content = result.content || "";
  const lineCount = content.split("\n").filter(Boolean).length;

  switch (toolName) {
    case "Read":
      return `${lineCount} lines`;
    case "Bash":
      return `${lineCount} lines`;
    case "Glob":
      return `${lineCount} files`;
    case "Grep":
      return `${lineCount} matches`;
    default:
      return "done";
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 3)}...`;
}

function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}
