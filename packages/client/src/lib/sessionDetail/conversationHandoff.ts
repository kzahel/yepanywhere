import { isCompactionLocalCommandOutput } from "@yep-anywhere/shared/transcript/commandTurn";
import { parseUserPrompt } from "../parseUserPrompt";
import { turnContentText } from "../sessionMessageText";
import { getPathBasename } from "../text";
import type { ContentBlock } from "../../types";
import type {
  RenderItem,
  ToolCallItem,
  UserPromptItem,
} from "@yep-anywhere/shared/transcript/items";
import {
  conversationViewSurfaceReason,
  isMediaToolCall,
  projectConversationView,
} from "./conversationView";

export interface ConversationHandoffPrefillInput {
  items: readonly RenderItem[];
  fromUserTurnId: string;
  provider: string;
  sessionId: string;
  goal?: string | null;
  projectPath?: string | null;
  nowMs?: number;
}

function compactGoalStatement(goal: string | null | undefined): string {
  return (goal ?? "").replace(/\s+/g, " ").trim();
}

export function buildConversationHandoffPreamble(params: {
  provider: string;
  sessionId: string;
  goal?: string | null;
}): string {
  const goal = compactGoalStatement(params.goal);
  const takeover = goal
    ? `You are taking over for a stopped session with /goal ${goal}.`
    : "You are taking over for a stopped session.";
  return [
    takeover,
    "Any of the session's edit locks or other authorizations are hereby yours.",
    `"user: " indicating a user turn, activity details elided (see ${params.provider} session ${params.sessionId} if needed), session-final conversation follows verbatim:`,
  ].join("\n");
}

function sliceFromUserTurn(
  items: readonly RenderItem[],
  fromUserTurnId: string,
): RenderItem[] | null {
  const start = items.findIndex(
    (item) => item.type === "user_prompt" && item.id === fromUserTurnId,
  );
  if (start < 0) {
    return null;
  }
  return items.slice(start);
}

function isCompactBanner(item: RenderItem): boolean {
  if (item.type !== "system") {
    return false;
  }
  return (
    item.subtype === "compact_boundary" ||
    item.status === "compacting" ||
    isCompactionLocalCommandOutput(item.content)
  );
}

function toProjectRelativePathname(
  path: string,
  fallbackName: string,
  projectPath?: string | null,
): string {
  const trimmed = path.trim();
  const fallback = fallbackName.trim() || getPathBasename(trimmed);
  if (!trimmed || trimmed.startsWith("data:")) {
    return fallback;
  }
  const root = projectPath?.replace(/[/\\]+$/, "") ?? "";
  if (root && (trimmed === root || trimmed.startsWith(`${root}/`))) {
    return trimmed.slice(root.length + 1) || fallback;
  }
  if (!trimmed.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed;
  }
  return fallback || trimmed;
}

function uniquePathnames(pathnames: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const pathname of pathnames) {
    const trimmed = pathname.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function uploadedPathnames(
  content: string | ContentBlock[],
  projectPath?: string | null,
): string[] {
  const raw = typeof content === "string" ? content : turnContentText(content);
  const parsed = parseUserPrompt(raw);
  return uniquePathnames(
    parsed.uploadedFiles.map((file) =>
      toProjectRelativePathname(file.path, file.originalName, projectPath),
    ),
  );
}

function mediaToolPathnames(
  item: ToolCallItem,
  projectPath?: string | null,
): string[] {
  const fromLinks = (item.toolResult?.projectPathLinks ?? []).map((link) =>
    toProjectRelativePathname(link.filePath, link.text, projectPath),
  );
  const fromMedia = (item.toolResult?.media ?? []).flatMap((media) => {
    const filename = media.filename?.trim();
    return filename
      ? [toProjectRelativePathname(filename, filename, projectPath)]
      : [];
  });
  const input =
    item.toolInput && typeof item.toolInput === "object"
      ? (item.toolInput as Record<string, unknown>)
      : {};
  const inputPathCandidates = [
    input.file_path,
    input.path,
    input.target,
  ].filter(
    (value): value is string =>
      typeof value === "string" && value.trim() !== "",
  );
  const fromInput = inputPathCandidates.map((candidate) =>
    toProjectRelativePathname(
      candidate,
      getPathBasename(candidate),
      projectPath,
    ),
  );
  return uniquePathnames([...fromLinks, ...fromMedia, ...fromInput]);
}

function assistantSourceText(
  item: Extract<RenderItem, { type: "text" }>,
): string {
  const direct = item.text.trim();
  if (direct) {
    return item.text.replace(/\s+$/, "").replace(/^\s+/, "");
  }
  for (const message of item.sourceMessages) {
    const fromMessage = turnContentText(
      message.message?.content ?? message.content,
    ).trim();
    if (fromMessage) {
      return fromMessage;
    }
  }
  return "";
}

function userPromptSource(
  item: UserPromptItem,
  projectPath?: string | null,
): string {
  const raw =
    typeof item.content === "string"
      ? item.content
      : turnContentText(item.content);
  const parsed = parseUserPrompt(raw);
  const body = [
    parsed.text.trim(),
    ...uploadedPathnames(item.content, projectPath),
  ]
    .filter(Boolean)
    .join("\n");
  return body ? `user: ${body}` : "";
}

function serializeImportanceItem(
  item: RenderItem,
  projectPath?: string | null,
): string | null {
  if (isCompactBanner(item)) {
    return null;
  }
  if (item.type === "user_prompt") {
    const text = userPromptSource(item, projectPath);
    return text || null;
  }
  if (item.type === "text") {
    const text = assistantSourceText(item);
    return text || null;
  }
  if (item.type === "tool_call" && isMediaToolCall(item)) {
    const pathnames = mediaToolPathnames(item, projectPath);
    return pathnames.length > 0 ? pathnames.join("\n") : null;
  }
  return null;
}

/**
 * Client-side handoff body from the in-memory transcript model.
 *
 * Walks `projectConversationView` (not scroll DOM). Importance-surfaced
 * rows become original markdown source; error-surfaced rows, activity
 * summaries, thinking, and compact banners are omitted.
 */
export function buildConversationHandoffPrefill(
  input: ConversationHandoffPrefillInput,
): string | null {
  const slice = sliceFromUserTurn(input.items, input.fromUserTurnId);
  if (!slice) {
    return null;
  }
  const projected = projectConversationView(slice, {
    active: false,
    nowMs: input.nowMs ?? 0,
  });
  const body = projected
    .filter((item) => conversationViewSurfaceReason(item) === "importance")
    .map((item) => serializeImportanceItem(item, input.projectPath))
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  const preamble = buildConversationHandoffPreamble({
    provider: input.provider,
    sessionId: input.sessionId,
    goal: input.goal,
  });
  return body ? `${preamble}\n\n${body}` : preamble;
}
