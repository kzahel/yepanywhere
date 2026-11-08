import {
  CODEX_TOOL_CORRELATION_FIELD,
  createCodexToolCorrelation,
} from "@yep-anywhere/shared";
import {
  canonicalizeCodexToolName,
  isCodexBackgroundProcessOutput,
  isCodexInterruptedToolOutput,
  type CodexToolCallContext,
  normalizeCodexCustomToolInvocation,
  normalizeCodexToolInvocation,
  normalizeCodexToolOutputWithContext,
  parseCodexToolArguments,
} from "../../codex/normalization.js";
import {
  CODEX_CONTENT_FILTER_BLOCK_SUBTYPE,
  codexContentFilterGuidance,
} from "../../codex/contentFilterBlock.js";
import { attachToolResultMediaCandidates } from "../../media/inlineImageData.js";
import {
  type LiveToolOutput,
  renderLiveToolOutput,
} from "./live-tool-output.js";
import type { SDKMessage } from "../types.js";
import type { RawResponseItemCompletedNotification } from "./codex-protocol/index.js";
import {
  asCodexAgentMessageDeltaNotification,
  asCodexCommandExecutionOutputDeltaNotification,
  asCodexErrorNotification,
  asCodexFileChangeOutputDeltaNotification,
  asCodexItemCompletedNotification,
  asCodexItemStartedNotification,
  asCodexPlanDeltaNotification,
  asCodexRawResponseItemCompletedNotification,
  asCodexReasoningSummaryTextDeltaNotification,
  asCodexThreadTokenUsageUpdatedNotification,
  asCodexTurnCompletedNotification,
  asCodexTurnPlanUpdatedNotification,
  readCodexTurnErrorDetail,
} from "./codex-notification-guards.js";
import type { JsonRpcNotification } from "./codex-json-rpc.js";
import {
  buildItemEventKey,
  buildItemMessageUuid,
  buildItemResultUuid,
  buildItemToolUuid,
  convertItemToSDKMessages,
  getOptionalString,
  isResultBackedThreadItem,
  logSdkCorrelationDebug,
  normalizeThreadItem,
  withCodexTimestamp,
} from "./codex-item-conversion.js";

export function stringifyTraceValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface TokenUsageSnapshot {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  contextWindow?: number;
}

export interface CodexLiveEventState {
  streamingTextByItemKey: Map<string, string>;
  streamingReasoningSummaryByItemKey: Map<string, string[]>;
  streamingToolOutputByItemKey: Map<string, CodexLiveToolOutput>;
  toolCallContexts: Map<string, CodexToolCallContext>;
  resultBackedToolItemsByTurnId: Map<string, Set<string>>;
  planUpdateCountByTurnId: Map<string, number>;
}

/**
 * Each live tool-output message is a cumulative snapshot that replaces the
 * previous one, so an unbounded snapshot makes a long output cost quadratic
 * bytes across provider replay, fan-out, and relay. The live preview keeps the
 * head (collapsed rows show leading lines) and the tail (progress); the
 * completed item carries the full output.
 */
export const CODEX_LIVE_TOOL_OUTPUT_HEAD_CHARS = 32 * 1024;

export const CODEX_LIVE_TOOL_OUTPUT_TAIL_CHARS = 32 * 1024;

export type CodexLiveToolOutput = LiveToolOutput;

export function appendCodexLiveToolOutput(
  output: CodexLiveToolOutput | undefined,
  delta: string,
): CodexLiveToolOutput {
  let head = output?.head ?? "";
  let tail = output?.tail ?? "";
  let omittedChars = output?.omittedChars ?? 0;
  const headRoom = CODEX_LIVE_TOOL_OUTPUT_HEAD_CHARS - head.length;
  let rest = delta;
  if (headRoom > 0) {
    head += rest.slice(0, headRoom);
    rest = rest.slice(headRoom);
  }
  tail += rest;
  if (tail.length > CODEX_LIVE_TOOL_OUTPUT_TAIL_CHARS) {
    omittedChars += tail.length - CODEX_LIVE_TOOL_OUTPUT_TAIL_CHARS;
    tail = tail.slice(-CODEX_LIVE_TOOL_OUTPUT_TAIL_CHARS);
  }
  return { head, tail, omittedChars };
}

export function createLiveEventState(): CodexLiveEventState {
  return {
    streamingTextByItemKey: new Map(),
    streamingReasoningSummaryByItemKey: new Map(),
    streamingToolOutputByItemKey: new Map(),
    toolCallContexts: new Map(),
    resultBackedToolItemsByTurnId: new Map(),
    planUpdateCountByTurnId: new Map(),
  };
}

export function extractErrorRecord(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.error && typeof record.error === "object") {
    return record.error as Record<string, unknown>;
  }
  return record;
}

export function extractOpenAIRequestId(
  ...values: unknown[]
): string | undefined {
  for (const value of values) {
    const direct = findRequestIdInValue(value, 0);
    if (direct) return direct;
    const text = typeof value === "string" ? value : stringifyTraceValue(value);
    const match =
      /request\s*id[:\s]+([0-9a-f]{8}-[0-9a-f-]{20,})/i.exec(text) ??
      /request[_-]?id["'\s:=]+([0-9a-f]{8}-[0-9a-f-]{20,})/i.exec(text);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

function findRequestIdInValue(value: unknown, depth: number): string | null {
  if (!value || typeof value !== "object" || depth > 3) return null;
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (
      /^(request[_-]?id|x-request-id)$/i.test(key) &&
      typeof entry === "string" &&
      entry.trim()
    ) {
      return entry.trim();
    }
    const nested = findRequestIdInValue(entry, depth + 1);
    if (nested) return nested;
  }
  return null;
}

export function extractTurnUsage(params: unknown): {
  turnId: string;
  snapshot: TokenUsageSnapshot;
  total: TokenUsageSnapshot;
} | null {
  const notification = asCodexThreadTokenUsageUpdatedNotification(params);
  if (!notification) return null;

  return {
    turnId: notification.turnId,
    snapshot: {
      totalTokens: notification.tokenUsage.last.totalTokens,
      inputTokens: notification.tokenUsage.last.inputTokens,
      outputTokens: notification.tokenUsage.last.outputTokens,
      cachedInputTokens: notification.tokenUsage.last.cachedInputTokens,
      contextWindow:
        typeof notification.tokenUsage.modelContextWindow === "number"
          ? notification.tokenUsage.modelContextWindow
          : undefined,
    },
    total: {
      totalTokens: notification.tokenUsage.total.totalTokens,
      inputTokens: notification.tokenUsage.total.inputTokens,
      outputTokens: notification.tokenUsage.total.outputTokens,
      cachedInputTokens: notification.tokenUsage.total.cachedInputTokens,
      contextWindow:
        typeof notification.tokenUsage.modelContextWindow === "number"
          ? notification.tokenUsage.modelContextWindow
          : undefined,
    },
  };
}

export function convertNotificationToSDKMessages(
  notification: JsonRpcNotification,
  sessionId: string,
  usageByTurnId: Map<string, TokenUsageSnapshot>,
  liveEventState: CodexLiveEventState,
): SDKMessage[] {
  switch (notification.method) {
    case "thread/tokenUsage/updated": {
      const usage = extractTurnUsage(notification.params);
      if (!usage) {
        return [];
      }

      const message = withCodexTimestamp({
        type: "system",
        subtype: "token_usage",
        session_id: sessionId,
        turnId: usage.turnId,
        isSynthetic: true,
        usage: {
          input_tokens: usage.snapshot.inputTokens,
          output_tokens: usage.snapshot.outputTokens,
          cached_input_tokens: usage.snapshot.cachedInputTokens,
        },
        ...(usage.snapshot.contextWindow && usage.snapshot.contextWindow > 0
          ? { model_context_window: usage.snapshot.contextWindow }
          : {}),
      } as SDKMessage);
      logSdkCorrelationDebug(sessionId, message, {
        eventKind: "token_usage",
        turnId: usage.turnId,
        phase: "usage_updated",
        sourceEvent: notification.method,
      });
      return [message];
    }

    case "turn/plan/updated": {
      const params = asCodexTurnPlanUpdatedNotification(notification.params);
      if (!params) return [];

      const sequence =
        (liveEventState.planUpdateCountByTurnId.get(params.turnId) ?? 0) + 1;
      liveEventState.planUpdateCountByTurnId.set(params.turnId, sequence);
      const callId = `codex-plan-${params.turnId}-${sequence}`;
      const observedAt = new Date().toISOString();
      const input = {
        ...(params.explanation ? { explanation: params.explanation } : {}),
        plan: params.plan.map(({ status, step }) => ({
          step,
          status: status === "inProgress" ? "in_progress" : status,
        })),
      };
      const toolUse = withCodexTimestamp(
        {
          type: "assistant",
          session_id: sessionId,
          uuid: buildItemToolUuid(callId),
          [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
            "plan_update",
            params.turnId,
            callId,
            observedAt,
          ),
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: callId,
                name: "UpdatePlan",
                input,
              },
            ],
          },
        } as SDKMessage,
        observedAt,
      );
      const toolResult = withCodexTimestamp(
        {
          type: "user",
          session_id: sessionId,
          uuid: buildItemResultUuid(callId),
          [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
            "plan_update",
            params.turnId,
            callId,
            observedAt,
          ),
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: callId,
                content: "Plan updated",
              },
            ],
          },
          toolUseResult: { message: "Plan updated" },
        } as SDKMessage,
        observedAt,
      );
      logSdkCorrelationDebug(sessionId, toolUse, {
        eventKind: "plan_update",
        turnId: params.turnId,
        itemId: callId,
        callId,
        phase: "completed",
        sourceEvent: notification.method,
      });
      logSdkCorrelationDebug(sessionId, toolResult, {
        eventKind: "tool_result",
        turnId: params.turnId,
        itemId: callId,
        callId,
        phase: "completed",
        sourceEvent: notification.method,
      });
      return [toolUse, toolResult];
    }

    case "turn/completed": {
      const params = asCodexTurnCompletedNotification(notification.params);
      const turnId = params?.turn.id ?? null;
      const turnStatus = params?.turn.status;
      const usage = turnId ? usageByTurnId.get(turnId) : undefined;
      const usagePayload = usage
        ? {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cached_input_tokens: usage.cachedInputTokens,
          }
        : undefined;
      const messages: SDKMessage[] = [];
      if (turnId) {
        liveEventState.planUpdateCountByTurnId.delete(turnId);
      }
      const orphanedToolUseIds = turnId
        ? consumeLiveResultBackedToolItems(liveEventState, turnId)
        : [];
      if (turnId && orphanedToolUseIds.length > 0) {
        const orphanMarker = withCodexTimestamp({
          type: "system",
          subtype: "codex_tool_orphans",
          session_id: sessionId,
          uuid: `codex-tool-orphans-${turnId}`,
          isSynthetic: true,
          orphanedToolUseIds,
        } as SDKMessage);
        logSdkCorrelationDebug(sessionId, orphanMarker, {
          eventKind: "tool_orphans",
          turnId,
          phase: "completed",
          sourceEvent: notification.method,
        });
        messages.push(orphanMarker);
      }

      if (params?.turn.status === "interrupted") {
        const completedAt =
          typeof params.turn.completedAt === "number" &&
          Number.isFinite(params.turn.completedAt)
            ? new Date(params.turn.completedAt * 1000).toISOString()
            : undefined;
        const message = withCodexTimestamp(
          {
            type: "system",
            subtype: "turn_aborted",
            session_id: sessionId,
            uuid: `codex-turn-interrupted-${params.turn.id}`,
            content: params.turn.error?.message || "Conversation interrupted",
            reason: "interrupted",
            isSynthetic: true,
            sourceEvent: notification.method,
            codexThreadId: params.threadId,
            codexTurnId: turnId,
            codexTurnStatus: params.turn.status,
            usage: usagePayload,
          } as SDKMessage,
          completedAt,
        );
        logSdkCorrelationDebug(sessionId, message, {
          eventKind: "turn_interrupted",
          ...(turnId ? { turnId } : {}),
          status: turnStatus,
          phase: "completed",
          sourceEvent: notification.method,
        });
        messages.push(message);
        return messages;
      }

      const message = withCodexTimestamp({
        type: "system",
        subtype: "turn_complete",
        session_id: sessionId,
        usage: usagePayload,
      } as SDKMessage);
      logSdkCorrelationDebug(sessionId, message, {
        eventKind: "turn_complete",
        ...(turnId ? { turnId } : {}),
        phase: "completed",
        sourceEvent: notification.method,
      });
      messages.push(message);
      return messages;
    }

    case "error": {
      const params = asCodexErrorNotification(notification.params);
      const rawParams =
        notification.params && typeof notification.params === "object"
          ? (notification.params as Record<string, unknown>)
          : null;
      const fallbackError = extractErrorRecord(notification.params);
      const errorMessage =
        params?.error.message ?? getOptionalString(fallbackError?.message);
      const willRetry =
        params?.willRetry ??
        (typeof rawParams?.willRetry === "boolean"
          ? rawParams.willRetry
          : false);
      const isProcessExit = rawParams?.codexProcessExit === true;
      const message =
        (typeof errorMessage === "string" && errorMessage) ||
        (typeof rawParams?.message === "string"
          ? rawParams.message
          : "Codex turn failed");

      const errorEvent = {
        type: "error",
        uuid: params?.turnId
          ? `codex-error-${params.turnId}`
          : `codex-error-${sessionId}-${Date.now()}`,
        session_id: sessionId,
        error: message,
        codexErrorInfo:
          params?.error.codexErrorInfo ?? fallbackError?.codexErrorInfo ?? null,
        codexAdditionalDetails:
          readCodexTurnErrorDetail(params?.error) ??
          getOptionalString(fallbackError?.additionalDetails) ??
          null,
        codexWillRetry: willRetry,
        codexErrorScope: isProcessExit ? "app_server_process" : "turn",
        codexThreadId: params?.threadId,
        codexTurnId: params?.turnId,
        codexRequestId: extractOpenAIRequestId(
          notification.params,
          params?.error,
          message,
        ),
      } as SDKMessage;
      logSdkCorrelationDebug(sessionId, errorEvent, {
        eventKind: "error",
        phase: "emitted",
        sourceEvent: notification.method,
      });
      return [errorEvent];
    }

    case "item/started":
    case "item/completed": {
      const params =
        notification.method === "item/started"
          ? asCodexItemStartedNotification(notification.params)
          : asCodexItemCompletedNotification(notification.params);
      if (!params) return [];

      const normalized = normalizeThreadItem(params.item);
      if (!normalized) {
        return [];
      }

      const turnId = params.turnId;
      if (
        notification.method === "item/started" &&
        isResultBackedThreadItem(normalized)
      ) {
        recordLiveResultBackedToolItem(liveEventState, turnId, normalized.id);
      }
      const messages = convertItemToSDKMessages(
        normalized,
        sessionId,
        turnId,
        notification.method,
      );
      if (notification.method === "item/completed") {
        clearLiveResultBackedToolItem(liveEventState, turnId, normalized.id);
        clearLiveEventStateForItem(liveEventState, turnId, normalized.id);
      }
      return messages;
    }

    case "item/agentMessage/delta": {
      const params = asCodexAgentMessageDeltaNotification(notification.params);
      if (!params?.delta) return [];
      return [
        buildStreamingAssistantMessage(
          sessionId,
          params.turnId,
          params.itemId,
          params.delta,
          "agent_message_delta",
          liveEventState,
        ),
      ];
    }

    case "item/plan/delta": {
      const params = asCodexPlanDeltaNotification(notification.params);
      if (!params?.delta) return [];
      return [
        buildStreamingAssistantMessage(
          sessionId,
          params.turnId,
          params.itemId,
          params.delta,
          "plan_delta",
          liveEventState,
        ),
      ];
    }

    case "item/reasoning/summaryTextDelta": {
      const params = asCodexReasoningSummaryTextDeltaNotification(
        notification.params,
      );
      if (!params?.delta) return [];
      return [
        buildStreamingReasoningSummaryMessage(
          sessionId,
          params.turnId,
          params.itemId,
          params.summaryIndex,
          params.delta,
          liveEventState,
        ),
      ];
    }

    case "item/commandExecution/outputDelta": {
      const params = asCodexCommandExecutionOutputDeltaNotification(
        notification.params,
      );
      if (!params?.delta) return [];
      return [
        buildStreamingToolResultMessage(
          sessionId,
          params.turnId,
          params.itemId,
          params.delta,
          "command_output_delta",
          liveEventState,
        ),
      ];
    }

    case "item/fileChange/outputDelta": {
      const params = asCodexFileChangeOutputDeltaNotification(
        notification.params,
      );
      if (!params?.delta) return [];
      return [
        buildStreamingToolResultMessage(
          sessionId,
          params.turnId,
          params.itemId,
          params.delta,
          "file_change_output_delta",
          liveEventState,
        ),
      ];
    }

    case "rawResponseItem/completed": {
      const params = asCodexRawResponseItemCompletedNotification(
        notification.params,
      );
      if (!params) return [];
      return convertRawResponseItemToSDKMessages(
        params,
        sessionId,
        liveEventState,
      );
    }

    case "account/rateLimits/updated": {
      // account/rateLimits/updated is telemetry, not a terminal turn error.
      // Real usage-limit/quota failures arrive via the `error` notification.
      return [];
    }

    default:
      return [];
  }
}

function recordLiveResultBackedToolItem(
  liveEventState: CodexLiveEventState,
  turnId: string,
  itemId: string,
): void {
  const items =
    liveEventState.resultBackedToolItemsByTurnId.get(turnId) ?? new Set();
  items.add(itemId);
  liveEventState.resultBackedToolItemsByTurnId.set(turnId, items);
}

function clearLiveResultBackedToolItem(
  liveEventState: CodexLiveEventState,
  turnId: string,
  itemId: string,
): void {
  const items = liveEventState.resultBackedToolItemsByTurnId.get(turnId);
  if (!items) return;
  items.delete(itemId);
  if (items.size === 0) {
    liveEventState.resultBackedToolItemsByTurnId.delete(turnId);
  }
}

function consumeLiveResultBackedToolItems(
  liveEventState: CodexLiveEventState,
  turnId: string,
): string[] {
  const items = liveEventState.resultBackedToolItemsByTurnId.get(turnId);
  if (!items) return [];
  liveEventState.resultBackedToolItemsByTurnId.delete(turnId);
  return [...items];
}

function buildStreamingAssistantMessage(
  sessionId: string,
  turnId: string,
  itemId: string,
  delta: string,
  sourceEvent: string,
  liveEventState: CodexLiveEventState,
): SDKMessage {
  const key = buildItemEventKey(turnId, itemId);
  const text = `${liveEventState.streamingTextByItemKey.get(key) ?? ""}${delta}`;
  liveEventState.streamingTextByItemKey.set(key, text);

  const message = withCodexTimestamp({
    type: "assistant",
    session_id: sessionId,
    uuid: buildItemMessageUuid(itemId),
    _isStreaming: true,
    message: {
      role: "assistant",
      content: text,
    },
  } as SDKMessage);
  logSdkCorrelationDebug(sessionId, message, {
    eventKind: sourceEvent,
    turnId,
    itemId,
    phase: "delta",
    sourceEvent,
  });
  return message;
}

function buildStreamingReasoningSummaryMessage(
  sessionId: string,
  turnId: string,
  itemId: string,
  summaryIndex: number,
  delta: string,
  liveEventState: CodexLiveEventState,
): SDKMessage {
  const key = buildItemEventKey(turnId, itemId);
  const parts =
    liveEventState.streamingReasoningSummaryByItemKey.get(key) ?? [];
  parts[summaryIndex] = `${parts[summaryIndex] ?? ""}${delta}`;
  liveEventState.streamingReasoningSummaryByItemKey.set(key, parts);

  const thinking = parts.filter(Boolean).join("\n");
  const message = withCodexTimestamp({
    type: "assistant",
    session_id: sessionId,
    uuid: buildItemMessageUuid(itemId),
    _isStreaming: true,
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking }],
    },
  } as SDKMessage);
  logSdkCorrelationDebug(sessionId, message, {
    eventKind: "reasoning_summary_delta",
    turnId,
    itemId,
    phase: "delta",
    sourceEvent: "item/reasoning/summaryTextDelta",
  });
  return message;
}

function buildStreamingToolResultMessage(
  sessionId: string,
  turnId: string,
  itemId: string,
  delta: string,
  sourceEvent: string,
  liveEventState: CodexLiveEventState,
): SDKMessage {
  const key = buildItemEventKey(turnId, itemId);
  const output = appendCodexLiveToolOutput(
    liveEventState.streamingToolOutputByItemKey.get(key),
    delta,
  );
  liveEventState.streamingToolOutputByItemKey.set(key, output);
  const content = renderLiveToolOutput(output);

  const message = withCodexTimestamp({
    type: "user",
    session_id: sessionId,
    uuid: buildItemResultUuid(itemId),
    _isStreaming: true,
    ...(sourceEvent === "command_output_delta"
      ? {
          [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
            "command_execution",
            turnId,
            itemId,
          ),
        }
      : {}),
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: itemId,
          content,
        },
      ],
    },
  } as SDKMessage);
  logSdkCorrelationDebug(sessionId, message, {
    eventKind: "tool_result",
    turnId,
    itemId,
    callId: itemId,
    phase: "delta",
    sourceEvent,
  });
  return message;
}

function clearLiveEventStateForItem(
  liveEventState: CodexLiveEventState,
  turnId: string,
  itemId: string,
): void {
  const key = buildItemEventKey(turnId, itemId);
  liveEventState.streamingTextByItemKey.delete(key);
  liveEventState.streamingReasoningSummaryByItemKey.delete(key);
  liveEventState.streamingToolOutputByItemKey.delete(key);
}

function convertRawResponseItemToSDKMessages(
  params: RawResponseItemCompletedNotification,
  sessionId: string,
  liveEventState: CodexLiveEventState,
): SDKMessage[] {
  const item = params.item as Record<string, unknown>;
  const itemType = getOptionalString(item.type);
  if (!itemType) return [];

  const observedAt = new Date().toISOString();

  switch (itemType) {
    case "function_call": {
      const callId = getOptionalString(item.call_id);
      const rawToolName = getOptionalString(item.name);
      const argumentsText = getOptionalString(item.arguments);
      if (!callId || !rawToolName) return [];

      const normalizedInvocation = normalizeCodexToolInvocation(
        canonicalizeCodexToolName(rawToolName),
        parseCodexToolArguments(argumentsText ?? undefined),
      );
      liveEventState.toolCallContexts.set(callId, {
        toolName: normalizedInvocation.toolName,
        input: normalizedInvocation.input,
        readShellInfo: normalizedInvocation.readShellInfo,
        writeShellInfo: normalizedInvocation.writeShellInfo,
      });
      recordLiveResultBackedToolItem(liveEventState, params.turnId, callId);

      const message = withCodexTimestamp(
        {
          type: "assistant",
          session_id: sessionId,
          uuid: buildItemToolUuid(callId, rawToolName),
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: callId,
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
      logSdkCorrelationDebug(sessionId, message, {
        eventKind: "function_call",
        turnId: params.turnId,
        itemId: callId,
        callId,
        phase: "completed",
        sourceEvent: "rawResponseItem/completed",
      });
      return [message];
    }

    case "function_call_output": {
      const callId = getOptionalString(item.call_id);
      if (!callId) return [];
      const normalized = normalizeCodexToolOutputWithContext(
        item.output,
        liveEventState.toolCallContexts.get(callId),
      );
      if (
        !isCodexBackgroundProcessOutput(item.output) &&
        !isCodexInterruptedToolOutput(item.output)
      ) {
        liveEventState.toolCallContexts.delete(callId);
        clearLiveResultBackedToolItem(liveEventState, params.turnId, callId);
      }

      const toolResult: {
        type: "tool_result";
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      } = {
        type: "tool_result",
        tool_use_id: callId,
        content: normalized.content,
      };
      if (normalized.isError) {
        toolResult.is_error = true;
      }

      const message = withCodexTimestamp(
        {
          type: "user",
          session_id: sessionId,
          uuid: buildItemResultUuid(callId),
          message: {
            role: "user",
            content: [toolResult],
          },
          ...(normalized.structured !== undefined
            ? { toolUseResult: normalized.structured }
            : {}),
        } as SDKMessage,
        observedAt,
      );
      attachToolResultMediaCandidates(message, normalized.mediaCandidates);
      logSdkCorrelationDebug(sessionId, message, {
        eventKind: "tool_result",
        turnId: params.turnId,
        itemId: callId,
        callId,
        phase: "completed",
        sourceEvent: "rawResponseItem/completed",
      });
      return [message];
    }

    case "custom_tool_call": {
      const callId = getOptionalString(item.call_id);
      const rawToolName = getOptionalString(item.name);
      const input = getOptionalString(item.input);
      if (!callId || !rawToolName) return [];

      const normalizedInvocation = normalizeCodexCustomToolInvocation(
        rawToolName,
        input ?? "",
      );
      liveEventState.toolCallContexts.set(callId, {
        toolName: normalizedInvocation.toolName,
        input: normalizedInvocation.input,
        readShellInfo: normalizedInvocation.readShellInfo,
        writeShellInfo: normalizedInvocation.writeShellInfo,
      });
      recordLiveResultBackedToolItem(liveEventState, params.turnId, callId);

      const message = withCodexTimestamp(
        {
          type: "assistant",
          session_id: sessionId,
          uuid: buildItemToolUuid(callId),
          [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
            "custom_tool_call",
            params.turnId,
            callId,
          ),
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: callId,
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
      logSdkCorrelationDebug(sessionId, message, {
        eventKind: "custom_tool_call",
        turnId: params.turnId,
        itemId: callId,
        callId,
        phase: "completed",
        sourceEvent: "rawResponseItem/completed",
      });
      return [message];
    }

    case "custom_tool_call_output": {
      const callId = getOptionalString(item.call_id);
      if (!callId) return [];
      const normalized = normalizeCodexToolOutputWithContext(
        item.output,
        liveEventState.toolCallContexts.get(callId),
      );
      if (
        !isCodexBackgroundProcessOutput(item.output) &&
        !isCodexInterruptedToolOutput(item.output)
      ) {
        liveEventState.toolCallContexts.delete(callId);
        clearLiveResultBackedToolItem(liveEventState, params.turnId, callId);
      }

      const toolResult: {
        type: "tool_result";
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      } = {
        type: "tool_result",
        tool_use_id: callId,
        content: normalized.content,
      };
      if (normalized.isError) {
        toolResult.is_error = true;
      }

      const message = withCodexTimestamp(
        {
          type: "user",
          session_id: sessionId,
          uuid: buildItemResultUuid(callId),
          [CODEX_TOOL_CORRELATION_FIELD]: createCodexToolCorrelation(
            "custom_tool_call",
            params.turnId,
            callId,
          ),
          message: {
            role: "user",
            content: [toolResult],
          },
          ...(normalized.structured !== undefined
            ? { toolUseResult: normalized.structured }
            : {}),
        } as SDKMessage,
        observedAt,
      );
      attachToolResultMediaCandidates(message, normalized.mediaCandidates);
      logSdkCorrelationDebug(sessionId, message, {
        eventKind: "tool_result",
        turnId: params.turnId,
        itemId: callId,
        callId,
        phase: "completed",
        sourceEvent: "rawResponseItem/completed",
      });
      return [message];
    }

    case "message": {
      const guidance = codexContentFilterGuidance(item);
      const itemId = getOptionalString(item.id);
      if (guidance === null || !itemId) return [];
      const message = withCodexTimestamp(
        {
          type: "system",
          subtype: CODEX_CONTENT_FILTER_BLOCK_SUBTYPE,
          session_id: sessionId,
          uuid: itemId,
          content: guidance,
        } as SDKMessage,
        observedAt,
      );
      logSdkCorrelationDebug(sessionId, message, {
        eventKind: "content_filter_block",
        turnId: params.turnId,
        itemId,
        phase: "completed",
        sourceEvent: "rawResponseItem/completed",
      });
      return [message];
    }

    case "compaction": {
      const message = withCodexTimestamp(
        {
          type: "system",
          subtype: "compact_boundary",
          session_id: sessionId,
          uuid: `codex-compaction-${params.turnId}`,
          content: "Context compacted",
        } as SDKMessage,
        observedAt,
      );
      logSdkCorrelationDebug(sessionId, message, {
        eventKind: "context_compaction",
        turnId: params.turnId,
        itemId: `codex-compaction-${params.turnId}`,
        phase: "completed",
        sourceEvent: "rawResponseItem/completed",
      });
      return [message];
    }

    default:
      return [];
  }
}
