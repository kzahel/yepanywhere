import { getPathBasename, makeDisplayPath } from "../text";
import { canonicalizeToolName, getExplorationKind } from "../toolNames";
import type {
  RenderItem,
  ToolCallItem,
} from "@yep-anywhere/shared/transcript/items";
import {
  buildExplorationProjectionSegments,
  type ExplorationProjection,
  projectExplorationParent,
} from "./explorationProjection";

export { getExplorationKind };

export type AssistantRenderSegment =
  | { kind: "item"; item: RenderItem }
  | {
      kind: "explored";
      id: string;
      items: ToolCallItem[];
      projection: ExplorationProjection;
    };

export function isExplorationToolCall(item: RenderItem): item is ToolCallItem {
  return item.type === "tool_call" && projectExplorationParent(item) !== null;
}

export function buildAssistantRenderSegments(
  items: readonly RenderItem[],
): AssistantRenderSegment[] {
  return buildExplorationProjectionSegments(items).map((segment) => {
    if (segment.kind === "item") return segment;
    return {
      kind: "explored",
      id: segment.projection.id,
      items: segment.projection.parents.map((parent) => parent.item),
      projection: segment.projection,
    };
  });
}

export function getExploredEntryDisplayLabel(toolName: string): string {
  const kind = getExplorationKind(toolName);
  if (kind === "search") {
    if (canonicalizeToolName(toolName) === "Grep") {
      return "Grep";
    }
    return "Search";
  }
  if (kind === "list") {
    return "List";
  }
  return "Read";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(input: unknown, field: string): string {
  if (!isRecord(input)) {
    return "";
  }
  const value = input[field];
  return typeof value === "string" ? value.trim() : "";
}

function compactPath(
  path: string,
  projectPath: string | null | undefined,
): string {
  return makeDisplayPath(path, projectPath);
}

function getSearchSummary(
  input: unknown,
  projectPath: string | null | undefined,
): string {
  const pattern = stringField(input, "pattern") || stringField(input, "query");
  const path =
    stringField(input, "path") ||
    stringField(input, "target_directory") ||
    stringField(input, "directory");
  const glob = stringField(input, "glob");
  const scope = path || glob;
  if (pattern && scope) {
    return `${pattern} in ${path ? compactPath(path, projectPath) : glob}`;
  }
  return pattern || scope || "search";
}

function getListSummary(
  input: unknown,
  projectPath: string | null | undefined,
): string {
  const pattern = stringField(input, "pattern");
  const path =
    stringField(input, "path") ||
    stringField(input, "target_directory") ||
    stringField(input, "directory");
  if (pattern && path) {
    return `${pattern} in ${compactPath(path, projectPath)}`;
  }
  return path ? compactPath(path, projectPath) : pattern || "files";
}

export function getExploredEntryFallbackSummary(
  item: ToolCallItem,
  projectPath?: string | null,
): string {
  const kind = getExplorationKind(item.toolName);
  if (kind === "search") {
    return getSearchSummary(item.toolInput, projectPath);
  }
  if (kind === "list") {
    return getListSummary(item.toolInput, projectPath);
  }
  const filePath =
    stringField(item.toolInput, "file_path") ||
    stringField(item.toolInput, "target_file");
  return filePath
    ? getPathBasename(makeDisplayPath(filePath, projectPath))
    : "file";
}

export function getExploredEntrySearchPreview(
  item: ToolCallItem,
  projectPath?: string | null,
): string {
  const summary = getExploredEntryFallbackSummary(item, projectPath);
  return summary
    ? `${getExploredEntryDisplayLabel(item.toolName)}: ${summary}`
    : getExploredEntryDisplayLabel(item.toolName);
}

export function getExploredEntrySearchText(
  item: ToolCallItem,
  projectPath?: string | null,
): string {
  const parts = [
    getExploredEntryDisplayLabel(item.toolName),
    getExploredEntryFallbackSummary(item, projectPath),
    item.toolResult?.content,
  ];
  return Array.from(
    new Set(
      parts
        .filter((part): part is string => typeof part === "string")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ).join("\n");
}
