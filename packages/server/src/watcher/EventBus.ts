/**
 * Simple in-memory pub/sub event bus for file change and session status events.
 */

import type { UrlProjectId } from "@claude-anywhere/shared";
import type { SessionStatus, SessionSummary } from "../supervisor/types.js";

export type FileChangeType = "create" | "modify" | "delete";

export interface FileChangeEvent {
  type: "file-change";
  path: string;
  relativePath: string;
  changeType: FileChangeType;
  timestamp: string;
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
  status: SessionStatus;
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
  timestamp: string;
  messageId?: string;
}

/** Process state type - what the agent is doing */
export type ProcessStateType = "running" | "waiting-input";

/** Event emitted when a process state changes (running vs waiting for input) */
export interface ProcessStateEvent {
  type: "process-state-changed";
  sessionId: string;
  /** Base64url-encoded project path (UrlProjectId format) */
  projectId: UrlProjectId;
  /** Current process state - what the agent is doing */
  processState: ProcessStateType;
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
  activeWorkers: number;
  queueLength: number;
  /** True if any worker is running or waiting-input (unsafe to restart) */
  hasActiveWork: boolean;
  timestamp: string;
}

/** Union of all event types that can be emitted through the bus */
export type BusEvent =
  | FileChangeEvent
  | SessionStatusEvent
  | SessionCreatedEvent
  | SourceChangeEvent
  | BackendReloadedEvent
  | SessionSeenEvent
  | ProcessStateEvent
  | QueueRequestAddedEvent
  | QueuePositionChangedEvent
  | QueueRequestRemovedEvent
  | WorkerActivityEvent;

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
