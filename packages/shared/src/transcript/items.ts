import type {
  ProjectPathLinkTarget,
  ToolDisplayAction,
  ToolResultMedia,
  TranscriptDisplayObject,
} from "../index.js";
import type { ContentBlock, Message } from "./message.js";
import type { WorkflowAnnotation } from "./workflowTags.js";

/**
 * RenderItem types for the preprocessed message rendering system.
 *
 * Instead of rendering Message[] directly, we preprocess into RenderItem[]
 * that pairs tool_use with tool_result for unified display.
 */

export type RenderItem =
  | TextItem
  | ThinkingItem
  | ToolCallItem
  | UserPromptItem
  | SessionSetupItem
  | TranscriptDisplayObjectItem
  | SystemItem
  | TaskNotificationItem
  | ConversationActivityItem;

/** Base fields shared by all render items */
interface RenderItemBase {
  workflow?: WorkflowAnnotation;
  /** Source JSONL messages that contributed to this item (for debugging) */
  sourceMessages: Message[];
  /** True if this item is from a Task subagent */
  isSubagent?: boolean;
}

export interface TextItem extends RenderItemBase {
  type: "text";
  id: string;
  text: string;
  /** True if this text is still being streamed */
  isStreaming?: boolean;
  /**
   * True when the provider cut this text off mid-generation to take a steering
   * message. Set only on the last text of such a message, so the marker sits
   * where the sentence stops.
   */
  abortedMidStream?: boolean;
  /** Pre-rendered HTML from server (for completed messages) */
  augmentHtml?: string;
  /** Prefix-causal basename targets noticed by the browser replay. */
  projectPathLinks?: ProjectPathLinkTarget[];
}

export interface ThinkingItem extends RenderItemBase {
  type: "thinking";
  id: string;
  thinking: string;
  signature?: string;
  status: "streaming" | "complete";
}

export interface ToolCallItem extends RenderItemBase {
  type: "tool_call";
  id: string; // tool_use.id
  toolName: string; // tool_use.name
  toolInput: unknown; // tool_use.input
  /** Derived semantics carried for grouping; renderers ignore them for now. */
  displayActions?: ToolDisplayAction[];
  toolResult?: ToolResultData; // undefined while pending
  /** "incomplete" means the turn ended without YA observing a result. */
  status: "pending" | "complete" | "error" | "aborted" | "incomplete";
}

export interface ToolResultData {
  content: string;
  isError: boolean;
  /** Structured result from JSONL toolUseResult field */
  structured?: unknown;
  /** Session-scoped media captured from the tool result. */
  media?: ToolResultMedia[];
  /** Exact file targets confirmed by the serving project. */
  projectPathLinks?: ProjectPathLinkTarget[];
}

export interface UserPromptItem extends RenderItemBase {
  type: "user_prompt";
  id: string;
  content: string | ContentBlock[];
  /** Exact file targets confirmed by the serving project. */
  projectPathLinks?: ProjectPathLinkTarget[];
}

/**
 * A Claude Code `<task-notification>` entry: the SDK injects these (as user-role
 * entries) when a backgrounded task changes state. Rendered as a system/event
 * chip, not a user bubble. Detected via `origin.kind` (see parseTaskNotification).
 */
export interface TaskNotificationItem extends RenderItemBase {
  type: "task_notification";
  id: string;
  /** Raw XML body, retained for copy/debug and as a fallback when unparsed. */
  raw: string;
  taskId?: string;
  toolUseId?: string;
  outputFile?: string;
  status?: string;
  summary?: string;
  /** Streaming progress body (Monitor `<event>` log dump), when present. */
  event?: string;
}

export interface SessionSetupItem extends RenderItemBase {
  type: "session_setup";
  id: string;
  title: string;
  prompts: Array<string | ContentBlock[]>;
}

export interface TranscriptDisplayObjectItem extends RenderItemBase {
  type: "transcript_display_object";
  id: string;
  object: TranscriptDisplayObject;
}

export interface SystemItem extends RenderItemBase {
  type: "system";
  id: string;
  subtype: "compact_boundary" | "status" | "init" | string;
  content: string;
  details?: Array<string | ContentBlock[]>;
  /** For status subtype: the current status (e.g., "compacting") */
  status?: "compacting" | null;
  /** For config_ack subtype: whether it differs from the previous config ack */
  configChanged?: boolean;
}

/**
 * Compact Conversation-view replacement for routine activity in one assistant
 * turn. Expanding it restores the hidden render items in their original
 * positions; the summary itself remains at the turn end as the collapse
 * control.
 */
export interface ConversationActivityItem extends RenderItemBase {
  type: "conversation_activity";
  id: string;
  activityCount: number;
  active: boolean;
  expanded: boolean;
  /**
   * Compact intersection of Conversation View and the thinking-visibility
   * control. These previews remain attached to the final activity summary;
   * expanding an activity restores the original thinking item instead.
   */
  thinkingPreviews?: ConversationThinkingPreview[];
  /**
   * True when this turn still has visible agent-authored conversation text
   * after its last thinking block. Conversation view uses that to auto-hide
   * the thinking preview once the completed turn has been glanceable.
   */
  hasFollowingConversationText?: boolean;
  /**
   * Newest concrete activity kinds for a live turn, newest first. Capped
   * generously; the visible count is decided by layout — the list clips to the
   * height beside the thinking preview. The visible row is only a name; its
   * ordinary tool summary remains available as a tooltip.
   */
  recentActivities?: ConversationRecentActivity[];
  /**
   * Newest ordinary activity summaries available when the summary tooltip is
   * explicitly enlarged. The headline's count remains authoritative when this
   * bounded preview omits thinking or older activity.
   */
  tooltipActivities?: ConversationRecentActivity[];
  /** Earliest observed source-message timestamp among condensed activities. */
  startedAtMs: number | null;
  /** Latest observed timestamp, or the current clock while the turn is active. */
  endedAtMs: number | null;
}

export interface ConversationThinkingPreview {
  id: string;
  kind: "current" | "latest" | "previous";
  slot: ConversationThinkingPreviewSlot;
  thinking: string;
  status: ThinkingItem["status"];
  /**
   * Latest observed source timestamp for this block, so a card can say how far
   * back in the turn it sits. Null when the provider gave no timestamps; the
   * card then shows no age rather than inventing one.
   */
  endedAtMs: number | null;
}

export type ConversationThinkingPreviewSlot = "latest" | "previous";

export interface ConversationRecentActivity {
  label: string;
  detail: string;
  preview?: string;
}
