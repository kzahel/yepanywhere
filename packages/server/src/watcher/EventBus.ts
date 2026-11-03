/**
 * Simple in-memory pub/sub event bus for file change and session status events.
 */

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
  SessionCreationProvenance,
  ProviderRuntimeStatus,
  PromptSuggestionMode,
  SafeRestartChangedEvent,
  SessionCatalogUpdatedEvent,
  RecentsChangedEvent,
  TranscriptDisplayObject,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type { SessionOwnership, SessionSummary } from "../supervisor/types.js";

export type FileChangeType = "create" | "modify" | "delete";

/** Provider that owns the watched directory */
export type WatchProvider =
  | "claude"
  | "gemini"
  | "codex"
  | "pi"
  | "antigravity";

export interface FileChangeEvent {
  type: "file-change";
  /** Provider that owns this file */
  provider: WatchProvider;
  path: string;
  relativePath: string;
  /** Physical native store reported by the emitting watcher, never a YA id. */
  nativeStorageScope?: string;
  changeType: FileChangeType;
  timestamp: string;
  /** Exact source-file facts when the watcher observed an existing file. */
  mtimeMs?: number;
  size?: number;
  /** Parsed file type based on path */
  fileType:
    | "session"
    | "agent-session"
    | "settings"
    | "credentials"
    | "telemetry"
    | "other";
}

export interface SessionStatusEvent {
  type: "session-status-changed";
  sessionId: string;
  /** Base64url-encoded project path (UrlProjectId format) */
  projectId: UrlProjectId;
  ownership: SessionOwnership;
  timestamp: string;
}

export interface SessionCreatedEvent {
  type: "session-created";
  session: SessionSummary;
  timestamp: string;
}

/** Event emitted when source code changes and manual reload is needed */
export interface SourceChangeEvent {
  type: "source-change";
  target: "backend" | "frontend";
  files: string[];
  timestamp: string;
}

/** Event emitted when the backend server has restarted (for multi-tab sync) */
export interface BackendReloadedEvent {
  type: "backend-reloaded";
  timestamp: string;
}

/** Event emitted when a session is marked as seen (for cross-tab/device sync) */
export interface SessionSeenEvent {
  type: "session-seen";
  sessionId: string;
  /** When the session was read; `SESSION_UNREAD_TIMESTAMP` means unread. */
  timestamp: string;
  messageId?: string;
}

/** Event emitted when a process activity changes (in-turn vs waiting for input) */
export interface ProcessStateEvent {
  type: "process-state-changed";
  sessionId: string;
  /** Base64url-encoded project path (UrlProjectId format) */
  projectId: UrlProjectId;
  /** Current agent activity - what the agent is doing */
  activity: AgentActivity;
  /** Type of pending input (only set when activity is "waiting-input") */
  pendingInputType?: PendingInputType;
  timestamp: string;
}

/** Event emitted when a process terminates unexpectedly. */
export interface ProcessTerminatedEvent {
  type: "process-terminated";
  sessionId: string;
  projectId: UrlProjectId;
  processId: string;
  provider: string;
  reason: string;
  timestamp: string;
}

/** A complete source-review response snapshot was durably incorporated. */
export interface ReviewResponseChangedEvent {
  type: "review-response-changed";
  projectId: UrlProjectId;
  submissionIds: string[];
  timestamp: string;
}

/** Event emitted when provider runtime retry/failure status changes. */
export interface ProviderRuntimeStatusChangedEvent {
  type: "provider-runtime-status-changed";
  sessionId: string;
  projectId: UrlProjectId;
  providerRuntimeStatus: ProviderRuntimeStatus;
  timestamp: string;
}

/** Event emitted when a request is added to the worker queue */
export interface QueueRequestAddedEvent {
  type: "queue-request-added";
  queueId: string;
  sessionId?: string;
  projectId: UrlProjectId;
  position: number;
  timestamp: string;
}

/** Event emitted when queue positions change */
export interface QueuePositionChangedEvent {
  type: "queue-position-changed";
  queueId: string;
  sessionId?: string;
  position: number;
  timestamp: string;
}

/** Event emitted when a request is removed from queue */
export interface QueueRequestRemovedEvent {
  type: "queue-request-removed";
  queueId: string;
  sessionId?: string;
  reason: "started" | "cancelled";
  timestamp: string;
}

/** Event emitted when worker activity changes (for safe restart indicator) */
export interface WorkerActivityEvent {
  type: "worker-activity-changed";
  /** Owned provider processes, including idle retained workers. */
  activeWorkers: number;
  /** Sessions that would interrupt active work if the server restarts now. */
  interruptibleSessionCount: number;
  /** Supervisor worker queue length. */
  queueLength: number;
  /** In-memory user turns waiting in worker or live per-session queues. */
  queuedSessionMessageCount?: number;
  /** True if any session has interruptible active work. */
  hasActiveWork: boolean;
  timestamp: string;
}

/** Event emitted when durable per-session queue state changes. */
export interface SessionQueuePersistenceChangedEvent {
  type: "session-queue-persistence-changed";
  timestamp: string;
}

/** Event emitted when session metadata changes (title, archived, starred) */
export interface SessionMetadataChangedEvent {
  nonHumanUserTurn?: NonHumanUserTurn | null;
  creationProvenance?: SessionCreationProvenance;
  type: "session-metadata-changed";
  sessionId: string;
  /** Updated title (if changed) */
  title?: string;
  /** Updated archived status (if changed) */
  archived?: boolean;
  /** Updated starred status (if changed) */
  starred?: boolean;
  /** Updated sidebar category (if changed); null when removed. */
  sidebarCategory?: string | null;
  /** Updated interactive Mother link for a YA-owned `/btw` aside. */
  parentSessionId?: string | null;
  /** Explicit meaning of parentSessionId. */
  parentSessionKind?: "btw-aside" | null;
  /** Updated provider-fork provenance link. */
  forkedFromSessionId?: string | null;
  /** Remaining `/clearloop` iterations; null when the loop ended. */
  clearloop?: SessionClearloopBadge | null;
  /** A same-session rewind just recorded; viewers apply it in place. */
  rewindRecord?: SessionRewindRecord;
  /**
   * A rewind record deleted because the provider refused to apply it; the
   * rows it grouped are live again and viewers reload the transcript.
   */
  rewindRecordRemoved?: string;
  /** Updated per-session prompt-suggestion preference (if changed) */
  promptSuggestionMode?: PromptSuggestionMode;
  /** Updated per-session recap timing override (if changed) */
  recapAfterSeconds?: number;
  /** Complete current set of saved viewer-only transcript objects. */
  transcriptDisplayObjects?: TranscriptDisplayObject[];
  /** YA's effective project/working directory for this session, if changed. */
  projectId?: UrlProjectId;
  /** Provider transcript project when it differs from the effective project. */
  transcriptProjectId?: UrlProjectId | null;
  timestamp: string;
}

/** Event emitted when a session process is aborted by this server */
export interface SessionAbortedEvent {
  type: "session-aborted";
  sessionId: string;
  projectId: UrlProjectId;
  /**
   * `idle-reap` when the supervisor tore down an idle process for want of
   * viewers; absent for a requested abort. A quiet session waiting out a
   * `/clearloop` inactivity window is reaped like any other and is not
   * thereby stopped.
   */
  reason?: "idle-reap";
  timestamp: string;
}

/**
 * Event emitted when something asks this server to stop a live session's
 * current turn — the Stop control or a restart handoff — before the interrupt
 * is attempted. The process stays alive and may report idle immediately after,
 * so listeners that treat an idle report as finished work use this to tell an
 * intentional stop from a completed turn. A hard abort emits
 * `session-aborted` instead.
 */
export interface SessionStopRequestedEvent {
  type: "session-stop-requested";
  sessionId: string;
  projectId: UrlProjectId;
  timestamp: string;
}

/**
 * Event emitted when this server forks a transcript into a new session. The
 * new session's file is written by us, so listeners that infer "another
 * program is writing this session" from file activity must not do so here.
 */
export interface SessionForkedEvent {
  type: "session-forked";
  /** The new session created by the fork. */
  sessionId: string;
  /** The session the transcript was forked from. */
  sourceSessionId: string;
  projectId: UrlProjectId;
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
  /** Capped excerpt of the most recent visible agent turn or provider recap. */
  lastAgentText?: string;
  asyncQuestions?: SessionSummary["asyncQuestions"];
  timestamp: string;
}

/** Event emitted when network binding configuration changes */
export interface NetworkBindingChangedEvent {
  type: "network-binding-changed";
  /** Localhost port (may have changed) */
  localhostPort: number;
  /** Network socket configuration */
  network: {
    enabled: boolean;
    host: string | null;
    port: number | null;
  } | null;
  timestamp: string;
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

/** Event emitted when cache-billing usage accounting shows a hit or likely miss. */
export interface CacheMissBillingEvent {
  type: "cache-miss-billing" | "cache-miss-billing-expected-expiry";
  record: CacheMissBillingRecord;
  showToast: boolean;
  timestamp: string;
}

/** Union of all event types that can be emitted through the bus */
export type BusEvent =
  | RecentsChangedEvent
  | SessionCatalogUpdatedEvent
  | FileChangeEvent
  | SessionStatusEvent
  | SessionCreatedEvent
  | SourceChangeEvent
  | BackendReloadedEvent
  | SessionSeenEvent
  | ProcessStateEvent
  | ProcessTerminatedEvent
  | ReviewResponseChangedEvent
  | ProviderRuntimeStatusChangedEvent
  | QueueRequestAddedEvent
  | QueuePositionChangedEvent
  | QueueRequestRemovedEvent
  | WorkerActivityEvent
  | SessionQueuePersistenceChangedEvent
  | SafeRestartChangedEvent
  | ProjectQueueChangedEvent
  | ProjectCodeNameChangedEvent
  | ProjectCaptionsChangedEvent
  | ProjectsChangedEvent
  | SessionMetadataChangedEvent
  | SessionAbortedEvent
  | SessionStopRequestedEvent
  | SessionForkedEvent
  | SessionUpdatedEvent
  | NetworkBindingChangedEvent
  | BrowserTabConnectedEvent
  | BrowserTabDisconnectedEvent
  | CacheMissBillingEvent;

export type EventHandler<T = BusEvent> = (event: T) => void;

export class EventBus {
  private subscribers: Set<EventHandler> = new Set();

  /**
   * Subscribe to bus events.
   * @returns Unsubscribe function
   */
  subscribe(handler: EventHandler): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /**
   * Emit an event to all subscribers.
   */
  emit(event: BusEvent): void {
    for (const handler of this.subscribers) {
      try {
        handler(event);
      } catch (error) {
        console.error("[EventBus] Handler error:", error);
      }
    }
  }

  /**
   * Get the number of active subscribers.
   */
  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
