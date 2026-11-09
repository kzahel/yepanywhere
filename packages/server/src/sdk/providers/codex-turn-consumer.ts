/**
 * Codex turn consumption: the notification reader that the session loop's
 * idle wait shares with the turn consumer, the consumer, the overload retry,
 * and the helpers that classify turn errors and read notification ids.
 */

import { getCodexToolCorrelation } from "@yep-anywhere/shared";
import { isCodexBackgroundProcessOutput } from "../../codex/normalization.js";
import { logSDKMessage } from "../messageLogger.js";
import type { SDKMessage } from "../types.js";
import type { TurnError } from "./codex-protocol/generated/v2/TurnError.js";
import type { CodexAppServerClient } from "./codex-app-server-client.js";
import {
  type CodexFailureTrace,
  describeNotificationForFailureTrace,
  describeSDKMessageForFailureTrace,
  formatCodexFailureTrace,
  recordCodexFailureTraceEvent,
  snapshotCodexFailureTrace,
} from "./codex-failure-trace.js";
import {
  getOptionalString,
  isResultBackedThreadItem,
  normalizeThreadItem,
} from "./codex-item-conversion.js";
import type { JsonRpcNotification } from "./codex-json-rpc.js";
import {
  type CodexLiveEventState,
  type TokenUsageSnapshot,
  convertNotificationToSDKMessages,
  extractOpenAIRequestId,
  extractTurnUsage,
} from "./codex-live-event-conversion.js";
import { log } from "./codex-log.js";
import {
  asCodexErrorNotification,
  asCodexItemCompletedNotification,
  asCodexItemStartedNotification,
  asCodexRawResponseItemCompletedNotification,
  asCodexTurnCompletedNotification,
  isCodexLiveDeltaNotificationMethod,
  isCodexLiveDeltaSuppressionEnabled,
  readCodexTurnErrorDetail,
} from "./codex-notification-guards.js";
import type { CodexTurnRuntimeState } from "./codex-session-state.js";
import type { CodexThreadTurn } from "./codex-thread-params.js";
import type { StartSessionOptions } from "./types.js";

const CODEX_SERVER_OVERLOAD_RETRY_LIMIT = 16;
const CODEX_SERVER_OVERLOAD_RETRY_SCALE_MS = 5000;
const CODEX_SERVER_OVERLOAD_RETRY_MAX_DELAY_MS = 180_000;

export type CodexOverloadRetryWait = (
  delayMs: number,
  signal: AbortSignal,
) => Promise<boolean>;

function getCodexOverloadRetryDelayMs(attempt: number): number {
  return Math.min(
    (attempt + 1) ** 2 * CODEX_SERVER_OVERLOAD_RETRY_SCALE_MS,
    CODEX_SERVER_OVERLOAD_RETRY_MAX_DELAY_MS,
  );
}

export async function waitForCodexOverloadRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (elapsed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve(elapsed);
    };
    const onAbort = (): void => finish(false);
    const timeout = setTimeout(() => finish(true), delayMs);
    timeout.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type CodexRetryableTurnErrorKind =
  | "capacityUnavailable"
  | "cyberAccessDenied";

export interface CodexRetryableTurnError {
  kind: CodexRetryableTurnErrorKind;
  message: SDKMessage;
}

type CodexTurnErrorText = Pick<TurnError, "message" | "codexErrorInfo"> &
  Partial<Pick<TurnError, "additionalDetails">>;

function codexTurnErrorHttpStatus(error: CodexTurnErrorText): number | null {
  // Codex 0.162 declares `codexErrorInfo` open to future variants, so a known
  // variant key no longer narrows its body; read the status defensively.
  const info = error.codexErrorInfo;
  if (info && typeof info === "object") {
    for (const variant of [
      "httpConnectionFailed",
      "responseStreamDisconnected",
    ]) {
      if (!(variant in info)) continue;
      const body = (info as Record<string, unknown>)[variant];
      const status =
        body && typeof body === "object"
          ? (body as { httpStatusCode?: unknown }).httpStatusCode
          : null;
      return typeof status === "number" ? status : null;
    }
  }
  // Codex's error text carries the status even when the structured info
  // does not, for example `unexpected status 403 Forbidden: {...}`.
  const match = /\bunexpected status (\d{3})\b/.exec(
    `${error.message}\n${error.additionalDetails ?? ""}`,
  );
  return match ? Number(match[1]) : null;
}

/**
 * On a turn that requested a cyber access program, any HTTP 403 is treated as
 * the backend refusing that program. The refusal wording varies (`The
 * requested Cyber access program is not authorized for this model.`,
 * `Daybreak isn't available for this model.`) and enrollment can also hinge
 * on how the account signed in, so the body is not matched: a turn without
 * the program always beats a failed one.
 */
export function isCodexCyberAccessDenial(error: CodexTurnErrorText): boolean {
  return codexTurnErrorHttpStatus(error) === 403;
}

function classifyCodexTurnError(
  error: CodexTurnErrorText,
  cyberAccessRequested: boolean,
): CodexRetryableTurnErrorKind | null {
  // Codex 0.166 split policy-restricted capacity out of `serverOverloaded`
  // with the same retry advice, so both take YA's same-model overload retry.
  if (
    error.codexErrorInfo === "serverOverloaded" ||
    error.codexErrorInfo === "policyCapacityUnavailable"
  ) {
    return "capacityUnavailable";
  }
  if (cyberAccessRequested && isCodexCyberAccessDenial(error)) {
    return "cyberAccessDenied";
  }
  return null;
}

function getCodexNotificationThreadId(
  notification: JsonRpcNotification,
): string | null {
  if (!notification.params || typeof notification.params !== "object")
    return null;
  const params = notification.params as Record<string, unknown>;
  if (typeof params.threadId === "string") return params.threadId;
  if (notification.method !== "thread/started") return null;
  const thread = params.thread as { id?: unknown } | null | undefined;
  return typeof thread?.id === "string" ? thread.id : null;
}

function getCodexNotificationTurnId(
  notification: JsonRpcNotification,
  threadId: string,
): string | null {
  if (!notification.params || typeof notification.params !== "object") {
    return null;
  }
  const params = notification.params as Record<string, unknown>;
  if (params.threadId !== threadId) return null;

  if (
    notification.method === "turn/started" ||
    notification.method === "turn/completed"
  ) {
    const turn =
      params.turn && typeof params.turn === "object"
        ? (params.turn as Record<string, unknown>)
        : null;
    return typeof turn?.id === "string" ? turn.id : null;
  }

  // Any same-thread app-server notification carrying a top-level turnId was
  // produced for that live turn. Keeping this structural avoids silently
  // missing a newly added item/delta notification method.
  return typeof params.turnId === "string" ? params.turnId : null;
}

function getCodexNotificationTurnStartedAt(
  notification: JsonRpcNotification,
): number | null {
  if (
    (notification.method !== "turn/started" &&
      notification.method !== "turn/completed") ||
    !notification.params ||
    typeof notification.params !== "object"
  ) {
    return null;
  }
  const turn = (notification.params as Record<string, unknown>).turn;
  if (!turn || typeof turn !== "object") return null;
  const startedAt = (turn as Record<string, unknown>).startedAt;
  return typeof startedAt === "number" && Number.isFinite(startedAt)
    ? startedAt
    : null;
}

export function logRawCodexNotification(
  sessionId: string,
  notification: JsonRpcNotification,
): void {
  logSDKMessage(
    sessionId || "unknown",
    {
      _rawSource: "codex_app_server_notification",
      ...notification,
    },
    { provider: "codex" },
  );
}

export function shouldSuppressLiveDeltaNotification(
  notification: JsonRpcNotification,
  options: StartSessionOptions,
): boolean {
  if (!isCodexLiveDeltaNotificationMethod(notification.method)) {
    return false;
  }
  if (isCodexLiveDeltaSuppressionEnabled()) {
    return true;
  }
  return options.shouldEmitLiveDeltas?.() === false;
}

export function isTurnTerminalNotification(
  notification: JsonRpcNotification,
  turnId: string,
): boolean {
  if (notification.method === "turn/completed") {
    const params = asCodexTurnCompletedNotification(notification.params);
    return params?.turn.id === turnId;
  }

  if (notification.method === "error") {
    const params = asCodexErrorNotification(notification.params);
    if (params) {
      return params.turnId === turnId && !params.willRetry;
    }
    const rawParams =
      notification.params && typeof notification.params === "object"
        ? (notification.params as Record<string, unknown>)
        : null;
    return (
      rawParams?.codexProcessExit === true && rawParams.willRetry === false
    );
  }

  return false;
}

/**
 * Classify a turn error that YA retries itself. A cyber access
 * denial counts only when this turn requested a program; the same 403 on a
 * turn that sent none has nothing to drop.
 */
export function classifyRetryableTurnError(
  notification: JsonRpcNotification,
  turnId: string,
  cyberAccessRequested: boolean,
): CodexRetryableTurnErrorKind | null {
  if (notification.method !== "error") return null;
  const params = asCodexErrorNotification(notification.params);
  if (params?.turnId !== turnId) return null;
  const kind = classifyCodexTurnError(params.error, cyberAccessRequested);
  return params.willRetry && kind !== "cyberAccessDenied" ? null : kind;
}

export function updateBackgroundProcessTracking(
  notification: JsonRpcNotification,
  runtimeState: CodexTurnRuntimeState,
): void {
  if (notification.method === "rawResponseItem/completed") {
    const params = asCodexRawResponseItemCompletedNotification(
      notification.params,
    );
    const item =
      params?.item && typeof params.item === "object"
        ? (params.item as Record<string, unknown>)
        : null;
    const itemType = getOptionalString(item?.type);
    if (itemType === "function_call" || itemType === "custom_tool_call") {
      const callId = getOptionalString(item?.call_id);
      if (callId) {
        runtimeState.activeToolCallIds.add(callId);
      }
      return;
    }
    if (
      itemType === "function_call_output" ||
      itemType === "custom_tool_call_output"
    ) {
      const callId = getOptionalString(item?.call_id);
      if (!callId) return;
      if (isCodexBackgroundProcessOutput(item?.output)) {
        runtimeState.backgroundToolCallIds.add(callId);
      } else {
        runtimeState.activeToolCallIds.delete(callId);
        runtimeState.backgroundToolCallIds.delete(callId);
      }
    }
    return;
  }

  if (notification.method === "item/completed") {
    const params = asCodexItemCompletedNotification(notification.params);
    if (!params) return;
    const normalized = normalizeThreadItem(params.item);
    if (normalized?.type === "command_execution") {
      runtimeState.activeToolCallIds.delete(normalized.id);
      runtimeState.backgroundToolCallIds.delete(normalized.id);
    }
    return;
  }

  if (notification.method === "item/started") {
    const params = asCodexItemStartedNotification(notification.params);
    if (!params) return;
    const normalized = normalizeThreadItem(params.item);
    if (normalized && isResultBackedThreadItem(normalized)) {
      runtimeState.activeToolCallIds.add(normalized.id);
    }
  }
}

/**
 * The session's one prefetched notification. The session loop's idle wait
 * and the turn consumer share it: whichever receives it clears it, so no
 * notification is dropped between turns.
 */
export class CodexNotificationReader {
  private pendingNotification: Promise<JsonRpcNotification> | null = null;
  private readonly appServer: CodexAppServerClient;
  private readonly signal: AbortSignal;

  constructor(appServer: CodexAppServerClient, signal: AbortSignal) {
    this.appServer = appServer;
    this.signal = signal;
  }

  peek(): Promise<JsonRpcNotification> {
    if (!this.pendingNotification) {
      this.pendingNotification = this.appServer.nextNotification(this.signal);
      // A turn-start RPC can fail before the prefetched notification is read.
      void this.pendingNotification.catch(() => {});
    }
    return this.pendingNotification;
  }

  async read(): Promise<JsonRpcNotification> {
    const notification = await this.peek();
    this.pendingNotification = null;
    return notification;
  }

  /** The idle wait received the peeked notification and handles it itself. */
  takePeeked(): void {
    this.pendingNotification = null;
  }
}

/**
 * What a turn needs from its session. The session loop builds one per session
 * after the thread starts, so `sessionId` is final.
 */
export interface CodexTurnContext {
  readonly appServer: CodexAppServerClient;
  readonly reader: CodexNotificationReader;
  readonly options: StartSessionOptions;
  readonly signal: AbortSignal;
  readonly sessionId: string;
  readonly runtimeState: CodexTurnRuntimeState;
  readonly failureTrace: CodexFailureTrace;
  readonly usageByTurnId: Map<string, TokenUsageSnapshot>;
  readonly liveEventState: CodexLiveEventState;
  readonly observeCommands: (
    notification: JsonRpcNotification,
  ) => Promise<SDKMessage | null>;
  readonly logRawNotification: (notification: JsonRpcNotification) => void;
  readonly overloadRetryWait: CodexOverloadRetryWait;
}

export async function* consumeCodexTurn(
  context: CodexTurnContext,
  turn: CodexThreadTurn,
  notificationBarrierSequence: number,
  cyberAccessRequested = false,
): AsyncGenerator<
  SDKMessage,
  { retryableError: CodexRetryableTurnError | null },
  void
> {
  const {
    appServer,
    reader,
    options,
    signal,
    sessionId,
    runtimeState,
    failureTrace,
    usageByTurnId,
    liveEventState,
    observeCommands,
    logRawNotification,
  } = context;
  const activeTurnId = turn.id;
  runtimeState.activeTurnId = activeTurnId;
  runtimeState.activeToolCallIds.clear();
  runtimeState.backgroundToolCallIds.clear();
  failureTrace.activeTurnId = activeTurnId;
  let turnComplete = turn.status !== "inProgress";
  if (!turnComplete) {
    yield {
      type: "system",
      subtype: "session_state_changed",
      state: "running",
      session_id: sessionId,
    };
  }
  let emittedTurnError = false;
  let retryableError: CodexRetryableTurnError | null = null;
  let suppressedPreTurnNotifications: {
    count: number;
    firstSequence: number;
    lastSequence: number;
    firstTurnId: string;
    lastTurnId: string;
    firstMethod: string;
    lastMethod: string;
    firstStartedAt: number | null;
    lastStartedAt: number | null;
    maxQueueAgeMs: number;
    maxQueuedAhead: number;
  } | null = null;

  const logSuppressedPreTurnNotifications = (reason: string): void => {
    if (!suppressedPreTurnNotifications) return;
    log.warn(
      {
        sessionId,
        expectedTurnId: runtimeState.activeTurnId ?? activeTurnId,
        expectedTurnStartedAt: turn.startedAt,
        notificationBarrierSequence,
        ...suppressedPreTurnNotifications,
        reason,
      },
      "Suppressed stale Codex notifications queued before turn start",
    );
    suppressedPreTurnNotifications = null;
  };

  while (!turnComplete && !signal.aborted) {
    const notification = await reader.read();
    if (shouldSuppressLiveDeltaNotification(notification, options)) {
      continue;
    }
    const observedThreadId = getCodexNotificationThreadId(notification);
    if (
      observedThreadId !== null &&
      observedThreadId !== runtimeState.threadId
    ) {
      // Native subagents share this transport. Keep their raw diagnostics,
      // but never treat their tools, usage or completion as the parent's.
      logRawNotification(notification);
      continue;
    }
    const notificationReceipt = appServer.getNotificationReceipt(notification);
    const currentActiveTurnId: string =
      runtimeState.activeTurnId ?? activeTurnId;
    const observedTurnId = getCodexNotificationTurnId(
      notification,
      runtimeState.threadId,
    );
    const queuedBeforeTurnStart =
      notificationReceipt !== null &&
      notificationReceipt.sequence <= notificationBarrierSequence;
    if (
      observedTurnId &&
      observedTurnId !== currentActiveTurnId &&
      queuedBeforeTurnStart
    ) {
      // thread/resume normally replays the last turn's usage. It is not
      // stale live activity and needs no warning or active-id repair.
      if (notification.method === "thread/tokenUsage/updated") continue;
      const queueAgeMs = Math.max(
        0,
        Date.now() - notificationReceipt.receivedAtMs,
      );
      const startedAt = getCodexNotificationTurnStartedAt(notification);
      if (suppressedPreTurnNotifications) {
        suppressedPreTurnNotifications.count += 1;
        suppressedPreTurnNotifications.lastSequence =
          notificationReceipt.sequence;
        suppressedPreTurnNotifications.lastTurnId = observedTurnId;
        suppressedPreTurnNotifications.lastMethod = notification.method;
        suppressedPreTurnNotifications.lastStartedAt = startedAt;
        suppressedPreTurnNotifications.maxQueueAgeMs = Math.max(
          suppressedPreTurnNotifications.maxQueueAgeMs,
          queueAgeMs,
        );
        suppressedPreTurnNotifications.maxQueuedAhead = Math.max(
          suppressedPreTurnNotifications.maxQueuedAhead,
          notificationReceipt.queuedAhead,
        );
      } else {
        suppressedPreTurnNotifications = {
          count: 1,
          firstSequence: notificationReceipt.sequence,
          lastSequence: notificationReceipt.sequence,
          firstTurnId: observedTurnId,
          lastTurnId: observedTurnId,
          firstMethod: notification.method,
          lastMethod: notification.method,
          firstStartedAt: startedAt,
          lastStartedAt: startedAt,
          maxQueueAgeMs: queueAgeMs,
          maxQueuedAhead: notificationReceipt.queuedAhead,
        };
      }
      continue;
    }
    if (observedTurnId) {
      logSuppressedPreTurnNotifications("turn-scoped notification reached");
    }

    logRawNotification(notification);
    const goalCommands = await observeCommands(notification);
    if (goalCommands) yield goalCommands;
    if (notification.method === "skills/changed") {
      continue;
    }
    failureTrace.activeTurnId = currentActiveTurnId;

    if (notification.method === "thread/tokenUsage/updated") {
      const usage = extractTurnUsage(notification.params);
      if (usage) {
        usageByTurnId.set(usage.turnId, usage.snapshot);
        runtimeState.latestTokenUsage = usage.total;
      }
    }
    updateBackgroundProcessTracking(notification, runtimeState);
    recordCodexFailureTraceEvent(
      failureTrace,
      describeNotificationForFailureTrace(notification),
    );

    // Resume replays token usage for the last persisted turn, possibly
    // after turn/start's receipt barrier. Usage attribution is not an
    // active-turn announcement; adopting its id retargets live controls.
    if (
      observedTurnId &&
      observedTurnId !== runtimeState.activeTurnId &&
      notification.method !== "thread/tokenUsage/updated"
    ) {
      log.warn(
        {
          sessionId,
          expectedTurnId: runtimeState.activeTurnId,
          actualTurnId: observedTurnId,
          notificationMethod: notification.method,
          notificationBarrierSequence,
          notificationReceiptSequence: notificationReceipt?.sequence ?? null,
          notificationQueueAgeMs: notificationReceipt
            ? Math.max(0, Date.now() - notificationReceipt.receivedAtMs)
            : null,
          notificationQueuedAhead: notificationReceipt?.queuedAhead ?? null,
          notificationSource: notificationReceipt?.source ?? null,
          notificationTurnStartedAt:
            getCodexNotificationTurnStartedAt(notification),
        },
        "Resynchronized Codex turn id from provider notification",
      );
      runtimeState.activeTurnId = observedTurnId;
    }
    const effectiveActiveTurnId =
      runtimeState.activeTurnId ?? currentActiveTurnId;

    const messages = convertNotificationToSDKMessages(
      notification,
      sessionId,
      usageByTurnId,
      liveEventState,
    );
    const retryableKind = classifyRetryableTurnError(
      notification,
      effectiveActiveTurnId,
      cyberAccessRequested,
    );
    const interruptCyberAccessRetry =
      retryableKind === "cyberAccessDenied" &&
      retryableError === null &&
      asCodexErrorNotification(notification.params)?.willRetry === true;
    const suppressFailedRetryableCompletion =
      retryableError !== null &&
      notification.method === "turn/completed" &&
      isTurnTerminalNotification(notification, effectiveActiveTurnId);
    for (const rawMsg of messages) {
      const msg =
        rawMsg.type === "error"
          ? ({
              ...rawMsg,
              codexFailureTrace: snapshotCodexFailureTrace(failureTrace),
              codexFailureSummary: formatCodexFailureTrace(failureTrace),
            } as SDKMessage)
          : rawMsg;
      if (retryableKind && msg.type === "error") {
        retryableError = { kind: retryableKind, message: msg };
        continue;
      }
      if (suppressFailedRetryableCompletion) {
        continue;
      }
      if (
        observedThreadId === runtimeState.threadId &&
        getCodexToolCorrelation(msg)?.origin === "command_execution"
      ) {
        // Private acquisition evidence, absent on older hosted workers.
        // A current native thread match is stronger than presentation ids.
        msg._codexOwnedCommand = true;
      }
      failureTrace.lastEmittedMessage = describeSDKMessageForFailureTrace(msg);
      yield msg;
    }

    if (retryableKind) {
      if (interruptCyberAccessRetry) {
        await appServer.request("turn/interrupt", {
          threadId: runtimeState.threadId,
          turnId: effectiveActiveTurnId,
        });
      }
      continue;
    }
    if (isTurnTerminalNotification(notification, effectiveActiveTurnId)) {
      if (notification.method === "error") emittedTurnError = true;
      // A turn error precedes its completion; do not release queued work
      // while the provider still owns the failed turn.
      turnComplete = notification.method !== "error" || appServer.isClosed;
    }
  }
  logSuppressedPreTurnNotifications("turn consumption ended");
  runtimeState.activeTurnId = null;
  failureTrace.activeTurnId = null;

  if (signal.aborted) {
    return { retryableError: null };
  }

  if (!emittedTurnError && turn.status === "failed" && turn.error?.message) {
    const fallbackError = {
      type: "error",
      uuid: `codex-error-${turn.id}`,
      session_id: sessionId,
      error: turn.error.message,
      codexErrorInfo: turn.error.codexErrorInfo ?? null,
      codexAdditionalDetails: readCodexTurnErrorDetail(turn.error),
      codexWillRetry: false,
      codexTurnId: turn.id,
      codexFailureTrace: snapshotCodexFailureTrace(failureTrace),
      codexFailureSummary: formatCodexFailureTrace(failureTrace),
      codexRequestId: extractOpenAIRequestId(
        turn.error,
        turn.error.additionalDetails,
        turn.error.message,
      ),
    } as SDKMessage;
    const kind = classifyCodexTurnError(turn.error, cyberAccessRequested);
    if (kind) {
      return { retryableError: { kind, message: fallbackError } };
    }
    yield fallbackError;
  }

  if (retryableError) {
    return { retryableError };
  }

  runtimeState.pendingCompaction = undefined;
  yield {
    type: "result",
    session_id: sessionId,
  } as SDKMessage;
  return { retryableError: null };
}

export async function* prepareCodexOverloadRetry(
  context: CodexTurnContext,
  overloadError: SDKMessage,
  attempt: number,
): AsyncGenerator<SDKMessage, boolean, void> {
  const { signal, sessionId, runtimeState, overloadRetryWait } = context;
  if (attempt > CODEX_SERVER_OVERLOAD_RETRY_LIMIT) {
    yield {
      ...overloadError,
      codexWillRetry: false,
      codexOverloadRetryExhausted: true,
      codexRetryAttempt: CODEX_SERVER_OVERLOAD_RETRY_LIMIT,
      codexRetryMaxRetries: CODEX_SERVER_OVERLOAD_RETRY_LIMIT,
    } as SDKMessage;
    return false;
  }

  const retryDelayMs = getCodexOverloadRetryDelayMs(attempt);
  const controller = new AbortController();
  const retrySignal = AbortSignal.any([signal, controller.signal]);
  runtimeState.overloadRetryController = controller;
  try {
    yield {
      ...overloadError,
      codexWillRetry: true,
      codexOverloadRetry: true,
      codexRetryDelayMs: retryDelayMs,
      codexRetryAttempt: attempt,
      codexRetryMaxRetries: CODEX_SERVER_OVERLOAD_RETRY_LIMIT,
    } as SDKMessage;
    log.info(
      {
        sessionId,
        turnId: overloadError.codexTurnId,
        model: runtimeState.turnModelOverride ?? runtimeState.resolvedModel,
        retryAttempt: attempt,
        retryDelayMs,
      },
      "Codex model is overloaded; waiting to retry the operation",
    );
    return (
      !retrySignal.aborted &&
      (await overloadRetryWait(retryDelayMs, retrySignal)) &&
      !retrySignal.aborted
    );
  } finally {
    runtimeState.overloadRetryController = undefined;
  }
}
