import type { SDKMessage } from "../types.js";
import type { JsonRpcNotification } from "./codex-json-rpc.js";
import { getOptionalString, normalizeStatus } from "./codex-item-conversion.js";
import {
  extractErrorRecord,
  extractOpenAIRequestId,
  stringifyTraceValue,
} from "./codex-live-event-conversion.js";
import {
  asCodexErrorNotification,
  asCodexItemCompletedNotification,
  asCodexItemStartedNotification,
  asCodexRawResponseItemCompletedNotification,
  asCodexTurnCompletedNotification,
  readCodexTurnErrorDetail,
} from "./codex-notification-guards.js";

const CODEX_FAILURE_TRACE_LIMIT = 12;

const CODEX_FAILURE_PREVIEW_CHARS = 240;

export interface CodexFailureTraceEvent {
  at: string;
  sourceEvent: string;
  turnId?: string;
  itemId?: string;
  itemType?: string;
  status?: string;
  phase?: string;
  toolName?: string;
  command?: string;
  deltaChars?: number;
  outputChars?: number;
  errorMessage?: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string | null;
  openaiRequestId?: string;
}

export interface CodexFailureTrace {
  sessionId?: string;
  activeTurnId?: string | null;
  lastUserMessage?: {
    uuid?: string;
    chars: number;
  };
  lastNotification?: CodexFailureTraceEvent;
  lastEmittedMessage?: CodexFailureTraceEvent;
  recentNotifications: CodexFailureTraceEvent[];
}

export function recordCodexFailureTraceEvent(
  trace: CodexFailureTrace,
  event: CodexFailureTraceEvent,
): void {
  trace.lastNotification = event;
  trace.recentNotifications.push(event);
  if (trace.recentNotifications.length > CODEX_FAILURE_TRACE_LIMIT) {
    trace.recentNotifications.splice(
      0,
      trace.recentNotifications.length - CODEX_FAILURE_TRACE_LIMIT,
    );
  }
}

export function snapshotCodexFailureTrace(
  trace: CodexFailureTrace,
): CodexFailureTrace {
  return {
    sessionId: trace.sessionId,
    activeTurnId: trace.activeTurnId,
    lastUserMessage: trace.lastUserMessage
      ? { ...trace.lastUserMessage }
      : undefined,
    lastNotification: trace.lastNotification
      ? { ...trace.lastNotification }
      : undefined,
    lastEmittedMessage: trace.lastEmittedMessage
      ? { ...trace.lastEmittedMessage }
      : undefined,
    recentNotifications: trace.recentNotifications.map((event) => ({
      ...event,
    })),
  };
}

export function formatCodexFailureTrace(trace: CodexFailureTrace): string {
  const lastNotification = trace.lastNotification
    ? formatCodexTraceEvent(trace.lastNotification)
    : "none";
  const lastEmitted = trace.lastEmittedMessage
    ? formatCodexTraceEvent(trace.lastEmittedMessage)
    : "none";
  return `last notification: ${lastNotification}; last emitted SDK message: ${lastEmitted}`;
}

function formatCodexTraceEvent(event: CodexFailureTraceEvent): string {
  const details = [
    event.sourceEvent,
    event.itemType,
    event.toolName,
    event.status,
    event.phase,
    event.command ? `command=${event.command}` : undefined,
    event.errorMessage ? `error=${event.errorMessage}` : undefined,
    event.openaiRequestId ? `requestId=${event.openaiRequestId}` : undefined,
  ].filter(Boolean);
  return details.join(" ");
}

export function describeNotificationForFailureTrace(
  notification: JsonRpcNotification,
): CodexFailureTraceEvent {
  const base = (event: Omit<CodexFailureTraceEvent, "at">) => ({
    at: new Date().toISOString(),
    ...event,
  });

  switch (notification.method) {
    case "item/started":
    case "item/completed": {
      const params =
        notification.method === "item/started"
          ? asCodexItemStartedNotification(notification.params)
          : asCodexItemCompletedNotification(notification.params);
      const item =
        params?.item && typeof params.item === "object"
          ? (params.item as Record<string, unknown>)
          : null;
      return base({
        sourceEvent: notification.method,
        turnId: params?.turnId,
        itemId:
          getOptionalString(item?.id) ??
          getOptionalString((item as { call_id?: unknown })?.call_id) ??
          undefined,
        itemType: normalizeCodexItemType(getOptionalString(item?.type)),
        status: normalizeStatus(item?.status),
        phase:
          notification.method === "item/completed" ? "completed" : "started",
        toolName: getTraceToolName(item) ?? undefined,
        command: previewTraceString(
          getOptionalString(item?.command) ??
            getOptionalString(item?.aggregated_output) ??
            getOptionalString(item?.aggregatedOutput),
        ),
      });
    }

    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/reasoning/summaryTextDelta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta": {
      const params =
        notification.params && typeof notification.params === "object"
          ? (notification.params as Record<string, unknown>)
          : null;
      const delta = getOptionalString(params?.delta);
      return base({
        sourceEvent: notification.method,
        turnId: getOptionalString(params?.turnId) ?? undefined,
        itemId: getOptionalString(params?.itemId) ?? undefined,
        itemType: inferTraceItemTypeFromDeltaEvent(notification.method),
        phase: "delta",
        deltaChars: delta?.length,
        outputChars: delta?.length,
      });
    }

    case "rawResponseItem/completed": {
      const params = asCodexRawResponseItemCompletedNotification(
        notification.params,
      );
      const item =
        params?.item && typeof params.item === "object"
          ? (params.item as Record<string, unknown>)
          : null;
      return base({
        sourceEvent: notification.method,
        turnId: params?.turnId,
        itemId:
          getOptionalString(item?.id) ??
          getOptionalString(item?.call_id) ??
          undefined,
        itemType: normalizeCodexItemType(getOptionalString(item?.type)),
        phase: "completed",
        toolName: getTraceToolName(item) ?? undefined,
      });
    }

    case "thread/tokenUsage/updated": {
      const params =
        notification.params && typeof notification.params === "object"
          ? (notification.params as Record<string, unknown>)
          : null;
      return base({
        sourceEvent: notification.method,
        turnId: getOptionalString(params?.turnId) ?? undefined,
        phase: "usage",
      });
    }

    case "turn/completed": {
      const params = asCodexTurnCompletedNotification(notification.params);
      return base({
        sourceEvent: notification.method,
        turnId: params?.turn.id,
        status: params?.turn.status,
        phase: "completed",
        errorMessage: params?.turn.error?.message,
        codexErrorInfo: params?.turn.error?.codexErrorInfo ?? undefined,
        additionalDetails:
          readCodexTurnErrorDetail(params?.turn.error) ?? undefined,
        openaiRequestId: extractOpenAIRequestId(
          params?.turn.error,
          params?.turn.error?.additionalDetails,
          params?.turn.error?.message,
        ),
      });
    }

    case "error": {
      const params = asCodexErrorNotification(notification.params);
      const fallbackError = extractErrorRecord(notification.params);
      const rawParams =
        notification.params && typeof notification.params === "object"
          ? (notification.params as Record<string, unknown>)
          : null;
      const willRetry =
        params?.willRetry ??
        (typeof rawParams?.willRetry === "boolean"
          ? rawParams.willRetry
          : false);
      const errorMessage =
        params?.error.message ??
        getOptionalString(fallbackError?.message) ??
        "Codex turn failed";
      return base({
        sourceEvent: notification.method,
        turnId: params?.turnId,
        phase: willRetry ? "retrying" : "terminal",
        errorMessage,
        codexErrorInfo:
          params?.error.codexErrorInfo ??
          fallbackError?.codexErrorInfo ??
          undefined,
        additionalDetails:
          readCodexTurnErrorDetail(params?.error) ??
          getOptionalString(fallbackError?.additionalDetails) ??
          undefined,
        openaiRequestId: extractOpenAIRequestId(
          notification.params,
          fallbackError,
          errorMessage,
        ),
      });
    }

    default:
      return base({ sourceEvent: notification.method });
  }
}

export function describeSDKMessageForFailureTrace(
  message: SDKMessage,
): CodexFailureTraceEvent {
  const event: CodexFailureTraceEvent = {
    at: new Date().toISOString(),
    sourceEvent: `sdk:${message.type}`,
    phase: typeof message.subtype === "string" ? message.subtype : undefined,
  };

  if (message.error !== undefined) {
    event.errorMessage = previewTraceString(
      typeof message.error === "string"
        ? message.error
        : stringifyTraceValue(message.error),
    );
    event.openaiRequestId = extractOpenAIRequestId(message.error);
  }

  const content = message.message?.content;
  if (typeof content === "string") {
    event.outputChars = content.length;
    return event;
  }
  if (!Array.isArray(content)) {
    return event;
  }

  const interestingBlock = content.find(
    (block) =>
      block.type === "tool_use" ||
      block.type === "tool_result" ||
      block.type === "thinking",
  );
  if (!interestingBlock) {
    return event;
  }

  event.itemType = interestingBlock.type;
  if (interestingBlock.type === "tool_use") {
    event.itemId = interestingBlock.id;
    event.toolName = interestingBlock.name;
    event.command = previewTraceString(
      getTraceCommandFromInput(interestingBlock.input),
    );
  } else if (interestingBlock.type === "tool_result") {
    event.itemId = interestingBlock.tool_use_id;
    event.outputChars = interestingBlock.content?.length;
  } else if (interestingBlock.type === "thinking") {
    event.outputChars = interestingBlock.thinking?.length;
  }

  return event;
}

function inferTraceItemTypeFromDeltaEvent(method: string): string | undefined {
  if (method.includes("commandExecution")) return "command_execution";
  if (method.includes("fileChange")) return "file_change";
  if (method.includes("reasoning")) return "reasoning";
  if (method.includes("plan")) return "plan";
  if (method.includes("agentMessage")) return "agent_message";
  return undefined;
}

function normalizeCodexItemType(type: string | null): string | undefined {
  return type?.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

function getTraceToolName(item: Record<string, unknown> | null): string | null {
  if (!item) return null;
  const type = normalizeCodexItemType(getOptionalString(item.type));
  if (type === "command_execution") return "Bash";
  if (type === "file_change") return "Edit";
  if (type === "web_search") return "WebSearch";
  if (type === "mcp_tool_call") {
    const server = getOptionalString(item.server);
    const tool = getOptionalString(item.tool);
    return server && tool ? `${server}:${tool}` : (tool ?? null);
  }
  if (type === "dynamic_tool_call") {
    const namespace = getOptionalString(item.namespace);
    const tool = getOptionalString(item.tool);
    return namespace && tool ? `${namespace}:${tool}` : (tool ?? null);
  }
  return getOptionalString(item.name);
}

function getTraceCommandFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  return (
    getOptionalString(record.command) ?? getOptionalString(record.cmd) ?? null
  );
}

function previewTraceString(
  value: string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= CODEX_FAILURE_PREVIEW_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, CODEX_FAILURE_PREVIEW_CHARS)}...`;
}
