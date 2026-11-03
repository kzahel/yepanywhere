/**
 * Shared subscription handlers for session and activity streams.
 *
 * WebSocket relay handlers call these functions, providing their own
 * `emit` implementation for the transport layer.
 */

import {
  type StreamAugmenter,
  createStreamAugmenter,
  extractIdFromAssistant,
  extractMessageIdFromStart,
  extractTextDelta,
  extractTextFromAssistant,
  isStreamingComplete,
  markSubagent,
} from "./augments/index.js";
import { isLiveToolOutputMessage } from "@yep-anywhere/shared";
import { createTaskListAugmenter } from "./augments/task-list-augments.js";
import { getLogger } from "./logging/logger.js";
import {
  sessionQueueSummaries,
  type SessionQueueSummaryDeps,
} from "./routes/session-queue-summaries.js";
import {
  type ProjectPathIndex,
  tryClaimProjectPathIndex,
} from "./projects/projectPathIndex.js";
import type { Process } from "./supervisor/Process.js";
import type { ProcessEvent } from "./supervisor/types.js";
import type { BusEvent, EventBus } from "./watcher/index.js";

export type Emit = (eventType: string, data: unknown) => void;

/**
 * Session frames also carry their event id: `<processId>.<cursor>.<frame>`,
 * where every message Process buffered at or before `cursor` has reached
 * this subscriber once the frame has.
 */
export type SessionEmit = (
  eventType: string,
  data: unknown,
  eventId: string,
) => void;

/**
 * Replay position a client already holds, from the last session event id it
 * received; null when it came from another Process or an older server.
 */
function parseResumeCursor(
  lastEventId: unknown,
  processId: string,
): number | null {
  const prefix = `${processId}.`;
  if (typeof lastEventId !== "string" || !lastEventId.startsWith(prefix)) {
    return null;
  }
  const cursor = Number(lastEventId.slice(prefix.length).split(".")[0]);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : null;
}

export interface SubscriptionOptions extends SessionQueueSummaryDeps {
  /** Called when an internal error occurs (e.g. augmentation failure). */
  onError?: (err: unknown) => void;
  /** Optional label for debug logs (e.g., subscription id). */
  logLabel?: string;
  /** Whether this subscriber wants live provider deltas and streaming augments. */
  wantsLiveDeltas?: boolean;
  /** Whether this subscriber wants running tool calls' live output. */
  wantsLiveToolOutput?: boolean;
  /**
   * Last session event id the client received; replay then skips buffered
   * messages it already has. Unrecognized ids replay the whole buffer.
   */
  lastEventId?: string;
  /** Injectable augmenter factory for deterministic transport tests. */
  createAugmenter?: typeof createStreamAugmenter;
  /** Authenticated exact probes for bare absolute-path viewer links. */
  resolveAbsoluteFilePaths?: (
    paths: readonly string[],
  ) => Promise<ReadonlySet<string>>;
}

/**
 * Normalize provider stream message shapes before augmentation/rendering.
 * Keep this lightweight; provider-specific heavy transforms should happen upstream.
 */
export function normalizeStreamMessage(
  message: Record<string, unknown>,
): Record<string, unknown> {
  if (
    message.type === "user" &&
    message.tool_use_result === undefined &&
    message.toolUseResult !== undefined
  ) {
    message.tool_use_result = message.toolUseResult;
  }
  return message;
}

function hasToolResultContent(message: Record<string, unknown>): boolean {
  const sdkMessage = message.message;
  const content =
    sdkMessage && typeof sdkMessage === "object" && "content" in sdkMessage
      ? (sdkMessage as { content?: unknown }).content
      : message.content;

  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        block !== null &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "tool_result",
    )
  );
}

function isPlainUserEcho(message: Record<string, unknown>): boolean {
  return (
    message.type === "user" &&
    message.tool_use_result === undefined &&
    message.toolUseResult === undefined &&
    !hasToolResultContent(message)
  );
}

function isLiveDeltaMessage(message: Record<string, unknown>): boolean {
  return message.type === "stream_event" || message._isStreaming === true;
}

function getStableMessageIdentity(
  message: Record<string, unknown>,
): string | null {
  if (typeof message.uuid === "string") return message.uuid;
  return typeof message.id === "string" ? message.id : null;
}

/**
 * Create a session subscription that forwards process events via `emit`.
 *
 * Subscribes to process events BEFORE capturing state for the "connected" event,
 * preventing a race condition where state changes during replay are lost.
 */
export function createSessionSubscription(
  process: Process,
  emitFrame: SessionEmit,
  options?: SubscriptionOptions,
): { cleanup: () => void } {
  const resumeCursor = parseResumeCursor(options?.lastEventId, process.id);
  // Advanced only past messages this subscriber has been sent, so any frame's
  // id is a safe resume point once that frame has arrived.
  let deliveredCursor = resumeCursor ?? 0;
  let frameCount = 0;
  const emit: Emit = (eventType, data) => {
    emitFrame(
      eventType,
      data,
      `${process.id}.${deliveredCursor}.${frameCount++}`,
    );
  };
  let completed = false;
  let currentStreamingMessageId: string | null = null;
  const wantsLiveDeltas = options?.wantsLiveDeltas !== false;
  const wantsLiveToolOutput = options?.wantsLiveToolOutput !== false;
  const unregisterViewer = process.registerViewer();
  const unregisterLiveDeltaSubscriber = wantsLiveDeltas
    ? process.registerLiveDeltaSubscriber()
    : null;

  // Task correlation is synchronous and order-sensitive, so prepare it before
  // raw delivery. The async augmenter shares this idempotent instance.
  const taskListAugmenter = createTaskListAugmenter();

  // Lazy augmenter
  let augmenter: StreamAugmenter | null = null;
  let augmenterPromise: Promise<StreamAugmenter> | null = null;
  // One path-cache claim for the augmenter's life. A streaming session renders
  // many turns against the same few directories, so re-claiming per turn would
  // let the project be evicted between them and re-probe from cold each time.
  let pathIndex: ProjectPathIndex | null = null;

  const getAugmenter = async (): Promise<StreamAugmenter> => {
    if (augmenter) return augmenter;
    if (!augmenterPromise) {
      augmenterPromise = (async () => {
        pathIndex = await tryClaimProjectPathIndex(process.projectPath);
        // The claim can land after teardown, and an unreleased one pins the
        // project's cached directories for as long as the process lives.
        if (completed) {
          pathIndex?.release();
          pathIndex = null;
        }
        return (options?.createAugmenter ?? createStreamAugmenter)({
          safeMarkdownOptions: {
            projectFileLinks: {
              projectId: process.projectId,
              projectPath: process.projectPath,
              ...(pathIndex ? { index: pathIndex } : {}),
              resolveAbsoluteFilePaths: options?.resolveAbsoluteFilePaths,
            },
          },
          taskListAugmenter,
          onMarkdownAugment: (data) => {
            if (!completed) emit("markdown-augment", data);
          },
          onPending: (data) => {
            if (!completed) emit("pending", data);
          },
          onError: (err, context) => {
            options?.onError?.(err);
            console.warn(`[subscription] ${context}:`, err);
          },
        });
      })();
    }
    augmenter = await augmenterPromise;
    return augmenter;
  };

  // Coordinator state is mutable across deltas, so it retains one FIFO lane.
  // Finalized-message rendering is independent and runs through the bounded
  // per-item queue below instead of waiting behind unrelated messages.
  let coordinatorTail: Promise<void> = Promise.resolve();
  const processCoordinatorInOrder = (
    message: Record<string, unknown>,
  ): Promise<void> => {
    const next = coordinatorTail.then(async () => {
      if (completed) return;
      const aug = await getAugmenter();
      await aug.processStreamingMessage(message);
    });
    coordinatorTail = next.catch(() => {});
    return next;
  };

  interface FinalizationJob {
    id: string;
    generation: number;
    message: Record<string, unknown>;
    resolve: () => void;
  }

  const maxConcurrentFinalizations = 4;
  const maxQueuedFinalizations = 128;
  let activeFinalizations = 0;
  const finalizationGenerations = new Map<string, number>();
  const finalizationQueue: FinalizationJob[] = [];
  let finalizationOverflow: {
    startedAtMs: number;
    droppedCount: number;
    firstDroppedId: string;
    lastDroppedId: string;
    maxQueueDepth: number;
  } | null = null;

  const recordFinalizationOverflow = (dropped: FinalizationJob): void => {
    if (finalizationOverflow) {
      finalizationOverflow.droppedCount += 1;
      finalizationOverflow.lastDroppedId = dropped.id;
      finalizationOverflow.maxQueueDepth = Math.max(
        finalizationOverflow.maxQueueDepth,
        finalizationQueue.length,
      );
      return;
    }
    finalizationOverflow = {
      startedAtMs: Date.now(),
      droppedCount: 1,
      firstDroppedId: dropped.id,
      lastDroppedId: dropped.id,
      maxQueueDepth: maxQueuedFinalizations,
    };
    getLogger().warn(
      {
        component: "session-subscription",
        sessionId: process.sessionId,
        projectId: process.projectId,
        subscription: options?.logLabel ?? null,
        maxQueuedFinalizations,
        activeFinalizations,
        queuedFinalizationsBeforeDrop: maxQueuedFinalizations,
        firstDroppedId: dropped.id,
      },
      "Finalized-message augmentation queue saturated; dropping optional enrichment",
    );
  };

  const finishFinalizationOverflow = (reason: string): void => {
    if (!finalizationOverflow) return;
    getLogger().warn(
      {
        component: "session-subscription",
        sessionId: process.sessionId,
        projectId: process.projectId,
        subscription: options?.logLabel ?? null,
        maxQueuedFinalizations,
        elapsedMs: Math.max(0, Date.now() - finalizationOverflow.startedAtMs),
        ...finalizationOverflow,
        reason,
      },
      "Finalized-message augmentation queue saturation ended",
    );
    finalizationOverflow = null;
  };

  const settleDroppedFinalization = (job: FinalizationJob): void => {
    if (finalizationGenerations.get(job.id) === job.generation) {
      finalizationGenerations.delete(job.id);
    }
    job.resolve();
  };

  const drainFinalizations = (): void => {
    while (
      !completed &&
      activeFinalizations < maxConcurrentFinalizations &&
      finalizationQueue.length > 0
    ) {
      const job = finalizationQueue.shift();
      if (!job) break;
      if (finalizationGenerations.get(job.id) !== job.generation) {
        job.resolve();
        continue;
      }

      activeFinalizations += 1;
      void getAugmenter()
        .then(async (aug) => {
          if (completed) return;
          const finalMarkdown = await aug.processFinalizedMessage(job.message);
          if (
            completed ||
            finalizationGenerations.get(job.id) !== job.generation
          ) {
            return;
          }
          emit("message", markSubagent(job.message));
          if (!completed && finalMarkdown) {
            emit("markdown-augment", finalMarkdown);
          }
        })
        .catch((error) => {
          options?.onError?.(error);
        })
        .finally(() => {
          activeFinalizations -= 1;
          if (finalizationGenerations.get(job.id) === job.generation) {
            finalizationGenerations.delete(job.id);
          }
          job.resolve();
          drainFinalizations();
        });
    }
    if (finalizationQueue.length === 0) {
      finishFinalizationOverflow("queue_drained");
    }
  };

  const scheduleFinalization = (
    message: Record<string, unknown>,
  ): Promise<void> => {
    const id = getStableMessageIdentity(message);
    if (!id || completed) return Promise.resolve();

    const generation = (finalizationGenerations.get(id) ?? 0) + 1;
    finalizationGenerations.set(id, generation);
    const queuedIndex = finalizationQueue.findIndex((job) => job.id === id);
    if (queuedIndex >= 0) {
      finalizationQueue.splice(queuedIndex, 1)[0]?.resolve();
    }

    return new Promise((resolve) => {
      if (finalizationQueue.length >= maxQueuedFinalizations) {
        const dropped = finalizationQueue.shift();
        if (dropped) {
          settleDroppedFinalization(dropped);
          recordFinalizationOverflow(dropped);
        }
      }
      finalizationQueue.push({
        id,
        generation,
        message: structuredClone(message),
        resolve,
      });
      drainFinalizations();
    });
  };

  const clearQueuedFinalizations = (reason: string): void => {
    for (const job of finalizationQueue.splice(0)) {
      settleDroppedFinalization(job);
    }
    finalizationGenerations.clear();
    finishFinalizationOverflow(reason);
  };

  const emitStatus = (state: Process["state"]) => {
    emit("status", {
      sessionId: process.sessionId,
      state: state.type,
      liveness: process.getLivenessSnapshot(),
      providerRuntimeStatus: process.getProviderRuntimeStatus(),
      ...(state.type === "waiting-input" ? { request: state.request } : {}),
    });
  };

  // Heartbeat
  const heartbeatInterval = setInterval(() => {
    try {
      if (!completed) {
        emit("heartbeat", {
          timestamp: new Date().toISOString(),
          liveness: process.getLivenessSnapshot(),
        });
      }
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, 30_000);

  // IMPORTANT: Subscribe BEFORE capturing state to prevent race condition.
  // Any state change is guaranteed to either:
  // 1. Be captured in the state snapshot below (if it happened before)
  // 2. Be received by this subscriber (if it happened after)
  const unsubscribe = process.subscribe(async (event: ProcessEvent) => {
    if (completed) return;

    try {
      switch (event.type) {
        case "message": {
          const message = normalizeStreamMessage(
            event.message as Record<string, unknown>,
          );
          if (!wantsLiveDeltas && isLiveDeltaMessage(message)) {
            break;
          }
          if (!wantsLiveToolOutput && isLiveToolOutputMessage(message)) {
            break;
          }
          taskListAugmenter.processMessage(message);

          const startMessageId =
            extractMessageIdFromStart(message) ??
            extractIdFromAssistant(message);
          if (startMessageId) {
            currentStreamingMessageId = startMessageId;
          }

          const snapshot = extractTextFromAssistant(message);
          const textDelta = extractTextDelta(message);
          const text = snapshot ?? textDelta;
          if (text !== null && currentStreamingMessageId) {
            process.accumulateStreamingText(
              currentStreamingMessageId,
              text,
              snapshot !== null ? "snapshot" : "delta",
            );
          }

          // Raw provider messages are the ordered, user-visible activity path.
          // Optional markdown/tool enrichment may follow as a same-id update,
          // but must never delay or reorder the underlying transcript event.
          // Process buffers a message just before emitting it, so the replay
          // cursor now covers it and everything buffered earlier.
          deliveredCursor = process.getReplayCursor();
          emit("message", markSubagent(message));
          if (
            isStreamingComplete(message) ||
            (snapshot !== null && message._isStreaming !== true)
          ) {
            currentStreamingMessageId = null;
            process.clearStreamingText();
          }

          void processCoordinatorInOrder(message).catch((error) => {
            options?.onError?.(error);
          });
          if (!isLiveDeltaMessage(message) && !isPlainUserEcho(message)) {
            await scheduleFinalization(message);
          }
          break;
        }

        case "state-change":
          emitStatus(event.state);
          break;

        // Both refresh the same status payload from current process state;
        // the changed value is read back off the process at emit time.
        case "liveness-update":
        case "provider-runtime-status-change":
          emitStatus(process.state);
          break;

        case "mode-change":
          emit("mode-change", {
            permissionMode: event.mode,
            modeVersion: event.version,
          });
          break;

        case "mode-applied":
          emit("mode-applied", {
            appliedPermissionMode: event.mode,
          });
          break;

        case "error":
          emit("error", { message: event.error.message });
          break;

        case "configuration-error":
          emit("configuration-error", {
            setting: event.setting,
            requestedValue: event.requestedValue,
            message: event.error.message,
          });
          break;

        case "deferred-queue":
          emit("deferred-queue", {
            messages: sessionQueueSummaries(
              options ?? {},
              process.sessionId,
              process,
            ),
            reason: event.reason,
            tempId: event.tempId,
            yaCommand: event.yaCommand,
          });
          break;

        case "complete":
          // Optional enrichment must not hold the client in a processing state.
          // Each completed stream message flushes its own coordinator work; any
          // still-queued finalized enrichment is safely superseded by the
          // durable transcript catch-up triggered by this event.
          emit("complete", {
            sessionId: process.sessionId,
            timestamp: new Date().toISOString(),
            providerRuntimeStatus: process.getProviderRuntimeStatus(),
          });
          completed = true;
          clearQueuedFinalizations("session_complete");
          clearInterval(heartbeatInterval);
          break;
      }
    } catch (err) {
      options?.onError?.(err);
    }
  });

  // Now that we're subscribed, capture state and emit "connected"
  const currentState = process.state;
  const deferredMessages = sessionQueueSummaries(
    options ?? {},
    process.sessionId,
    process,
  );
  emit("connected", {
    processId: process.id,
    sessionId: process.sessionId,
    state: currentState.type,
    permissionMode: process.permissionMode,
    appliedPermissionMode: process.appliedPermissionMode,
    modeVersion: process.modeVersion,
    recapAfterSeconds: process.recapAfterSeconds,
    recapMode: process.recapMode,
    provider: process.provider,
    model: process.resolvedModel,
    liveness: process.getLivenessSnapshot(),
    providerRuntimeStatus: process.getProviderRuntimeStatus(),
    ...(currentState.type === "waiting-input"
      ? { request: currentState.request }
      : {}),
    ...(deferredMessages.length > 0 ? { deferredMessages } : {}),
  });

  // Replay buffered messages for late-joining clients. Prepare clones so task
  // correlation and optional presentation fields never mutate Process history.
  // A resuming client already has messages at or before its cursor; they
  // still feed task correlation, which depends on the whole ordered buffer.
  const history = process.getMessageHistory();
  const replaySeqs = history.map((message) => process.getReplaySeq(message));
  const sendsMessage = replaySeqs.map(
    (seq) => resumeCursor === null || seq === undefined || seq > resumeCursor,
  );
  // History is not ordered by position (in-turn steer echoes come first), so
  // a replay frame may only claim positions below every one still to come.
  const minSeqAfter: number[] = [];
  let minSeq = Number.POSITIVE_INFINITY;
  for (let i = history.length - 1; i >= 0; i--) {
    minSeqAfter[i] = minSeq;
    if (sendsMessage[i]) minSeq = Math.min(minSeq, replaySeqs[i] ?? minSeq);
  }
  const replayCursorAtSubscribe = process.getReplayCursor();
  for (const [i, historyMessage] of history.entries()) {
    const message = normalizeStreamMessage({
      ...structuredClone(historyMessage),
      isReplay: true,
    });
    taskListAugmenter.processMessage(message);
    if (!sendsMessage[i]) continue;
    deliveredCursor = Math.max(
      deliveredCursor,
      Math.min(replayCursorAtSubscribe, (minSeqAfter[i] ?? minSeq) - 1),
    );
    emit("message", markSubagent(message));
    if (!isLiveDeltaMessage(message) && !isPlainUserEcho(message)) {
      void scheduleFinalization(message);
    }
  }
  // Everything buffered so far was sent, already held, or has expired.
  deliveredCursor = Math.max(deliveredCursor, replayCursorAtSubscribe);

  // Catch-up: send accumulated streaming text as pending HTML
  const streamingContent = wantsLiveDeltas
    ? process.getStreamingContent()
    : null;
  if (streamingContent) {
    coordinatorTail = getAugmenter()
      .then(async (aug) => {
        await aug.processCatchUp(
          streamingContent.text,
          streamingContent.messageId,
        );
      })
      .catch((err) => {
        console.warn(
          "[subscription] Failed to send catch-up pending HTML:",
          err,
        );
      });
  }

  return {
    cleanup: () => {
      completed = true;
      clearQueuedFinalizations("subscription_cleanup");
      clearInterval(heartbeatInterval);
      unsubscribe();
      unregisterLiveDeltaSubscriber?.();
      unregisterViewer();
      pathIndex?.release();
      pathIndex = null;
      if (currentStreamingMessageId) {
        process.clearStreamingText();
        currentStreamingMessageId = null;
      }
    },
  };
}

export interface ActivitySubscriptionOptions extends SubscriptionOptions {
  /**
   * A bus event as this subscriber may receive it, or null when hidden from
   * them. Absent forwards every event as is. The stream's own `connected` and
   * `heartbeat` frames are always sent.
   */
  eventForSubscriber?: (event: BusEvent) => BusEvent | null;
}

/**
 * Create an activity subscription that forwards EventBus events via `emit`.
 */
export function createActivitySubscription(
  eventBus: EventBus,
  emit: Emit,
  options?: ActivitySubscriptionOptions,
): { cleanup: () => void } {
  let closed = false;

  emit("connected", { timestamp: new Date().toISOString() });

  const heartbeatInterval = setInterval(() => {
    try {
      if (!closed) {
        emit("heartbeat", { timestamp: new Date().toISOString() });
      }
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, 30_000);

  const unsubscribe = eventBus.subscribe((event: BusEvent) => {
    if (closed) return;
    try {
      const delivered = options?.eventForSubscriber
        ? options.eventForSubscriber(event)
        : event;
      if (delivered === null) return;
      const label = options?.logLabel ? ` sub=${options.logLabel}` : "";
      getLogger().debug(
        `[ActivitySubscription] Forwarding event type=${event.type}${label}`,
      );
      emit(delivered.type, delivered);
    } catch (err) {
      options?.onError?.(err);
    }
  });

  return {
    cleanup: () => {
      closed = true;
      clearInterval(heartbeatInterval);
      unsubscribe();
    },
  };
}
