import {
  isInjectedContinuationPrompt,
  isSyntheticNoResponseTurn,
} from "../claude-sdk-schema/guards.js";
import { isPostCompactReplayText } from "../postCompactReplay.js";
import { INSTRUCTION_RESTORATION_PREAMBLE } from "../instructionRestoration.js";
import type { ContentBlock, Message } from "./message.js";
import type {
  RenderItem,
  SystemItem,
  ToolCallItem,
  ToolResultData,
} from "./items.js";
import {
  formatCommandTurn,
  isCompactionLocalCommandOutput,
  isLocalCommandCaveatOnly,
  parseCommandTurn,
  parseLocalCommandStdout,
} from "./commandTurn.js";
import { getMessageId } from "./message.js";
import {
  isTaskNotificationMessage,
  parseTaskNotification,
} from "./parseTaskNotification.js";
import { readProjectPathLinkTargets } from "./projectPathLinks.js";
import { parseShellToolOutput } from "./shellToolOutput.js";
import { parseAgentResultFromText } from "./agentResults.js";
import { contentBlocksText } from "./slashCommandBodies.js";
import type { TranscriptProjectionAugments } from "./types.js";

const AWAY_SUMMARY_HINT_SUFFIX_RE = /\s*\(disable recaps in \/config\)\s*$/u;

export interface MessageProjectionDiagnostics {
  onUnmatchedToolResult?: (details: {
    toolUseId: string;
    message: Message;
  }) => void;
  onAssistantMessage?: (details: {
    _isStreaming: boolean | undefined;
    id: string | undefined;
    msgId: string;
    uuid: string | undefined;
  }) => void;
}

export function stripAwaySummaryHintSuffix(content: string): string {
  return content.replace(AWAY_SUMMARY_HINT_SUFFIX_RE, "");
}

export function projectTranscriptMessages(
  messages: Message[],
  augments?: TranscriptProjectionAugments,
  diagnostics?: MessageProjectionDiagnostics,
): RenderItem[] {
  const items: RenderItem[] = [];
  const toolCallIndices = new Map<string, number>(); // tool_use_id → index in items
  const pendingToolCalls = new Map<string, number>(); // tool_use_id → index in items
  const toolResults: { block: ContentBlock; message: Message }[] = [];
  const configAckState = { lastSignature: null as string | null };

  const orphanedToolIds = collectOrphanedToolIds(
    messages,
    augments?.activeToolApproval === true,
  );

  for (const msg of messages) {
    processMessage(
      msg,
      items,
      toolCallIndices,
      pendingToolCalls,
      toolResults,
      orphanedToolIds,
      configAckState,
      augments,
      diagnostics,
    );
  }

  // Reconciliation can place a result before its call; retain result order
  // while pairing only after every call in the loaded window is registered.
  for (const { block, message } of toolResults) {
    attachToolResult(block, message, items, pendingToolCalls, diagnostics);
  }

  return items;
}

function collectOrphanedToolIds(
  messages: Message[],
  suppressCurrentTurnOrphans: boolean,
): Set<string> {
  const orphanedToolIds = new Set<string>();
  const suppressFromIndex = suppressCurrentTurnOrphans
    ? findLastUserPromptMessageIndex(messages)
    : messages.length;

  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index];
    if (!msg?.orphanedToolUseIds) {
      continue;
    }

    if (suppressCurrentTurnOrphans && index >= suppressFromIndex) {
      continue;
    }

    for (const id of msg.orphanedToolUseIds) {
      orphanedToolIds.add(id);
    }
  }

  return orphanedToolIds;
}

function findLastUserPromptMessageIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const msg = messages[index];
    if (msg && isUserPromptMessage(msg)) {
      return index;
    }
  }
  return 0;
}

const INTERNAL_REASONING_PLACEHOLDER = "Reasoning [internal]";

/**
 * The fields the user-turn predicates read. Server-normalized messages and
 * client transcript messages both satisfy it, though their `Message` types
 * differ in how narrowly they spell `role`.
 */
export interface UserTurnCandidate {
  type?: string;
  role?: string;
  content?: unknown;
  message?: { role?: unknown; content?: unknown };
  isCompactSummary?: unknown;
  isMeta?: unknown;
  isSynthetic?: unknown;
  isSubagent?: unknown;
  toolUseResult?: unknown;
}

function getPreprocessMessageContent(
  msg: UserTurnCandidate,
): string | ContentBlock[] | undefined {
  return (msg.message?.content ?? msg.content) as
    | string
    | ContentBlock[]
    | undefined;
}

/** Claude's durable compact-summary body opener (JSONL + live stream). */
const CLAUDE_COMPACT_SUMMARY_PREAMBLE =
  "This session is being continued from a previous conversation that ran out of context";

/**
 * Compact-summary rows are user-role in the provider log but must never paint
 * as a user bubble. Prefer the explicit flag; fall back to Claude's stable
 * preamble (and transcript-only marker) when live SDK stream omits the flag.
 */
function isPostCompactReplayMessage(msg: Message): boolean {
  const content = getPreprocessMessageContent(msg);
  if (content === undefined) {
    return false;
  }
  const text =
    typeof content === "string" ? content : contentBlocksText(content);
  if (
    !isPostCompactReplayText(text) &&
    !text.trimStart().startsWith(INSTRUCTION_RESTORATION_PREAMBLE)
  ) {
    return false;
  }
  const role =
    (msg.message as { role?: "user" | "assistant" } | undefined)?.role ??
    msg.role;
  return msg.type === "user" || role === "user";
}

function isCompactSummaryMessage(msg: UserTurnCandidate): boolean {
  if (msg.isCompactSummary === true) {
    return true;
  }
  const content = getPreprocessMessageContent(msg);
  if (content === undefined) {
    return false;
  }
  const text =
    typeof content === "string" ? content : contentBlocksText(content);
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(CLAUDE_COMPACT_SUMMARY_PREAMBLE)) {
    return false;
  }
  // Preamble alone is extremely distinctive; still require a user-role row.
  const role = msg.message?.role ?? msg.role;
  return msg.type === "user" || role === "user";
}

function isCompactCommand(command: string): boolean {
  const normalized = command.trim().replace(/^\/+/, "").toLowerCase();
  return normalized === "compact" || normalized === "compress";
}

function systemLocalCommandContent(content: unknown): string | null {
  if (typeof content !== "string") {
    return null;
  }

  if (isLocalCommandCaveatOnly(content)) {
    return null;
  }

  const commandTurn = parseCommandTurn(content);
  if (commandTurn) {
    return isCompactCommand(commandTurn.command)
      ? null
      : formatCommandTurn(commandTurn);
  }

  const localCommandStdout = parseLocalCommandStdout(content);
  if (localCommandStdout !== null) {
    if (!localCommandStdout) {
      return null;
    }
    return isCompactionLocalCommandOutput(localCommandStdout)
      ? null
      : localCommandStdout;
  }

  const trimmedContent = content.trim();
  return trimmedContent ? trimmedContent : null;
}

function systemLocalCommandDetails(msg: Message): string[] | undefined {
  const details = (msg as { details?: unknown }).details;
  if (!Array.isArray(details)) {
    return undefined;
  }
  const text = details.filter(
    (detail): detail is string => typeof detail === "string" && !!detail.trim(),
  );
  return text.length > 0 ? text : undefined;
}

/** Claude Code's exit notice that writes failed (ENOSPC/EDQUOT). `lost` and
 * `error_code` are open sets upstream, so unknown values are named as-is. */
function sessionWritesLostContent(msg: Message): string {
  const { error_code: code, lost } = msg as {
    error_code?: unknown;
    lost?: unknown;
  };
  const reason =
    code === "ENOSPC"
      ? "the disk was full"
      : code === "EDQUOT"
        ? "the disk quota was used up"
        : typeof code === "string"
          ? code
          : "a write error";
  const parts = (Array.isArray(lost) ? lost : []).map((item) =>
    item === "transcript"
      ? "Part of the session transcript was not saved, so resuming may miss part of the conversation."
      : item === "global_config"
        ? "Settings changes to ~/.claude.json were not saved."
        : `${String(item)} was not saved.`,
  );
  return [
    `Claude Code could not write to disk: ${reason}.`,
    ...(parts.length > 0 ? parts : ["Session data was not saved."]),
  ].join(" ");
}

function compactMetadataDetail(msg: Message): string | null {
  const metadata = (msg as { compactMetadata?: unknown }).compactMetadata;
  if (!isRecord(metadata)) {
    return null;
  }
  return `compactMetadata:\n${JSON.stringify(metadata, null, 2)}`;
}

/**
 * Human-readable compact body first, then raw provider metadata — so expand
 * shows the compression summary before machine JSON.
 *
 * Deliberately excludes `msg.content`: the chip's own label already renders it
 * verbatim, so repeating it here made the expanded body restate its own
 * heading. When neither a retained summary nor metadata exists the chip stays
 * expandable and the renderer supplies its empty-detail line instead.
 */
function compactBoundaryDetails(msg: Message): Array<string | ContentBlock[]> {
  const details: Array<string | ContentBlock[]> = [];
  const summaryText = (msg as { compactSummaryText?: unknown })
    .compactSummaryText;
  if (typeof summaryText === "string" && summaryText.trim()) {
    details.push(
      typeof msg._html === "string"
        ? [{ type: "text", text: summaryText.trim(), _html: msg._html }]
        : summaryText.trim(),
    );
  }
  const metadata = compactMetadataDetail(msg);
  if (metadata) {
    details.push(metadata);
  }
  return details;
}

function compactSummaryDetails(
  content: string | ContentBlock[] | undefined,
): Array<string | ContentBlock[]> {
  return content === undefined ? [] : [content];
}

function isSlashCommandSkillBodyMessage(msg: UserTurnCandidate): boolean {
  const content = getPreprocessMessageContent(msg);
  return (
    msg.isMeta === true &&
    content !== undefined &&
    contentBlocksText(content)
      .trimStart()
      .startsWith("Base directory for this skill:")
  );
}

export function isUserPromptMessage(msg: Message): boolean {
  const content = getPreprocessMessageContent(msg);
  const role =
    (msg.message as { role?: "user" | "assistant" } | undefined)?.role ??
    msg.role;
  const isUserMessage = msg.type === "user" || role === "user";
  if (!isUserMessage) {
    return false;
  }
  // Task notifications arrive as user-role entries but are SDK-injected, not
  // user-authored — they must not anchor the "last user prompt" affordances.
  if (isTaskNotificationMessage(msg)) {
    return false;
  }
  if (isCompactSummaryMessage(msg)) {
    return false;
  }
  if (isPostCompactReplayMessage(msg)) {
    return false;
  }
  if (isSlashCommandSkillBodyMessage(msg)) {
    return false;
  }
  if (Array.isArray(content)) {
    return !content.every((block) => block.type === "tool_result");
  }
  if (typeof content !== "string") {
    return false;
  }
  if (msg.isMeta === true && isLocalCommandCaveatOnly(content)) {
    return false;
  }
  if (parseLocalCommandStdout(content) !== null) {
    return false;
  }
  return !parseCommandTurn(content);
}

/**
 * Real user turn: a turn the user authored. It is the unit the
 * session-rewind turn index `N` counts (topics/session-rewind.md
 * § Vocabulary) and the request a fork-from-turn boundary starts at. Server
 * normalization stamps `turnIndex` with it, the fork and rewind routes find
 * boundaries with it, and the client numbers live stream rows with it, so
 * none of them can disagree about which rows are turns. Compact summaries,
 * post-compact replay text, skill bodies, tool results, and synthetic or
 * subagent rows are not turns.
 */
export function isRealUserTurn(msg: UserTurnCandidate): boolean {
  const role = msg.message?.role ?? msg.role ?? msg.type;
  if (role !== "user") return false;
  if (msg.isSynthetic === true || msg.isSubagent === true) return false;
  if (msg.toolUseResult !== undefined) return false;
  if (isCompactSummaryMessage(msg)) return false;
  if (isSlashCommandSkillBodyMessage(msg)) return false;
  const content = getPreprocessMessageContent(msg);
  if (content === undefined) return true;
  if (
    Array.isArray(content) &&
    content.some(
      (block) => block.type === "tool_result" || block.type === "tool_use",
    )
  ) {
    return false;
  }
  const text =
    typeof content === "string" ? content : contentBlocksText(content);
  return (
    !isPostCompactReplayText(text) &&
    !text.trimStart().startsWith(INSTRUCTION_RESTORATION_PREAMBLE)
  );
}

function isDisplayableThinking(
  thinking: string | undefined,
): thinking is string {
  const trimmed = thinking?.trim();
  return !!trimmed && trimmed !== INTERNAL_REASONING_PLACEHOLDER;
}

function findLastNonEmptyTextBlockIndex(content: ContentBlock[]): number {
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (block?.type === "text" && block.text?.trim()) {
      return i;
    }
  }
  return -1;
}

function processMessage(
  msg: Message,
  items: RenderItem[],
  toolCallIndices: Map<string, number>,
  pendingToolCalls: Map<string, number>,
  toolResults: { block: ContentBlock; message: Message }[],
  orphanedToolIds: Set<string>,
  configAckState: { lastSignature: string | null },
  augments?: TranscriptProjectionAugments,
  diagnostics?: MessageProjectionDiagnostics,
): void {
  const msgId = getMessageId(msg);

  // Claude Code restarts a session whose process is gone by injecting a
  // "Continue from where you left off." meta prompt and answering it with a
  // zero-token placeholder. Neither is a real turn, so rendering them as a user
  // bubble followed by an assistant reply invents an exchange that never
  // happened. Drop the injected prompt; show the placeholder as the one system
  // notice that says what actually occurred.
  if (isInjectedContinuationPrompt(msg)) {
    return;
  }
  if (isPostCompactReplayMessage(msg)) {
    return;
  }
  if (isSyntheticNoResponseTurn(msg)) {
    items.push({
      type: "system",
      id: msgId,
      subtype: "no_model_turn",
      content: "Session continued without running a turn",
      sourceMessages: [msg],
      isSubagent: msg.isSubagent,
    });
    return;
  }

  // Handle provider/runtime error entries as visible system messages.
  if (msg.type === "error") {
    const errorText =
      (typeof msg.error === "string" && msg.error) ||
      (typeof msg.content === "string" && msg.content) ||
      "Agent error";
    const systemItem: SystemItem = {
      type: "system",
      id: msgId || `error-${msg.timestamp ?? Date.now()}`,
      subtype: msg.codexWillRetry === true ? "warning" : "error",
      content: errorText,
      sourceMessages: [msg],
    };
    items.push(systemItem);
    return;
  }

  // Handle system entries (compact_boundary, status, etc.)
  if (msg.type === "system") {
    const subtype = (msg as { subtype?: string }).subtype ?? "unknown";
    if (subtype === "informational") {
      if (typeof msg.content === "string" && msg.content.trim()) {
        items.push({
          type: "system",
          id: msgId,
          subtype: msg.level === "warning" ? "warning" : "informational",
          content: msg.content,
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
        });
      }
      return;
    }
    if (subtype === "session_writes_lost") {
      items.push({
        type: "system",
        id: msgId,
        subtype: "warning",
        content: sessionWritesLostContent(msg),
        sourceMessages: [msg],
        isSubagent: msg.isSubagent,
      });
      return;
    }
    if (subtype === "local_command") {
      const content = systemLocalCommandContent(msg.content);
      if (content !== null) {
        items.push({
          type: "system",
          id: msgId,
          subtype,
          content,
          details: systemLocalCommandDetails(msg),
          ...((msg as { detailsOpen?: unknown }).detailsOpen === true
            ? { detailsOpen: true }
            : {}),
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
        });
      }
      return;
    }

    // Header of a same-session rewound group (topics/session-rewind.md). The
    // group details ride on the source message; the header carries no text.
    if (subtype === "rewound_group") {
      items.push({
        type: "system",
        id: msgId,
        subtype,
        content: typeof msg.content === "string" ? msg.content : "",
        sourceMessages: [msg],
      });
      return;
    }

    if (subtype === "tool_output") {
      const toolName =
        typeof msg.codexToolName === "string" ? msg.codexToolName : "";
      const namespace =
        typeof msg.codexToolNamespace === "string"
          ? msg.codexToolNamespace
          : "";
      const qualifiedName = [namespace, toolName].filter(Boolean).join(".");
      const output = typeof msg.content === "string" ? msg.content : "";
      items.push({
        type: "system",
        id: msgId,
        subtype,
        content: qualifiedName,
        details: output ? [output] : [],
        sourceMessages: [msg],
        isSubagent: msg.isSubagent,
      });
      return;
    }

    // Render compact_boundary as a visible system message
    if (
      subtype === "compact_boundary" ||
      subtype === "turn_aborted" ||
      subtype === "content_filter_block" ||
      subtype === "config_ack" ||
      subtype === "away_summary" ||
      subtype === "subagent_activity"
    ) {
      const configSignature =
        subtype === "config_ack" ? getConfigAckSignature(msg) : null;
      const content =
        typeof msg.content === "string"
          ? msg.content
          : subtype === "turn_aborted"
            ? "Turn aborted"
            : subtype === "content_filter_block"
              ? ""
              : subtype === "config_ack"
                ? "Configuration updated"
                : subtype === "away_summary"
                  ? "Recap unavailable"
                  : subtype === "subagent_activity"
                    ? "Subagent updated"
                    : "Context compacted";
      const systemItem: SystemItem = {
        type: "system",
        id: msgId,
        subtype,
        content:
          subtype === "away_summary"
            ? stripAwaySummaryHintSuffix(content)
            : content,
        sourceMessages: [msg],
        ...(subtype === "compact_boundary"
          ? {
              details: compactBoundaryDetails(msg),
            }
          : {}),
        ...(subtype === "config_ack"
          ? {
              configChanged:
                msg.configMismatch === true &&
                configSignature !== null &&
                configSignature !== configAckState.lastSignature,
            }
          : {}),
      };
      items.push(systemItem);
      if (subtype === "config_ack" && configSignature !== null) {
        configAckState.lastSignature = configSignature;
      }
    }
    // Status messages (compacting indicator) are transient - handled separately via isCompacting state
    // Skip other system entries (init, status, etc.) - they're internal
    return;
  }

  // Debug logging for streaming transition issues
  if (msg.type === "assistant") {
    diagnostics?.onAssistantMessage?.({
      msgId,
      uuid: msg.uuid,
      id: msg.id,
      _isStreaming: msg._isStreaming,
    });
  }

  // Get content from nested message object (SDK structure) first, fall back to top-level
  // Phase 4c: prefer message.content over top-level content
  const content =
    (msg.message as { content?: string | ContentBlock[] } | undefined)
      ?.content ?? msg.content;

  // Use type for discrimination (SDK field), fall back to role for legacy data
  // Phase 4c: prefer type over role, but maintain backward compatibility
  const role =
    (msg.message as { role?: "user" | "assistant" } | undefined)?.role ??
    msg.role;
  const isUserMessage = msg.type === "user" || role === "user";

  // String content = user prompt (only if type is user)
  if (typeof content === "string") {
    if (isUserMessage) {
      if (isCompactSummaryMessage(msg)) {
        items.push({
          type: "system",
          id: msgId,
          subtype: "compact_boundary",
          content: "Context compacted",
          details: compactSummaryDetails(content),
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
        });
        return;
      }
      if (msg.isMeta === true && isLocalCommandCaveatOnly(content)) {
        return;
      }
      const commandTurn = parseCommandTurn(content);
      if (commandTurn) {
        if (isCompactCommand(commandTurn.command)) {
          return;
        }
        items.push({
          type: "system",
          id: msgId,
          subtype: "local_command",
          content: formatCommandTurn(commandTurn),
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
        });
        return;
      }
      const localCommandStdout = parseLocalCommandStdout(content);
      if (localCommandStdout !== null) {
        if (!localCommandStdout) {
          return;
        }
        if (isCompactionLocalCommandOutput(localCommandStdout)) {
          return;
        }
        items.push({
          type: "system",
          id: msgId,
          subtype: "local_command",
          content: localCommandStdout,
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
        });
        return;
      }
      // SDK-injected task notifications render as a system/event chip, not a
      // user bubble. Gated on origin.kind (non-heuristic), then the XML body is
      // parsed for the chip's structured fields.
      if (isTaskNotificationMessage(msg)) {
        const parsed = parseTaskNotification(content);
        items.push({
          type: "task_notification",
          id: msgId,
          raw: content,
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
          ...parsed,
        });
        return;
      }
      items.push({
        type: "user_prompt",
        id: msgId,
        content,
        projectPathLinks: readProjectPathLinkTargets(msg._projectPathLinks),
        sourceMessages: [msg],
        isSubagent: msg.isSubagent,
      });
      return;
    }
    // Assistant message with string content - convert to text block
    if (content.trim()) {
      const messageHtml = (msg as { _html?: string })._html;
      items.push({
        type: "text",
        id: msgId,
        text: content,
        sourceBlockIndex: 0,
        sourceMessages: [msg],
        isSubagent: msg.isSubagent,
        augmentHtml: messageHtml ?? augments?.markdown?.[msgId]?.html,
      });
    }
    return;
  }

  // Not an array - shouldn't happen but handle gracefully
  if (!Array.isArray(content)) {
    return;
  }

  // Check if this is a user message with only tool_result blocks
  const isToolResultMessage =
    isUserMessage && content.every((b) => b.type === "tool_result");

  if (isToolResultMessage) {
    // Keep result order independent of where calls appear in the window.
    for (const block of content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        toolResults.push({ block, message: msg });
      }
    }
    return;
  }

  // Check if this is a real user prompt (not tool results)
  if (isUserMessage) {
    if (isCompactSummaryMessage(msg)) {
      items.push({
        type: "system",
        id: msgId,
        subtype: "compact_boundary",
        content: "Context compacted",
        details: compactSummaryDetails(content),
        sourceMessages: [msg],
        isSubagent: msg.isSubagent,
      });
      return;
    }
    items.push({
      type: "user_prompt",
      id: msgId,
      content,
      sourceMessages: [msg],
      isSubagent: msg.isSubagent,
    });
    return;
  }

  // Assistant message - process each block
  // First pass: find the last text block index (for streaming cursor placement)
  const lastTextBlockIndex = msg._isStreaming
    ? findLastNonEmptyTextBlockIndex(content)
    : -1;
  // Claude aborts the in-flight request to take a `priority: "now"` steer and
  // persists the text streamed so far, so that record stops mid-sentence. The
  // same index marks where the cut happened.
  const abortedTextBlockIndex =
    msg.isAbortedMidStream === true && !msg._isStreaming
      ? findLastNonEmptyTextBlockIndex(content)
      : -1;

  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block) continue;

    const blockId = `${msgId}-${i}`;

    if (block.type === "text") {
      if (block.text?.trim()) {
        // Get _html from server-injected augment, fall back to markdownAugments (for SSE path)
        const blockHtml = (block as { _html?: string })._html;
        items.push({
          type: "text",
          id: blockId,
          text: block.text,
          sourceBlockIndex: i,
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
          // Only show streaming cursor on the last text block
          isStreaming: msg._isStreaming && i === lastTextBlockIndex,
          // Prefer inline _html from server, fall back to markdownAugments (SSE path)
          augmentHtml: blockHtml ?? augments?.markdown?.[msgId]?.html,
          ...(i === abortedTextBlockIndex ? { abortedMidStream: true } : {}),
        });
      }
    } else if (block.type === "thinking") {
      const thinking = block.thinking;
      if (isDisplayableThinking(thinking)) {
        items.push({
          type: "thinking",
          id: blockId,
          thinking,
          sourceBlockIndex: i,
          signature: undefined,
          status: msg._isStreaming ? "streaming" : "complete",
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
        });
      }
    } else if (block.type === "tool_use") {
      if (block.id && block.name) {
        // Stream reconnects/resume can replay the same tool_use id from a
        // different assistant message snapshot. Keep one render item per tool id.
        const existingIndex = toolCallIndices.get(block.id);
        if (existingIndex !== undefined) {
          const existingItem = items[existingIndex];
          if (existingItem?.type === "tool_call") {
            items[existingIndex] = updateToolCallSnapshot(
              existingItem,
              msg,
              block.input,
              block._displayActions,
              block._mcpApp,
            );
            if (existingItem.status === "pending") {
              pendingToolCalls.set(block.id, existingIndex);
            }
          }
          continue;
        }

        // Check if this tool call is missing a result after the turn boundary.
        // That is not the same as an explicit interruption: Codex/YA may have
        // missed the result event even though a side effect, such as an edit,
        // landed in the filesystem.
        const isOrphaned = orphanedToolIds.has(block.id);
        const toolCall: ToolCallItem = {
          type: "tool_call",
          id: block.id,
          toolName: block.name,
          toolInput: block.input,
          ...(block._displayActions
            ? { displayActions: block._displayActions }
            : {}),
          ...(block._mcpApp ? { mcpApp: block._mcpApp } : {}),
          toolResult: undefined,
          status: isOrphaned ? "incomplete" : "pending",
          sourceMessages: [msg],
          isSubagent: msg.isSubagent,
        };
        const itemIndex = items.length;
        toolCallIndices.set(block.id, itemIndex);
        pendingToolCalls.set(block.id, itemIndex);
        items.push(toolCall);
      }
    }
  }
}

function getConfigAckSignature(msg: Message): string | null {
  const configModel =
    typeof msg.configModel === "string" ? msg.configModel.trim() : "";
  const configThinking =
    typeof msg.configThinking === "string" ? msg.configThinking.trim() : "";
  if (configModel || configThinking) {
    return `${configModel}::${configThinking}`;
  }
  return typeof msg.content === "string" ? msg.content.trim() : null;
}

function appendSourceMessage(
  item: ToolCallItem,
  message: Message,
): ToolCallItem {
  const messageId = getMessageId(message);
  if (
    item.sourceMessages.some((source) => getMessageId(source) === messageId)
  ) {
    return item;
  }
  return {
    ...item,
    sourceMessages: [...item.sourceMessages, message],
  };
}

function updateToolCallSnapshot(
  item: ToolCallItem,
  message: Message,
  toolInput: unknown,
  displayActions: ToolCallItem["displayActions"],
  mcpApp: ToolCallItem["mcpApp"],
): ToolCallItem {
  const withSource = appendSourceMessage(item, message);
  return {
    ...withSource,
    toolInput,
    displayActions,
    ...(mcpApp ? { mcpApp } : {}),
  };
}

function attachToolResult(
  block: ContentBlock,
  resultMessage: Message,
  items: RenderItem[],
  pendingToolCalls: Map<string, number>,
  diagnostics?: MessageProjectionDiagnostics,
): void {
  const toolUseId = block.tool_use_id;
  if (!toolUseId) return;

  const index = pendingToolCalls.get(toolUseId);
  if (index === undefined) {
    // Orphan result - shouldn't happen normally
    if (diagnostics?.onUnmatchedToolResult) {
      diagnostics.onUnmatchedToolResult({ toolUseId, message: resultMessage });
    } else {
      console.warn(`Tool result for unknown tool_use: ${toolUseId}`);
    }
    return;
  }

  const item = items[index];
  if (item?.type !== "tool_call") return;

  // Attach result to existing tool call
  // Handle both camelCase (toolUseResult) and snake_case (tool_use_result) from SDK
  let structured =
    resultMessage.toolUseResult ??
    (resultMessage as Record<string, unknown>).tool_use_result;

  // SDK 0.2.76+: Agent tool has no structured tool_use_result.
  // Parse agentId and usage stats from the text content blocks instead.
  if (!structured && (item.toolName === "Agent" || item.toolName === "Task")) {
    structured = parseAgentResultFromText(block);
  }
  structured = normalizeBashFailureResult(item, block, structured);
  const projectPathLinks = readProjectPathLinkTargets(block._projectPathLinks);

  const resultData: ToolResultData = {
    content: typeof block.content === "string" ? block.content : "",
    isError: block.is_error || false,
    structured,
    ...(projectPathLinks ? { projectPathLinks } : {}),
    ...(resultMessage.toolResultMedia?.some(
      (media) => media.toolCallId === block.tool_use_id,
    )
      ? {
          media: resultMessage.toolResultMedia.filter(
            (media) => media.toolCallId === block.tool_use_id,
          ),
        }
      : {}),
  };
  const isBackgroundProcessResult = isBackgroundProcessToolResult(
    block,
    item.toolName,
  );
  const isInterruptedProcessResult = isInterruptedToolResult(
    block,
    resultData,
    item.toolName,
  );

  // A streaming result is the running call's output so far; the call stays
  // pending and its final result can still attach.
  const isLiveOutput = resultMessage._isStreaming === true;

  // Create a new ToolCallItem to ensure React sees the change
  let status: ToolCallItem["status"] = "complete";
  if (isLiveOutput) {
    status = "pending";
  } else if (isInterruptedProcessResult || item.status === "aborted") {
    status = "aborted";
  } else if (isBackgroundProcessResult) {
    status = item.status === "incomplete" ? "incomplete" : "pending";
  } else if (block.is_error) {
    status = "error";
  }
  const updatedItem: ToolCallItem = {
    type: "tool_call",
    id: item.id,
    toolName: item.toolName,
    toolInput: item.toolInput,
    ...(item.displayActions ? { displayActions: item.displayActions } : {}),
    ...(item.mcpApp ? { mcpApp: item.mcpApp } : {}),
    toolResult: resultData,
    status,
    sourceMessages: appendSourceMessage(item, resultMessage).sourceMessages,
    isSubagent: item.isSubagent,
  };

  items[index] = updatedItem;
  if (
    !isLiveOutput &&
    !isBackgroundProcessResult &&
    !isInterruptedProcessResult
  ) {
    pendingToolCalls.delete(toolUseId);
  }
}

function normalizeBashFailureResult(
  item: ToolCallItem,
  block: ContentBlock,
  structured: unknown,
): unknown {
  if (item.toolName !== "Bash" || block.is_error !== true) {
    return structured;
  }
  const resultText =
    typeof structured === "string"
      ? structured
      : typeof block.content === "string"
        ? block.content
        : "";
  const parsed = parseShellToolOutput(resultText, {
    bareExitCodeIsEnvelope: true,
  });
  if (!parsed.hasEnvelope || parsed.exitCode === undefined) {
    return structured;
  }
  return {
    stdout: parsed.output,
    stderr: "",
    interrupted: false,
    isImage: false,
    exitCode: parsed.exitCode,
  };
}

function isBackgroundProcessToolResult(
  block: ContentBlock,
  toolName: string,
): boolean {
  if (toolName !== "Bash") {
    return false;
  }
  const content = typeof block.content === "string" ? block.content : "";
  if (!content) {
    return false;
  }
  return (
    /(?:^|\n)\s*(?:Process\s+running\s+with\s+session\s+ID|session(?:\s+id)?)\s*:?\s*\d+\b/i.test(
      content,
    ) &&
    !/(?:^|\n)\s*(?:Exit code:|Process exited with code)\s*-?\d+\b/i.test(
      content,
    )
  );
}

function isInterruptedToolResult(
  block: ContentBlock,
  result: ToolResultData,
  toolName: string,
): boolean {
  if (toolName !== "Bash") {
    return false;
  }
  if (
    result.structured &&
    typeof result.structured === "object" &&
    (result.structured as { interrupted?: unknown }).interrupted === true
  ) {
    return true;
  }
  const content = typeof block.content === "string" ? block.content : "";
  return /(?:^|\n)\s*(?:aborted by user|interrupted by user)(?:\s|$)/i.test(
    content,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
