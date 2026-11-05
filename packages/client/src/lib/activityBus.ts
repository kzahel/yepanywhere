import type { SessionClearloopBadge } from "@yep-anywhere/shared";
import type {
  AgentActivity,
  NonHumanUserTurn,
  CacheMissBillingRecord,
  SessionRewindRecord,
  ContextUsage,
  PendingInputType,
  ProjectCaptionsChangedEvent,
  ProjectCodeNameChangedEvent,
  ProjectQueueChangedEvent,
  ProjectsChangedEvent,
  ProviderName,
  SessionCreationProvenance,
  SessionCreationStatus,
  ProviderRuntimeStatus,
  PromptSuggestionMode,
  SafeRestartChangedEvent,
  SafeRestartState,
  SessionCatalogUpdatedEvent,
  RecentsChangedEvent,
  TranscriptDisplayObject,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type { SessionStatus, SessionSummary } from "../types";
import {
  createManagedStream,
  type ManagedStream,
  type ManagedStreamEvent,
  SERVER_PUSH_INACTIVITY_TIMEOUT_MS,
  type SourceTransport,
} from "./transport";

declare global {
  interface Window {
    __ACTIVITY_DEBUG__?: boolean;
  }
}

// Event types matching what the server emits
export type FileChangeType = "create" | "modify" | "delete";
export type FileType =
  | "session"
  | "agent-session"
  | "settings"
  | "credentials"
  | "telemetry"
  | "other";

export interface FileChangeEvent {
  type: "file-change";
  provider: "claude" | "gemini" | "codex";
  path: string;
  relativePath: string;
  changeType: FileChangeType;
  timestamp: string;
  mtimeMs?: number;
  size?: number;
  fileType: FileType;
}

export interface SessionStatusEvent {
  type: "session-status-changed";
  sessionId: string;
  projectId: UrlProjectId;
  ownership: SessionStatus;
  timestamp: string;
}

export interface SessionCreatedEvent {
  type: "session-created";
  session: SessionSummary;
  timestamp: string;
}

export interface SessionIdRemappedEvent {
  type: "session-id-remapped";
  oldSessionId: string;
  newSessionId: string;
  projectId: UrlProjectId;
  processId: string;
  provider: ProviderName;
  timestamp: string;
}

export interface SessionSeenEvent {
  type: "session-seen";
  sessionId: string;
  /** When the session was read; `SESSION_UNREAD_TIMESTAMP` means unread. */
  timestamp: string;
  messageId?: string;
}

export interface ProcessStateEvent {
  type: "process-state-changed";
  sessionId: string;
  projectId: UrlProjectId;
  activity: AgentActivity;
  /** Type of pending input (only set when activity is "waiting-input") */
  pendingInputType?: PendingInputType;
  timestamp: string;
}

export interface ReviewResponseChangedEvent {
  type: "review-response-changed";
  projectId: UrlProjectId;
  submissionIds: string[];
  timestamp: string;
}

export interface ProviderRuntimeStatusChangedEvent {
  type: "provider-runtime-status-changed";
  sessionId: string;
  projectId: UrlProjectId;
  providerRuntimeStatus: ProviderRuntimeStatus;
  timestamp: string;
}

export interface SessionMetadataChangedEvent {
  /** Optional on older servers; ordinary startup recovery remains available. */
  creation?: SessionCreationStatus;
  nativeSessionId?: string;
  nonHumanUserTurn?: NonHumanUserTurn | null;
  creationProvenance?: SessionCreationProvenance;
  type: "session-metadata-changed";
  sessionId: string;
  title?: string;
  archived?: boolean;
  starred?: boolean;
  /** Sidebar category after the change; null when removed. */
  sidebarCategory?: string | null;
  parentSessionId?: string | null;
  parentSessionKind?: "btw-aside" | null;
  forkedFromSessionId?: string | null;
  /** Remaining `/clearloop` iterations; null when the loop ended. */
  clearloop?: SessionClearloopBadge | null;
  /** A same-session rewind just recorded; the open session applies it. */
  rewindRecord?: SessionRewindRecord;
  /** A rewind record the provider refused; the open session reloads. */
  rewindRecordRemoved?: string;
  promptSuggestionMode?: PromptSuggestionMode;
  recapAfterSeconds?: number;
  transcriptDisplayObjects?: TranscriptDisplayObject[];
  /** YA's effective project/working directory for this session, if changed. */
  projectId?: UrlProjectId;
  /** Provider transcript project when it differs from the effective project. */
  transcriptProjectId?: UrlProjectId | null;
  timestamp: string;
}

/**
 * Event emitted when session content changes (title, messageCount, etc.).
 * This is different from session-metadata-changed which is for user-set metadata.
 * This event is for auto-derived values from the session JSONL file.
 */
export interface SessionUpdatedEvent {
  type: "session-updated";
  sessionId: string;
  projectId: UrlProjectId;
  /** New title (derived from first user message) */
  title?: string | null;
  /** New message count */
  messageCount?: number;
  /** Updated timestamp */
  updatedAt?: string;
  /** Context window usage from the last assistant message */
  contextUsage?: ContextUsage;
  /** Resolved model name (e.g., "claude-sonnet-4-5-20250929") */
  model?: string;
  /** Capped excerpt of the most recent regular agent turn (hover card). */
  lastAgentText?: string;
  asyncQuestions?: SessionSummary["asyncQuestions"];
  timestamp: string;
}

// Dev mode events
export interface SourceChangeEvent {
  type: "source-change";
  target: "backend" | "frontend";
  files: string[];
  timestamp: string;
}

export interface WorkerActivityEvent {
  type: "worker-activity-changed";
  /** Owned provider processes, including idle retained workers. */
  activeWorkers: number;
  /** Sessions that would interrupt active work if the server restarts now. */
  interruptibleSessionCount?: number;
  /** Supervisor worker queue length. */
  queueLength: number;
  /** In-memory user turns waiting in worker or live per-session queues. */
  queuedSessionMessageCount?: number;
  /** True if any session has interruptible active work. */
  hasActiveWork: boolean;
  timestamp: string;
}

export type { SafeRestartChangedEvent, SafeRestartState };

export function getInterruptibleSessionCount(
  activity: Pick<
    WorkerActivityEvent,
    "activeWorkers" | "hasActiveWork" | "interruptibleSessionCount"
  >,
): number {
  if (
    typeof activity.interruptibleSessionCount === "number" &&
    Number.isFinite(activity.interruptibleSessionCount)
  ) {
    return Math.max(0, activity.interruptibleSessionCount);
  }
  return activity.hasActiveWork ? activity.activeWorkers : 0;
}

/** Event emitted when a browser tab connects to the activity stream */
export interface BrowserTabConnectedEvent {
  type: "browser-tab-connected";
  browserProfileId: string;
  connectionId: number;
  transport: "ws";
  /** Total tabs connected for this browserProfileId */
  tabCount: number;
  /** Total tabs connected across all browser profiles */
  totalTabCount: number;
  timestamp: string;
}

/** Event emitted when a browser tab disconnects from the activity stream */
export interface BrowserTabDisconnectedEvent {
  type: "browser-tab-disconnected";
  browserProfileId: string;
  connectionId: number;
  /** Remaining tabs for this browserProfileId (0 = browser profile fully offline) */
  tabCount: number;
  /** Total tabs connected across all browser profiles */
  totalTabCount: number;
  timestamp: string;
}

export interface CacheMissBillingEvent {
  type: "cache-miss-billing" | "cache-miss-billing-expected-expiry";
  record: CacheMissBillingRecord;
  showToast: boolean;
  timestamp: string;
}

export interface SessionQueuePersistenceChangedEvent {
  type: "session-queue-persistence-changed";
  timestamp: string;
}

// Map event names to their data types
export interface ActivityEventMap {
  "recents-changed": RecentsChangedEvent;
  "session-catalog-updated": SessionCatalogUpdatedEvent;
  "file-change": FileChangeEvent;
  "session-status-changed": SessionStatusEvent;
  "session-created": SessionCreatedEvent;
  "session-id-remapped": SessionIdRemappedEvent;
  "session-updated": SessionUpdatedEvent;
  "session-seen": SessionSeenEvent;
  "process-state-changed": ProcessStateEvent;
  "review-response-changed": ReviewResponseChangedEvent;
  "provider-runtime-status-changed": ProviderRuntimeStatusChangedEvent;
  "project-queue-changed": ProjectQueueChangedEvent;
  "project-code-names-changed": ProjectCodeNameChangedEvent;
  "project-captions-changed": ProjectCaptionsChangedEvent;
  "projects-changed": ProjectsChangedEvent;
  "session-queue-persistence-changed": SessionQueuePersistenceChangedEvent;
  "session-metadata-changed": SessionMetadataChangedEvent;
  // Connection events
  "browser-tab-connected": BrowserTabConnectedEvent;
  "browser-tab-disconnected": BrowserTabDisconnectedEvent;
  "cache-miss-billing": CacheMissBillingEvent;
  "cache-miss-billing-expected-expiry": CacheMissBillingEvent;
  // Dev mode events
  "source-change": SourceChangeEvent;
  "backend-reloaded": undefined;
  "worker-activity-changed": WorkerActivityEvent;
  "safe-restart-changed": SafeRestartChangedEvent;
  reconnect: undefined;
  refresh: undefined;
}

export type ActivityEventType = keyof ActivityEventMap;

type Listener<T> = (data: T) => void;
type SourceKey = string;

/** One entry of the trail {@link ActivityBus.getRecentEvents} keeps. */
export interface RecentActivityEvent {
  /** `Date.now()` when the bus dispatched it. */
  atMs: number;
  /** Whether it arrived over the activity stream or was raised in this tab. */
  origin: "stream" | "local";
  type: ActivityEventType;
}

/**
 * How many dispatches the trail keeps. Enough to tell one event's cascade from
 * a burst without holding event payloads alive.
 */
const RECENT_ACTIVITY_EVENT_LIMIT = 24;

interface ActivityStreamRecord {
  sourceKey: SourceKey;
  transport: SourceTransport;
  stream: ManagedStream | null;
  unsubscribeStream: (() => void) | null;
  unsubscribeVisibilityRestored: (() => void) | null;
  retainCount: number;
  connected: boolean;
  hasConnected: boolean;
}

function isActivityDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (window.__ACTIVITY_DEBUG__ === true) return true;
  try {
    return localStorage.getItem("yep-anywhere-activity-debug") === "true";
  } catch {
    return false;
  }
}

/**
 * Singleton compatibility facade for activity events.
 *
 * The transport subscription itself is source-scoped and retained by
 * SourceSummaryRuntime leases. Legacy consumers still subscribe through on()
 * and receive events from the source currently bridged by the app shell.
 */
class ActivityBus {
  private listeners = new Map<ActivityEventType, Set<Listener<unknown>>>();
  private sourceListeners = new Map<
    SourceKey,
    Map<ActivityEventType, Set<Listener<unknown>>>
  >();
  private streamRecords = new Map<SourceKey, ActivityStreamRecord>();
  private bridgeRetainCounts = new Map<SourceKey, number>();
  private streamsSuspended = false;
  private connectedListeners = new Set<() => void>();
  private lastNotifiedConnected = false;
  private recentEvents: RecentActivityEvent[] = [];

  constructor() {
    if (typeof window === "undefined") return;
    window.addEventListener("pagehide", this.handlePageHide);
    window.addEventListener("pageshow", this.handlePageShow);
  }

  private handlePageHide = (): void => {
    if (this.streamsSuspended) return;
    this.streamsSuspended = true;
    for (const record of this.streamRecords.values()) {
      this.detachStream(record);
    }
  };

  private handlePageShow = (): void => {
    if (!this.streamsSuspended) return;
    this.streamsSuspended = false;
    for (const record of this.streamRecords.values()) {
      if (record.retainCount > 0) {
        this.attachStream(record);
      }
    }
  };
  private get debugEnabled(): boolean {
    return isActivityDebugEnabled();
  }

  /**
   * The last few dispatches, oldest first, for the fatal-error report.
   *
   * A client crash from an update storm — React's "Maximum update depth
   * exceeded" — names only the component that happened to enqueue the update
   * that crossed React's limit, which is often a bystander. What the report is
   * missing is what the tab was reacting to, so keep the traffic that preceded
   * the crash: one event's cascade and a burst of them look the same in the
   * stack but call for opposite fixes.
   */
  getRecentEvents(): readonly RecentActivityEvent[] {
    return this.recentEvents;
  }

  private recordRecentEvent(
    type: ActivityEventType,
    origin: RecentActivityEvent["origin"],
  ): void {
    this.recentEvents.push({ atMs: Date.now(), origin, type });
    if (this.recentEvents.length > RECENT_ACTIVITY_EVENT_LIMIT) {
      this.recentEvents.splice(
        0,
        this.recentEvents.length - RECENT_ACTIVITY_EVENT_LIMIT,
      );
    }
  }

  get connected(): boolean {
    for (const [sourceKey, retainCount] of this.bridgeRetainCounts) {
      if (retainCount > 0 && this.streamRecords.get(sourceKey)?.connected) {
        return true;
      }
    }
    return false;
  }

  /**
   * Observe `connected`. Without this every consumer polls the getter on its
   * own interval — the connection state is derived from stream records that
   * only change on open, error, close, and retain changes, so an interval is
   * pure overhead that also delays the answer by up to its period.
   */
  subscribeConnected(listener: () => void): () => void {
    this.connectedListeners.add(listener);
    return () => {
      this.connectedListeners.delete(listener);
    };
  }

  /** Call after anything that can change `connected`. Notifies only on change. */
  private notifyConnectedChanged(): void {
    const connected = this.connected;
    if (connected === this.lastNotifiedConnected) return;
    this.lastNotifiedConnected = connected;
    for (const listener of Array.from(this.connectedListeners)) {
      listener();
    }
  }

  /**
   * Retain a source-bound activity stream. Safe to call multiple times for the
   * same source/transport; the returned cleanup releases one retain.
   */
  retainSourceStream(
    sourceKey: SourceKey,
    transport: SourceTransport,
  ): () => void {
    const record = this.getOrCreateStreamRecord(sourceKey, transport);
    record.retainCount += 1;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.streamRecords.get(sourceKey);
      if (current !== record) {
        return;
      }
      record.retainCount = Math.max(0, record.retainCount - 1);
      if (record.retainCount === 0) {
        this.closeStreamRecord(sourceKey, record);
      }
    };
  }

  /**
   * Retain the source stream and bridge its events to legacy global listeners.
   */
  retainCurrentSourceStream(
    sourceKey: SourceKey,
    transport: SourceTransport,
  ): () => void {
    const releaseStream = this.retainSourceStream(sourceKey, transport);
    this.bridgeRetainCounts.set(
      sourceKey,
      (this.bridgeRetainCounts.get(sourceKey) ?? 0) + 1,
    );
    this.notifyConnectedChanged();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const retainCount = Math.max(
        0,
        (this.bridgeRetainCounts.get(sourceKey) ?? 0) - 1,
      );
      if (retainCount === 0) {
        this.bridgeRetainCounts.delete(sourceKey);
      } else {
        this.bridgeRetainCounts.set(sourceKey, retainCount);
      }
      releaseStream();
      this.notifyConnectedChanged();
    };
  }

  private getOrCreateStreamRecord(
    sourceKey: SourceKey,
    transport: SourceTransport,
  ): ActivityStreamRecord {
    const existing = this.streamRecords.get(sourceKey);
    if (existing?.transport === transport) {
      return existing;
    }

    if (existing) {
      this.closeStreamRecord(sourceKey, existing);
    }

    const record = this.createStreamRecord(sourceKey, transport);
    this.streamRecords.set(sourceKey, record);
    return record;
  }

  private createStreamRecord(
    sourceKey: SourceKey,
    transport: SourceTransport,
  ): ActivityStreamRecord {
    if (this.debugEnabled) {
      console.log("[ActivityBus] Retaining source activity stream", sourceKey);
    }

    const record: ActivityStreamRecord = {
      sourceKey,
      transport,
      stream: null,
      unsubscribeStream: null,
      unsubscribeVisibilityRestored: null,
      retainCount: 0,
      connected: false,
      // A cold source can mount pages before its first socket is available.
      // Its first open must revalidate reads that failed during acquisition.
      hasConnected: transport.status.getSnapshot().state !== "ready",
    };
    if (!this.streamsSuspended) {
      this.attachStream(record);
    }
    return record;
  }

  private attachStream(record: ActivityStreamRecord): void {
    if (record.stream) return;
    const stream = createManagedStream(
      record.transport,
      {
        subscribe: ({ transport: activeTransport, handlers }) =>
          activeTransport.subscribeActivity(handlers),
        captureEventId: () => undefined,
        onEvent: (event) => this.handleStreamEvent(record, event),
        onOpen: () => this.handleStreamOpen(record),
        onError: (error) => this.handleStreamError(record, error),
        onClose: (error) => this.handleStreamClose(record, error),
      },
      {
        autoStart: false,
        inactivityTimeoutMs: SERVER_PUSH_INACTIVITY_TIMEOUT_MS,
      },
    );
    record.stream = stream;
    record.unsubscribeStream = stream.subscribe(() => {
      record.connected = stream.getSnapshot().connected;
      this.notifyConnectedChanged();
    });
    record.unsubscribeVisibilityRestored =
      record.transport.status.subscribeVisibilityRestored?.(() => {
        if (record.connected) {
          this.emitFromSource(record.sourceKey, "refresh", undefined);
        }
      }) ?? null;
    stream.start();
  }

  private detachStream(record: ActivityStreamRecord): void {
    record.unsubscribeVisibilityRestored?.();
    record.unsubscribeVisibilityRestored = null;
    record.unsubscribeStream?.();
    record.unsubscribeStream = null;
    record.stream?.close();
    record.stream = null;
    record.connected = false;
    this.notifyConnectedChanged();
  }

  private closeStreamRecord(
    sourceKey: SourceKey,
    record: ActivityStreamRecord,
  ): void {
    this.detachStream(record);
    this.streamRecords.delete(sourceKey);
  }

  /**
   * Handle events from WebSocket subscription.
   */
  private handleStreamEvent(
    record: ActivityStreamRecord,
    event: ManagedStreamEvent,
  ): void {
    if (event.eventType === "heartbeat" || event.eventType === "connected") {
      return;
    }

    // Emit the event to listeners
    if (this.isValidEventType(event.eventType)) {
      this.recordRecentEvent(event.eventType, "stream");
      if (this.debugEnabled) {
        console.log(
          "[ActivityBus] Dispatching source event:",
          record.sourceKey,
          event.eventType,
          event.data,
        );
      }
      this.emitFromSource(
        record.sourceKey,
        event.eventType,
        event.data as ActivityEventMap[typeof event.eventType],
      );
    } else if (this.debugEnabled) {
      console.log(
        "[ActivityBus] Dropping unknown event type:",
        event.eventType,
        event.data,
      );
    }
  }

  private handleStreamOpen(record: ActivityStreamRecord): void {
    record.connected = true;
    this.notifyConnectedChanged();
    if (this.debugEnabled) {
      console.log(
        "[ActivityBus] Source activity stream opened",
        record.sourceKey,
      );
    }

    if (record.hasConnected) {
      this.emitFromSource(record.sourceKey, "reconnect", undefined);
    }
    record.hasConnected = true;
  }

  private handleStreamError(record: ActivityStreamRecord, error: Error): void {
    record.connected = false;
    this.notifyConnectedChanged();
    const isExpectedReconnectError =
      error.message === "Connection reconnecting";
    if (!isExpectedReconnectError) {
      console.error("[ActivityBus] Connection error:", error);
    } else if (this.debugEnabled) {
      console.log("[ActivityBus] Connection reconnecting");
    }
  }

  private handleStreamClose(
    record: ActivityStreamRecord,
    error: Error | undefined,
  ): void {
    record.connected = false;
    this.notifyConnectedChanged();
    if (this.debugEnabled) {
      console.log("[ActivityBus] Source activity stream closed", {
        sourceKey: record.sourceKey,
        message: error?.message,
      });
    }
  }

  /**
   * Type guard for valid event types.
   */
  private isValidEventType(type: string): type is ActivityEventType {
    return [
      "file-change",
      "session-catalog-updated",
      "recents-changed",
      "session-status-changed",
      "session-created",
      "session-id-remapped",
      "session-updated",
      "session-seen",
      "process-state-changed",
      "review-response-changed",
      "provider-runtime-status-changed",
      "project-queue-changed",
      "project-code-names-changed",
      "project-captions-changed",
      "projects-changed",
      "session-queue-persistence-changed",
      "session-metadata-changed",
      "browser-tab-connected",
      "browser-tab-disconnected",
      "cache-miss-billing",
      "cache-miss-billing-expected-expiry",
      "source-change",
      "backend-reloaded",
      "worker-activity-changed",
      "safe-restart-changed",
      "reconnect",
      "refresh",
    ].includes(type);
  }

  /**
   * Subscribe to a source-specific event type. Returns an unsubscribe
   * function.
   */
  onSource<K extends ActivityEventType>(
    sourceKey: SourceKey,
    eventType: K,
    callback: Listener<ActivityEventMap[K]>,
  ): () => void {
    let sourceMap = this.sourceListeners.get(sourceKey);
    if (!sourceMap) {
      sourceMap = new Map();
      this.sourceListeners.set(sourceKey, sourceMap);
    }
    let set = sourceMap.get(eventType);
    if (!set) {
      set = new Set();
      sourceMap.set(eventType, set);
    }
    set.add(callback as Listener<unknown>);

    return () => {
      set.delete(callback as Listener<unknown>);
      if (set.size === 0) {
        sourceMap.delete(eventType);
      }
      if (sourceMap.size === 0) {
        this.sourceListeners.delete(sourceKey);
      }
    };
  }

  /**
   * Subscribe to an event type. Returns an unsubscribe function.
   */
  on<K extends ActivityEventType>(
    eventType: K,
    callback: Listener<ActivityEventMap[K]>,
  ): () => void {
    let set = this.listeners.get(eventType);
    if (!set) {
      set = new Set();
      this.listeners.set(eventType, set);
    }
    set.add(callback as Listener<unknown>);

    return () => {
      set.delete(callback as Listener<unknown>);
    };
  }

  emitLocal<K extends ActivityEventType>(
    eventType: K,
    data: ActivityEventMap[K],
  ): void {
    this.recordRecentEvent(eventType, "local");
    if (this.debugEnabled) {
      console.log("[ActivityBus] Dispatching local event:", eventType, data);
    }
    this.emit(eventType, data);
    for (const sourceKey of this.bridgeRetainCounts.keys()) {
      this.emitSource(sourceKey, eventType, data);
    }
  }

  private emit<K extends ActivityEventType>(
    eventType: K,
    data: ActivityEventMap[K],
  ): void {
    const set = this.listeners.get(eventType);
    if (set) {
      for (const listener of set) {
        listener(data);
      }
    }
  }

  private emitFromSource<K extends ActivityEventType>(
    sourceKey: SourceKey,
    eventType: K,
    data: ActivityEventMap[K],
  ): void {
    this.emitSource(sourceKey, eventType, data);
    if ((this.bridgeRetainCounts.get(sourceKey) ?? 0) > 0) {
      this.emit(eventType, data);
    }
  }

  private emitSource<K extends ActivityEventType>(
    sourceKey: SourceKey,
    eventType: K,
    data: ActivityEventMap[K],
  ): void {
    const set = this.sourceListeners.get(sourceKey)?.get(eventType);
    if (set) {
      for (const listener of set) {
        listener(data);
      }
    }
  }

  resetForTests(): void {
    for (const [sourceKey, record] of Array.from(this.streamRecords)) {
      this.closeStreamRecord(sourceKey, record);
    }
    this.listeners.clear();
    this.sourceListeners.clear();
    this.bridgeRetainCounts.clear();
    this.streamsSuspended = false;
  }
}

export const activityBus = new ActivityBus();
