import {
  type ContextUsage,
  type ProviderName,
  type ProviderRuntimeStatus,
  type RecapMode,
  type SessionQueuedMessageSummary,
  type SessionQueuedYaCommand,
  type SessionLivenessSnapshot,
  type SlashCommand,
  type UploadedFile,
  DEFAULT_RECAP_AFTER_SECONDS,
  getModelContextWindow,
  normalizeRecapAfterSeconds,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { markReloadPerfPhase } from "../lib/diagnostics/reloadPerfProbe";
import { logSessionUiTrace } from "../lib/diagnostics/uiTrace";
import {
  isBrowserDebugPerformanceRecording,
  recordBrowserDebugPerformanceMetric,
} from "../lib/browserDebugPerformance";
import {
  hasUnconfirmedSelfSends,
  ownedSessionShouldFetchDurableTranscript,
  PENDING_SEND_RECONCILE_MS,
} from "../lib/deliveryState";
import { getMessageId } from "@yep-anywhere/shared/transcript/message";
import { findPendingTasks } from "../lib/pendingTasks";
import {
  extractParentSessionIdFromAgentFileEvent,
  extractSessionIdFromFileEvent,
} from "../lib/sessionFile";
import {
  sessionModelPick,
  sessionPermissionModePick,
} from "../lib/sessionPickStorage";
import type {
  InputRequest,
  Message,
  PermissionMode,
  SessionStatus,
} from "../types";
import {
  type FileChangeEvent,
  type ProcessStateEvent,
  type SessionMetadataChangedEvent,
  type SessionStatusEvent,
  type SessionUpdatedEvent,
  useFileActivity,
} from "./useFileActivity";
import {
  type IncrementalFetchTrigger,
  type SessionLoadResult,
  useSessionMessages,
} from "./useSessionMessages";
import { useSessionStream } from "./useSessionStream";
import { stripQueuedTurnMarkers } from "../lib/queuedTurnMarkers";
import {
  type SessionWatchChangeEvent,
  useSessionWatchStream,
} from "./useSessionWatchStream";
import {
  type StreamingMarkdownCallbacks,
  useStreamingContent,
} from "./useStreamingContent";
import { getStreamingEnabled } from "./useStreamingEnabled";

export type ProcessState = "idle" | "in-turn" | "waiting-input";

interface RuntimeSnapshotToken {
  projectId: string;
  sessionId: string;
  generation: number;
  lifecycleObservationRevision: number;
}

// Re-export types from useSessionMessages
export type { AgentContent, AgentContentMap } from "./useSessionMessages";

const THROTTLE_MS = 500;
const FILE_CHANGE_FACT_DEDUPE_MS = 1000;
const STREAM_ACTIVITY_TOKEN_UPDATE_MS = 500;
const STREAM_LIVENESS_UPDATE_MS = 500;
const FALLBACK_STREAM_LONG_SILENCE_THRESHOLD_MS = 300_000;
// Background "away recap" scheduling. A session is "away" when its tab is
// hidden or the user navigated away from its view -- equivalent conditions.
// After the session's configured away threshold elapses while still away, we
// request a recap in the background rather than on return: recap generation has
// ~10s latency, so on-return would stall the view. Timers are module-level so
// they survive this hook unmounting on navigation. We gate on a live processId:
// with no YA-owned process there is nothing to recap and we avoid the cost. (A
// live processId is only a weak proxy for the provider context still being
// warm, but it is the cheap, simple guard.)
const awayRecapTimers = new Map<string, ReturnType<typeof setTimeout>>();

interface SessionFileChangeFact {
  path?: string;
  mtimeMs?: number;
  size?: number;
}

type SessionFileChangeRoute = "broad-file-watch" | "focused-session-watch";

function getSessionFileChangeFactKey(
  event: SessionFileChangeFact,
): string | null {
  if (
    typeof event.path !== "string" ||
    typeof event.mtimeMs !== "number" ||
    !Number.isFinite(event.mtimeMs) ||
    typeof event.size !== "number" ||
    !Number.isFinite(event.size)
  ) {
    return null;
  }
  return `${event.path}\0${event.mtimeMs}\0${event.size}`;
}

function buildSessionFileChangePerfDetail(
  route: SessionFileChangeRoute,
  event: FileChangeEvent | SessionWatchChangeEvent,
): IncrementalFetchTrigger {
  return {
    route,
    path: event.path,
    mtimeMs: event.mtimeMs,
    size: event.size,
    eventTimestamp: event.timestamp,
    ...(event.type === "session-watch-change" && {
      eventSource: event.source,
      changeVersion: event.changeVersion,
      sourceObservedAt: event.sourceObservedAt,
    }),
  };
}

function hasUnreconciledHeartbeatProgress(
  liveness: SessionLivenessSnapshot,
  reconciledTranscriptUpdatedAt: string | undefined,
): boolean {
  if (!liveness.lastProviderMessageAt) return false;
  const progressAtMs = Date.parse(liveness.lastProviderMessageAt);
  const reconciledTranscriptUpdatedAtMs = Date.parse(
    reconciledTranscriptUpdatedAt ?? "",
  );
  return (
    Number.isFinite(progressAtMs) &&
    (!Number.isFinite(reconciledTranscriptUpdatedAtMs) ||
      progressAtMs > reconciledTranscriptUpdatedAtMs)
  );
}

function scheduleAwayRecap(
  projectId: string,
  sessionId: string,
  awayThresholdMs: number,
): void {
  // One away period -> one timer; keep the original "away since".
  if (awayRecapTimers.has(sessionId)) {
    return;
  }
  const awaySinceMs = Date.now();
  const timer = setTimeout(() => {
    awayRecapTimers.delete(sessionId);
    // Session-keyed so a process that died while we were away (e.g. a server
    // restart) can still be revived and recapped server-side.
    void api
      .requestSessionRecap(projectId, sessionId, awaySinceMs)
      .catch((error) => {
        console.warn("Failed to request recap:", error);
      });
  }, awayThresholdMs);
  awayRecapTimers.set(sessionId, timer);
}

function cancelAwayRecap(sessionId: string): void {
  const timer = awayRecapTimers.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    awayRecapTimers.delete(sessionId);
  }
}

// Test-only: clear any pending away-recap timers between tests.
export function __resetAwayRecapTimersForTest(): void {
  for (const timer of awayRecapTimers.values()) {
    clearTimeout(timer);
  }
  awayRecapTimers.clear();
}

// Whether an away-recap POST is worth sending for this session: only when a
// recap mode that can act is enabled. A live session recaps in any non-off
// mode; a cold (process-dead) session can only be revived+recapped in fork
// mode. `mode` is undefined until we have seen the session live this view, so
// a never-live (list-browsed) session never fires. See topics/fork-recap.md.
function awayRecapEnabled(
  mode: RecapMode | undefined,
  sessionIsLive: boolean,
): boolean {
  if (!mode || mode === "off") {
    return false;
  }
  return sessionIsLive || mode === "fork";
}

function hasUserVisibleStreamProgress(
  streamEvent: Record<string, unknown>,
): boolean {
  // "user-visible liveness": only content chunks that can render visible text/thinking
  // count as actual progress for stale->live transition.
  const eventType = streamEvent.type;
  if (typeof eventType !== "string") {
    return false;
  }

  if (eventType === "content_block_delta") {
    const delta = streamEvent.delta;
    if (!delta || typeof delta !== "object") {
      return false;
    }
    const text = (delta as Record<string, unknown>).text;
    const thinking = (delta as Record<string, unknown>).thinking;
    return (
      (typeof text === "string" && text.length > 0) ||
      (typeof thinking === "string" && thinking.length > 0)
    );
  }

  if (eventType === "content_block_start") {
    const contentBlock = streamEvent.content_block;
    if (!contentBlock || typeof contentBlock !== "object") {
      return false;
    }
    const text = (contentBlock as Record<string, unknown>).text;
    const thinking = (contentBlock as Record<string, unknown>).thinking;
    return (
      (typeof text === "string" && text.length > 0) ||
      (typeof thinking === "string" && thinking.length > 0)
    );
  }

  return false;
}

function getKnownStreamPayloadChars(data: Record<string, unknown>): number {
  if (typeof data.html === "string") return data.html.length;
  if (typeof data.suggestion === "string") return data.suggestion.length;
  const event = data.event;
  if (!event || typeof event !== "object") return 0;
  const delta = (event as Record<string, unknown>).delta;
  if (!delta || typeof delta !== "object") return 0;
  const deltaRecord = delta as Record<string, unknown>;
  if (typeof deltaRecord.text === "string") return deltaRecord.text.length;
  if (typeof deltaRecord.thinking === "string") {
    return deltaRecord.thinking.length;
  }
  return 0;
}

function getContextUsageFromTokenUsageMessage(
  message: Record<string, unknown>,
  fallbackModel?: string,
  fallbackProvider?: ProviderName,
): ContextUsage | undefined {
  const usage =
    message.usage && typeof message.usage === "object"
      ? (message.usage as Record<string, unknown>)
      : null;
  const inputTokens =
    usage && typeof usage.input_tokens === "number" ? usage.input_tokens : null;
  if (inputTokens === null) {
    return undefined;
  }

  const outputTokens =
    usage && typeof usage.output_tokens === "number"
      ? usage.output_tokens
      : undefined;
  const cacheReadTokens =
    usage && typeof usage.cached_input_tokens === "number"
      ? usage.cached_input_tokens
      : undefined;

  const contextWindowCandidate =
    message.model_context_window &&
    typeof message.model_context_window === "number" &&
    Number.isFinite(message.model_context_window)
      ? message.model_context_window
      : getModelContextWindow(fallbackModel, fallbackProvider);
  const contextWindow =
    contextWindowCandidate > 0 ? contextWindowCandidate : undefined;

  return {
    inputTokens,
    percentage:
      contextWindow && contextWindow > 0
        ? (inputTokens / contextWindow) * 100
        : 0,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
  };
}

function parseProcessState(value: unknown): ProcessState | null {
  if (value === "idle" || value === "in-turn" || value === "waiting-input") {
    return value;
  }
  return null;
}

interface CompactBoundarySnapshot {
  count: number;
  latestKey: string | null;
  latestTimestampMs: number | null;
}

function isCompactBoundaryMessage(message: Message): boolean {
  return message.type === "system" && message.subtype === "compact_boundary";
}

function getCompactBoundaryKey(message: Message, index: number): string {
  return (
    getMessageId(message) ??
    `${index}:${typeof message.timestamp === "string" ? message.timestamp : ""}`
  );
}

function getCompactBoundarySnapshot(
  messages: Message[],
): CompactBoundarySnapshot {
  let count = 0;
  let latestKey: string | null = null;
  let latestTimestampMs: number | null = null;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || !isCompactBoundaryMessage(message)) {
      continue;
    }

    count += 1;
    latestKey = getCompactBoundaryKey(message, index);
    latestTimestampMs = parseMessageTimestampMs(message.timestamp);
  }

  return { count, latestKey, latestTimestampMs };
}

function compactBoundaryAdvancedSince(
  current: CompactBoundarySnapshot,
  baseline: CompactBoundarySnapshot | null,
): boolean {
  if (current.count === 0) {
    return false;
  }
  if (!baseline || baseline.count === 0) {
    return true;
  }
  if (current.latestKey === baseline.latestKey) {
    return false;
  }
  if (
    current.latestTimestampMs !== null &&
    baseline.latestTimestampMs !== null
  ) {
    return current.latestTimestampMs > baseline.latestTimestampMs;
  }
  return current.count > baseline.count;
}

// Re-export StreamingMarkdownCallbacks for consumers
export type { StreamingMarkdownCallbacks } from "./useStreamingContent";

/** Pending message waiting for server confirmation */
export interface PendingMessage {
  tempId: string;
  content: string;
  timestamp: string;
  clientOrder?: number;
  /** Display status text (e.g. "Uploading...", "Sending..."). Defaults to "Sending..." */
  status?: string;
  attachments?: UploadedFile[];
}

/**
 * Deferred message queued server-side, waiting for the agent's turn to end.
 *
 * The server owns the queue summary. The client never persists it or
 * reconciles it by text, but a delivered user echo can remove matching rows by
 * tempId because that identity is definitive proof that the server accepted
 * them.
 */
export type DeferredMessage = SessionQueuedMessageSummary;

const CONCATENATED_USER_TURN_SEPARATOR = "\n\n--------\n\n";
const USER_ECHO_CLOCK_SKEW_MS = 60_000;

// Delivered turns can carry server-injected markers that were never part of
// the user's typed text: compose-time anchors (optionally with a
// `had seen: "…"` needle) and experimental `[sent <ISO>]` turn timestamps.
// Strip them before matching a delivered turn against a persisted queued
// message (lib/queuedTurnMarkers.ts).

function parseMessageTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function extractUserMessageText(
  sdkMessage: Record<string, unknown>,
): string | null {
  const message = sdkMessage.message as
    | { content?: unknown; role?: unknown }
    | undefined;
  const content = message?.content ?? sdkMessage.content;

  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(content)) {
    const textParts = content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .filter((part) => part.length > 0);
    if (textParts.length === 0) return null;
    const joined = textParts.join("\n").trim();
    return joined.length > 0 ? joined : null;
  }

  return null;
}

function userTextContainsDeferredContent(
  userText: string,
  deferredContent: string,
): boolean {
  const normalizedUserText = userText.trim();
  const normalizedDeferredContent = deferredContent.trim();
  if (!normalizedUserText || !normalizedDeferredContent) {
    return false;
  }

  // A delivered chunk matches when, after dropping any legacy time marker, it
  // equals the queued text or begins with it (a queued message may itself be
  // multi-paragraph, hence the trailing "\n\n" prefix form).
  const partMatches = (part: string): boolean => {
    const normalizedPart = stripQueuedTurnMarkers(part.trim());
    return (
      normalizedPart === normalizedDeferredContent ||
      normalizedPart.startsWith(`${normalizedDeferredContent}\n\n`)
    );
  };

  if (partMatches(normalizedUserText)) {
    return true;
  }

  return normalizedUserText
    .split(CONCATENATED_USER_TURN_SEPARATOR)
    .some(partMatches);
}

function removeEchoedQueueMessage<
  T extends { tempId?: string; content: string },
>(messages: T[], tempIds?: string[], incomingText?: string | null): T[] {
  let next = messages;
  if (tempIds?.length) {
    const ids = new Set(tempIds);
    next = next.filter(
      (message) => !(message.tempId && ids.has(message.tempId)),
    );
  }

  if (!incomingText) {
    return next;
  }

  return next.filter(
    (message) =>
      !userTextContainsDeferredContent(incomingText, message.content),
  );
}

function userTurnMatchesPending(
  message: Message,
  pending: PendingMessage,
): boolean {
  if (message.type !== "user" && message.role !== "user") {
    return false;
  }
  if (message.tempId === pending.tempId) {
    return true;
  }

  const text = extractUserMessageText(message as Record<string, unknown>);
  if (!text || !userTextContainsDeferredContent(text, pending.content)) {
    return false;
  }

  const messageTimestampMs = parseMessageTimestampMs(message.timestamp);
  const pendingTimestampMs = parseMessageTimestampMs(pending.timestamp);
  if (messageTimestampMs === null || pendingTimestampMs === null) {
    return false;
  }

  return messageTimestampMs + USER_ECHO_CLOCK_SKEW_MS >= pendingTimestampMs;
}

function removeDeliveredPendingMessages(
  pendingMessages: PendingMessage[],
  messages: Message[],
): PendingMessage[] {
  if (pendingMessages.length === 0 || messages.length === 0) {
    return pendingMessages;
  }

  const recentMessages = messages.slice(-30);
  const filtered = pendingMessages.filter(
    (pending) =>
      !recentMessages.some((message) =>
        userTurnMatchesPending(message, pending),
      ),
  );
  return filtered.length === pendingMessages.length
    ? pendingMessages
    : filtered;
}

export function useSession(
  projectId: string,
  sessionId: string,
  initialStatus?: {
    owner: "self";
    processId: string;
    permissionMode?: PermissionMode;
    appliedPermissionMode?: PermissionMode;
    modeVersion?: number;
    recapAfterSeconds?: number;
    recapMode?: RecapMode;
  },
  streamingMarkdownCallbacks?: StreamingMarkdownCallbacks,
  options?: {
    tailTurns?: number;
    tailFrom?: string;
    detailedLoadingProgress?: boolean;
    codexStreamDurableIdAlignment?: boolean;
    backgroundEffectsPaused?: boolean;
    onConfigurationError?: (failure: {
      setting: "effort";
      requestedValue?: string;
      message: string;
    }) => void;
  },
) {
  const sourceSummary = useCurrentSourceRuntime().summary;
  const backgroundEffectsPaused = options?.backgroundEffectsPaused === true;
  useEffect(() => {
    markReloadPerfPhase("session_background_effects_changed", {
      mounted: true,
      sessionId,
      paused: backgroundEffectsPaused,
    });
    return () => {
      markReloadPerfPhase("session_background_effects_changed", {
        mounted: false,
        sessionId,
        paused: backgroundEffectsPaused,
      });
    };
  }, [backgroundEffectsPaused, sessionId]);
  // Runtime metadata is a recovery snapshot, while activity/stream events are
  // live observations. A snapshot may only publish lifecycle fields if no live
  // observation arrived after it started; overlapping snapshots are
  // latest-started-wins.
  const lifecycleObservationRevisionRef = useRef(0);
  const runtimeSnapshotGenerationRef = useRef(0);
  const runtimeSnapshotIdentityRef = useRef({ projectId, sessionId });
  runtimeSnapshotIdentityRef.current = { projectId, sessionId };
  const noteLifecycleObservation = useCallback(() => {
    lifecycleObservationRevisionRef.current += 1;
  }, []);
  // Use initial status if provided (from navigation state) to connect stream immediately
  const [status, setStatus] = useState<SessionStatus>(
    initialStatus ?? { owner: "none" },
  );
  // If we have initial status, assume process is in-turn (just started)
  const [processState, setProcessState] = useState<ProcessState>(
    initialStatus ? "in-turn" : "idle",
  );
  const hasOptimisticInitialStatus = initialStatus !== undefined;
  const [pendingInputRequest, setPendingInputRequest] =
    useState<InputRequest | null>(null);
  const setObservedStatus = useCallback<typeof setStatus>(
    (nextStatus) => {
      noteLifecycleObservation();
      setStatus(nextStatus);
    },
    [noteLifecycleObservation],
  );
  const setObservedProcessState = useCallback<typeof setProcessState>(
    (nextProcessState) => {
      noteLifecycleObservation();
      setProcessState(nextProcessState);
    },
    [noteLifecycleObservation],
  );
  const setObservedPendingInputRequest = useCallback<
    typeof setPendingInputRequest
  >(
    (nextPendingInputRequest) => {
      noteLifecycleObservation();
      setPendingInputRequest(nextPendingInputRequest);
    },
    [noteLifecycleObservation],
  );
  const [error, setError] = useState<Error | null>(null);
  const reconciledTranscriptRef = useRef<{
    sessionId: string;
    updatedAt: string | undefined;
  }>({ sessionId, updatedAt: undefined });
  if (reconciledTranscriptRef.current.sessionId !== sessionId) {
    reconciledTranscriptRef.current = { sessionId, updatedAt: undefined };
  }
  const handleTranscriptReconciled = useCallback(
    (updatedAt: string) => {
      if (reconciledTranscriptRef.current.sessionId === sessionId) {
        reconciledTranscriptRef.current.updatedAt = updatedAt;
      }
    },
    [sessionId],
  );

  const reportProviderRuntimeStatus = useCallback(
    (
      targetSessionId: string,
      providerRuntimeStatus: ProviderRuntimeStatus | undefined,
    ) => {
      sourceSummary.reportProviderRuntimeStatusSnapshot({
        sessionId: targetSessionId,
        projectId,
        providerRuntimeStatus: providerRuntimeStatus ?? null,
      });
    },
    [projectId, sourceSummary],
  );

  // Actual session ID from server (may differ from URL sessionId during temp→real ID transition)
  // This happens when createSession returns before the SDK sends the real session ID
  const [actualSessionId, setActualSessionId] = useState<string>(sessionId);

  // Track last stream activity timestamp for engagement tracking
  // This includes both main session and subagent messages, so we can properly
  // mark sessions as "seen" even when subagent content arrives (which doesn't
  // update the parent session file's mtime until completion)
  const [lastStreamActivityAt, setLastStreamActivityAt] = useState<
    string | null
  >(null);
  const streamActivityRef = useRef<{
    lastUpdateMs: number;
    pendingIso: string | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({
    lastUpdateMs: Number.NEGATIVE_INFINITY,
    pendingIso: null,
    timer: null,
  });
  const streamProgressLivenessRef = useRef<{
    lastUpdateMs: number;
    pendingObservedAtMs: number | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({
    lastUpdateMs: Number.NEGATIVE_INFINITY,
    pendingObservedAtMs: null,
    timer: null,
  });

  const noteStreamActivity = useCallback((immediate = false) => {
    const nowMs = Date.now();
    const iso = new Date(nowMs).toISOString();
    const ref = streamActivityRef.current;
    const elapsedMs = nowMs - ref.lastUpdateMs;

    if (immediate || elapsedMs >= STREAM_ACTIVITY_TOKEN_UPDATE_MS) {
      if (ref.timer) {
        clearTimeout(ref.timer);
        ref.timer = null;
      }
      ref.pendingIso = null;
      ref.lastUpdateMs = nowMs;
      setLastStreamActivityAt(iso);
      return;
    }

    ref.pendingIso = iso;
    if (!ref.timer) {
      ref.timer = setTimeout(() => {
        const pendingIso = ref.pendingIso;
        ref.pendingIso = null;
        ref.timer = null;
        ref.lastUpdateMs = Date.now();
        if (pendingIso) {
          setLastStreamActivityAt(pendingIso);
        }
      }, STREAM_ACTIVITY_TOKEN_UPDATE_MS - elapsedMs);
    }
  }, []);

  const buildStreamProgressLiveness = useCallback(
    (nowMs: number, previous: SessionLivenessSnapshot | null) => {
      const now = new Date(nowMs).toISOString();
      const previousEvidence = previous?.evidence ?? [];
      const evidence = Array.from(
        new Set([...previousEvidence, "stream_event"]),
      );

      return {
        checkedAt: now,
        derivedStatus: "verified-progressing" as const,
        activeWorkKind: previous?.activeWorkKind ?? "agent-turn",
        state: previous?.state ?? "in-turn",
        evidence,
        lastProviderMessageAt: previous?.lastProviderMessageAt ?? null,
        lastRawProviderEventAt: now,
        lastRawProviderEventSource: "stream_event",
        lastStateChangeAt: previous?.lastStateChangeAt ?? now,
        lastVerifiedProgressAt: now,
        lastVerifiedIdleAt: previous?.lastVerifiedIdleAt ?? null,
        lastLivenessProbeAt: previous?.lastLivenessProbeAt ?? null,
        lastLivenessProbeStatus: previous?.lastLivenessProbeStatus ?? null,
        lastLivenessProbeSource: previous?.lastLivenessProbeSource ?? null,
        ...(previous?.lastLivenessProbeDetail
          ? { lastLivenessProbeDetail: previous.lastLivenessProbeDetail }
          : {}),
        silenceMs: 0,
        longSilenceThresholdMs:
          previous?.longSilenceThresholdMs ??
          FALLBACK_STREAM_LONG_SILENCE_THRESHOLD_MS,
        processAlive: previous?.processAlive ?? true,
        queueDepth: previous?.queueDepth ?? 0,
        deferredQueueDepth: previous?.deferredQueueDepth ?? 0,
      };
    },
    [],
  );

  const publishStreamProgressLiveness = useCallback(
    (observedAtMs: number) => {
      const ref = streamProgressLivenessRef.current;
      ref.lastUpdateMs = Date.now();
      setSessionLiveness((previous) => {
        const previousProgressMs = Date.parse(
          previous?.lastVerifiedProgressAt ?? previous?.checkedAt ?? "",
        );
        if (
          previous?.derivedStatus === "verified-progressing" &&
          Number.isFinite(previousProgressMs) &&
          previousProgressMs >= observedAtMs
        ) {
          return previous;
        }
        return buildStreamProgressLiveness(observedAtMs, previous);
      });
    },
    [buildStreamProgressLiveness],
  );

  const noteStreamProgressLiveness = useCallback(() => {
    noteLifecycleObservation();
    const observedAtMs = Date.now();
    const ref = streamProgressLivenessRef.current;
    const elapsedMs = observedAtMs - ref.lastUpdateMs;
    if (elapsedMs < 0 || elapsedMs >= STREAM_LIVENESS_UPDATE_MS) {
      if (ref.timer) {
        clearTimeout(ref.timer);
        ref.timer = null;
      }
      ref.pendingObservedAtMs = null;
      publishStreamProgressLiveness(observedAtMs);
      return;
    }

    // Gate before enqueueing React state, but retain one trailing observation.
    // A provider burst gets one timer, and silence cannot strand its final state.
    ref.pendingObservedAtMs = observedAtMs;
    if (!ref.timer) {
      ref.timer = setTimeout(() => {
        const pendingObservedAtMs = ref.pendingObservedAtMs;
        ref.pendingObservedAtMs = null;
        ref.timer = null;
        if (pendingObservedAtMs !== null) {
          publishStreamProgressLiveness(pendingObservedAtMs);
        }
      }, STREAM_LIVENESS_UPDATE_MS - elapsedMs);
    }
  }, [noteLifecycleObservation, publishStreamProgressLiveness]);

  useEffect(() => {
    return () => {
      const activityTimer = streamActivityRef.current.timer;
      if (activityTimer) {
        clearTimeout(activityTimer);
      }
      const livenessTimer = streamProgressLivenessRef.current.timer;
      if (livenessTimer) {
        clearTimeout(livenessTimer);
      }
    };
  }, []);

  // Pending messages queue - messages waiting for server confirmation
  // These are displayed separately from the main message list
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);

  // Deferred messages queue — a mirror of the server's queue summary. Server
  // snapshots replace it wholesale; delivered user echoes may remove rows by
  // tempId so a missed queue event cannot leave accepted messages visible.
  const [deferredMessages, setDeferredMessagesState] = useState<
    DeferredMessage[]
  >([]);
  const deliveredDeferredTempIdsRef = useRef<Set<string>>(new Set());
  const setDeferredMessages = useCallback((messages: DeferredMessage[]) => {
    const deliveredTempIds = deliveredDeferredTempIdsRef.current;
    setDeferredMessagesState(
      deliveredTempIds.size === 0
        ? messages
        : messages.filter(
            (message) =>
              !message.tempId || !deliveredTempIds.has(message.tempId),
          ),
    );
  }, []);

  // Reset when switching sessions; the server's connected event repopulates it.
  useEffect(() => {
    void sessionId;
    deliveredDeferredTempIdsRef.current.clear();
    setDeferredMessagesState([]);
  }, [sessionId]);

  // Compacting state - true when context is being compressed. The setter below
  // records a transcript baseline so JSONL catch-up can clear only compactions
  // that completed after the current local compacting attempt began.
  const [isCompacting, setIsCompactingState] = useState(false);
  const [sessionLiveness, setSessionLiveness] =
    useState<SessionLivenessSnapshot | null>(null);

  // Permission mode state: localMode is UI-selected, serverMode is confirmed by server.
  // A live process's mode (from initialStatus) stays authoritative; only when there
  // is no live-process mode do we restore the user's last choice from storage instead
  // of dropping to "default".
  const initialPermissionMode =
    initialStatus?.permissionMode ??
    sessionPermissionModePick.load(sessionId) ??
    "default";
  const initialModeVersion = initialStatus?.modeVersion ?? 0;
  const [localMode, setLocalMode] = useState<PermissionMode>(
    initialPermissionMode,
  );
  const [, setServerMode] = useState<PermissionMode>(initialPermissionMode);
  const [modeVersion, setModeVersion] = useState<number>(initialModeVersion);
  const localModeRef = useRef<PermissionMode>(localMode);
  // In-place session switches reuse this hook instance (page reloads remount it and
  // use the initializer above). Restore the switched-to session's stored mode, but
  // skip the initial mount so a live process's authoritative mode is not clobbered.
  const restoredModeSessionRef = useRef(sessionId);
  useEffect(() => {
    if (restoredModeSessionRef.current === sessionId) {
      return;
    }
    restoredModeSessionRef.current = sessionId;
    setLocalMode(sessionPermissionModePick.load(sessionId) ?? "default");
  }, [sessionId]);
  // Track whether we've already processed a stream "connected" event in this mount.
  // For Codex providers, the first connected-event catch-up fetch can duplicate
  // freshly streamed messages because JSONL and stream IDs are not yet aligned.
  const hasHandledConnectedEventRef = useRef(false);
  const recapAwayThresholdMs =
    normalizeRecapAfterSeconds(
      status.owner === "self"
        ? status.recapAfterSeconds
        : DEFAULT_RECAP_AFTER_SECONDS,
    ) * 1000;
  const recapAwayThresholdMsRef = useRef(recapAwayThresholdMs);
  recapAwayThresholdMsRef.current = recapAwayThresholdMs;
  // Last-known recap mode + liveness, kept in refs so the away trigger (fired
  // on hide/leave) can suppress the POST when recaps are off, and so the mode
  // learned while the process was live survives the owner->none flip when it
  // dies (e.g. a server restart).
  const liveRecapMode = status.owner === "self" ? status.recapMode : undefined;
  const recapModeRef = useRef<RecapMode | undefined>(liveRecapMode);
  if (liveRecapMode) {
    recapModeRef.current = liveRecapMode;
  }
  const sessionIsLiveRef = useRef(status.owner === "self");
  sessionIsLiveRef.current = status.owner === "self";

  // Reset connected-event tracking when switching sessions.
  useEffect(() => {
    void sessionId;
    hasHandledConnectedEventRef.current = false;
    runtimeSnapshotGenerationRef.current += 1;
    noteLifecycleObservation();
    setSessionLiveness(null);
  }, [noteLifecycleObservation, sessionId]);

  // Tab visibility is one "away" signal: hiding schedules the background recap;
  // returning (visible) cancels it if it has not fired yet.
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        // Arm only when a recap mode that can act is enabled (a cold fork-mode
        // session is revived + recapped server-side on fire); skip otherwise so
        // we do not POST for sessions with recaps off.
        if (awayRecapEnabled(recapModeRef.current, sessionIsLiveRef.current)) {
          scheduleAwayRecap(
            projectId,
            sessionId,
            recapAwayThresholdMsRef.current,
          );
        }
        return;
      }
      if (document.visibilityState === "visible") {
        cancelAwayRecap(sessionId);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [sessionId, projectId]);

  // Navigating away from this session's view is the equivalent away signal:
  // being present (mounted with the tab visible) cancels any pending recap;
  // leaving (unmount or in-place session switch) schedules it. The cleanup
  // closure carries this render's projectId and sessionId, so an in-place
  // A->B switch schedules A against A's own session.
  useEffect(() => {
    if (
      typeof document === "undefined" ||
      document.visibilityState === "visible"
    ) {
      cancelAwayRecap(sessionId);
    }
    return () => {
      if (awayRecapEnabled(recapModeRef.current, sessionIsLiveRef.current)) {
        scheduleAwayRecap(
          projectId,
          sessionId,
          recapAwayThresholdMsRef.current,
        );
      }
    };
  }, [sessionId, projectId]);

  // Slash commands available for this session (from init message)
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  // Tools available for this session (from init message)
  const [sessionTools, setSessionTools] = useState<string[]>([]);
  // MCP servers available for this session (from init message)
  const [mcpServers, setMcpServers] = useState<string[]>([]);
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null);
  const lastKnownModeVersionRef = useRef<number>(initialModeVersion);

  useEffect(() => {
    localModeRef.current = localMode;
  }, [localMode]);

  // Apply server mode update only if version is >= our last known version
  // This syncs local mode only when the server update is authoritative.
  const applyServerModeUpdate = useCallback(
    (mode: PermissionMode, version: number) => {
      if (version >= lastKnownModeVersionRef.current) {
        lastKnownModeVersionRef.current = version;
        setServerMode(mode);
        setModeVersion(version);
        localModeRef.current = mode;
        setLocalMode(mode);
        sessionPermissionModePick.save(sessionId, mode);
      }
    },
    [sessionId],
  );

  const beginRuntimeSnapshot = useCallback((): RuntimeSnapshotToken => {
    runtimeSnapshotGenerationRef.current += 1;
    return {
      projectId,
      sessionId,
      generation: runtimeSnapshotGenerationRef.current,
      lifecycleObservationRevision: lifecycleObservationRevisionRef.current,
    };
  }, [projectId, sessionId]);

  const isRuntimeSnapshotCurrent = useCallback(
    (token: RuntimeSnapshotToken): boolean =>
      token.projectId === runtimeSnapshotIdentityRef.current.projectId &&
      token.sessionId === runtimeSnapshotIdentityRef.current.sessionId &&
      token.generation === runtimeSnapshotGenerationRef.current &&
      token.lifecycleObservationRevision ===
        lifecycleObservationRevisionRef.current,
    [],
  );

  const reconcileSessionRuntime = useCallback(
    async (options?: { ignoreIfLiveSnapshotHandled?: boolean }) => {
      const snapshotToken = beginRuntimeSnapshot();
      const data = await api.getSessionMetadata(projectId, sessionId);
      if (
        options?.ignoreIfLiveSnapshotHandled &&
        hasHandledConnectedEventRef.current
      ) {
        return;
      }
      if (!isRuntimeSnapshotCurrent(snapshotToken)) {
        return;
      }
      reportProviderRuntimeStatus(sessionId, data.providerRuntimeStatus);
      setDeferredMessages(data.deferredMessages ?? []);
      const metadataProcessState = parseProcessState(data.processState);
      setStatus(data.ownership);
      if (metadataProcessState) {
        setProcessState(metadataProcessState);
      }
      if (data.ownership.owner === "none") {
        setProcessState("idle");
        setPendingInputRequest(null);
      } else if (
        metadataProcessState === "waiting-input" &&
        data.pendingInputRequest
      ) {
        setPendingInputRequest(data.pendingInputRequest);
      } else if (
        metadataProcessState &&
        metadataProcessState !== "waiting-input"
      ) {
        setPendingInputRequest(null);
      }
    },
    [
      beginRuntimeSnapshot,
      isRuntimeSnapshotCurrent,
      projectId,
      reportProviderRuntimeStatus,
      sessionId,
      setDeferredMessages,
    ],
  );

  // Handle initial load completion from useSessionMessages
  const handleLoadComplete = useCallback(
    (result: SessionLoadResult) => {
      // Only update status from REST if we don't already have an owned status from navigation.
      // This prevents a race condition where:
      // 1. Session created with initialStatus = {owner: "self"}
      // 2. stream connects because status.owner === "self"
      // 3. REST API returns status = {owner: "none"} (stale)
      // 4. setStatus({owner: "none"}) disconnects stream before it receives events
      // The owned status from initialStatus should only be changed by stream events.
      setStatus((prev) => {
        // If we already have owned status (from initialStatus), keep it unless REST also says owned
        if (prev.owner === "self" && result.status.owner !== "self") {
          return prev;
        }
        return result.status;
      });

      // Sync permission mode from server if owned
      if (
        result.status.owner === "self" &&
        result.status.permissionMode &&
        result.status.modeVersion !== undefined
      ) {
        applyServerModeUpdate(
          result.status.permissionMode,
          result.status.modeVersion,
        );
      }
      // Set pending input request from API response immediately
      // This fixes race condition where stream connection is delayed but tool approval is pending
      if (result.pendingInputRequest) {
        setPendingInputRequest(result.pendingInputRequest as InputRequest);
      }
      // Set slash commands from API response so the "/" button appears reliably.
      // The SSE init message that normally carries these is discarded after
      // ~30s; stopped providers with static commands also rely on this payload.
      setSlashCommands(result.slashCommands ?? []);
      setDeferredMessages(result.deferredMessages ?? []);

      // Navigation status is an optimistic seed for a newly started session.
      // Browser history can later replay that same seed after the process has
      // become idle, while the full session-detail response carries ownership
      // but not process state. Reconcile through the lightweight runtime
      // snapshot so a missed stream/activity event cannot leave false activity.
      if (hasOptimisticInitialStatus && !hasHandledConnectedEventRef.current) {
        void reconcileSessionRuntime({
          ignoreIfLiveSnapshotHandled: true,
        }).catch(() => {});
      }

      // Focusing a non-running session: its list/hover preview gets no live
      // session-updated events, so recompute it once (the server pushes the
      // result). Owned/external sessions are tracked live. See
      // topics/session-hovercard-recent-activity.md.
      if (result.status.owner === "none") {
        void api.refreshSessionPreview(projectId, sessionId).catch(() => {});
      }
    },
    [
      applyServerModeUpdate,
      hasOptimisticInitialStatus,
      projectId,
      reconcileSessionRuntime,
      sessionId,
      setDeferredMessages,
    ],
  );

  // Handle initial load error
  const handleLoadError = useCallback((err: Error) => {
    setError(err);
  }, []);

  // Use the session messages hook for message state and stream buffering
  const {
    messages,
    agentContent,
    toolUseToAgent,
    markdownAugments,
    applyFinalMarkdownAugment,
    loading,
    sessionLoadProgress,
    session,
    updateSession,
    handleStreamingUpdate,
    handleStreamMessageEvent,
    flushPendingStreamMessage,
    handleStreamSubagentMessage,
    registerToolUseAgent,
    mergeLoadedAgentContent,
    updateAgentContextUsage,
    clearAgentStreamingPlaceholders,
    clearStreamingPlaceholders,
    removeUnconfirmedSelfSend,
    fetchNewMessages,
    pagination,
    activeWindowTrimRevision,
    loadingOlder,
    olderLoadContinuationRequired,
    loadOlderMessages,
    readOlderSearchPage,
    initialScrollSnapshot,
    updateRouteScrollSnapshot,
    updateActiveWindowFollowingBottom,
    restoredFromSnapshot,
  } = useSessionMessages({
    projectId,
    sessionId,
    tailTurns: options?.tailTurns,
    tailFrom: options?.tailFrom,
    detailedLoadingProgress: options?.detailedLoadingProgress,
    codexStreamDurableIdAlignment: options?.codexStreamDurableIdAlignment,
    onLoadComplete: handleLoadComplete,
    onTranscriptReconciled: handleTranscriptReconciled,
    onLoadError: handleLoadError,
  });

  const messagesRef = useRef<Message[]>(messages);
  const messagesLoadingRef = useRef(loading);
  const compactBoundaryBaselineRef = useRef<CompactBoundarySnapshot | null>(
    null,
  );
  const canReconcileCompactingFromMessagesRef = useRef(false);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    messagesLoadingRef.current = loading;
  }, [loading]);

  const setIsCompacting = useCallback(
    (value: boolean | ((previous: boolean) => boolean)) => {
      setIsCompactingState((previous) => {
        const next = typeof value === "function" ? value(previous) : value;

        if (next && !previous) {
          compactBoundaryBaselineRef.current = getCompactBoundarySnapshot(
            messagesRef.current,
          );
          canReconcileCompactingFromMessagesRef.current =
            !messagesLoadingRef.current;
        } else if (!next) {
          compactBoundaryBaselineRef.current = null;
          canReconcileCompactingFromMessagesRef.current = false;
        }

        return next;
      });
    },
    [],
  );

  // Centralized stale-spinner reconciliation. Live provider events still start
  // the spinner, but durable/session snapshots must be able to disprove it
  // after mobile sleep or a missed WebSocket frame.
  useEffect(() => {
    if (!isCompacting) {
      return;
    }

    if (status.owner !== "self") {
      setIsCompacting(false);
      return;
    }

    if (!canReconcileCompactingFromMessagesRef.current) {
      return;
    }

    const currentSnapshot = getCompactBoundarySnapshot(messages);
    if (
      compactBoundaryAdvancedSince(
        currentSnapshot,
        compactBoundaryBaselineRef.current,
      )
    ) {
      setIsCompacting(false);
    }
  }, [isCompacting, messages, setIsCompacting, status.owner]);

  useEffect(() => {
    void sessionId;
    setIsCompacting(false);
  }, [sessionId, setIsCompacting]);

  const nextClientOrderRef = useRef(0);

  useEffect(() => {
    void sessionId;
    nextClientOrderRef.current = 0;
  }, [sessionId]);

  // Optimistic pending sends (the normal-send flow) reconcile against the
  // transcript by content. Deferred rows reconcile only by explicit tempId in
  // the live echo; queue snapshots remain authoritative for every other change.
  useEffect(() => {
    setPendingMessages((prev) =>
      removeDeliveredPendingMessages(prev, messages),
    );
  }, [messages]);

  // Tracks whether any self-sent turn is still awaiting its durable
  // transcript copy (delivery-state "sent"); read by handleFileChange via ref
  // so the handler identity stays stable. pendingCountRef is the prior
  // stage: Sending chips that have not received a live echo yet.
  const hasUnconfirmedSendsRef = useRef(false);
  const pendingCountRef = useRef(0);
  useEffect(() => {
    hasUnconfirmedSendsRef.current = hasUnconfirmedSelfSends(messages);
  }, [messages]);
  useEffect(() => {
    pendingCountRef.current = pendingMessages.length;
  }, [pendingMessages]);

  // Update local mode (UI selection) and sync to server if process is active
  const setPermissionMode = useCallback(
    async (mode: PermissionMode) => {
      localModeRef.current = mode;
      setLocalMode(mode);
      sessionPermissionModePick.save(sessionId, mode);

      // If there's an active process, immediately sync to server
      if (status.owner === "self" || status.owner === "external") {
        try {
          const result = await api.setPermissionMode(sessionId, mode);
          // Update server-confirmed mode
          if (result.modeVersion >= lastKnownModeVersionRef.current) {
            lastKnownModeVersionRef.current = result.modeVersion;
            setServerMode(result.permissionMode);
            setModeVersion(result.modeVersion);
          }
          if (result.appliedPermissionMode) {
            setStatus((prev) =>
              prev.owner === "self"
                ? {
                    ...prev,
                    appliedPermissionMode: result.appliedPermissionMode,
                  }
                : prev,
            );
          }
        } catch (err) {
          // If API fails (e.g., no active process), mode will be sent on next message
          console.warn("Failed to sync permission mode:", err);
        }
      }
    },
    [sessionId, status.owner],
  );

  // Throttle state for incremental fetching
  const throttleRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    pending: boolean;
    pendingTrigger?: IncrementalFetchTrigger;
  }>({ timer: null, pending: false });
  const recentSessionFileFactsRef = useRef(
    new Map<string, { recordedAtMs: number; route: SessionFileChangeRoute }>(),
  );

  const recordSessionFileChangeFact = useCallback(
    (event: SessionFileChangeFact, route: SessionFileChangeRoute): boolean => {
      const key = getSessionFileChangeFactKey(event);
      if (!key) return false;

      const observedAtMs = Date.now();
      const recentFacts = recentSessionFileFactsRef.current;
      for (const [candidate, fact] of recentFacts) {
        if (observedAtMs - fact.recordedAtMs > FILE_CHANGE_FACT_DEDUPE_MS) {
          recentFacts.delete(candidate);
        }
      }
      const previousFact = recentFacts.get(key);
      recentFacts.set(key, { recordedAtMs: observedAtMs, route });
      return (
        previousFact !== undefined &&
        previousFact.route !== route &&
        observedAtMs - previousFact.recordedAtMs <= FILE_CHANGE_FACT_DEDUPE_MS
      );
    },
    [],
  );

  // Add a message to the pending queue
  // Generates a tempId that will be sent to the server and echoed back in stream
  const addPendingMessage = useCallback(
    (
      content: string,
      attachments?: UploadedFile[],
      timestamp = new Date().toISOString(),
    ): { tempId: string; clientOrder: number } => {
      const clientOrder = nextClientOrderRef.current++;
      const tempId = `temp-${Date.now()}-${clientOrder}`;
      logSessionUiTrace("pending-add", {
        sessionId,
        tempId,
        clientOrder,
        textLength: content.length,
      });
      setPendingMessages((prev) => [
        ...prev,
        {
          tempId,
          content,
          timestamp,
          clientOrder,
          ...(attachments?.length ? { attachments } : {}),
        },
      ]);
      return { tempId, clientOrder };
    },
    [sessionId],
  );

  // Remove a pending message by tempId (used when server confirms or send fails)
  const removePendingMessage = useCallback(
    (tempId: string) => {
      logSessionUiTrace("pending-remove", { sessionId, tempId });
      setPendingMessages((prev) => prev.filter((p) => p.tempId !== tempId));
    },
    [sessionId],
  );

  // Update a pending message's fields (e.g. status text)
  const updatePendingMessage = useCallback(
    (tempId: string, updates: Partial<PendingMessage>) => {
      logSessionUiTrace("pending-update", {
        sessionId,
        tempId,
        hasStatus: updates.status !== undefined,
      });
      setPendingMessages((prev) =>
        prev.map((p) => (p.tempId === tempId ? { ...p, ...updates } : p)),
      );
    },
    [sessionId],
  );

  // Track if we've loaded pending agents for this session
  const pendingAgentsLoadedRef = useRef<string | null>(null);

  const loadPendingAgents = useCallback(async () => {
    // Find pending Tasks (tool_use without matching tool_result)
    const pendingTasks = findPendingTasks(messages);
    if (pendingTasks.length === 0) return;

    try {
      // Get agent mappings (toolUseId → agentId)
      const { mappings } = await api.getAgentMappings(projectId, sessionId);
      const mappingsMap = new Map(
        mappings.map((m) => [m.toolUseId, m.agentId]),
      );

      // Register loaded mappings so TaskRenderer can access agent content
      // after page reload through the same reducer/store path as streaming.
      for (const [toolUseId, agentId] of mappingsMap) {
        registerToolUseAgent(toolUseId, agentId);
      }

      // Load content for each pending task that has an agent file
      for (const task of pendingTasks) {
        const agentId = mappingsMap.get(task.toolUseId);
        if (!agentId) continue;

        try {
          const agentData = await api.getAgentSession(
            projectId,
            sessionId,
            agentId,
          );

          mergeLoadedAgentContent(agentId, agentData);
        } catch {
          // Skip agents that can't be loaded
        }
      }
    } catch {
      // Silent fail for agent mappings - not critical
    }
  }, [
    mergeLoadedAgentContent,
    messages,
    projectId,
    registerToolUseAgent,
    sessionId,
  ]);

  // Load pending agent content on session load. This handles page reload while
  // Tasks are running by loading child content-so-far.
  useEffect(() => {
    // Only run once per session after initial load
    if (
      options?.backgroundEffectsPaused ||
      loading ||
      pendingAgentsLoadedRef.current === sessionId
    ) {
      return;
    }
    if (messages.length === 0) return;

    pendingAgentsLoadedRef.current = sessionId;
    void loadPendingAgents();
  }, [
    loading,
    loadPendingAgents,
    messages,
    options?.backgroundEffectsPaused,
    sessionId,
  ]);

  // Leading + trailing edge throttle:
  // - Leading: fires immediately on first call
  // - Trailing: fires again after timeout if events came during window
  // This ensures no updates are lost
  const throttledFetch = useCallback(
    (trigger?: IncrementalFetchTrigger) => {
      const ref = throttleRef.current;

      if (!ref.timer) {
        // No active throttle - fire immediately (LEADING EDGE)
        markReloadPerfPhase("session_incremental_fetch_requested", trigger);
        void fetchNewMessages(trigger);
        ref.timer = setTimeout(() => {
          ref.timer = null;
          if (ref.pending) {
            const pendingTrigger = ref.pendingTrigger;
            ref.pending = false;
            ref.pendingTrigger = undefined;
            throttledFetch(pendingTrigger); // Fire again (TRAILING EDGE)
          }
        }, THROTTLE_MS);
      } else {
        // Throttled - mark as pending for trailing edge
        ref.pending = true;
        ref.pendingTrigger = trigger;
      }
    },
    [fetchNewMessages],
  );

  // Live user-echo is the fast ack. If that notice is dropped while the
  // tab stays connected, fetch durable history until the chip can match.
  useEffect(() => {
    if (pendingMessages.length === 0) {
      return;
    }
    const timer = window.setInterval(() => {
      throttledFetch({ route: "pending-send-reconcile" });
    }, PENDING_SEND_RECONCILE_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [pendingMessages.length, throttledFetch]);

  // Handle file changes - for non-owned sessions only
  // For owned sessions, stream provides real-time messages and session-updated events
  // provide metadata (title, messageCount), so we don't need to poll the API
  const handleFileChange = useCallback(
    (event: FileChangeEvent) => {
      // Only care about session files
      if (event.fileType !== "session" && event.fileType !== "agent-session") {
        return;
      }

      if (event.fileType === "agent-session") {
        const parentSessionId = extractParentSessionIdFromAgentFileEvent(event);
        if (parentSessionId !== sessionId) return;

        // The JSONL can be created just before its metadata sidecar. Refresh on
        // either create so the exact tool-call → child mapping becomes visible.
        if (event.changeType === "create") {
          void loadPendingAgents();
        }
        return;
      }

      // Check if file matches current session (exact match to avoid false positives)
      // File format is: projects/<projectId>/<sessionId>.jsonl
      const fileSessionId = extractSessionIdFromFileEvent(event);
      if (fileSessionId !== sessionId) {
        return;
      }

      // For owned sessions: messages come via the stream, metadata via the
      // session-updated event — skip file-change processing, EXCEPT while a
      // self-send is still awaiting its live echo (Sending chip) or its
      // durable copy. Then the durable rows are what confirms the send, so
      // fetch them mid-turn. Self-limiting: once nothing is pending or
      // unconfirmed, owned sessions go back to skipping.
      if (
        status.owner === "self" &&
        !ownedSessionShouldFetchDurableTranscript({
          hasUnconfirmedSelfSends: hasUnconfirmedSendsRef.current,
          pendingSendCount: pendingCountRef.current,
        })
      ) {
        return;
      }

      const perfDetail = buildSessionFileChangePerfDetail(
        "broad-file-watch",
        event,
      );
      const deduped = recordSessionFileChangeFact(event, "broad-file-watch");
      markReloadPerfPhase("session_file_change_received", {
        ...perfDetail,
        deduped,
      });
      if (deduped) return;

      // For external/idle sessions: fetch both messages and metadata via API
      throttledFetch(perfDetail);
    },
    [
      loadPendingAgents,
      recordSessionFileChangeFact,
      sessionId,
      status.owner,
      throttledFetch,
    ],
  );

  // Handle session content updates via stream (title, messageCount, updatedAt, contextUsage)
  const handleSessionUpdated = useCallback(
    (event: SessionUpdatedEvent) => {
      if (event.sessionId !== sessionId) return;

      // Update session metadata from stream event (no API call needed)
      updateSession((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          ...(event.title !== undefined && { title: event.title }),
          ...(event.messageCount !== undefined && {
            messageCount: event.messageCount,
          }),
          ...(event.updatedAt !== undefined && {
            updatedAt: event.updatedAt,
          }),
          ...(event.contextUsage !== undefined && {
            contextUsage: event.contextUsage,
          }),
          ...(event.model !== undefined && { model: event.model }),
        };
      });
    },
    [sessionId, updateSession],
  );

  const handleSessionMetadataChange = useCallback(
    (event: SessionMetadataChangedEvent) => {
      if (event.sessionId !== sessionId) return;

      updateSession((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          ...(event.title !== undefined && { customTitle: event.title }),
          ...(event.archived !== undefined && { isArchived: event.archived }),
          ...(event.starred !== undefined && { isStarred: event.starred }),
          ...(event.parentSessionId !== undefined && {
            parentSessionId: event.parentSessionId ?? undefined,
          }),
          ...(event.parentSessionKind !== undefined && {
            parentSessionKind: event.parentSessionKind ?? undefined,
          }),
          ...(event.forkedFromSessionId !== undefined && {
            forkedFromSessionId: event.forkedFromSessionId ?? undefined,
          }),
          ...(event.heartbeatTurnsEnabled !== undefined && {
            heartbeatTurnsEnabled: event.heartbeatTurnsEnabled,
          }),
          ...(event.heartbeatTurnsAfterMinutes !== undefined && {
            heartbeatTurnsAfterMinutes:
              event.heartbeatTurnsAfterMinutes ?? undefined,
          }),
          ...(event.heartbeatTurnText !== undefined && {
            heartbeatTurnText: event.heartbeatTurnText ?? undefined,
          }),
          ...(event.heartbeatForceAfterMinutes !== undefined && {
            heartbeatForceAfterMinutes:
              event.heartbeatForceAfterMinutes ?? undefined,
          }),
          ...(event.promptSuggestionMode !== undefined && {
            promptSuggestionMode: event.promptSuggestionMode,
          }),
          ...(event.recapAfterSeconds !== undefined && {
            recapAfterSeconds: event.recapAfterSeconds,
          }),
          ...(event.transcriptDisplayObjects !== undefined && {
            transcriptDisplayObjects: event.transcriptDisplayObjects,
          }),
          ...(event.projectId !== undefined && {
            projectId: event.projectId,
            workingProjectId:
              event.transcriptProjectId === null ? undefined : event.projectId,
          }),
          ...(event.transcriptProjectId !== undefined && {
            transcriptProjectId: event.transcriptProjectId ?? undefined,
          }),
        };
      });
      if (event.recapAfterSeconds !== undefined) {
        setStatus((prev) =>
          prev.owner === "self"
            ? {
                ...prev,
                recapAfterSeconds: normalizeRecapAfterSeconds(
                  event.recapAfterSeconds,
                ),
              }
            : prev,
        );
      }
    },
    [sessionId, updateSession],
  );

  // Listen for session status changes via stream
  const handleSessionStatusChange = useCallback(
    (event: SessionStatusEvent) => {
      if (event.sessionId !== sessionId) return;
      noteLifecycleObservation();

      const ownershipDropped =
        status.owner !== "none" && event.ownership.owner === "none";

      logSessionUiTrace("activity-session-status", {
        sessionId,
        previousOwner: status.owner,
        nextOwner: event.ownership.owner,
        processId:
          event.ownership.owner === "self" ? event.ownership.processId : null,
        permissionMode:
          event.ownership.owner === "self"
            ? event.ownership.permissionMode
            : null,
      });
      setStatus(event.ownership);

      if (ownershipDropped) {
        setProcessState("idle");
        setPendingInputRequest(null);
        throttledFetch();
      }
    },
    [noteLifecycleObservation, sessionId, status.owner, throttledFetch],
  );

  // Listen for process state changes via activity bus as a backup for session stream
  // This handles the race condition where the session stream might miss a status event
  // (e.g., when backgrounding the tab quickly after starting a session)
  const handleProcessStateChange = useCallback(
    async (event: ProcessStateEvent) => {
      if (event.sessionId !== sessionId) return;

      // Update process state from activity bus
      if (
        event.activity === "idle" ||
        event.activity === "in-turn" ||
        event.activity === "waiting-input"
      ) {
        noteLifecycleObservation();
        logSessionUiTrace("activity-process-state", {
          sessionId,
          activity: event.activity,
          pendingInputType: event.pendingInputType ?? null,
        });
        setProcessState(event.activity);

        // Activity and session content travel over separate subscriptions. An
        // idle event therefore cannot prove that the client received the final
        // assistant message. Reconcile against the durable transcript at this
        // boundary, with a trailing pass for providers that finish persistence
        // just after reporting idle.
        if (event.activity === "idle") {
          setPendingInputRequest(null);
          throttledFetch();
          throttledFetch();
        }
      }

      // If activity bus says waiting-input but we don't have the request,
      // fetch it via REST as a backup
      if (
        event.activity === "waiting-input" &&
        event.pendingInputType &&
        !pendingInputRequest
      ) {
        const snapshotToken = beginRuntimeSnapshot();
        void api.getSessionMetadata(projectId, sessionId).then((result) => {
          if (!isRuntimeSnapshotCurrent(snapshotToken)) {
            return;
          }
          reportProviderRuntimeStatus(sessionId, result.providerRuntimeStatus);
          setDeferredMessages(result.deferredMessages ?? []);
          if (result.pendingInputRequest) {
            setPendingInputRequest(result.pendingInputRequest);
          }
        });
      }
    },
    [
      beginRuntimeSnapshot,
      isRuntimeSnapshotCurrent,
      pendingInputRequest,
      projectId,
      reportProviderRuntimeStatus,
      noteLifecycleObservation,
      sessionId,
      setDeferredMessages,
      throttledFetch,
    ],
  );

  // Handle activity bus reconnection (e.g., after phone screen wake).
  // Catches up on messages and ownership changes that occurred while disconnected.
  // Without this, a session that completed while the screen was off would show stale
  // data because the session stream unsubscribes when ownership becomes "none" and
  // nobody triggers fetchNewMessages().
  const handleActivityReconnect = useCallback(async () => {
    fetchNewMessages();
    try {
      await reconcileSessionRuntime();
    } catch {
      // Silent fail - non-critical
    }
  }, [fetchNewMessages, reconcileSessionRuntime]);

  useFileActivity({
    enabled: !backgroundEffectsPaused,
    onSessionStatusChange: handleSessionStatusChange,
    onFileChange: handleFileChange,
    onSessionMetadataChange: handleSessionMetadataChange,
    onSessionUpdated: handleSessionUpdated,
    onProcessStateChange: handleProcessStateChange,
    onReconnect: handleActivityReconnect,
  });

  // Focused watch stream for non-owned sessions.
  // This is a targeted server-side watch of the currently viewed session file,
  // independent from broad global activity-tree watch behavior.
  const handleSessionWatchChange = useCallback(
    (event: SessionWatchChangeEvent) => {
      if (status.owner === "self") return;
      const perfDetail = buildSessionFileChangePerfDetail(
        "focused-session-watch",
        event,
      );
      const deduped = recordSessionFileChangeFact(
        event,
        "focused-session-watch",
      );
      markReloadPerfPhase("session_file_change_received", {
        ...perfDetail,
        deduped,
      });
      if (deduped) return;
      throttledFetch(perfDetail);
    },
    [recordSessionFileChangeFact, status.owner, throttledFetch],
  );

  const {
    connected: sessionWatchConnected,
    resubscribing: sessionWatchResubscribing,
  } = useSessionWatchStream(
    !backgroundEffectsPaused && status.owner !== "self"
      ? {
          sessionId,
          projectId,
          provider: session?.provider,
        }
      : null,
    {
      onChange: handleSessionWatchChange,
      onOpen: () => {
        if (messagesLoadingRef.current) return;
        throttledFetch({ route: "focused-session-watch-open" });
      },
      onReconnect: () => {
        if (messagesLoadingRef.current) return;
        throttledFetch({ route: "focused-session-watch-reconnect" });
      },
    },
  );

  // Cleanup throttle timers
  useEffect(() => {
    return () => {
      if (throttleRef.current.timer) {
        clearTimeout(throttleRef.current.timer);
      }
    };
  }, []);

  // Callback for agent context usage updates
  const handleAgentContextUsage = useCallback(
    (agentId: string, usage: { inputTokens: number; percentage: number }) => {
      updateAgentContextUsage(agentId, usage);
    },
    [updateAgentContextUsage],
  );

  // Use streaming content hook for handling stream_event stream messages
  const {
    handleStreamEvent,
    clearStreaming,
    cleanup: cleanupStreaming,
  } = useStreamingContent({
    onUpdateMessage: handleStreamingUpdate,
    onToolUseMapping: registerToolUseAgent,
    onAgentContextUsage: handleAgentContextUsage,
    contextWindowSize: getModelContextWindow(session?.model, session?.provider),
    streamingMarkdownCallbacks,
  });

  // Cleanup streaming timers on unmount
  useEffect(() => {
    return () => {
      cleanupStreaming();
    };
  }, [cleanupStreaming]);

  // Subscribe to live updates
  const handleStreamMessage = useCallback(
    (data: { eventType: string; [key: string]: unknown }) => {
      if (isBrowserDebugPerformanceRecording()) {
        recordBrowserDebugPerformanceMetric("session-stream.event", {
          category: data.eventType,
          chars: getKnownStreamPayloadChars(data),
        });
      }
      logSessionUiTrace("session-stream-dispatch", {
        sessionId,
        eventType: data.eventType,
        sdkType: typeof data.type === "string" ? data.type : undefined,
        subtype: typeof data.subtype === "string" ? data.subtype : undefined,
        state: typeof data.state === "string" ? data.state : undefined,
        tempId: typeof data.tempId === "string" ? data.tempId : undefined,
      });
      if (data.eventType === "message") {
        // The message event contains the SDK message directly
        // Pass through all fields without stripping
        const sdkMessage = data as Record<string, unknown> & {
          eventType: string;
        };

        // Extract id - prefer uuid, fall back to id field, then generate
        const rawUuid = sdkMessage.uuid;
        const rawId = sdkMessage.id;
        const id: string =
          (typeof rawUuid === "string" ? rawUuid : null) ??
          (typeof rawId === "string" ? rawId : null) ??
          `msg-${Date.now()}`;

        // Extract type and role
        const msgType =
          typeof sdkMessage.type === "string" ? sdkMessage.type : undefined;
        const msgRole = sdkMessage.role as Message["role"] | undefined;
        const isLiveStreamingUpdate =
          msgType === "stream_event" || sdkMessage._isStreaming === true;
        const hasUserVisibleLiveness =
          msgType === "stream_event" &&
          hasUserVisibleStreamProgress(
            (sdkMessage.event as Record<string, unknown>) ?? {},
          );

        // Track stream activity for engagement/freshness UI. Queue state,
        // status, and full user/assistant messages stay immediate; live
        // token/delta freshness is coalesced.
        noteStreamActivity(!isLiveStreamingUpdate);

        if (hasUserVisibleLiveness) {
          noteStreamProgressLiveness();
        }

        // Handle stream_event messages (partial content from streaming API)
        // Delegate to useStreamingContent hook
        if (msgType === "stream_event") {
          if (handleStreamEvent(sdkMessage)) {
            return; // Event was handled, don't process as regular message
          }
        }

        // Predicted next-user-prompt suggestion: store and don't add to message list
        if (msgType === "prompt_suggestion") {
          const suggestion = sdkMessage.suggestion;
          if (typeof suggestion === "string" && suggestion.trim()) {
            setPromptSuggestion(suggestion);
          }
          return;
        }

        // For assistant messages, clear streaming state and remove ALL streaming placeholders
        if (msgType === "assistant") {
          // Check if this is a subagent message
          // Use parentToolUseId as the routing key (it's the Task tool_use id)
          const msgAgentId = sdkMessage.isSubagent
            ? typeof sdkMessage.agentId === "string"
              ? sdkMessage.agentId
              : typeof sdkMessage.parentToolUseId === "string"
                ? sdkMessage.parentToolUseId
                : undefined
            : undefined;

          // Clear streaming state via hook
          clearStreaming();

          if (msgAgentId) {
            clearAgentStreamingPlaceholders(msgAgentId);
          } else {
            clearStreamingPlaceholders();
          }
        }

        // Build message object, preserving all SDK fields
        const incoming: Message = {
          ...(sdkMessage as Partial<Message>),
          id,
          type: msgType,
          // Ensure role is set for user/assistant types
          role:
            msgRole ??
            (msgType === "user" || msgType === "assistant"
              ? msgType
              : undefined),
        };

        // Remove eventType from the message (it's stream envelope, not message data)
        (incoming as { eventType?: string }).eventType = undefined;

        if (Array.isArray(sdkMessage.slash_command_inventory)) {
          setSlashCommands(
            sdkMessage.slash_command_inventory as SlashCommand[],
          );
        }

        // Extract slash_commands, tools, and mcp_servers from init messages
        if (msgType === "system" && sdkMessage.subtype === "init") {
          if (Array.isArray(sdkMessage.slash_commands)) {
            const legacyNames = sdkMessage.slash_commands as string[];
            setSlashCommands((current) => {
              if (current.some((command) => command.invocation)) {
                return current;
              }
              return legacyNames.map((name) => ({
                name,
                description: "",
              }));
            });
          }
          if (Array.isArray(sdkMessage.tools)) {
            setSessionTools(sdkMessage.tools as string[]);
          }
          if (Array.isArray(sdkMessage.mcp_servers)) {
            setMcpServers(sdkMessage.mcp_servers as string[]);
          }
        }

        // Handle synthetic token usage messages from provider-specific
        // notifications so context usage reflects actual provider state.
        if (msgType === "system" && sdkMessage.subtype === "token_usage") {
          const usage = getContextUsageFromTokenUsageMessage(
            sdkMessage,
            session?.model,
            session?.provider,
          );
          if (usage) {
            updateSession((prev) =>
              prev ? { ...prev, contextUsage: usage } : prev,
            );
          }
          // Token usage messages are telemetry, not transcript content.
          return;
        }

        // Handle status messages (compacting indicator)
        if (msgType === "system" && sdkMessage.subtype === "status") {
          const status = sdkMessage.status as "compacting" | null;
          setIsCompacting(status === "compacting");
          // Don't add status messages to the message list - they're transient
          return;
        }

        // Clear compacting state when compact_boundary arrives (compaction complete)
        if (msgType === "system" && sdkMessage.subtype === "compact_boundary") {
          setIsCompacting(false);
          // Let the message be added to show the completed compaction indicator
        }

        // Handle tempId for pending message resolution
        // When server echoes back tempId, remove from pending/deferred queues.
        // Deferred promotion should also be reflected by a deferred-queue event,
        // but this reconciles clients that miss that event across reconnects.
        const tempId = sdkMessage.tempId as string | undefined;
        // A delivered queued bundle echoes back every merged chunk's id; an
        // unbundled turn carries just the single tempId. Clearing by this id set
        // is what lets all chips of a time-marked merged turn resolve without
        // re-matching their original text.
        const echoedTempIds = Array.isArray(sdkMessage.tempIds)
          ? (sdkMessage.tempIds as string[]).filter(
              (id): id is string => typeof id === "string",
            )
          : tempId
            ? [tempId]
            : [];
        if (msgType === "system" && sdkMessage.subtype === "local_command") {
          for (const id of echoedTempIds) removePendingMessage(id);
        }
        if (msgType === "user") {
          setPromptSuggestion(null);
          const incomingText = extractUserMessageText(sdkMessage);
          logSessionUiTrace("user-echo", {
            sessionId,
            tempId: tempId ?? null,
            textLength: incomingText?.length ?? 0,
          });
          // Clear optimistic pending sends (the normal-send flow) by id, or by
          // content for providers that omit tempId on the user echo. Deferred
          // rows clear only by identity: matching text is not enough because an
          // identical prompt could still be queued.
          if (echoedTempIds.length) {
            for (const id of echoedTempIds) {
              removePendingMessage(id);
              deliveredDeferredTempIdsRef.current.add(id);
            }
            setDeferredMessagesState((prev) =>
              removeEchoedQueueMessage(prev, echoedTempIds),
            );
          } else if (incomingText) {
            setPendingMessages((prev) =>
              removeEchoedQueueMessage(prev, undefined, incomingText),
            );
          }
        }

        // Route subagent messages to agentContent instead of main messages
        // This keeps the parent session's DAG clean and allows proper nesting in UI
        const subagentId = sdkMessage.isSubagent
          ? typeof sdkMessage.agentId === "string"
            ? sdkMessage.agentId
            : typeof sdkMessage.parentToolUseId === "string"
              ? sdkMessage.parentToolUseId
              : undefined
          : undefined;
        if (subagentId) {
          const parentToolUseId =
            typeof sdkMessage.parentToolUseId === "string"
              ? sdkMessage.parentToolUseId
              : undefined;
          if (parentToolUseId) {
            registerToolUseAgent(parentToolUseId, subagentId);
          }

          handleStreamSubagentMessage(incoming, subagentId);
          return; // Don't add to main messages
        }

        handleStreamMessageEvent(incoming);
      } else if (data.eventType === "configuration-error") {
        const setting = data.setting;
        const message = data.message;
        if (setting === "effort" && typeof message === "string") {
          options?.onConfigurationError?.({
            setting,
            requestedValue:
              typeof data.requestedValue === "string"
                ? data.requestedValue
                : undefined,
            message,
          });
        }
      } else if (data.eventType === "status") {
        const statusData = data as {
          eventType: string;
          sessionId?: string;
          state: string;
          request?: InputRequest;
          liveness?: SessionLivenessSnapshot;
          providerRuntimeStatus?: ProviderRuntimeStatus;
        };
        reportProviderRuntimeStatus(
          statusData.sessionId ?? statusData.request?.sessionId ?? sessionId,
          statusData.providerRuntimeStatus,
        );
        if (statusData.liveness) {
          setSessionLiveness(statusData.liveness);
        }
        // Track process state (in-turn, idle, waiting-input)
        if (
          statusData.state === "idle" ||
          statusData.state === "in-turn" ||
          statusData.state === "waiting-input"
        ) {
          noteLifecycleObservation();
          if (statusData.state !== "in-turn") {
            flushPendingStreamMessage();
          }
          logSessionUiTrace("stream-status", {
            sessionId,
            state: statusData.state,
            hasRequest: !!statusData.request,
          });
          setProcessState(statusData.state as ProcessState);
        }
        // Capture pending input request when waiting for user input
        if (statusData.state === "waiting-input" && statusData.request) {
          setPendingInputRequest(statusData.request);
          // Also update actualSessionId from request in case it differs from URL
          // This handles the temp→real ID transition when state-change arrives
          // after the connected event (which may have had the temp ID)
          if (
            statusData.request.sessionId &&
            statusData.request.sessionId !== sessionId
          ) {
            setActualSessionId(statusData.request.sessionId);
          }
        } else {
          // Clear pending request when state changes away from waiting-input
          setPendingInputRequest(null);
        }
      } else if (data.eventType === "heartbeat") {
        const heartbeatData = data as {
          eventType: string;
          liveness?: SessionLivenessSnapshot;
        };
        if (heartbeatData.liveness) {
          setSessionLiveness(heartbeatData.liveness);
          if (
            hasUnreconciledHeartbeatProgress(
              heartbeatData.liveness,
              reconciledTranscriptRef.current.updatedAt,
            )
          ) {
            throttledFetch({
              route: "session-heartbeat-progress",
              lastProviderMessageAt:
                heartbeatData.liveness.lastProviderMessageAt,
              reconciledTranscriptUpdatedAt:
                reconciledTranscriptRef.current.updatedAt,
            });
          }
          const heartbeatProcessState = parseProcessState(
            heartbeatData.liveness.state,
          );
          if (heartbeatProcessState) {
            noteLifecycleObservation();
            setProcessState(heartbeatProcessState);
            if (heartbeatProcessState !== "waiting-input") {
              setPendingInputRequest(null);
            }
          }
        }
      } else if (data.eventType === "deferred-queue") {
        const deferredData = data as {
          eventType: string;
          messages: DeferredMessage[];
          reason?: "queued" | "cancelled" | "edited" | "promoted";
          tempId?: string;
          yaCommand?: SessionQueuedYaCommand;
        };
        logSessionUiTrace("stream-deferred-queue", {
          sessionId,
          reason: deferredData.reason ?? null,
          tempId: deferredData.tempId ?? null,
          yaCommand: deferredData.yaCommand ?? null,
          count: deferredData.messages?.length ?? 0,
        });
        // Mirror the server's authoritative queue wholesale.
        setDeferredMessages(deferredData.messages ?? []);
        const sessionProvider = session?.provider;
        const needsDeferredPromotionCatchUp =
          deferredData.reason === "promoted" &&
          (deferredData.yaCommand === "done" ||
            ((deferredData.messages?.length ?? 0) === 0 &&
              sessionProvider !== "codex" &&
              sessionProvider !== "codex-oss"));
        if (needsDeferredPromotionCatchUp) {
          throttledFetch();
          // A second call asks the existing throttle for a trailing catch-up in
          // case the provider user echo lands just after the promotion event.
          throttledFetch();
        }
      } else if (data.eventType === "complete") {
        const completeData = data as {
          eventType: string;
          sessionId?: string;
          providerRuntimeStatus?: ProviderRuntimeStatus;
        };
        noteLifecycleObservation();
        logSessionUiTrace("stream-complete", { sessionId });
        reportProviderRuntimeStatus(
          completeData.sessionId ?? sessionId,
          completeData.providerRuntimeStatus,
        );
        flushPendingStreamMessage();
        setProcessState("idle");
        setStatus({ owner: "none" });
        setSessionLiveness(null);
        setPendingInputRequest(null);
        throttledFetch();
      } else if (data.eventType === "connected") {
        // Sync state and permission mode from connected event
        const connectedData = data as {
          eventType: string;
          sessionId?: string;
          state?: string;
          permissionMode?: PermissionMode;
          appliedPermissionMode?: PermissionMode;
          modeVersion?: number;
          request?: InputRequest;
          provider?: ProviderName;
          model?: string;
          recapAfterSeconds?: number;
          recapMode?: RecapMode;
          deferredMessages?: DeferredMessage[];
          liveness?: SessionLivenessSnapshot;
          providerRuntimeStatus?: ProviderRuntimeStatus;
        };
        setSessionLiveness(connectedData.liveness ?? null);
        if (connectedData.recapMode) {
          recapModeRef.current = connectedData.recapMode;
        }

        // Update actual session ID if server reports a different one
        // This handles the temp→real ID transition when createSession returns
        // before the SDK sends the real session ID
        // Check both the connected event's sessionId and the request's sessionId
        const serverSessionId =
          connectedData.sessionId ?? connectedData.request?.sessionId;
        reportProviderRuntimeStatus(
          serverSessionId ?? sessionId,
          connectedData.providerRuntimeStatus,
        );
        logSessionUiTrace("stream-connected", {
          sessionId,
          serverSessionId: serverSessionId ?? null,
          state: connectedData.state ?? null,
          permissionMode: connectedData.permissionMode ?? null,
          appliedPermissionMode: connectedData.appliedPermissionMode ?? null,
          modeVersion: connectedData.modeVersion ?? null,
          provider: connectedData.provider ?? null,
          model: connectedData.model ?? null,
          recapAfterSeconds: connectedData.recapAfterSeconds ?? null,
          deferredCount: connectedData.deferredMessages?.length ?? 0,
        });
        if (connectedData.recapAfterSeconds !== undefined) {
          setStatus((prev) =>
            prev.owner === "self"
              ? {
                  ...prev,
                  recapAfterSeconds: normalizeRecapAfterSeconds(
                    connectedData.recapAfterSeconds,
                  ),
                }
              : prev,
          );
        }
        if (serverSessionId && serverSessionId !== sessionId) {
          setActualSessionId(serverSessionId);
        }

        // Sync process state so watching tabs see "processing" indicator
        if (
          connectedData.state === "idle" ||
          connectedData.state === "in-turn" ||
          connectedData.state === "waiting-input"
        ) {
          noteLifecycleObservation();
          setProcessState(connectedData.state as ProcessState);
        }
        // Restore pending input request if state is waiting-input, clear if not
        // (handles reconnection after another tab already approved/denied)
        if (connectedData.state === "waiting-input" && connectedData.request) {
          setPendingInputRequest(connectedData.request);
        } else {
          setPendingInputRequest(null);
        }
        if (
          connectedData.permissionMode &&
          connectedData.modeVersion !== undefined
        ) {
          applyServerModeUpdate(
            connectedData.permissionMode,
            connectedData.modeVersion,
          );
        }
        if (connectedData.appliedPermissionMode) {
          setStatus((prev) =>
            prev.owner === "self"
              ? {
                  ...prev,
                  appliedPermissionMode: connectedData.appliedPermissionMode,
                }
              : prev,
          );
        }

        // Update session with provider/model from connected event (belt-and-suspenders)
        // This ensures the ProviderBadge shows even if the initial session load returned
        // incomplete data (e.g., JSONL not yet written for new sessions)
        const sseProvider = connectedData.provider;
        const sseModel = connectedData.model;
        if (sseProvider) {
          updateSession((prev) => {
            if (!prev) return prev;
            // Always update model if the connected event has a resolved model
            // (provider won't change, but model resolves from undefined/"Default" to actual name)
            return {
              ...prev,
              provider: prev.provider || sseProvider,
              ...(sseModel && { model: sseModel }),
            };
          });
        }

        // Mirror the server's authoritative queue from the connected event.
        // This is why a refresh, a new tab, or another device all converge on
        // the same queue: the server reports it and the client renders it.
        setDeferredMessages(connectedData.deferredMessages ?? []);

        // Fetch messages from JSONL since last known message.
        // For Codex providers, skip the very first connected-event fetch because
        // it can duplicate fresh stream messages (ID mismatch between stream and
        // early JSONL normalization). Reconnects still fetch as normal.
        const connectedProvider = connectedData.provider ?? session?.provider;
        const isCodexProvider =
          connectedProvider === "codex" || connectedProvider === "codex-oss";
        const isFirstConnectedEvent = !hasHandledConnectedEventRef.current;
        hasHandledConnectedEventRef.current = true;

        if (!(isFirstConnectedEvent && isCodexProvider)) {
          fetchNewMessages();
        }
      } else if (data.eventType === "mode-change") {
        // Handle mode change from another tab/client
        const modeData = data as {
          eventType: string;
          permissionMode?: PermissionMode;
          modeVersion?: number;
        };
        if (modeData.permissionMode && modeData.modeVersion !== undefined) {
          applyServerModeUpdate(modeData.permissionMode, modeData.modeVersion);
        }
      } else if (data.eventType === "mode-applied") {
        const modeData = data as {
          eventType: string;
          appliedPermissionMode?: PermissionMode;
        };
        if (modeData.appliedPermissionMode) {
          setStatus((prev) =>
            prev.owner === "self"
              ? {
                  ...prev,
                  appliedPermissionMode: modeData.appliedPermissionMode,
                }
              : prev,
          );
        }
      } else if (data.eventType === "markdown-augment") {
        // Handle markdown augment events (server-rendered)
        const augmentData = data as {
          eventType: string;
          blockIndex?: number;
          html: string;
          type?: string;
          messageId?: string;
        };

        // Two types of markdown-augment events:
        // 1. Final message augment: has messageId (uuid), no blockIndex
        //    → Store in markdownAugments for completed message rendering
        // 2. Streaming block augment: has blockIndex and type
        //    → Dispatch to streaming context for live rendering
        if (
          augmentData.messageId &&
          augmentData.blockIndex === undefined &&
          augmentData.html
        ) {
          applyFinalMarkdownAugment(augmentData.messageId, augmentData.html);
        } else if (
          augmentData.blockIndex !== undefined &&
          getStreamingEnabled()
        ) {
          // Streaming block augment - dispatch to context
          streamingMarkdownCallbacks?.onAugment?.({
            blockIndex: augmentData.blockIndex,
            html: augmentData.html,
            type: augmentData.type ?? "text",
            messageId: augmentData.messageId,
          });
        }
      } else if (data.eventType === "pending") {
        // Handle streaming markdown pending text events
        const pendingData = data as {
          eventType: string;
          html: string;
        };
        if (getStreamingEnabled()) {
          streamingMarkdownCallbacks?.onPending?.({
            html: pendingData.html,
          });
        }
      } else if (data.eventType === "session-id-changed") {
        // Handle session ID change (temp ID → real SDK ID)
        // This event means the URL should be updated to use the new session ID
        const changeData = data as {
          eventType: string;
          oldSessionId: string;
          newSessionId: string;
        };
        if (changeData.newSessionId && changeData.newSessionId !== sessionId) {
          setActualSessionId(changeData.newSessionId);
          // Also update pendingInputRequest.sessionId if it matches the old ID
          // This prevents approval panel from hiding due to ID mismatch after
          // the temp→real transition
          setPendingInputRequest((prev) => {
            if (prev && prev.sessionId === changeData.oldSessionId) {
              return { ...prev, sessionId: changeData.newSessionId };
            }
            return prev;
          });
        }
      }
    },
    [
      applyFinalMarkdownAugment,
      applyServerModeUpdate,
      sessionId,
      handleStreamEvent,
      noteStreamActivity,
      noteStreamProgressLiveness,
      noteLifecycleObservation,
      clearStreaming,
      removePendingMessage,
      streamingMarkdownCallbacks,
      handleStreamMessageEvent,
      flushPendingStreamMessage,
      handleStreamSubagentMessage,
      registerToolUseAgent,
      clearAgentStreamingPlaceholders,
      clearStreamingPlaceholders,
      setIsCompacting,
      setDeferredMessages,
      updateSession,
      fetchNewMessages,
      throttledFetch,
      reportProviderRuntimeStatus,
      session?.provider,
      session?.model,
      options?.onConfigurationError,
    ],
  );

  // Handle stream errors by checking if process is still alive
  // If process died (idle timeout), transition to idle state
  // Uses lightweight metadata endpoint to avoid re-fetching all messages
  const handleStreamError = useCallback(async () => {
    const snapshotToken = beginRuntimeSnapshot();
    try {
      const data = await api.getSessionMetadata(projectId, sessionId);
      if (!isRuntimeSnapshotCurrent(snapshotToken)) {
        return;
      }
      reportProviderRuntimeStatus(sessionId, data.providerRuntimeStatus);
      setDeferredMessages(data.deferredMessages ?? []);
      const metadataProcessState = parseProcessState(data.processState);
      if (data.ownership.owner !== "self") {
        setStatus({ owner: "none" });
        setProcessState("idle");
        setPendingInputRequest(null);
        return;
      }
      setStatus(data.ownership);
      if (metadataProcessState) {
        setProcessState(metadataProcessState);
        if (
          metadataProcessState === "waiting-input" &&
          data.pendingInputRequest
        ) {
          setPendingInputRequest(data.pendingInputRequest);
        } else if (metadataProcessState !== "waiting-input") {
          setPendingInputRequest(null);
        }
      }
    } catch {
      if (!isRuntimeSnapshotCurrent(snapshotToken)) {
        return;
      }
      // If session fetch fails, assume process is dead
      setStatus({ owner: "none" });
      setProcessState("idle");
      setPendingInputRequest(null);
    }
  }, [
    beginRuntimeSnapshot,
    isRuntimeSnapshotCurrent,
    projectId,
    reportProviderRuntimeStatus,
    sessionId,
    setDeferredMessages,
  ]);

  // Only connect to session stream when we own the session
  // External sessions are tracked via the activity stream instead
  const {
    connected,
    reconnect: reconnectStream,
    resubscribing: sessionStreamResubscribing,
  } = useSessionStream(
    !backgroundEffectsPaused && status.owner === "self" ? sessionId : null,
    { onMessage: handleStreamMessage, onError: handleStreamError },
  );

  const sessionUpdatesConnected =
    status.owner === "self"
      ? connected
      : status.owner === "external"
        ? sessionWatchConnected
        : false;
  const sessionUpdatesResubscribing =
    status.owner === "self"
      ? sessionStreamResubscribing
      : status.owner === "external"
        ? sessionWatchResubscribing
        : false;

  // Restore the user's last per-session model pick when reopening a session
  // that no self-owned process is running, mirroring the permission-mode restore
  // above. A live process's model stays authoritative (its config arrives via the
  // stream), so we only overlay the stored pick when idle, and only once per
  // loaded session id so later metadata updates and the stream can still move it.
  const restoredModelSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!session) return;
    if (restoredModelSessionRef.current === sessionId) return;
    restoredModelSessionRef.current = sessionId;
    if (status.owner === "self") return;
    const stored = sessionModelPick.load(sessionId);
    if (stored && stored !== session.model) {
      updateSession((prev) => (prev ? { ...prev, model: stored } : prev));
    }
  }, [session, sessionId, status.owner, updateSession]);

  // Allow external model update (e.g., after /model command switches mid-session).
  // Persist the pick per session so reopening an idle session restores it
  // instead of falling back to the JSONL-derived model — the model change only
  // reaches the server at the next turn, so an abandoned pick would otherwise be
  // lost (mirrors the per-session permission-mode persistence above).
  const setSessionModel = useCallback(
    (model: string) => {
      sessionModelPick.save(sessionId, model);
      updateSession((prev) => (prev ? { ...prev, model } : prev));
    },
    [sessionId, updateSession],
  );

  return {
    session,
    updateSession,
    setSessionModel,
    messages,
    agentContent, // Subagent messages keyed by agentId (for Task tool)
    mergeLoadedAgentContent,
    toolUseToAgent, // Mapping from Task tool_use_id → agentId (for rendering during streaming)
    markdownAugments, // Pre-rendered markdown HTML from REST response (keyed by blockId)
    status,
    processState,
    sessionLiveness,
    isCompacting, // True when context is being compressed
    pendingInputRequest,
    setIsCompacting,
    actualSessionId, // Real session ID from server (may differ from URL during temp→real transition)
    permissionMode: localMode, // UI-selected mode (sent with next message)
    modeVersion,
    loading,
    sessionLoadProgress,
    error,
    connected,
    sessionWatchConnected,
    sessionUpdatesConnected,
    sessionUpdatesResubscribing,
    lastStreamActivityAt, // Last stream message timestamp for engagement tracking
    setStatus: setObservedStatus,
    setProcessState: setObservedProcessState,
    setPendingInputRequest: setObservedPendingInputRequest,
    setPermissionMode,
    pendingMessages, // Messages waiting for server confirmation
    addPendingMessage, // Add to pending queue, returns tempId
    removePendingMessage, // Remove from pending by tempId
    updatePendingMessage, // Update pending message fields (e.g. status)
    deferredMessages, // Server-authoritative queued-message mirror
    setDeferredMessages, // Replace the mirror from a server queue/cancel response
    removeUnconfirmedSelfSend, // Remove a cancelled optimistic steering echo
    slashCommands, // Available slash commands from init message
    sessionTools, // Available tools from init message
    mcpServers, // Available MCP servers from init message
    promptSuggestion, // Predicted next user prompt from prompt_suggestion SDK message
    dismissPromptSuggestion: () => setPromptSuggestion(null),
    pagination, // Compact-boundary pagination metadata
    activeWindowTrimRevision, // Ephemeral accepted auto-trim render signal
    loadingOlder, // Whether older messages are being loaded
    olderLoadContinuationRequired, // Safety pause before the preceding user turn
    loadOlderMessages, // Load through older chunks to a user-turn boundary
    readOlderSearchPage, // Search-only bounded history read; does not grow the active window
    initialScrollSnapshot, // Retained same-tab route scroll anchor
    updateRouteScrollSnapshot, // Update retained same-tab route scroll anchor
    updateActiveWindowFollowingBottom, // Immediate active-window follow intent
    restoredFromSnapshot, // Initial render came from retained same-tab data
    reconnectStream, // Force session stream reconnection (e.g., after process restart)
    fetchNewMessages, // Fetch durable YA/provider rows added since the visible tail
  };
}
