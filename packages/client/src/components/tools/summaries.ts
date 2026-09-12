import type { PreparedToolDisplay } from "../renderers/tools/defineTool";
import { getDisplayBashCommandFromInput } from "../../lib/bashCommand";
import { getPathBasename } from "../../lib/text";
import type {
  ToolCallItem,
  ToolResultData,
} from "@yep-anywhere/shared/transcript/items";
import { toolRegistry } from "../renderers/tools";
import type { ToolSummaryContext } from "../renderers/tools/types";

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
  status: ToolCallItem["status"],
  context?: ToolSummaryContext,
  prepared?: PreparedToolDisplay,
): string {
  const renderer =
    prepared ??
    toolRegistry.prepare(toolName, {
      input,
      result: result?.structured ?? result?.content,
      isError: result?.isError,
      status,
    });
  const canonicalToolName = toolRegistry.metadata(toolName).tool;

  if (status === "pending" || status === "aborted" || status === "incomplete") {
    // Show input summary while no ordinary result is available.
    if (renderer.getUseSummary) {
      const summary = renderer.getUseSummary(context);
      if (summary !== undefined) return summary;
    }
    return getDefaultInputSummary(canonicalToolName, input);
  }

  // Show result summary when complete or error
  // For some tools, combine input + result for a complete summary
  let inputSummary: string;
  if (renderer.getUseSummary) {
    const summary = renderer.getUseSummary(context);
    inputSummary = summary ?? getDefaultInputSummary(canonicalToolName, input);
  } else {
    inputSummary = getDefaultInputSummary(canonicalToolName, input);
  }

  let resultSummary: string;
  if (renderer.getResultSummary) {
    const summary = renderer.getResultSummary(context);
    resultSummary =
      summary ?? getDefaultResultSummary(canonicalToolName, result, status);
  } else {
    resultSummary = getDefaultResultSummary(canonicalToolName, result, status);
  }

  if (!result) return inputSummary;

  // Combine input and result for tools where the input context is valuable
  if (canonicalToolName === "Glob" || canonicalToolName === "Grep") {
    return `${inputSummary} → ${resultSummary}`;
  }

  // For Bash, always show description (input summary) since output is in collapsed preview
  if (canonicalToolName === "Bash") {
    return inputSummary;
  }

  if (canonicalToolName === "WriteStdin") {
    if (inputSummary && inputSummary !== "waiting for output") {
      return `${inputSummary} → ${resultSummary}`;
    }
    return resultSummary;
  }

  return resultSummary;
}

/**
 * Default input summary when renderer doesn't provide one.
 * Handles both Claude SDK field names and generic fallback for other providers.
 */
function getDefaultInputSummary(toolName: string, input: unknown): string {
  // Guard against null/undefined input
  if (!input || typeof input !== "object") {
    return "...";
  }

  const i = input as Record<string, unknown>;

  // Try Claude SDK field names first, then fall back to generic
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      if (typeof i.file_path === "string") return getFileName(i.file_path);
      break;
    case "Bash":
      {
        const command = getDisplayBashCommandFromInput(i);
        if (command) return command;
      }
      break;
    case "Glob":
      if (typeof i.pattern === "string") return i.pattern;
      break;
    case "Grep":
      if (typeof i.pattern === "string") return `"${i.pattern}"`;
      break;
    case "Task":
    case "Agent":
      if (typeof i.description === "string") return truncate(i.description, 30);
      break;
    case "WebSearch":
      if (typeof i.query === "string") return truncate(i.query, 30);
      break;
    case "WebFetch":
      if (typeof i.url === "string") return truncate(i.url, 40);
      break;
  }

  // Fallback: try to find first meaningful string property to show
  return getFirstStringValue(i);
}

/**
 * Get the first short string value from an object for fallback display.
 * Useful for unknown tool inputs from non-Claude providers.
 */
function getFirstStringValue(obj: Record<string, unknown>): string {
  for (const value of Object.values(obj)) {
    if (typeof value === "string" && value.length > 0 && value.length < 100) {
      return truncate(value, 40);
    }
  }
  return "...";
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
  // Guard against non-string content (can happen with some tool results)
  const content = typeof result.content === "string" ? result.content : "";
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
  return getPathBasename(filePath);
}
