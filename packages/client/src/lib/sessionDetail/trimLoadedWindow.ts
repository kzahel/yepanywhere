import type { PaginationInfo } from "../../api/client";
import type { Message } from "../../types";
import { getMessageId } from "@yep-anywhere/shared/transcript/message";
import { findMessageIndexById } from "../mergeMessages";
import { parseTimestampMs } from "../messageAge";
import {
  ACTIVE_WINDOW_MIN_BOUNDARY_AGE_MS,
  isActiveWindowCompactBoundary,
  isActiveWindowRealUserTurn,
} from "./activeWindowTrimPolicy";
import type {
  AgentContentMap,
  MarkdownAugmentMap,
  SessionDetailAction,
  SessionDetailState,
} from "./types";

type TrimLoadedWindowAction = Extract<
  SessionDetailAction,
  { type: "trimLoadedWindow" }
>;

interface TranscriptReferences {
  agentIds: Set<string>;
  toolUseIds: Set<string>;
}

const TOOL_USE_ID_KEYS = new Set([
  "call_id",
  "parentToolUseId",
  "parent_tool_use_id",
  "toolUseId",
  "tool_use_id",
]);
const AGENT_ID_KEYS = new Set(["agentId", "agent_id"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addNonEmptyString(target: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed) {
    target.add(trimmed);
  }
}

function collectAgentIdsFromText(text: string, agentIds: Set<string>): void {
  const patterns = [
    /^agentId:\s*([^\s(),]+)/gm,
    /"agent_id"\s*:\s*"([^"]+)"/g,
    /"agentId"\s*:\s*"([^"]+)"/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      addNonEmptyString(agentIds, match[1]);
    }
  }
}

function collectReferencesFromValue(
  value: unknown,
  references: TranscriptReferences,
  seen: Set<object>,
): void {
  if (typeof value === "string") {
    collectAgentIdsFromText(value, references.agentIds);
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectReferencesFromValue(item, references, seen);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  if (record.type === "tool_use") {
    addNonEmptyString(references.toolUseIds, record.id);
  }
  if (
    record.type === "function_call" ||
    record.type === "function_call_output"
  ) {
    addNonEmptyString(references.toolUseIds, record.call_id);
  }
  if (isRecord(record.toolUse)) {
    addNonEmptyString(references.toolUseIds, record.toolUse.id);
  }
  if (isRecord(record.tool_use)) {
    addNonEmptyString(references.toolUseIds, record.tool_use.id);
  }

  for (const [key, child] of Object.entries(record)) {
    if (TOOL_USE_ID_KEYS.has(key)) {
      addNonEmptyString(references.toolUseIds, child);
    }
    if (AGENT_ID_KEYS.has(key)) {
      addNonEmptyString(references.agentIds, child);
    }
    collectReferencesFromValue(child, references, seen);
  }
}

function collectMessageReferences(
  messages: readonly Message[],
  references: TranscriptReferences,
): void {
  const seen = new Set<object>();
  for (const message of messages) {
    collectReferencesFromValue(message, references, seen);
  }
}

function isActiveAgentStatus(status: string): boolean {
  return status === "pending" || status === "running";
}

function collectReachableTranscriptReferences(
  retainedMessages: readonly Message[],
  agentContent: AgentContentMap,
  toolUseToAgentEntries: ReadonlyArray<readonly [string, string]>,
): TranscriptReferences {
  const references: TranscriptReferences = {
    agentIds: new Set<string>(),
    toolUseIds: new Set<string>(),
  };
  collectMessageReferences(retainedMessages, references);

  for (const [agentId, content] of Object.entries(agentContent)) {
    if (isActiveAgentStatus(content.status)) {
      references.agentIds.add(agentId);
    }
  }

  const scannedAgentIds = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [toolUseId, agentId] of toolUseToAgentEntries) {
      if (
        references.toolUseIds.has(toolUseId) ||
        references.agentIds.has(agentId)
      ) {
        const previousSize = references.agentIds.size;
        references.agentIds.add(agentId);
        changed ||= references.agentIds.size !== previousSize;
      }
    }

    for (const agentId of Array.from(references.agentIds)) {
      if (scannedAgentIds.has(agentId)) {
        continue;
      }
      scannedAgentIds.add(agentId);
      const content = agentContent[agentId];
      if (!content) {
        continue;
      }
      const previousAgentCount = references.agentIds.size;
      const previousToolCount = references.toolUseIds.size;
      collectMessageReferences(content.messages, references);
      changed ||=
        references.agentIds.size !== previousAgentCount ||
        references.toolUseIds.size !== previousToolCount;
    }
  }
  return references;
}

function pruneMarkdownAugments(
  markdownAugments: MarkdownAugmentMap,
  retainedMessageIds: ReadonlySet<string>,
): MarkdownAugmentMap {
  const entries = Object.entries(markdownAugments).filter(([messageId]) =>
    retainedMessageIds.has(messageId),
  );
  if (entries.length === Object.keys(markdownAugments).length) {
    return markdownAugments;
  }
  return Object.fromEntries(entries);
}

function pruneToolUseToAgentEntries(
  entries: Array<[string, string]>,
  references: TranscriptReferences,
): Array<[string, string]> {
  const retained = entries.filter(
    ([toolUseId, agentId]) =>
      references.toolUseIds.has(toolUseId) || references.agentIds.has(agentId),
  );
  return retained.length === entries.length ? entries : retained;
}

function pruneAgentContent(
  agentContent: AgentContentMap,
  retainedAgentIds: ReadonlySet<string>,
): AgentContentMap {
  const entries = Object.entries(agentContent).filter(([agentId]) =>
    retainedAgentIds.has(agentId),
  );
  if (entries.length === Object.keys(agentContent).length) {
    return agentContent;
  }
  return Object.fromEntries(entries);
}

function buildTrimmedPagination(
  state: SessionDetailState,
  retainedMessages: readonly Message[],
  action: TrimLoadedWindowAction,
): PaginationInfo {
  const previous = state.pagination;
  let loadedCompactions = 0;
  let loadedUserTurns = 0;
  for (const message of state.messages) {
    if (isActiveWindowCompactBoundary(message)) {
      loadedCompactions += 1;
    }
    if (isActiveWindowRealUserTurn(message)) {
      loadedUserTurns += 1;
    }
  }

  return {
    hasOlderMessages: true,
    totalMessageCount: Math.max(
      previous?.totalMessageCount ?? 0,
      state.messages.length,
    ),
    returnedMessageCount: retainedMessages.length,
    truncatedBeforeMessageId: action.startMessageId,
    totalCompactions: Math.max(
      previous?.totalCompactions ?? 0,
      loadedCompactions,
    ),
    ...(previous?.totalUserTurns !== undefined && {
      totalUserTurns: Math.max(previous.totalUserTurns, loadedUserTurns),
    }),
    truncatedBy: action.reason,
  };
}

export function trimSessionDetailLoadedWindow(
  state: SessionDetailState,
  action: TrimLoadedWindowAction,
): SessionDetailState {
  const startIndex = findMessageIndexById(
    state.messages,
    action.startMessageId,
  );
  if (startIndex <= 0) {
    return state;
  }
  const boundary = state.messages[startIndex];
  if (!boundary) {
    return state;
  }
  const boundaryTimestampMs = parseTimestampMs(boundary.timestamp);
  if (
    boundaryTimestampMs === null ||
    action.nowMs <= boundaryTimestampMs + ACTIVE_WINDOW_MIN_BOUNDARY_AGE_MS
  ) {
    return state;
  }

  const messages = state.messages.slice(startIndex);
  const retainedMessageIds = new Set(
    messages.map(getMessageId).filter((messageId) => messageId.length > 0),
  );
  const references = collectReachableTranscriptReferences(
    messages,
    state.agentContent,
    state.toolUseToAgentEntries,
  );

  return {
    ...state,
    messages,
    activeWindowTrimRevision: state.activeWindowTrimRevision + 1,
    pagination: buildTrimmedPagination(state, messages, action),
    markdownAugments: pruneMarkdownAugments(
      state.markdownAugments,
      retainedMessageIds,
    ),
    toolUseToAgentEntries: pruneToolUseToAgentEntries(
      state.toolUseToAgentEntries,
      references,
    ),
    agentContent: pruneAgentContent(state.agentContent, references.agentIds),
  };
}
