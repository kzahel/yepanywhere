import type { PaginationInfo } from "../../api/client";
import type { Message, SessionMetadata } from "../../types";
import type { SessionRouteScrollSnapshot } from "../sessionRouteSnapshots";
import type {
  ActiveToolApproval,
  TranscriptProjectionAugments,
} from "@yep-anywhere/shared/transcript/types";
import type {
  AgentContentMap,
  MarkdownAugmentMap,
  SessionDetailState,
} from "./types";

export interface SessionDetailRuntimeSnapshot {
  messages: readonly Message[];
  session: SessionMetadata | null;
  pagination?: PaginationInfo;
  agentContent: AgentContentMap;
  markdownAugments: MarkdownAugmentMap;
  toolUseToAgentEntries: Array<[string, string]>;
  lastMessageId?: string;
  maxPersistedTimestampMs: number;
  scrollSnapshot?: SessionRouteScrollSnapshot;
}

export function selectSessionDetailRuntimeSnapshot(
  state: SessionDetailState,
): SessionDetailRuntimeSnapshot {
  return {
    messages: state.messages,
    session: state.session,
    pagination: state.pagination,
    agentContent: state.agentContent,
    markdownAugments: state.markdownAugments,
    toolUseToAgentEntries: state.toolUseToAgentEntries,
    lastMessageId: state.lastMessageId,
    maxPersistedTimestampMs: state.maxPersistedTimestampMs,
  };
}

export function selectSessionDetailActiveWindowTrimRevision(
  state: SessionDetailState,
): number {
  return state.activeWindowTrimRevision;
}

export function selectSessionDetailMessages(
  state: SessionDetailState,
): Message[] {
  return state.messages;
}

export function selectSessionDetailAgentContent(
  state: SessionDetailState,
): AgentContentMap {
  return state.agentContent;
}

export function selectSessionDetailToolUseToAgentEntries(
  state: SessionDetailState,
): Array<[string, string]> {
  return state.toolUseToAgentEntries;
}

export function selectSessionDetailPagination(
  state: SessionDetailState,
): PaginationInfo | undefined {
  return state.pagination;
}

export function selectSessionDetailSession(
  state: SessionDetailState,
): SessionMetadata | null {
  return state.session;
}

export function selectSessionDetailLastMessageId(
  state: SessionDetailState,
): string | undefined {
  return state.lastMessageId;
}

export function selectSessionDetailProjectionAugments(
  state: SessionDetailState,
  options: { activeToolApproval?: ActiveToolApproval } = {},
): TranscriptProjectionAugments | undefined {
  const hasMarkdownAugments = Object.keys(state.markdownAugments).length > 0;
  if (!hasMarkdownAugments && options.activeToolApproval === undefined) {
    return undefined;
  }

  return {
    ...(hasMarkdownAugments && { markdown: state.markdownAugments }),
    ...(options.activeToolApproval !== undefined && {
      activeToolApproval: options.activeToolApproval,
    }),
  };
}
