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
import { getLogger } from "./logging/logger.js";
import type { Process } from "./supervisor/Process.js";
import type { ProcessEvent } from "./supervisor/types.js";
import type { BusEvent, EventBus } from "./watcher/index.js";

export type Emit = (eventType: string, data: unknown) => void;

export interface SubscriptionOptions {
  /** Called when an internal error occurs (e.g. augmentation failure). */
  onError?: (err: unknown) => void;
  /** Optional label for debug logs (e.g., subscription id). */
  logLabel?: string;
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

/**
 * Create a session subscription that forwards process events via `emit`.
 *
 * Subscribes to process events BEFORE capturing state for the "connected" event,
 * preventing a race condition where state changes during replay are lost.
 */
export function createSessionSubscription(
  process: Process,
  emit: Emit,
  options?: SubscriptionOptions,
): { cleanup: () => void } {
  let completed = false;
  let currentStreamingMessageId: string | null = null;

  // Lazy augmenter
  let augmenter: StreamAugmenter | null = null;
  let augmenterPromise: Promise<StreamAugmenter> | null = null;

  const getAugmenter = async (): Promise<StreamAugmenter> => {
    if (augmenter) return augmenter;
    if (!augmenterPromise) {
      augmenterPromise = createStreamAugmenter({
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
    }
    augmenter = await augmenterPromise;
    return augmenter;
  };

  // Heartbeat
  const heartbeatInterval = setInterval(() => {
    try {
      if (!completed) {
        emit("heartbeat", { timestamp: new Date().toISOString() });
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
          const aug = await getAugmenter();
          await aug.processMessage(message);
          emit("message", markSubagent(message));

          const startMessageId =
            extractMessageIdFromStart(message) ??
            extractIdFromAssistant(message);
          if (startMessageId) {
            currentStreamingMessageId = startMessageId;
          }

          const textDelta =
            extractTextDelta(message) ?? extractTextFromAssistant(message);
          if (textDelta && currentStreamingMessageId) {
            process.accumulateStreamingText(
              currentStreamingMessageId,
              textDelta,
            );
          }

          if (isStreamingComplete(message)) {
            currentStreamingMessageId = null;
            process.clearStreamingText();
          }
          break;
        }

        case "state-change":
          emit("status", {
            state: event.state.type,
            ...(event.state.type === "in-turn"
              ? { turnStartedAt: event.state.since.toISOString() }
              : {}),
            ...(event.state.type === "waiting-input"
              ? { request: event.state.request }
              : {}),
          });
          break;

        case "mode-change":
          emit("mode-change", {
            permissionMode: event.mode,
            modeVersion: event.version,
          });
          break;

        case "error":
          emit("error", { message: event.error.message });
          break;

        case "session-id-changed":
          emit("session-id-changed", {
            oldSessionId: event.oldSessionId,
            newSessionId: event.newSessionId,
          });
          break;

        case "deferred-queue":
          emit("deferred-queue", { messages: event.messages });
          break;

        case "complete":
          if (augmenter) {
            await augmenter.flush();
          }
          emit("complete", { timestamp: new Date().toISOString() });
          completed = true;
          clearInterval(heartbeatInterval);
          break;
      }
    } catch (err) {
      options?.onError?.(err);
    }
  });

  // Now that we're subscribed, capture state and emit "connected"
  const currentState = process.state;
  const deferredMessages = process.getDeferredQueueSummary();
  emit("connected", {
    processId: process.id,
    sessionId: process.sessionId,
    state: currentState.type,
    ...(currentState.type === "in-turn"
      ? { turnStartedAt: currentState.since.toISOString() }
      : {}),
    permissionMode: process.permissionMode,
    modeVersion: process.modeVersion,
    provider: process.provider,
    model: process.resolvedModel,
    ...(currentState.type === "waiting-input"
      ? { request: currentState.request }
      : {}),
    ...(deferredMessages.length > 0 ? { deferredMessages } : {}),
  });

  // Replay buffered messages for late-joining clients
  for (const message of process.getMessageHistory()) {
    emit(
      "message",
      markSubagent({
        ...message,
        isReplay: true,
      }),
    );
  }

  // Catch-up: send accumulated streaming text as pending HTML
  const streamingContent = process.getStreamingContent();
  if (streamingContent) {
    getAugmenter()
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
      clearInterval(heartbeatInterval);
      unsubscribe();
      if (currentStreamingMessageId) {
        process.clearStreamingText();
        currentStreamingMessageId = null;
      }
    },
  };
}

/**
 * Create an activity subscription that forwards EventBus events via `emit`.
 */
export function createActivitySubscription(
  eventBus: EventBus,
  emit: Emit,
  options?: SubscriptionOptions,
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
      const label = options?.logLabel ? ` sub=${options.logLabel}` : "";
      getLogger().debug(
        `[ActivitySubscription] Forwarding event type=${event.type}${label}`,
      );
      emit(event.type, event);
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
