import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { PaginationInfo } from "../api/client";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { getMessageId } from "@yep-anywhere/shared/transcript/message";
import { createFinalMarkdownAugmentAction } from "../lib/sessionDetail/actionAdapters";
import type { SessionDetailRevealSnapshotResult } from "../lib/sessionDetail/revealSnapshot";
import {
  buildReturnedToolUseToAgent,
  canRevealReturnedSessionDetail,
  createStoreBackedSessionDetailSelector,
  getReturnedAgentContent,
  getReturnedMarkdownAugments,
  getReturnedSessionMessages,
} from "../lib/sessionDetail/returnedDetail";
import type {
  SessionLoadProgress,
  SessionLoadProgressStage,
} from "../lib/sessionDetail/loadProgress";
import {
  createSessionDetailCoordinator,
  type SessionDetailCoordinator,
  type SessionDetailLoadCompleteResult,
  type SessionDetailRevealSnapshotInput,
} from "../lib/sessionDetail/sessionDetailCoordinator";
import { isActiveWindowRealUserTurn } from "../lib/sessionDetail/activeWindowTrimPolicy";
import { getSessionDetailRetentionDefaults } from "../lib/sessionDetail/sessionDetailRetention";
import { isClientLogCollectionActive } from "../lib/diagnostics";
import { markReloadPerfPhase } from "../lib/diagnostics/reloadPerfProbe";
import {
  DEFAULT_SESSION_INITIAL_HISTORY_COMPACTIONS,
  getSessionActiveWindowTrimEnabled,
  getSessionInitialHistoryCompactions,
  getSessionScrollBehaviorMode,
  getSessionTranscriptCacheEnabled,
  recordLastSessionTranscriptBytes,
} from "./useSessionPerformanceSettings";
import { getStreamingEnabled } from "./useStreamingEnabled";
import { shouldRetainSessionScrollMemory } from "../lib/sessionScrollBehavior";
import type { Message, SessionMetadata } from "../types";
import {
  isSessionDetailShadowDiagnosticsEnabled,
  reportSessionDetailStoreDivergence,
  type SessionDetailRuntimeStateInput,
} from "../lib/sessionDetail/shadowDiagnostics";
import {
  selectSessionDetailLastMessageId,
  selectSessionDetailMessages,
  selectSessionDetailRuntimeSnapshot,
  selectSessionDetailSession,
} from "../lib/sessionDetail/selectors";
import {
  clearDefaultSessionDetailMemoryCache,
  type SessionDetailEntryKeyInput,
} from "../lib/sessionDetail/sessionDetailStore";
import type { GetSessionInput, GetSessionResult } from "../lib/sourceRuntime";
import type {
  AgentContent,
  AgentContentMap,
  AgentContextUsage,
  MarkdownAugmentMap,
  SessionDetailAction,
} from "../lib/sessionDetail/types";
import type {
  SessionRouteScrollSnapshot,
  SessionRouteSnapshot,
} from "../lib/sessionRouteSnapshots";
import {
  createSessionScrollMemoryStorageKey,
  isSessionScrollMemoryStorageKey,
  readSessionScrollMemory,
  selectFurthestSessionScrollMemory,
  writeSessionScrollMemory,
} from "../lib/sessionScrollMemoryStorage";

/** Result from initial session load */
export type SessionLoadResult = SessionDetailLoadCompleteResult;
export type { AgentContent, AgentContentMap } from "../lib/sessionDetail/types";

const DEFAULT_INITIAL_TAIL_TURNS = 20;
const INCREMENTAL_REFRESH_DIAGNOSTIC_INTERVAL_MS = 30_000;
const OLDER_USER_TURN_LOAD_PAGE_LIMIT = 8;
const SAME_ID_STREAM_REPLACEMENT_DELAY_MS = 100;
const INITIAL_HISTORY_FULL_REASON = "browser initial history preference";

function buildInitialHistoryRequest(options: {
  projectId: string;
  sessionId: string;
  compactBoundaries: number | null;
  afterMessageId?: string;
  tailTurns?: number;
  tailFrom?: string;
}): GetSessionInput {
  const {
    projectId,
    sessionId,
    compactBoundaries,
    afterMessageId,
    tailTurns,
    tailFrom,
  } = options;
  if (compactBoundaries === null) {
    return {
      projectId,
      sessionId,
      fullHistory: true,
      fullHistoryReason: INITIAL_HISTORY_FULL_REASON,
      ...(tailTurns !== undefined ? { tailTurns } : {}),
      ...(tailFrom ? { tailFrom } : {}),
    };
  }
  return {
    projectId,
    sessionId,
    tailCompactions: compactBoundaries,
    ...(afterMessageId ? { afterMessageId } : {}),
    ...(tailTurns !== undefined ? { tailTurns } : {}),
    ...(tailFrom ? { tailFrom } : {}),
  };
}

function isDocumentVisibleForScrollMemory(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "visible"
  );
}

export type SessionMetadataUpdate =
  | SessionMetadata
  | null
  | ((previous: SessionMetadata | null) => SessionMetadata | null);

export type { SessionLoadProgress, SessionLoadProgressStage };

export type IncrementalFetchTrigger = Record<string, unknown>;

/** Options for useSessionMessages */
export interface UseSessionMessagesOptions {
  projectId: string;
  sessionId: string;
  tailTurns?: number;
  tailFrom?: string;
  /** Enable opt-in progress paint yields for large initial transcript loads */
  detailedLoadingProgress?: boolean;
  /** Whether this server aligns Codex stream and durable transcript ids. */
  codexStreamDurableIdAlignment?: boolean;
  /** Called when initial load completes with session data */
  onLoadComplete?: (result: SessionLoadResult) => void;
  /** Called after versioned REST transcript rows have been applied. */
  onTranscriptReconciled?: (transcriptSnapshotUpdatedAt: string) => void;
  /** Called on load error */
  onLoadError?: (error: Error) => void;
}

/** Result from useSessionMessages hook */
export interface UseSessionMessagesResult {
  /** Messages in the session */
  messages: Message[];
  /** Subagent content keyed by agentId */
  agentContent: AgentContentMap;
  /** Mapping from Task tool_use_id → agentId */
  toolUseToAgent: Map<string, string>;
  /** Final server-rendered Markdown keyed by stable message ID. */
  markdownAugments: MarkdownAugmentMap;
  /** Store a final server-rendered Markdown replacement. */
  applyFinalMarkdownAugment: (messageId: string, html: string) => void;
  /** Whether initial load is in progress */
  loading: boolean;
  /** Fine-grained initial load progress for opt-in display */
  sessionLoadProgress: SessionLoadProgress;
  /** Session data from initial load */
  session: SessionMetadata | null;
  /** Apply session metadata updates through the session detail action layer */
  updateSession: (update: SessionMetadataUpdate) => void;
  /** Handle streaming content updates (for useStreamingContent) */
  handleStreamingUpdate: (message: Message, agentId?: string) => void;
  /** Handle stream message event (buffered until initial load completes) */
  handleStreamMessageEvent: (incoming: Message) => void;
  /** Publish the latest queued same-id stream replacement immediately. */
  flushPendingStreamMessage: () => void;
  /** Handle stream subagent message event */
  handleStreamSubagentMessage: (incoming: Message, agentId: string) => void;
  /** Register toolUse → agent mapping */
  registerToolUseAgent: (toolUseId: string, agentId: string) => void;
  /** Merge loaded subagent content with any live content already seen */
  mergeLoadedAgentContent: (agentId: string, content: AgentContent) => void;
  /** Update agent context usage metadata */
  updateAgentContextUsage: (
    agentId: string,
    contextUsage: AgentContextUsage,
  ) => void;
  /** Remove transient streaming placeholder rows from a subagent */
  clearAgentStreamingPlaceholders: (agentId: string) => void;
  /** Remove transient streaming placeholder rows from the main transcript */
  clearStreamingPlaceholders: () => void;
  /** Remove a local optimistic self-send that the server accepted cancelling */
  removeUnconfirmedSelfSend: (tempId: string) => void;
  /** Fetch new messages incrementally (for file change events) */
  fetchNewMessages: (trigger?: IncrementalFetchTrigger) => Promise<void>;
  /** Fetch session metadata only */
  fetchSessionMetadata: () => Promise<void>;
  /** Pagination info from compact-boundary-based loading */
  pagination: PaginationInfo | undefined;
  /** Ephemeral render signal incremented after each accepted active-window trim. */
  activeWindowTrimRevision: number;
  /** Whether older messages are being loaded */
  loadingOlder: boolean;
  /** Whether a safety boundary paused loading before reaching a real user turn */
  olderLoadContinuationRequired: boolean;
  /** Load through older chunks until reaching a real user turn or safety boundary */
  loadOlderMessages: () => Promise<void>;
  /** Read one bounded older page without adding it to the active transcript. */
  readOlderSearchPage: (beforeMessageId: string) => Promise<GetSessionResult>;
  /** Retained scroll anchor from the last same-tab route visit */
  initialScrollSnapshot: SessionRouteScrollSnapshot | null;
  /** Update the retained scroll anchor without re-rendering this hook */
  updateRouteScrollSnapshot: (snapshot: SessionRouteScrollSnapshot) => void;
  /** Update active-window follow intent immediately, without snapshot debounce. */
  updateActiveWindowFollowingBottom: (followingBottom: boolean) => void;
  /** True when the initial render was hydrated from a retained route snapshot */
  restoredFromSnapshot: boolean;
}

function readSessionLoadCache(
  coordinator: SessionDetailCoordinator,
): SessionRouteSnapshot | undefined {
  return coordinator.readInitialRouteSnapshot({
    enabled:
      getSessionTranscriptCacheEnabled() && typeof window !== "undefined",
  });
}

export function __resetSessionLoadCacheForTest(): void {
  clearDefaultSessionDetailMemoryCache();
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

interface IncrementalRefreshDiagnosticState {
  routeKey: string;
  lastReportedAtMs: number;
  suppressedCount: number;
}

function debugLogIncrementalRefreshDiagnostic(
  state: IncrementalRefreshDiagnosticState,
  input: {
    projectId: string;
    sessionId: string;
    afterMessageId?: string;
    incrementalError: Error;
    reconciliationError?: Error;
    outcome: "failed" | "recovered";
  },
): void {
  if (!import.meta.env.DEV && !isClientLogCollectionActive()) {
    return;
  }

  const nowMs = Date.now();
  if (
    nowMs - state.lastReportedAtMs <
    INCREMENTAL_REFRESH_DIAGNOSTIC_INTERVAL_MS
  ) {
    state.suppressedCount += 1;
    return;
  }

  const suppressedCount = state.suppressedCount;
  state.lastReportedAtMs = nowMs;
  state.suppressedCount = 0;
  console.info("[SessionIncrementalRefresh]", {
    event: "incremental-refresh-reconciliation",
    outcome: input.outcome,
    projectId: input.projectId,
    sessionId: input.sessionId,
    afterMessageId: input.afterMessageId,
    incrementalError: input.incrementalError.message,
    reconciliationError: input.reconciliationError?.message,
    ...(suppressedCount > 0 && { suppressedCount }),
  });
}

function yieldForSessionLoadingProgressPaint(
  enabled: boolean | undefined,
): Promise<void> {
  if (!enabled) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Hook for managing session messages with stream buffering.
 *
 * Handles:
 * - Initial REST load of messages
 * - Buffering stream messages until initial load completes
 * - Merging stream and JSONL messages
 * - Routing subagent messages to agentContent
 */
export function useSessionMessages(
  options: UseSessionMessagesOptions,
): UseSessionMessagesResult {
  const {
    projectId,
    sessionId,
    tailTurns,
    tailFrom,
    detailedLoadingProgress,
    codexStreamDurableIdAlignment,
    onLoadComplete,
    onTranscriptReconciled,
    onLoadError,
  } = options;
  const initialHistoryCompactions = getSessionInitialHistoryCompactions();
  const effectiveTailTurns =
    tailTurns ??
    (tailFrom ||
    initialHistoryCompactions !== DEFAULT_SESSION_INITIAL_HISTORY_COMPACTIONS
      ? undefined
      : DEFAULT_INITIAL_TAIL_TURNS);
  const runtime = useCurrentSourceRuntime();
  const sourceKey = runtime.sourceKey;
  const sourceSummary = runtime.summary;
  const snapshotKey: SessionDetailEntryKeyInput = useMemo(
    () => ({
      sourceKey,
      projectId,
      sessionId,
      initialHistoryCompactions,
      tailTurns: effectiveTailTurns,
      tailFrom,
    }),
    [
      effectiveTailTurns,
      initialHistoryCompactions,
      projectId,
      sessionId,
      sourceKey,
      tailFrom,
    ],
  );
  const coordinator = useMemo(
    () =>
      createSessionDetailCoordinator({
        entryKey: snapshotKey,
        runtime,
        activeWindowTrim: { enabled: getSessionActiveWindowTrimEnabled },
      }),
    [runtime, snapshotKey],
  );
  coordinator.setCodexStreamDurableIdAlignment(
    codexStreamDurableIdAlignment === true,
  );
  const sourceApi = coordinator.api;
  const snapshotKeyString = coordinator.entryKeyString;
  const scrollMemoryReference = useMemo(
    () => ({ sourceKey, projectId, sessionId }),
    [projectId, sessionId, sourceKey],
  );
  const scrollMemoryStorageKey = useMemo(
    () => createSessionScrollMemoryStorageKey(scrollMemoryReference),
    [scrollMemoryReference],
  );
  const cachedLoadRef = useRef<{
    key: string;
    coordinator: SessionDetailCoordinator;
    load: SessionRouteSnapshot | undefined;
  } | null>(null);
  const incrementalFetchSequenceRef = useRef(0);
  const incrementalRefreshDiagnosticRef =
    useRef<IncrementalRefreshDiagnosticState>({
      routeKey: snapshotKeyString,
      lastReportedAtMs: Number.NEGATIVE_INFINITY,
      suppressedCount: 0,
    });
  if (incrementalRefreshDiagnosticRef.current.routeKey !== snapshotKeyString) {
    incrementalRefreshDiagnosticRef.current = {
      routeKey: snapshotKeyString,
      lastReportedAtMs: Number.NEGATIVE_INFINITY,
      suppressedCount: 0,
    };
  }
  if (
    cachedLoadRef.current?.key !== snapshotKeyString ||
    cachedLoadRef.current.coordinator !== coordinator
  ) {
    cachedLoadRef.current = {
      key: snapshotKeyString,
      coordinator,
      load: readSessionLoadCache(coordinator),
    };
  }
  const cachedLoad = cachedLoadRef.current.load;

  // Core state
  const [loading, setLoading] = useState(true);
  const [revealedSnapshotKey, setRevealedSnapshotKey] = useState<string | null>(
    null,
  );
  const [sessionLoadProgress, setSessionLoadProgress] =
    useState<SessionLoadProgress>(() => coordinator.buildLoadProgress("idle"));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderLoadContinuation, setOlderLoadContinuation] = useState(() => ({
    routeKey: snapshotKeyString,
    required: false,
  }));
  const olderLoadContinuationRequired =
    olderLoadContinuation.routeKey === snapshotKeyString &&
    olderLoadContinuation.required;

  // Store-authoritative fields come from reducer-owned state. The remaining ref
  // holds hook-only scroll bookkeeping, which is intentionally not reactive.
  const deviceScrollMemoryRef = useRef<{
    key: string;
    snapshot: SessionRouteScrollSnapshot | null;
  } | null>(null);
  if (deviceScrollMemoryRef.current?.key !== scrollMemoryStorageKey) {
    deviceScrollMemoryRef.current = {
      key: scrollMemoryStorageKey,
      snapshot: shouldRetainSessionScrollMemory(getSessionScrollBehaviorMode())
        ? readSessionScrollMemory(scrollMemoryReference)
        : null,
    };
  }
  const deviceScrollCandidateRef = useRef<{
    key: string;
    snapshot: SessionRouteScrollSnapshot | null;
  }>({ key: scrollMemoryStorageKey, snapshot: null });
  if (deviceScrollCandidateRef.current.key !== scrollMemoryStorageKey) {
    deviceScrollCandidateRef.current = {
      key: scrollMemoryStorageKey,
      snapshot: null,
    };
  }
  const initialRetainedScrollSnapshot = shouldRetainSessionScrollMemory(
    getSessionScrollBehaviorMode(),
  )
    ? selectFurthestSessionScrollMemory(
        cachedLoad?.scrollSnapshot,
        deviceScrollMemoryRef.current.snapshot,
      )
    : undefined;
  const scrollSnapshotRef = useRef<SessionRouteScrollSnapshot | undefined>(
    initialRetainedScrollSnapshot,
  );
  const scrollSnapshotKeyRef = useRef(snapshotKeyString);
  if (scrollSnapshotKeyRef.current !== snapshotKeyString) {
    scrollSnapshotKeyRef.current = snapshotKeyString;
    scrollSnapshotRef.current = initialRetainedScrollSnapshot;
  }
  const dispatchSessionDetailAction = useCallback(
    (action: SessionDetailAction) => {
      coordinator.dispatch(action);
    },
    [coordinator],
  );
  const applyFinalMarkdownAugment = useCallback(
    (messageId: string, html: string) => {
      dispatchSessionDetailAction(
        createFinalMarkdownAugmentAction({ messageId, html }),
      );
    },
    [dispatchSessionDetailAction],
  );

  const readStoreSession = useCallback(
    () => coordinator.readSelected(selectSessionDetailSession) ?? null,
    [coordinator],
  );

  const readStoreLastMessageId = useCallback(
    () => coordinator.readSelected(selectSessionDetailLastMessageId),
    [coordinator],
  );

  const cleanupCurrentStoreRouteSnapshot = useCallback(() => {
    return coordinator.cleanupCurrentRouteSnapshot({
      enabled:
        getSessionTranscriptCacheEnabled() && typeof window !== "undefined",
      retainScrollSnapshot: shouldRetainSessionScrollMemory(
        getSessionScrollBehaviorMode(),
      ),
      scrollSnapshot: scrollSnapshotRef.current,
    });
  }, [coordinator]);
  const recordCurrentEntryBytes = useCallback(() => {
    const bytes = coordinator.getEntryApproxBytes();
    if (bytes) {
      recordLastSessionTranscriptBytes(bytes);
    }
  }, [coordinator]);
  const resetSessionDetailState = useCallback(
    (snapshot?: SessionRouteSnapshot) => {
      if (snapshot) {
        coordinator.replaceRouteSnapshot(snapshot);
        return;
      }
      coordinator.resetEntryState();
    },
    [coordinator],
  );

  // Hold the store entry for the mounted session: retention protects it from
  // TTL/LRU eviction, so incremental dispatches always land on real state.
  useEffect(() => coordinator.retain(), [coordinator]);

  const reportStoreDivergence = useCallback(
    (
      boundary: string,
      livePatch: Partial<SessionDetailRuntimeStateInput> = {},
    ) => {
      if (!isSessionDetailShadowDiagnosticsEnabled()) {
        return;
      }
      const store = coordinator.readSelected(
        selectSessionDetailRuntimeSnapshot,
      );
      if (!store) {
        return;
      }
      // Session and pagination are store-authoritative, so their live values
      // default to the store snapshot; only explicitly patched fields can
      // still diverge here.
      const liveSession = livePatch.session ?? store.session;
      const live: SessionDetailRuntimeStateInput = {
        messages: livePatch.messages ?? store.messages,
        session: liveSession,
        pagination: livePatch.pagination ?? store.pagination,
        agentContent: livePatch.agentContent ?? store.agentContent,
        toolUseToAgentEntries:
          livePatch.toolUseToAgentEntries ?? store.toolUseToAgentEntries,
      };
      reportSessionDetailStoreDivergence({
        boundary,
        projectId,
        sessionId,
        live,
        store,
      });
    },
    [coordinator, projectId, sessionId],
  );

  const notifyTranscriptReconciled = useCallback(
    (data: GetSessionResult, appliedRowCount: number) => {
      if (
        appliedRowCount > 0 &&
        data.transcriptSnapshotUpdatedAt !== undefined
      ) {
        onTranscriptReconciled?.(data.transcriptSnapshotUpdatedAt);
      }
    },
    [onTranscriptReconciled],
  );

  const updateSession = useCallback(
    (update: SessionMetadataUpdate) => {
      const previous = readStoreSession();
      const next = typeof update === "function" ? update(previous) : update;
      if (next === previous) {
        return;
      }
      dispatchSessionDetailAction({
        type: "setSessionMetadata",
        session: next,
      });
      reportStoreDivergence("session-metadata", {
        session: next,
      });
    },
    [dispatchSessionDetailAction, readStoreSession, reportStoreDivergence],
  );

  const warnSessionDetailStore = useCallback(
    (payload: Record<string, unknown>) => {
      if (!import.meta.env.DEV) {
        return;
      }
      console.warn("[SessionDetailStore]", {
        ...payload,
        projectId,
        sessionId,
      });
    },
    [projectId, sessionId],
  );

  const warnMissingStoreBackedDetailAfterReveal = useCallback(() => {
    warnSessionDetailStore({
      event: "session-detail-store-missing-after-reveal",
    });
  }, [warnSessionDetailStore]);

  const canRevealReturnedDetail = canRevealReturnedSessionDetail({
    revealedSnapshotKey,
    snapshotKeyString,
    loading,
  });
  const selectStoreBackedDetail = useMemo(() => {
    return createStoreBackedSessionDetailSelector(canRevealReturnedDetail);
  }, [canRevealReturnedDetail]);
  const storeBackedDetail = useSyncExternalStore(
    useCallback(
      (listener) => {
        return coordinator.subscribe(selectStoreBackedDetail, listener);
      },
      [coordinator, selectStoreBackedDetail],
    ),
    useCallback(
      () => coordinator.readSelected(selectStoreBackedDetail),
      [coordinator, selectStoreBackedDetail],
    ),
    () => undefined,
  );
  const returnedMessages = getReturnedSessionMessages(storeBackedDetail);
  const returnedAgentContent = getReturnedAgentContent(storeBackedDetail);
  const returnedMarkdownAugments =
    getReturnedMarkdownAugments(storeBackedDetail);
  const returnedToolUseToAgentEntries =
    storeBackedDetail?.revealed?.toolUseToAgentEntries;
  const returnedToolUseToAgent = useMemo(
    () => buildReturnedToolUseToAgent(returnedToolUseToAgentEntries),
    [returnedToolUseToAgentEntries],
  );
  useEffect(() => {
    if (!canRevealReturnedDetail || storeBackedDetail?.revealed) {
      return;
    }
    warnMissingStoreBackedDetailAfterReveal();
  }, [
    canRevealReturnedDetail,
    storeBackedDetail,
    warnMissingStoreBackedDetailAfterReveal,
  ]);

  useEffect(() => {
    return () => {
      recordCurrentEntryBytes();
      cleanupCurrentStoreRouteSnapshot();
    };
  }, [cleanupCurrentStoreRouteSnapshot, recordCurrentEntryBytes]);

  // Process a stream message event.
  const processStreamMessage = useCallback(
    (incoming: Message, fromBufferedReplay = false) => {
      const streamingEnabled = getStreamingEnabled();

      coordinator.applyStreamMessage(incoming, {
        fromBufferedReplay,
        streamingEnabled,
      });
    },
    [coordinator],
  );
  const pendingStreamReplacementRef = useRef<{
    message: Message;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const flushPendingStreamMessage = useCallback(() => {
    const pending = pendingStreamReplacementRef.current;
    if (!pending) return;
    pendingStreamReplacementRef.current = null;
    clearTimeout(pending.timer);
    processStreamMessage(pending.message);
  }, [processStreamMessage]);

  // Process a buffered stream subagent message
  const processStreamSubagentMessage = useCallback(
    (incoming: Message, agentId: string) => {
      const streamingEnabled = getStreamingEnabled();
      dispatchSessionDetailAction({
        type: "applyStreamSubagentMessage",
        agentId,
        message: incoming,
        streamingEnabled,
      });
    },
    [dispatchSessionDetailAction],
  );

  // Initial load. When a warm in-tab cache exists, the REST request is an
  // incremental refresh after the cached tail; merge that delta instead of
  // replacing the cached transcript.
  useEffect(() => {
    let cancelled = false;
    let warmHydrated = false;
    let pendingWarmData: GetSessionResult | null = null;
    let pendingWarmError: Error | null = null;
    let initialAfterMessageId: string | undefined;
    markReloadPerfPhase("session_snapshot_lookup_start", {
      projectId,
      sessionId,
    });
    const warmLoad = readSessionLoadCache(coordinator);
    markReloadPerfPhase("session_snapshot_lookup_complete", {
      projectId,
      sessionId,
      hit: warmLoad !== null,
      messageCount: warmLoad?.messages.length ?? 0,
    });
    const initialLoad = coordinator.beginInitialLoad({
      warmSnapshot: warmLoad,
    });

    const notifyLoadComplete = (
      data: GetSessionResult,
      appliedRowCount: number,
    ) => {
      sourceSummary.reportProviderRuntimeStatusSnapshot(
        coordinator.buildProviderRuntimeStatusSnapshot(data),
      );
      notifyTranscriptReconciled(data, appliedRowCount);
      onLoadComplete?.(coordinator.buildLoadCompleteResult(data));
    };

    const readRevealSnapshotAfterStoreUpdate = (
      boundary: string,
      fallback: SessionDetailRevealSnapshotInput,
    ): SessionDetailRevealSnapshotResult => {
      const reveal = coordinator.buildRevealSnapshot({
        ...fallback,
        scrollSnapshot: fallback.scrollSnapshot ?? scrollSnapshotRef.current,
      });
      if (!reveal.storeBacked) {
        warnSessionDetailStore({
          event: "session-detail-selector-missing-after-dispatch",
          boundary,
          selector: "runtimeSnapshot",
        });
      }
      return reveal;
    };

    const applyRevealSnapshot = (snapshot: SessionRouteSnapshot) => {
      scrollSnapshotRef.current = shouldRetainSessionScrollMemory(
        getSessionScrollBehaviorMode(),
      )
        ? selectFurthestSessionScrollMemory(
            snapshot.scrollSnapshot,
            deviceScrollMemoryRef.current?.snapshot,
          )
        : undefined;
      setRevealedSnapshotKey(snapshotKeyString);
    };

    const writeRevealSnapshotToLoadCache = (
      reveal: SessionDetailRevealSnapshotResult,
    ) => {
      return coordinator.writeCacheableRevealSnapshot(reveal, {
        enabled:
          getSessionTranscriptCacheEnabled() && typeof window !== "undefined",
        retainScrollSnapshot: shouldRetainSessionScrollMemory(
          getSessionScrollBehaviorMode(),
        ),
      });
    };

    const completeInitialReveal = (options: {
      snapshot: SessionRouteSnapshot;
      sourceMessageCount: number;
      provider?: string;
      restoredFromSnapshot?: boolean;
    }) => {
      const completion = coordinator.buildInitialRevealCompletion(options);
      const { snapshot } = completion;
      applyRevealSnapshot(snapshot);
      markReloadPerfPhase(
        "session_initial_messages_state_queued",
        completion.messagesQueuedPerfDetail,
      );

      // Mark ready and flush buffered stream events after the reveal snapshot
      // has been queued so buffered events merge on top of loaded transcript.
      initialLoad.completeReveal({
        processMessage: processStreamMessage,
        processSubagentMessage: processStreamSubagentMessage,
      });

      setLoading(false);
      setSessionLoadProgress(completion.loadCompleteProgress);
      markReloadPerfPhase(
        "session_initial_load_complete",
        completion.loadCompletePerfDetail,
      );
    };

    const finishWarmHydration = (options: {
      loadedSession: SessionMetadata;
      loadedPagination?: PaginationInfo;
      sourceMessageCount: number;
      provider?: string;
      diagnosticBoundary: string;
    }): SessionDetailRevealSnapshotResult => {
      const reveal = readRevealSnapshotAfterStoreUpdate(
        options.diagnosticBoundary,
        {
          session: options.loadedSession,
          pagination: options.loadedPagination,
          lastMessageId: readStoreLastMessageId(),
          scrollSnapshot: scrollSnapshotRef.current,
        },
      );
      const { snapshot } = reveal;
      completeInitialReveal({
        snapshot,
        sourceMessageCount: options.sourceMessageCount,
        provider: options.provider,
        restoredFromSnapshot: true,
      });
      return reveal;
    };

    const applyWarmDataBeforeHydration = (data: GetSessionResult) => {
      if (!warmLoad) return;
      markReloadPerfPhase(
        "session_initial_load_data_ready",
        coordinator.buildInitialLoadDataReadyPerfDetail(data, {
          restoredFromSnapshot: true,
        }),
      );
      const applied = coordinator.applyWarmRefresh(data, {
        warmSnapshot: warmLoad,
        initialAfterMessageId,
      });
      setSessionLoadProgress(
        coordinator.buildAppliedLoadProgress("rendering", applied),
      );
      const reveal = finishWarmHydration({
        loadedSession: data.session,
        loadedPagination: applied.pagination,
        sourceMessageCount: applied.sourceMessageCount,
        provider: data.session.provider,
        diagnosticBoundary: "warm-catchup-before-hydration",
      });
      writeRevealSnapshotToLoadCache(reveal);
      notifyLoadComplete(data, applied.sourceMessageCount);
    };

    const applyWarmDeltaAfterHydration = (data: GetSessionResult) => {
      if (!warmLoad) return;
      markReloadPerfPhase(
        "session_initial_load_data_ready",
        coordinator.buildInitialLoadDataReadyPerfDetail(data, {
          restoredFromSnapshot: true,
          appliedAfterSnapshotHydration: true,
        }),
      );
      const applied = coordinator.applyWarmRefresh(data, {
        warmSnapshot: warmLoad,
        initialAfterMessageId,
      });
      const reveal = readRevealSnapshotAfterStoreUpdate(
        "warm-catchup-after-hydration",
        {
          session: data.session,
          pagination: applied.pagination,
          lastMessageId: readStoreLastMessageId(),
          scrollSnapshot: scrollSnapshotRef.current,
        },
      );
      const { snapshot } = reveal;
      applyRevealSnapshot(snapshot);
      setSessionLoadProgress(
        coordinator.buildRouteSnapshotLoadProgress("complete", snapshot, {
          messageCount: snapshot.pagination?.returnedMessageCount,
        }),
      );
      notifyLoadComplete(data, applied.sourceMessageCount);
    };

    markReloadPerfPhase("session_initial_load_start", {
      projectId,
      sessionId,
      tailCompactions: initialHistoryCompactions,
      tailTurns: effectiveTailTurns,
      tailFrom,
      restoredFromSnapshot: initialLoad.restoredFromSnapshot,
    });
    scrollSnapshotRef.current = shouldRetainSessionScrollMemory(
      getSessionScrollBehaviorMode(),
    )
      ? selectFurthestSessionScrollMemory(
          warmLoad?.scrollSnapshot,
          deviceScrollMemoryRef.current?.snapshot,
        )
      : undefined;
    setRevealedSnapshotKey(null);
    if (warmLoad) {
      resetSessionDetailState(warmLoad);
      markReloadPerfPhase("session_snapshot_hydration_installed", {
        projectId,
        sessionId,
        messageCount: warmLoad.messages.length,
        messagesIdentityPreserved:
          coordinator.readSelected(selectSessionDetailMessages) ===
          warmLoad.messages,
      });
      setSessionLoadProgress(
        coordinator.buildRouteSnapshotLoadProgress("fetching", warmLoad),
      );
      setLoading(true);
      void (async () => {
        setSessionLoadProgress(
          coordinator.buildRouteSnapshotLoadProgress("rendering", warmLoad),
        );
        await yieldForSessionLoadingProgressPaint(true);
        if (cancelled) return;
        warmHydrated = true;
        if (pendingWarmData) {
          applyWarmDataBeforeHydration(pendingWarmData);
          return;
        }
        finishWarmHydration({
          loadedSession: warmLoad.session,
          loadedPagination: warmLoad.pagination,
          sourceMessageCount: warmLoad.messages.length,
          provider: warmLoad.session.provider,
          diagnosticBoundary: "warm-route-snapshot",
        });
        if (pendingWarmError) {
          onLoadError?.(pendingWarmError);
        }
      })();
    } else {
      setSessionLoadProgress(coordinator.buildLoadProgress("fetching"));
      resetSessionDetailState();
      setLoading(true);
    }

    const initialHistoryRequest = buildInitialHistoryRequest({
      projectId,
      sessionId,
      compactBoundaries: initialHistoryCompactions,
      afterMessageId: readStoreLastMessageId(),
      tailTurns: effectiveTailTurns,
      tailFrom,
    });
    initialAfterMessageId = initialHistoryRequest.afterMessageId;
    sourceApi
      .getSession(initialHistoryRequest)
      .then(async (data) => {
        if (cancelled) return;
        if (warmLoad) {
          if (!warmHydrated) {
            pendingWarmData = data;
            return;
          }
          applyWarmDeltaAfterHydration(data);
          return;
        }
        markReloadPerfPhase(
          "session_initial_load_data_ready",
          coordinator.buildInitialLoadDataReadyPerfDetail(data),
        );
        setSessionLoadProgress(
          coordinator.buildDataLoadProgress("rendering", data),
        );
        await yieldForSessionLoadingProgressPaint(detailedLoadingProgress);
        if (cancelled) return;

        const applied = coordinator.applyInitialLoad(data);
        const reveal = readRevealSnapshotAfterStoreUpdate("initial-load", {
          session: data.session,
          pagination: applied.pagination,
          lastMessageId: readStoreLastMessageId(),
          scrollSnapshot: scrollSnapshotRef.current,
        });
        const { snapshot } = reveal;
        completeInitialReveal({
          snapshot,
          sourceMessageCount: applied.sourceMessageCount,
          provider: data.session.provider,
        });

        writeRevealSnapshotToLoadCache(reveal);

        notifyLoadComplete(data, applied.sourceMessageCount);
      })
      .catch((err) => {
        if (cancelled) return;
        if (warmLoad) {
          const error = toError(err);
          markReloadPerfPhase(
            "session_initial_load_error",
            coordinator.buildInitialLoadErrorPerfDetail(error, {
              restoredFromSnapshot: true,
            }),
          );
          if (!warmHydrated) {
            pendingWarmError = error;
            return;
          }
          onLoadError?.(error);
          return;
        }
        markReloadPerfPhase(
          "session_initial_load_error",
          coordinator.buildInitialLoadErrorPerfDetail(err),
        );
        setSessionLoadProgress(coordinator.buildLoadProgress("error"));
        setLoading(false);
        onLoadError?.(err);
      });
    return () => {
      cancelled = true;
    };
  }, [
    projectId,
    sessionId,
    effectiveTailTurns,
    initialHistoryCompactions,
    tailFrom,
    detailedLoadingProgress,
    onLoadComplete,
    notifyTranscriptReconciled,
    onLoadError,
    coordinator,
    resetSessionDetailState,
    processStreamMessage,
    processStreamSubagentMessage,
    readStoreLastMessageId,
    snapshotKeyString,
    sourceApi,
    warnSessionDetailStore,
    sourceSummary,
  ]);

  // Handle streaming content updates (from useStreamingContent)
  const handleStreamingUpdate = useCallback(
    (streamingMessage: Message, agentId?: string) => {
      const messageId = getMessageId(streamingMessage);
      if (!messageId) return;

      dispatchSessionDetailAction({
        type: "upsertStreamingPlaceholder",
        message: streamingMessage,
        agentId,
      });
    },
    [dispatchSessionDetailAction],
  );

  // Handle stream message event (with buffering)
  const handleStreamMessageEvent = useCallback(
    (incoming: Message) => {
      const incomingId = getMessageId(incoming);
      const pending = pendingStreamReplacementRef.current;
      if (pending && getMessageId(pending.message) !== incomingId) {
        flushPendingStreamMessage();
      }

      const currentMessages = coordinator.readSelected(
        selectSessionDetailMessages,
      );
      const replacesPublishedMessage =
        incoming._isStreaming !== true &&
        incomingId.length > 0 &&
        currentMessages?.some(
          (message) => getMessageId(message) === incomingId,
        ) === true;
      if (replacesPublishedMessage) {
        const currentPending = pendingStreamReplacementRef.current;
        if (
          currentPending &&
          getMessageId(currentPending.message) === incomingId
        ) {
          currentPending.message = incoming;
          return;
        }
        pendingStreamReplacementRef.current = {
          message: incoming,
          timer: setTimeout(
            flushPendingStreamMessage,
            SAME_ID_STREAM_REPLACEMENT_DELAY_MS,
          ),
        };
        return;
      }
      coordinator.handleStreamMessage(incoming, processStreamMessage);
    },
    [coordinator, flushPendingStreamMessage, processStreamMessage],
  );

  useEffect(() => flushPendingStreamMessage, [flushPendingStreamMessage]);

  // Handle stream subagent message event (with buffering)
  const handleStreamSubagentMessage = useCallback(
    (incoming: Message, agentId: string) => {
      coordinator.handleStreamSubagentMessage(
        incoming,
        agentId,
        processStreamSubagentMessage,
      );
    },
    [coordinator, processStreamSubagentMessage],
  );

  // Register toolUse → agent mapping
  const registerToolUseAgent = useCallback(
    (toolUseId: string, agentId: string) => {
      dispatchSessionDetailAction({
        type: "registerToolUseAgent",
        toolUseId,
        agentId,
      });
    },
    [dispatchSessionDetailAction],
  );

  const mergeLoadedAgentContent = useCallback(
    (agentId: string, content: AgentContent) => {
      dispatchSessionDetailAction({
        type: "mergeLoadedAgentContent",
        agentId,
        content,
      });
    },
    [dispatchSessionDetailAction],
  );

  const updateAgentContextUsage = useCallback(
    (agentId: string, contextUsage: AgentContextUsage) => {
      dispatchSessionDetailAction({
        type: "updateAgentContextUsage",
        agentId,
        contextUsage,
      });
    },
    [dispatchSessionDetailAction],
  );

  const clearAgentStreamingPlaceholders = useCallback(
    (agentId: string) => {
      dispatchSessionDetailAction({
        type: "clearAgentStreamingPlaceholders",
        agentId,
      });
    },
    [dispatchSessionDetailAction],
  );

  const clearStreamingPlaceholders = useCallback(() => {
    dispatchSessionDetailAction({ type: "clearStreamingPlaceholders" });
  }, [dispatchSessionDetailAction]);

  const removeUnconfirmedSelfSend = useCallback(
    (tempId: string) => {
      dispatchSessionDetailAction({
        type: "removeUnconfirmedSelfSend",
        tempId,
      });
    },
    [dispatchSessionDetailAction],
  );

  // Fetch new messages incrementally (for file change events)
  const fetchNewMessages = useCallback(
    (trigger?: IncrementalFetchTrigger) => {
      return coordinator.runExclusiveFetchNewMessages(async () => {
        const requestId = ++incrementalFetchSequenceRef.current;
        let afterMessageId: string | undefined;
        const perfDetail = {
          ...trigger,
          projectId,
          sessionId,
          requestId,
        };
        markReloadPerfPhase(
          "session_incremental_fetch_request_start",
          perfDetail,
        );
        try {
          afterMessageId = readStoreLastMessageId();
          const data = await sourceApi.getSession(
            afterMessageId
              ? {
                  projectId,
                  sessionId,
                  afterMessageId,
                }
              : buildInitialHistoryRequest({
                  projectId,
                  sessionId,
                  compactBoundaries: initialHistoryCompactions,
                  tailTurns: effectiveTailTurns,
                  tailFrom,
                }),
          );
          markReloadPerfPhase("session_incremental_fetch_data_ready", {
            ...perfDetail,
            afterMessageId,
            sourceMessageCount: data.messages.length,
          });
          sourceSummary.reportProviderRuntimeStatusSnapshot(
            coordinator.buildProviderRuntimeStatusSnapshot(data),
          );
          const applied = coordinator.applyIncrementalRefresh(data, {
            afterMessageId,
          });
          notifyTranscriptReconciled(
            data,
            applied.applied ? applied.sourceMessageCount : 0,
          );
          if (applied.applied) {
            reportStoreDivergence("catchup", { session: data.session });
          }
          // Update session metadata (including title, model, contextUsage) which may have changed
          // For new sessions, prev may be null if JSONL didn't exist on initial load
          updateSession((prev) =>
            prev ? { ...prev, ...data.session } : data.session,
          );
          markReloadPerfPhase("session_incremental_fetch_state_queued", {
            ...perfDetail,
            afterMessageId,
            applied: applied.applied,
            messageCount: applied.messageCount,
            sourceMessageCount: applied.sourceMessageCount,
          });
        } catch (error) {
          const incrementalError = toError(error);
          markReloadPerfPhase("session_incremental_fetch_error", {
            ...perfDetail,
            afterMessageId,
            error: incrementalError.message,
          });
          if (!afterMessageId) {
            debugLogIncrementalRefreshDiagnostic(
              incrementalRefreshDiagnosticRef.current,
              {
                projectId,
                sessionId,
                incrementalError,
                outcome: "failed",
              },
            );
            return;
          }

          markReloadPerfPhase(
            "session_incremental_reconciliation_request_start",
            {
              ...perfDetail,
              afterMessageId,
            },
          );
          try {
            const data = await sourceApi.getSession(
              buildInitialHistoryRequest({
                projectId,
                sessionId,
                compactBoundaries: initialHistoryCompactions,
                tailTurns: effectiveTailTurns,
                tailFrom,
              }),
            );
            markReloadPerfPhase(
              "session_incremental_reconciliation_data_ready",
              {
                ...perfDetail,
                afterMessageId,
                sourceMessageCount: data.messages.length,
              },
            );
            sourceSummary.reportProviderRuntimeStatusSnapshot(
              coordinator.buildProviderRuntimeStatusSnapshot(data),
            );
            const applied = coordinator.applyFullTailReconciliation(data);
            notifyTranscriptReconciled(data, applied.sourceMessageCount);
            reportStoreDivergence("incremental-reconciliation", {
              session: data.session,
            });
            updateSession((prev) =>
              prev ? { ...prev, ...data.session } : data.session,
            );
            markReloadPerfPhase(
              "session_incremental_reconciliation_state_queued",
              {
                ...perfDetail,
                afterMessageId,
                messageCount: applied.messageCount,
                sourceMessageCount: applied.sourceMessageCount,
              },
            );
            debugLogIncrementalRefreshDiagnostic(
              incrementalRefreshDiagnosticRef.current,
              {
                projectId,
                sessionId,
                afterMessageId,
                incrementalError,
                outcome: "recovered",
              },
            );
          } catch (reconciliationFailure) {
            const reconciliationError = toError(reconciliationFailure);
            markReloadPerfPhase("session_incremental_reconciliation_error", {
              ...perfDetail,
              afterMessageId,
              error: reconciliationError.message,
            });
            debugLogIncrementalRefreshDiagnostic(
              incrementalRefreshDiagnosticRef.current,
              {
                projectId,
                sessionId,
                afterMessageId,
                incrementalError,
                reconciliationError,
                outcome: "failed",
              },
            );
          }
        }
      });
    },
    [
      coordinator,
      effectiveTailTurns,
      initialHistoryCompactions,
      notifyTranscriptReconciled,
      projectId,
      sessionId,
      tailFrom,
      readStoreLastMessageId,
      reportStoreDivergence,
      sourceApi,
      sourceSummary,
      updateSession,
    ],
  );

  // One reader demand advances through compact-boundary pages until it exposes
  // a real user turn. Bound both pages and newly retained bytes so a pathologically
  // large tool/assistant span requires an explicit continuation instead of
  // monopolizing the client.
  const loadOlderMessages = useCallback(async () => {
    if (!coordinator.buildOlderPageRequest().requested) {
      return;
    }
    coordinator.suppressActiveWindowTrimForHistoryExpansion();
    setOlderLoadContinuation({ routeKey: snapshotKeyString, required: false });
    setLoadingOlder(true);
    const initialBytes = coordinator.getEntryApproxBytes() ?? 0;
    const additionalByteLimit = Math.max(
      1,
      getSessionDetailRetentionDefaults().maxBytes,
    );
    try {
      const seenCursors = new Set<string>();
      let pageCount = 0;
      let staleCursorRecoveryAttempted = false;
      while (pageCount < OLDER_USER_TURN_LOAD_PAGE_LIMIT) {
        const request = coordinator.buildOlderPageRequest();
        if (!request.requested) {
          break;
        }
        const cursor = request.input.beforeMessageId;
        if (!cursor || seenCursors.has(cursor)) {
          break;
        }
        seenCursors.add(cursor);

        const data = await sourceApi.getSession(request.input);
        sourceSummary.reportProviderRuntimeStatusSnapshot(
          coordinator.buildProviderRuntimeStatusSnapshot(data),
        );

        // A server/client identity change can leave a mounted transcript with
        // a before-message cursor the freshly normalized transcript no longer
        // contains. The API reports that miss as an empty terminal page.
        // Refresh the bounded tail once to acquire its current cursor, then
        // continue the same explicit older-history demand.
        if (data.messages.length === 0) {
          if (staleCursorRecoveryAttempted) {
            break;
          }
          staleCursorRecoveryAttempted = true;
          const refreshedTail = await sourceApi.getSession(
            buildInitialHistoryRequest({
              projectId,
              sessionId,
              compactBoundaries: initialHistoryCompactions,
              tailTurns: effectiveTailTurns,
              tailFrom,
            }),
          );
          sourceSummary.reportProviderRuntimeStatusSnapshot(
            coordinator.buildProviderRuntimeStatusSnapshot(refreshedTail),
          );
          if (refreshedTail.messages.length === 0) {
            break;
          }
          coordinator.applyFullTailReconciliation(refreshedTail);
          reportStoreDivergence("older-page-cursor-recovery", {
            session: refreshedTail.session,
          });
          continue;
        }

        pageCount += 1;
        coordinator.applyOlderPage(data);
        reportStoreDivergence("older-page", { session: data.session });

        if (data.messages.some(isActiveWindowRealUserTurn)) {
          break;
        }
        const nextRequest = coordinator.buildOlderPageRequest();
        if (!nextRequest.requested) {
          break;
        }
        const retainedAdditionalBytes = Math.max(
          0,
          (coordinator.getEntryApproxBytes() ?? initialBytes) - initialBytes,
        );
        const reachedSafetyBoundary =
          pageCount >= OLDER_USER_TURN_LOAD_PAGE_LIMIT ||
          retainedAdditionalBytes >= additionalByteLimit;
        if (reachedSafetyBoundary) {
          setOlderLoadContinuation({
            routeKey: snapshotKeyString,
            required: true,
          });
          break;
        }
      }
    } catch {
      // Silent fail for loading older messages
    } finally {
      setLoadingOlder(false);
    }
  }, [
    coordinator,
    effectiveTailTurns,
    initialHistoryCompactions,
    projectId,
    reportStoreDivergence,
    sessionId,
    snapshotKeyString,
    sourceApi,
    sourceSummary,
    tailFrom,
  ]);

  const readOlderSearchPage = useCallback(
    (beforeMessageId: string) =>
      sourceApi.getSession({
        projectId,
        sessionId,
        tailCompactions: 2,
        beforeMessageId,
      }),
    [projectId, sessionId, sourceApi],
  );

  const updateRouteScrollSnapshot = useCallback(
    (snapshot: SessionRouteScrollSnapshot) => {
      coordinator.setActiveWindowFollowingBottom(snapshot.atBottom);
      if (!shouldRetainSessionScrollMemory(getSessionScrollBehaviorMode())) {
        scrollSnapshotRef.current = undefined;
        return;
      }
      let retainedSnapshot = snapshot;
      if (
        (snapshot.seenTurn || snapshot.completedTurn) &&
        isDocumentVisibleForScrollMemory()
      ) {
        deviceScrollCandidateRef.current = {
          key: scrollMemoryStorageKey,
          snapshot,
        };
        const result = writeSessionScrollMemory(
          scrollMemoryReference,
          snapshot,
        );
        if (result) {
          deviceScrollMemoryRef.current = {
            key: scrollMemoryStorageKey,
            snapshot: result.snapshot,
          };
          retainedSnapshot =
            selectFurthestSessionScrollMemory(snapshot, result.snapshot) ??
            snapshot;
        }
      }
      scrollSnapshotRef.current = retainedSnapshot;
      coordinator.patchScrollSnapshot(retainedSnapshot);
    },
    [coordinator, scrollMemoryReference, scrollMemoryStorageKey],
  );
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const reconcileDeviceScrollMemory = () => {
      if (!shouldRetainSessionScrollMemory(getSessionScrollBehaviorMode())) {
        return;
      }
      let stored = readSessionScrollMemory(scrollMemoryReference);
      const current = scrollSnapshotRef.current;
      const visibleCandidate = deviceScrollCandidateRef.current.snapshot;
      if (visibleCandidate && isDocumentVisibleForScrollMemory()) {
        const result = writeSessionScrollMemory(
          scrollMemoryReference,
          visibleCandidate,
        );
        stored = result?.snapshot ?? stored;
      }
      deviceScrollMemoryRef.current = {
        key: scrollMemoryStorageKey,
        snapshot: stored,
      };
      const winner = selectFurthestSessionScrollMemory(current, stored);
      if (winner && winner !== current) {
        scrollSnapshotRef.current = winner;
        coordinator.patchScrollSnapshot(winner);
      }
    };
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key === null ||
        isSessionScrollMemoryStorageKey(scrollMemoryReference, event.key)
      ) {
        reconcileDeviceScrollMemory();
      }
    };
    const handleVisibility = () => {
      if (isDocumentVisibleForScrollMemory()) {
        reconcileDeviceScrollMemory();
      }
    };

    window.addEventListener("storage", handleStorage);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("storage", handleStorage);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [coordinator, scrollMemoryReference, scrollMemoryStorageKey]);
  const updateActiveWindowFollowingBottom = useCallback(
    (followingBottom: boolean) => {
      coordinator.setActiveWindowFollowingBottom(followingBottom);
    },
    [coordinator],
  );

  // Fetch session metadata only
  const fetchSessionMetadata = useCallback(async () => {
    try {
      const data = await sourceApi.getSessionMetadata({
        projectId,
        sessionId,
      });
      sourceSummary.reportProviderRuntimeStatusSnapshot(
        coordinator.buildProviderRuntimeStatusSnapshot(data),
      );
      const metadataSession = {
        ...data.session,
        ownership: data.ownership,
      };
      // For new sessions, prev may be null if JSONL didn't exist on initial load
      updateSession((prev) =>
        prev ? { ...prev, ...metadataSession } : metadataSession,
      );
    } catch {
      // Silent fail for metadata updates
    }
  }, [
    coordinator,
    projectId,
    sessionId,
    sourceApi,
    sourceSummary,
    updateSession,
  ]);
  const selectedInitialScrollSnapshot = shouldRetainSessionScrollMemory(
    getSessionScrollBehaviorMode(),
  )
    ? (scrollSnapshotRef.current ??
      coordinator.readScrollSnapshot() ??
      cachedLoad?.scrollSnapshot ??
      null)
    : null;

  return {
    messages: returnedMessages,
    agentContent: returnedAgentContent,
    toolUseToAgent: returnedToolUseToAgent,
    markdownAugments: returnedMarkdownAugments,
    applyFinalMarkdownAugment,
    loading,
    sessionLoadProgress,
    session: storeBackedDetail?.session ?? null,
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
    fetchSessionMetadata,
    pagination: storeBackedDetail?.pagination,
    activeWindowTrimRevision:
      storeBackedDetail?.revealed?.activeWindowTrimRevision ?? 0,
    loadingOlder,
    olderLoadContinuationRequired,
    loadOlderMessages,
    readOlderSearchPage,
    initialScrollSnapshot: selectedInitialScrollSnapshot,
    updateRouteScrollSnapshot,
    updateActiveWindowFollowingBottom,
    restoredFromSnapshot: Boolean(cachedLoad),
  };
}
