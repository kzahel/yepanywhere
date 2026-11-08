import {
  type McpAppToolCall,
  mcpAppToolCallFromCodexItem,
} from "@yep-anywhere/shared";
import {
  CODEX_TOOL_CORRELATION_FIELD,
  type CodexAsyncUserInputQuestion,
  createCodexToolCorrelation,
  normalizeCodexAsyncUserInputQuestions,
} from "@yep-anywhere/shared";
import {
  isCodexCorrelationDebugEnabled,
  logCodexCorrelationDebug,
  summarizeCodexNormalizedMessage,
} from "../../codex/correlationDebugLogger.js";
import {
  canonicalizeCodexToolName,
  codexToolMessageId,
  type CodexToolCallContext,
  normalizeCodexCommandExecutionOutput,
  normalizeCodexToolInvocation,
  normalizeCodexToolOutputWithContext,
} from "../../codex/normalization.js";
import { formatCodexSubagentActivity } from "../../codex/subagentActivity.js";
import { attachToolResultMediaCandidates } from "../../media/inlineImageData.js";
import type { SDKMessage, TimestampedSDKMessage } from "../types.js";
import type { ThreadItem as CodexThreadItem } from "./codex-protocol/index.js";

export function logSdkCorrelationDebug(
  sessionId: string,
  message: SDKMessage,
  metadata: {
    eventKind?: string;
    turnId?: string;
    itemId?: string;
    callId?: string;
    phase?: string;
    sourceEvent?: string;
    status?: string;
  } = {},
): void {
  if (!isCodexCorrelationDebugEnabled()) return;
  logCodexCorrelationDebug({
    sessionId,
    channel: "sdk",
    authority: "transient",
    ...metadata,
    ...summarizeCodexNormalizedMessage(message),
  });
}

export function withCodexTimestamp<T extends SDKMessage>(
  message: T,
  timestamp = new Date().toISOString(),
): TimestampedSDKMessage<T> {
  if (
    typeof message.timestamp === "string" &&
    message.timestamp.trim().length > 0
  ) {
    return message as TimestampedSDKMessage<T>;
  }
  return {
    ...message,
    timestamp,
  } as TimestampedSDKMessage<T>;
}

export interface NormalizedFileChange {
  path: string;
  kind: "add" | "delete" | "update";
  diff?: string;
}

export type NormalizedThreadItem =
  | { id: string; type: "reasoning"; text: string }
  | {
      id: string;
      type: "agent_message";
      text: string;
      delivery?: "async";
      questions?: CodexAsyncUserInputQuestion[];
    }
  | {
      id: string;
      type: "command_execution";
      command: string;
      aggregated_output: string;
      exit_code?: number;
      durationMs?: number;
      status: string;
      cwd?: string;
      commandActions?: unknown[];
    }
  | {
      id: string;
      type: "file_change";
      changes: NormalizedFileChange[];
      status: string;
    }
  | {
      id: string;
      type: "mcp_tool_call";
      server: string;
      tool: string;
      arguments: unknown;
      mcpApp?: McpAppToolCall;
      result?: unknown;
      error?: { message: string };
      status: string;
    }
  | {
      id: string;
      type: "dynamic_tool_call";
      namespace?: string | null;
      tool: string;
      arguments: unknown;
      status: string;
      content_items?: unknown[] | null;
      success?: boolean | null;
    }
  | {
      id: string;
      type: "function_call_output";
      name: string;
      namespace?: string | null;
      output: unknown;
    }
  | { id: string; type: "web_search"; query: string }
  | {
      id: string;
      type: "todo_list";
      items: Array<{ text: string; completed: boolean }>;
    }
  | {
      id: string;
      type: "subagent_activity";
      kind: string;
      agentThreadId: string;
      agentPath: string;
      text: string;
    }
  | { id: string; type: "context_compaction" }
  | { id: string; type: "error"; message: string }
  | { id: string; type: "image_view"; path: string };

export function normalizeThreadItem(
  item: CodexThreadItem | Record<string, unknown>,
): NormalizedThreadItem | null {
  const itemRecord = item as Record<string, unknown>;
  const id = getOptionalString(itemRecord.id);
  const type = getOptionalString(itemRecord.type);
  if (!id || !type) {
    return null;
  }

  const normalizedType = type.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

  switch (normalizedType) {
    case "reasoning": {
      const text = getReasoningText(itemRecord);
      if (!text) return null;
      return { id, type: "reasoning", text };
    }

    case "agent_message":
    case "plan": {
      const text = getOptionalString(itemRecord.text) ?? "";
      const delivery = itemRecord.delivery === "async" ? "async" : undefined;
      const questions = delivery
        ? normalizeCodexAsyncUserInputQuestions(itemRecord.questions)
        : undefined;
      return {
        id,
        type: "agent_message",
        text,
        ...(delivery ? { delivery } : {}),
        ...(questions ? { questions } : {}),
      };
    }

    case "function_call_output": {
      const name = getOptionalString(itemRecord.name);
      if (!name) return null;
      return {
        id,
        type: "function_call_output",
        name,
        namespace: getOptionalString(itemRecord.namespace),
        output: itemRecord.output,
      };
    }

    case "command_execution": {
      const commandActions =
        (Array.isArray(itemRecord.commandActions)
          ? itemRecord.commandActions
          : Array.isArray(itemRecord.command_actions)
            ? itemRecord.command_actions
            : undefined) ?? undefined;
      const cwd = getOptionalString(itemRecord.cwd);
      return {
        id,
        type: "command_execution",
        command: getOptionalString(itemRecord.command) ?? "",
        aggregated_output:
          getOptionalString(itemRecord.aggregated_output) ??
          getOptionalString(itemRecord.aggregatedOutput) ??
          "",
        exit_code:
          getOptionalNumber(itemRecord.exit_code) ??
          getOptionalNumber(itemRecord.exitCode) ??
          undefined,
        durationMs:
          getOptionalNumber(itemRecord.duration_ms) ??
          getOptionalNumber(itemRecord.durationMs) ??
          undefined,
        status: normalizeStatus(itemRecord.status),
        ...(cwd ? { cwd } : {}),
        ...(commandActions ? { commandActions } : {}),
      };
    }

    case "file_change": {
      const changesRaw = Array.isArray(itemRecord.changes)
        ? itemRecord.changes
        : [];
      const changes: NormalizedFileChange[] = [];
      for (const change of changesRaw) {
        if (!change || typeof change !== "object") continue;
        const record = change as Record<string, unknown>;
        const path = getOptionalString(record.path);
        if (!path) continue;

        let kind: "add" | "delete" | "update" = "update";
        const rawKind = record.kind;
        if (typeof rawKind === "string") {
          if (
            rawKind === "add" ||
            rawKind === "delete" ||
            rawKind === "update"
          ) {
            kind = rawKind;
          }
        } else if (rawKind && typeof rawKind === "object") {
          const rawType = getOptionalString(
            (rawKind as Record<string, unknown>).type,
          );
          if (
            rawType === "add" ||
            rawType === "delete" ||
            rawType === "update"
          ) {
            kind = rawType;
          }
        }

        const diff = getOptionalString(record.diff) ?? undefined;
        changes.push({
          path,
          kind,
          ...(diff ? { diff } : {}),
        });
      }

      return {
        id,
        type: "file_change",
        changes,
        status: normalizeStatus(itemRecord.status),
      };
    }

    case "mcp_tool_call": {
      const errorObj =
        itemRecord.error && typeof itemRecord.error === "object"
          ? (itemRecord.error as Record<string, unknown>)
          : null;

      const server = getOptionalString(itemRecord.server) ?? "unknown";
      const tool = getOptionalString(itemRecord.tool) ?? "unknown";
      return {
        id,
        type: "mcp_tool_call",
        server,
        tool,
        arguments: itemRecord.arguments,
        mcpApp: mcpAppToolCallFromCodexItem(itemRecord, server, tool),
        result: itemRecord.result,
        error:
          getOptionalString(errorObj?.message) !== null
            ? { message: getOptionalString(errorObj?.message) ?? "" }
            : undefined,
        status: normalizeStatus(itemRecord.status),
      };
    }

    case "dynamic_tool_call": {
      return {
        id,
        type: "dynamic_tool_call",
        namespace: getOptionalString(itemRecord.namespace),
        tool: getOptionalString(itemRecord.tool) ?? "unknown",
        arguments: itemRecord.arguments,
        status: normalizeStatus(itemRecord.status),
        content_items: Array.isArray(itemRecord.contentItems)
          ? itemRecord.contentItems
          : null,
        success:
          typeof itemRecord.success === "boolean" ? itemRecord.success : null,
      };
    }

    case "web_search": {
      return {
        id,
        type: "web_search",
        query: getOptionalString(itemRecord.query) ?? "",
      };
    }

    case "todo_list": {
      const items = Array.isArray(itemRecord.items)
        ? itemRecord.items
            .map((entry: unknown) => {
              if (!entry || typeof entry !== "object") return null;
              const record = entry as Record<string, unknown>;
              const text = getOptionalString(record.text);
              if (!text) return null;
              return {
                text,
                completed: record.completed === true,
              };
            })
            .filter(
              (entry: unknown): entry is { text: string; completed: boolean } =>
                entry !== null,
            )
        : [];
      return {
        id,
        type: "todo_list",
        items,
      };
    }

    case "sub_agent_activity": {
      const kind = getOptionalString(itemRecord.kind) ?? "updated";
      const agentPath = getOptionalString(itemRecord.agentPath) ?? "";
      return {
        id,
        type: "subagent_activity",
        kind,
        agentThreadId: getOptionalString(itemRecord.agentThreadId) ?? "",
        agentPath,
        text: formatCodexSubagentActivity(kind, agentPath),
      };
    }

    case "context_compaction":
      return { id, type: "context_compaction" };

    case "image_view": {
      const imagePath = getOptionalString(itemRecord.path) ?? "";
      if (!imagePath) return null;
      return { id, type: "image_view", path: imagePath };
    }

    case "error": {
      const message = getOptionalString(itemRecord.message) ?? "Codex error";
      return {
        id,
        type: "error",
        message,
      };
    }

    default:
      return null;
  }
}

function getReasoningText(item: Record<string, unknown>): string {
  const text = getOptionalString(item.text);
  if (text) return text;

  const summary = Array.isArray(item.summary)
    ? item.summary.filter((part): part is string => typeof part === "string")
    : [];
  if (summary.length > 0) {
    return summary.join("\n");
  }

  const content = Array.isArray(item.content)
    ? item.content.filter((part): part is string => typeof part === "string")
    : [];
  if (content.length > 0) {
    return content.join("\n");
  }

  return "";
}

export function normalizeStatus(status: unknown): string {
  if (typeof status !== "string") return "unknown";
  return status.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

export function buildItemEventKey(turnId: string, itemId: string): string {
  return `${turnId}:${itemId}`;
}

export function buildItemMessageUuid(itemId: string): string {
  return itemId;
}

// Native tool thread items carry Codex's globally-unique call_id as item.id,
// so this uuid aligns directly with the durable response item. A code-mode
// commandExecution instead carries an inner exec-* id while rollout stores
// the outer call_* id; the client reconciles that scoped exception via
// _codexToolCorrelation. See topics/stream-durable-id-dedup.md.
export function buildItemToolUuid(callId: string, toolName = ""): string {
  return codexToolMessageId(callId, toolName);
}

export function buildItemResultUuid(callId: string): string {
  return `${callId}-result`;
}

export function isResultBackedThreadItem(item: NormalizedThreadItem): boolean {
  return (
    item.type === "command_execution" ||
    item.type === "file_change" ||
    item.type === "mcp_tool_call" ||
    item.type === "dynamic_tool_call" ||
    item.type === "image_view"
  );
}

// Thread items whose rendered uuid keys on call_id (item.id) so the streamed
// message matches its durable backfill row. web_search emits a tool_use but is
// not result-backed, so it is not covered by isResultBackedThreadItem.
function isToolBackedThreadItem(item: NormalizedThreadItem): boolean {
  return isResultBackedThreadItem(item) || item.type === "web_search";
}

/**
 * Convert a normalized thread item to SDKMessage(s).
 */
export function convertItemToSDKMessages(
  item: NormalizedThreadItem,
  sessionId: string,
  turnId: string,
  sourceEvent: "item/started" | "item/completed",
): SDKMessage[] {
  const isComplete = sourceEvent === "item/completed";
  const observedAt = new Date().toISOString();
  // Native tool items key the uuid on call_id (item.id). Nested code-mode
  // commands and image views temporarily key on their inner item id and
  // carry correlation metadata for adoption of the outer durable call_* id.
  // Message/reasoning item ids are the provider ids persisted in rollout.
  const uuid = isToolBackedThreadItem(item)
    ? buildItemToolUuid(
        item.id,
        item.type === "dynamic_tool_call" ? item.tool : "",
      )
    : item.type === "agent_message" ||
        item.type === "reasoning" ||
        item.type === "function_call_output"
      ? item.id
      : `${item.id}-${turnId}`;

  switch (item.type) {
    case "reasoning": {
      const message = withCodexTimestamp(
        {
          type: "assistant",
          session_id: sessionId,
          uuid,
          message: {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: item.text,
              },
            ],
          },
        } as SDKMessage,
        observedAt,
      );
      logSdkCorrelationDebug(sessionId, message, {
        eventKind: "reasoning",
        turnId,
        itemId: item.id,
        phase: isComplete ? "completed" : "started",
        sourceEvent,
      });
      return [message];
    }

    case "agent_message": {
      const message = withCodexTimestamp(
        {
          type: "assistant",
          session_id: sessionId,
          uuid,
          // item/started is a live snapshot, not a final message. Otherwise
          // delayed same-id enrichment can overwrite newer streamed text.
          ...(!isComplete ? { _isStreaming: true } : {}),
          message: {
            role: "assistant",
            content: item.text,
          },
          ...(item.delivery
            ? { codexAgentMessageDelivery: item.delivery }
            : {}),
          ...(item.questions ? { codexAsyncQuestions: item.questions } : {}),
        } as SDKMessage,
        observedAt,
      );
      logSdkCorrelationDebug(sessionId, message, {
        eventKind: "agent_message",
        turnId,
        itemId: item.id,
        phase: isComplete ? "completed" : "started",
        sourceEvent,
      });
      return [message];
    }

    case "function_call_output": {
      if (!isComplete) return [];
      const normalized = normalizeCodexToolOutputWithContext(item.output);
      const message = withCodexTimestamp(
        {
          type: "system",
          subtype: "tool_output",
          session_id: sessionId,
          uuid,
          content: normalized.content,
          codexToolName: item.name,
          ...(item.namespace ? { codexToolNamespace: item.namespace } : {}),
          ...(normalized.structured !== undefined
            ? { toolUseResult: normalized.structured }
            : {}),
        } as SDKMessage,
        observedAt,
      );
      attachToolResultMediaCandidates(message, normalized.mediaCandidates);
      logSdkCorrelationDebug(sessionId, message, {
        eventKind: "tool_result",
        turnId,
        itemId: item.id,
        phase: "completed",
        sourceEvent,
      });
      return [message];
    }

    case "command_execution": {
      const messages: SDKMessage[] = [];
      const correlationStartedAt =
        item.durationMs !== undefined
          ? new Date(
              Date.parse(observedAt) - Math.max(0, item.durationMs),
            ).toISOString()
          : observedAt;
      const normalizedInvocation = normalizeCodexToolInvocation("Bash", {
        command: item.command,
        ...(item.cwd ? { cwd: item.cwd } : {}),
      });
      const toolContext: CodexToolCallContext = {
        toolName: normalizedInvocation.toolName,
        input: normalizedInvocation.input,
        readShellInfo: normalizedInvocation.readShellInfo,
        writeShellInfo: normalizedInvocation.writeShellInfo,
      };

      // Emit tool_use for the command
      const toolUseMessage = withCodexTimestamp(
        {
          type: "assistant",
          session_id: sessionId,
          uuid,
          [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
            "command_execution",
            turnId,
            item.id,
            correlationStartedAt,
          ),
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: item.id,
                name: normalizedInvocation.toolName,
                input: normalizedInvocation.input,
                ...(normalizedInvocation.displayActions
                  ? { _displayActions: normalizedInvocation.displayActions }
                  : {}),
              },
            ],
          },
        } as SDKMessage,
        observedAt,
      );
      logSdkCorrelationDebug(sessionId, toolUseMessage, {
        eventKind: "command_execution",
        turnId,
        itemId: item.id,
        callId: item.id,
        phase: isComplete ? "completed" : "started",
        sourceEvent,
        status: item.status,
      });
      messages.push(toolUseMessage);

      // If completed, emit tool_result
      if (isComplete && item.status !== "in_progress") {
        const normalizedResult = normalizeCodexCommandExecutionOutput(
          {
            aggregatedOutput: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status,
          },
          toolContext,
        );
        const toolResultBlock: {
          type: "tool_result";
          tool_use_id: string;
          content: string;
          is_error?: boolean;
        } = {
          type: "tool_result",
          tool_use_id: item.id,
          content: normalizedResult.content,
        };
        if (normalizedResult.isError) {
          toolResultBlock.is_error = true;
        }

        const toolResultMessage = withCodexTimestamp(
          {
            type: "user",
            session_id: sessionId,
            uuid: `${uuid}-result`,
            [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
              "command_execution",
              turnId,
              item.id,
              correlationStartedAt,
            ),
            message: {
              role: "user",
              content: [toolResultBlock],
            },
            ...(normalizedResult.structured !== undefined
              ? { toolUseResult: normalizedResult.structured }
              : {}),
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolResultMessage, {
          eventKind: "tool_result",
          turnId,
          itemId: item.id,
          callId: item.id,
          phase: "completed",
          sourceEvent,
          status: item.status,
        });
        messages.push(toolResultMessage);
      }

      return messages;
    }

    case "file_change": {
      const changesSummary = item.changes
        .map((c) => `${c.kind}: ${c.path}`)
        .join("\n");
      const editInput: Record<string, unknown> = {
        changes: item.changes,
      };
      const singlePath = item.changes[0]?.path;
      if (singlePath && item.changes.length === 1) {
        editInput.file_path = singlePath;
      }

      const toolUseMessage = withCodexTimestamp(
        {
          type: "assistant",
          session_id: sessionId,
          uuid,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: item.id,
                name: "Edit",
                input: editInput,
              },
            ],
          },
        } as SDKMessage,
        observedAt,
      );
      logSdkCorrelationDebug(sessionId, toolUseMessage, {
        eventKind: "file_change",
        turnId,
        itemId: item.id,
        callId: item.id,
        phase: isComplete ? "completed" : "started",
        sourceEvent,
        status: item.status,
      });

      const messages = [toolUseMessage];

      if (isComplete) {
        const toolResultMessage = withCodexTimestamp(
          {
            type: "user",
            session_id: sessionId,
            uuid: `${uuid}-result`,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: item.id,
                  ...(item.status !== "completed" ? { is_error: true } : {}),
                  content:
                    item.status === "completed"
                      ? `File changes applied:\n${changesSummary}`
                      : item.status === "declined"
                        ? `File changes declined:\n${changesSummary}`
                        : `File changes failed:\n${changesSummary}`,
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolResultMessage, {
          eventKind: "tool_result",
          turnId,
          itemId: item.id,
          callId: item.id,
          phase: "completed",
          sourceEvent,
          status: item.status,
        });
        messages.push(toolResultMessage);
      }

      return messages;
    }

    case "mcp_tool_call": {
      const messages: SDKMessage[] = [];
      const toolUseMessage = withCodexTimestamp(
        {
          type: "assistant",
          session_id: sessionId,
          uuid,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: item.id,
                name: `${item.server}:${item.tool}`,
                input: item.arguments,
                ...(item.mcpApp ? { _mcpApp: item.mcpApp } : {}),
              },
            ],
          },
        } as SDKMessage,
        observedAt,
      );
      logSdkCorrelationDebug(sessionId, toolUseMessage, {
        eventKind: "mcp_tool_call",
        turnId,
        itemId: item.id,
        callId: item.id,
        phase: isComplete ? "completed" : "started",
        sourceEvent,
        status: item.status,
      });
      messages.push(toolUseMessage);

      if (isComplete && item.status !== "in_progress") {
        const toolResultMessage = withCodexTimestamp(
          {
            type: "user",
            session_id: sessionId,
            uuid: `${uuid}-result`,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: item.id,
                  content:
                    item.status === "completed"
                      ? JSON.stringify(item.result)
                      : item.error?.message || "MCP tool call failed",
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        logSdkCorrelationDebug(sessionId, toolResultMessage, {
          eventKind: "tool_result",
          turnId,
          itemId: item.id,
          callId: item.id,
          phase: "completed",
          sourceEvent,
          status: item.status,
        });
        messages.push(toolResultMessage);
      }

      return messages;
    }

    case "dynamic_tool_call": {
      const messages: SDKMessage[] = [];
      const toolName = item.namespace
        ? `${item.namespace}:${item.tool}`
        : canonicalizeCodexToolName(item.tool);

      const toolUseMessage = withCodexTimestamp(
        {
          type: "assistant",
          session_id: sessionId,
          uuid,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: item.id,
                name: toolName,
                input: item.arguments,
              },
            ],
          },
        } as SDKMessage,
        observedAt,
      );
      logSdkCorrelationDebug(sessionId, toolUseMessage, {
        eventKind: "dynamic_tool_call",
        turnId,
        itemId: item.id,
        callId: item.id,
        phase: isComplete ? "completed" : "started",
        sourceEvent,
        status: item.status,
      });
      messages.push(toolUseMessage);

      if (isComplete && item.status !== "in_progress") {
        const isError = item.success === false || item.status === "failed";
        const normalized = normalizeCodexToolOutputWithContext(
          item.content_items,
        );
        const toolResultBlock: {
          type: "tool_result";
          tool_use_id: string;
          content: string;
          is_error?: boolean;
        } = {
          type: "tool_result",
          tool_use_id: item.id,
          content: normalized.content,
        };
        if (isError) {
          toolResultBlock.is_error = true;
        }

        const toolResultMessage = withCodexTimestamp(
          {
            type: "user",
            session_id: sessionId,
            uuid: `${uuid}-result`,
            message: {
              role: "user",
              content: [toolResultBlock],
            },
          } as SDKMessage,
          observedAt,
        );
        attachToolResultMediaCandidates(
          toolResultMessage,
          normalized.mediaCandidates,
        );
        logSdkCorrelationDebug(sessionId, toolResultMessage, {
          eventKind: "tool_result",
          turnId,
          itemId: item.id,
          callId: item.id,
          phase: "completed",
          sourceEvent,
          status: item.status,
        });
        messages.push(toolResultMessage);
      }

      return messages;
    }

    case "web_search": {
      const message = withCodexTimestamp(
        {
          type: "assistant",
          session_id: sessionId,
          uuid,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: item.id,
                name: "WebSearch",
                input: { query: item.query },
              },
            ],
          },
        } as SDKMessage,
        observedAt,
      );
      logSdkCorrelationDebug(sessionId, message, {
        eventKind: "web_search",
        turnId,
        itemId: item.id,
        callId: item.id,
        phase: isComplete ? "completed" : "started",
        sourceEvent,
      });
      return [message];
    }

    case "todo_list": {
      const message = withCodexTimestamp(
        {
          type: "system",
          subtype: "todo_list",
          session_id: sessionId,
          uuid,
          items: item.items,
        } as SDKMessage,
        observedAt,
      );
      logSdkCorrelationDebug(sessionId, message, {
        eventKind: "todo_list",
        turnId,
        itemId: item.id,
        phase: isComplete ? "completed" : "started",
        sourceEvent,
      });
      return [message];
    }

    case "subagent_activity": {
      const message = withCodexTimestamp(
        {
          type: "system",
          subtype: "subagent_activity",
          session_id: sessionId,
          uuid,
          content: item.text,
          codexSubagentKind: item.kind,
          codexSubagentThreadId: item.agentThreadId,
          codexSubagentPath: item.agentPath,
        } as SDKMessage,
        observedAt,
      );
      logSdkCorrelationDebug(sessionId, message, {
        eventKind: "subagent_activity",
        turnId,
        itemId: item.id,
        phase: isComplete ? "completed" : "started",
        sourceEvent,
      });
      return [message];
    }

    case "context_compaction": {
      const message = withCodexTimestamp(
        {
          type: "system",
          subtype: isComplete ? "compact_boundary" : "status",
          session_id: sessionId,
          uuid,
          ...(isComplete
            ? { content: "Context compacted" }
            : { status: "compacting", content: "Compacting context..." }),
        } as SDKMessage,
        observedAt,
      );
      logSdkCorrelationDebug(sessionId, message, {
        eventKind: "context_compaction",
        turnId,
        itemId: item.id,
        phase: isComplete ? "completed" : "started",
        sourceEvent,
      });
      return [message];
    }

    case "image_view": {
      // Represent as a ViewImage tool_use + tool_result pair
      const toolUseMessage = withCodexTimestamp(
        {
          type: "assistant",
          session_id: sessionId,
          uuid,
          [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
            "image_view",
            turnId,
            item.id,
          ),
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: item.id,
                name: "ViewImage",
                input: { path: item.path },
              },
            ],
          },
        } as SDKMessage,
        observedAt,
      );
      logSdkCorrelationDebug(sessionId, toolUseMessage, {
        eventKind: "image_view",
        turnId,
        itemId: item.id,
        phase: isComplete ? "completed" : "started",
        sourceEvent,
      });
      const messages: SDKMessage[] = [toolUseMessage];

      if (isComplete) {
        const toolResultMessage = withCodexTimestamp(
          {
            type: "user",
            session_id: sessionId,
            uuid: `${uuid}-result`,
            [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
              "image_view",
              turnId,
              item.id,
            ),
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: item.id,
                  content: `Viewed image: ${item.path}`,
                },
              ],
            },
          } as SDKMessage,
          observedAt,
        );
        attachToolResultMediaCandidates(toolResultMessage, [
          { originalPath: item.path },
        ]);
        logSdkCorrelationDebug(sessionId, toolResultMessage, {
          eventKind: "tool_result",
          turnId,
          itemId: item.id,
          callId: item.id,
          phase: "completed",
          sourceEvent,
        });
        messages.push(toolResultMessage);
      }

      return messages;
    }

    case "error": {
      const message = withCodexTimestamp(
        {
          type: "error",
          session_id: sessionId,
          uuid,
          error: item.message,
        } as SDKMessage,
        observedAt,
      );
      logSdkCorrelationDebug(sessionId, message, {
        eventKind: "error",
        turnId,
        itemId: item.id,
        phase: isComplete ? "completed" : "started",
        sourceEvent,
      });
      return [message];
    }

    default:
      return [];
  }
}

export function getOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function getOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
