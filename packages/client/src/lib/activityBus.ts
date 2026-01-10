import type {
  PendingInputType,
  ProcessStateType,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { getWebsocketTransportEnabled } from "../hooks/useDeveloperMode";
import type { SessionStatus, SessionSummary } from "../types";
import type { Subscription } from "./connection/types";

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
  fileType: FileType;
}

export interface SessionStatusEvent {
  type: "session-status-changed";
  sessionId: string;
  projectId: UrlProjectId;
  status: SessionStatus;
  timestamp: string;
}

export interface SessionCreatedEvent {
  type: "session-created";
  session: SessionSummary;
  timestamp: string;
}

export interface SessionSeenEvent {
  type: "session-seen";
  sessionId: string;
  timestamp: string;
  messageId?: string;
}

export interface ProcessStateEvent {
  type: "process-state-changed";
  sessionId: string;
  projectId: UrlProjectId;
  processState: ProcessStateType;
  /** Type of pending input (only set when processState is "waiting-input") */
  pendingInputType?: PendingInputType;
  timestamp: string;
}

export interface SessionMetadataChangedEvent {
  type: "session-metadata-changed";
  sessionId: string;
  title?: string;
  archived?: boolean;
  starred?: boolean;
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
  activeWorkers: number;
  queueLength: number;
  hasActiveWork: boolean;
  timestamp: string;
}

// Map event names to their data types
interface ActivityEventMap {
  "file-change": FileChangeEvent;
  "session-status-changed": SessionStatusEvent;
  "session-created": SessionCreatedEvent;
  "session-updated": SessionUpdatedEvent;
  "session-seen": SessionSeenEvent;
  "process-state-changed": ProcessStateEvent;
  "session-metadata-changed": SessionMetadataChangedEvent;
  // Dev mode events
  "source-change": SourceChangeEvent;
  "backend-reloaded": undefined;
  "worker-activity-changed": WorkerActivityEvent;
  reconnect: undefined;
}

export type ActivityEventType = keyof ActivityEventMap;

type Listener<T> = (data: T) => void;

const API_BASE = "/api";
const RECONNECT_DELAY_MS = 2000;

/**
 * Singleton that manages activity event subscriptions.
 * Uses WebSocket transport when enabled, otherwise SSE.
 * Hooks subscribe via on() and receive events through callbacks.
 */
class ActivityBus {
  private eventSource: EventSource | null = null;
  private wsSubscription: Subscription | null = null;
  private listeners = new Map<ActivityEventType, Set<Listener<unknown>>>();
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private hasConnected = false;
  private _connected = false;
  private useWebSocket = false;

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Connect to the activity stream. Safe to call multiple times.
   * Uses WebSocket transport when enabled, otherwise SSE.
   */
  connect(): void {
    // Check if already connected
    if (this.eventSource || this.wsSubscription) return;

    // Check if WebSocket transport is enabled
    this.useWebSocket = getWebsocketTransportEnabled();

    if (this.useWebSocket) {
      this.connectWebSocket();
    } else {
      this.connectSSE();
    }
  }

  /**
   * Connect using WebSocket transport (Phase 2c).
   */
  private connectWebSocket(): void {
    // Lazy import to avoid circular dependencies
    import("./connection").then(({ getWebSocketConnection }) => {
      const connection = getWebSocketConnection();
      this.wsSubscription = connection.subscribeActivity({
        onEvent: (eventType, _eventId, data) => {
          // Handle activity events from WebSocket
          this.handleWsEvent(eventType, data);
        },
        onOpen: () => {
          // Mark as connected
          const isReconnect = this.hasConnected;
          this.hasConnected = true;
          this._connected = true;

          if (isReconnect) {
            this.emit("reconnect", undefined);
          }
        },
        onError: (err) => {
          console.error("[ActivityBus] WebSocket error:", err);
          this._connected = false;
          this.wsSubscription = null;

          // Auto-reconnect
          this.reconnectTimeout = setTimeout(
            () => this.connect(),
            RECONNECT_DELAY_MS,
          );
        },
      });
    });
  }

  /**
   * Handle events from WebSocket subscription.
   */
  private handleWsEvent(eventType: string, data: unknown): void {
    // Handle special events
    if (eventType === "connected" || eventType === "heartbeat") {
      return;
    }

    // Emit the event to listeners
    if (this.isValidEventType(eventType)) {
      this.emit(eventType, data as ActivityEventMap[typeof eventType]);
    }
  }

  /**
   * Type guard for valid event types.
   */
  private isValidEventType(type: string): type is ActivityEventType {
    return [
      "file-change",
      "session-status-changed",
      "session-created",
      "session-updated",
      "session-seen",
      "process-state-changed",
      "session-metadata-changed",
      "source-change",
      "backend-reloaded",
      "worker-activity-changed",
      "reconnect",
    ].includes(type);
  }

  /**
   * Connect using SSE (traditional method).
   */
  private connectSSE(): void {
    const es = new EventSource(`${API_BASE}/activity/events`);

    es.onopen = () => {
      const isReconnect = this.hasConnected;
      this.hasConnected = true;
      this._connected = true;

      if (isReconnect) {
        this.emit("reconnect", undefined);
      }
    };

    // Set up event listeners for each event type
    es.addEventListener("file-change", (event) =>
      this.handleEvent("file-change", event),
    );
    es.addEventListener("session-status-changed", (event) =>
      this.handleEvent("session-status-changed", event),
    );
    es.addEventListener("session-created", (event) =>
      this.handleEvent("session-created", event),
    );
    es.addEventListener("session-updated", (event) =>
      this.handleEvent("session-updated", event),
    );
    es.addEventListener("session-seen", (event) =>
      this.handleEvent("session-seen", event),
    );
    es.addEventListener("process-state-changed", (event) =>
      this.handleEvent("process-state-changed", event),
    );
    es.addEventListener("session-metadata-changed", (event) =>
      this.handleEvent("session-metadata-changed", event),
    );

    // Dev mode events
    es.addEventListener("source-change", (event) =>
      this.handleEvent("source-change", event),
    );
    es.addEventListener("backend-reloaded", () =>
      this.emit("backend-reloaded", undefined),
    );
    es.addEventListener("worker-activity-changed", (event) =>
      this.handleEvent("worker-activity-changed", event),
    );

    // Ignore these - just acknowledge receipt
    es.addEventListener("connected", () => {});
    es.addEventListener("heartbeat", () => {});

    es.onerror = () => {
      this._connected = false;
      es.close();
      this.eventSource = null;

      // Auto-reconnect
      this.reconnectTimeout = setTimeout(
        () => this.connect(),
        RECONNECT_DELAY_MS,
      );
    };

    this.eventSource = es;
  }

  /**
   * Disconnect from the activity stream.
   */
  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.wsSubscription) {
      this.wsSubscription.close();
      this.wsSubscription = null;
    }
    this._connected = false;
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

  private handleEvent(eventType: ActivityEventType, event: MessageEvent): void {
    if (event.data === undefined || event.data === null) return;

    try {
      const data = JSON.parse(event.data);
      this.emit(eventType, data);
    } catch {
      // Ignore malformed JSON
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
}

export const activityBus = new ActivityBus();
