import type {
  ContextUsage,
  PendingInputType,
  ProcessStateType,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { getWebsocketTransportEnabled } from "../hooks/useDeveloperMode";
import type { SessionStatus, SessionSummary } from "../types";
import { getGlobalConnection, isRemoteClient } from "./connection";
import { type Subscription, isNonRetryableError } from "./connection/types";
import { getOrCreateBrowserProfileId } from "./storageKeys";

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
  /** Context window usage from the last assistant message */
  contextUsage?: ContextUsage;
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

/** Event emitted when a browser tab connects to the activity stream */
export interface BrowserTabConnectedEvent {
  type: "browser-tab-connected";
  browserProfileId: string;
  connectionId: number;
  transport: "sse" | "ws";
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

// Map event names to their data types
interface ActivityEventMap {
  "file-change": FileChangeEvent;
  "session-status-changed": SessionStatusEvent;
  "session-created": SessionCreatedEvent;
  "session-updated": SessionUpdatedEvent;
  "session-seen": SessionSeenEvent;
  "process-state-changed": ProcessStateEvent;
  "session-metadata-changed": SessionMetadataChangedEvent;
  // Connection events
  "browser-tab-connected": BrowserTabConnectedEvent;
  "browser-tab-disconnected": BrowserTabDisconnectedEvent;
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
  private _lastEventTime: number | null = null;
  private _lastReconnectTime: number | null = null;

  get connected(): boolean {
    return this._connected;
  }

  /** Timestamp of last received event (including heartbeats) */
  get lastEventTime(): number | null {
    return this._lastEventTime;
  }

  /** Timestamp of last reconnect attempt */
  get lastReconnectTime(): number | null {
    return this._lastReconnectTime;
  }

  /**
   * Connect to the activity stream. Safe to call multiple times.
   * Uses global connection (remote mode), WebSocket transport when enabled, otherwise SSE.
   */
  connect(): void {
    // Check if already connected
    if (this.eventSource || this.wsSubscription) return;

    // Check for global connection (remote mode with SecureConnection)
    const globalConn = getGlobalConnection();
    if (globalConn) {
      this.connectWithConnection(globalConn);
      return;
    }

    // In remote client mode, we MUST have a SecureConnection
    if (isRemoteClient()) {
      console.warn(
        "[ActivityBus] Remote client requires SecureConnection - not authenticated",
      );
      return;
    }

    // Check if WebSocket transport is enabled
    this.useWebSocket = getWebsocketTransportEnabled();

    if (this.useWebSocket) {
      this.connectWebSocket();
    } else {
      this.connectSSE();
    }
  }

  /**
   * Connect using a provided connection (for remote mode).
   */
  private connectWithConnection(connection: {
    subscribeActivity: (handlers: {
      onEvent: (
        eventType: string,
        eventId: string | undefined,
        data: unknown,
      ) => void;
      onOpen?: () => void;
      onError?: (err: Error) => void;
      onClose?: () => void;
    }) => Subscription;
  }): void {
    this.wsSubscription = connection.subscribeActivity({
      onEvent: (eventType, _eventId, data) => {
        this.handleWsEvent(eventType, data);
      },
      onOpen: () => {
        const isReconnect = this.hasConnected;
        this.hasConnected = true;
        this._connected = true;

        if (isReconnect) {
          this.emit("reconnect", undefined);
        }
      },
      onError: (err) => {
        console.error("[ActivityBus] Connection error:", err);
        this._connected = false;
        this.wsSubscription = null;

        // Don't reconnect for non-retryable errors (e.g., auth required)
        if (isNonRetryableError(err)) {
          console.warn(
            "[ActivityBus] Non-retryable error, not reconnecting:",
            err.message,
          );
          return;
        }

        // Auto-reconnect
        this.reconnectTimeout = setTimeout(
          () => this.connect(),
          RECONNECT_DELAY_MS,
        );
      },
      onClose: () => {
        // Connection closed cleanly (e.g., relay restart) - trigger reconnect
        console.log("[ActivityBus] Connection closed, reconnecting...");
        this._connected = false;
        this.wsSubscription = null;
        this.reconnectTimeout = setTimeout(
          () => this.connect(),
          RECONNECT_DELAY_MS,
        );
      },
    });
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

          // Don't reconnect for non-retryable errors (e.g., auth required)
          if (isNonRetryableError(err)) {
            console.warn(
              "[ActivityBus] Non-retryable error, not reconnecting:",
              err.message,
            );
            return;
          }

          // Auto-reconnect
          this.reconnectTimeout = setTimeout(
            () => this.connect(),
            RECONNECT_DELAY_MS,
          );
        },
        onClose: () => {
          // Connection closed cleanly (e.g., relay restart) - trigger reconnect
          console.log("[ActivityBus] WebSocket closed, reconnecting...");
          this._connected = false;
          this.wsSubscription = null;
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
    // Track last event time for all events (including heartbeats)
    this._lastEventTime = Date.now();

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
      "browser-tab-connected",
      "browser-tab-disconnected",
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
    // Get or create browser profile ID for connection tracking
    const browserProfileId = getOrCreateBrowserProfileId();
    const baseUrl = `${API_BASE}/activity/events`;

    // Build URL with browser profile ID and origin metadata
    const params = new URLSearchParams({
      browserProfileId,
      origin: window.location.origin,
      scheme: window.location.protocol.replace(":", ""),
      hostname: window.location.hostname,
      userAgent: navigator.userAgent,
    });
    // Only add port if it's specified (not default)
    if (window.location.port) {
      params.set("port", window.location.port);
    }

    const url = `${baseUrl}?${params.toString()}`;
    const es = new EventSource(url);

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

    // Connection events
    es.addEventListener("browser-tab-connected", (event) =>
      this.handleEvent("browser-tab-connected", event),
    );
    es.addEventListener("browser-tab-disconnected", (event) =>
      this.handleEvent("browser-tab-disconnected", event),
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
   * Force a reconnection by closing the current connection and reconnecting.
   * Useful when the connection may have gone stale (e.g., mobile wake from sleep).
   * For remote mode (SecureConnection), this reconnects the underlying WebSocket.
   */
  forceReconnect(): void {
    console.log(
      `[ActivityBus] Forcing reconnection... connected=${this._connected}, hasSubscription=${!!this.wsSubscription}, lastEvent=${this._lastEventTime ? `${Math.round((Date.now() - this._lastEventTime) / 1000)}s ago` : "never"}`,
    );
    this._lastReconnectTime = Date.now();

    // Clear any pending reconnect timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // For remote mode with SecureConnection, force reconnect the underlying WebSocket
    const globalConn = getGlobalConnection();
    console.log(
      `[ActivityBus] globalConn=${!!globalConn}, hasForceReconnect=${!!globalConn?.forceReconnect}`,
    );
    if (globalConn?.forceReconnect) {
      this._connected = false;
      // Close our subscription (will be re-established by SecureConnection.forceReconnect)
      if (this.wsSubscription) {
        console.log("[ActivityBus] Closing existing wsSubscription");
        this.wsSubscription.close();
        this.wsSubscription = null;
      }
      // Force reconnect the underlying connection, then re-subscribe
      console.log("[ActivityBus] Calling SecureConnection.forceReconnect()");
      globalConn
        .forceReconnect()
        .then(() => {
          console.log(
            "[ActivityBus] SecureConnection.forceReconnect() resolved, calling connect()",
          );
          this.connect();
        })
        .catch((err) => {
          console.error("[ActivityBus] Force reconnect failed:", err);
          // Try to reconnect anyway after a delay
          this.reconnectTimeout = setTimeout(
            () => this.connect(),
            RECONNECT_DELAY_MS,
          );
        });
      return;
    }

    // For SSE or WebSocket transport, just close and reconnect
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.wsSubscription) {
      this.wsSubscription.close();
      this.wsSubscription = null;
    }
    this._connected = false;

    // Reconnect immediately
    this.connect();
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
