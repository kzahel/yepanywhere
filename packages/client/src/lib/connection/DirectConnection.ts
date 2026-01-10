import type { UploadedFile } from "@yep-anywhere/shared";
import { uploadFile } from "../../api/upload";
import type {
  Connection,
  StreamHandlers,
  Subscription,
  UploadOptions,
} from "./types";

const API_BASE = "/api";

/**
 * Known SSE event types for session streams.
 * DirectConnection listens for all of these and forwards to handlers.
 */
const SESSION_EVENT_TYPES = [
  "connected",
  "message",
  "status",
  "mode-change",
  "error",
  "complete",
  "heartbeat",
  "markdown-augment",
  "pending",
  "edit-augment",
  "session-id-changed",
  "stream_event",
] as const;

/**
 * Known SSE event types for activity streams.
 */
const ACTIVITY_EVENT_TYPES = [
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
] as const;

/**
 * Direct connection to yepanywhere server using native browser APIs.
 *
 * Uses:
 * - fetch() for HTTP requests
 * - EventSource for SSE subscriptions
 * - WebSocket for file uploads
 *
 * This is the default connection mode for localhost and LAN access.
 */
export class DirectConnection implements Connection {
  readonly mode = "direct" as const;

  /**
   * Make a JSON API request.
   */
  async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Yep-Anywhere": "true",
        ...init?.headers,
      },
    });

    if (!res.ok) {
      const setupRequired = res.headers.get("X-Setup-Required") === "true";
      const error = new Error(
        `API error: ${res.status} ${res.statusText}`,
      ) as Error & {
        status: number;
        setupRequired?: boolean;
      };
      error.status = res.status;
      if (setupRequired) error.setupRequired = true;
      throw error;
    }

    return res.json();
  }

  /**
   * Subscribe to session events via SSE.
   */
  subscribeSession(
    sessionId: string,
    handlers: StreamHandlers,
    lastEventId?: string,
  ): Subscription {
    const baseUrl = `${API_BASE}/sessions/${sessionId}/stream`;
    const url = lastEventId ? `${baseUrl}?lastEventId=${lastEventId}` : baseUrl;

    return this.createEventSourceSubscription(
      url,
      handlers,
      SESSION_EVENT_TYPES,
    );
  }

  /**
   * Subscribe to activity events via SSE.
   */
  subscribeActivity(handlers: StreamHandlers): Subscription {
    const url = `${API_BASE}/activity/events`;
    return this.createEventSourceSubscription(
      url,
      handlers,
      ACTIVITY_EVENT_TYPES,
    );
  }

  /**
   * Upload a file via WebSocket.
   */
  async upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile> {
    return uploadFile(projectId, sessionId, file, options);
  }

  /**
   * Create an EventSource subscription with automatic event forwarding.
   */
  private createEventSourceSubscription(
    url: string,
    handlers: StreamHandlers,
    eventTypes: readonly string[],
  ): Subscription {
    const es = new EventSource(url);

    // Track event listeners for cleanup
    const listeners = new Map<string, (event: MessageEvent) => void>();

    // Create handler for each event type
    for (const eventType of eventTypes) {
      const listener = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          handlers.onEvent(eventType, event.lastEventId || undefined, data);
        } catch {
          // If JSON parse fails, pass raw data
          handlers.onEvent(
            eventType,
            event.lastEventId || undefined,
            event.data,
          );
        }
      };
      listeners.set(eventType, listener);
      es.addEventListener(eventType, listener);
    }

    es.onopen = () => {
      handlers.onOpen?.();
    };

    es.onerror = () => {
      // EventSource handles reconnection automatically for recoverable errors
      // Only call onError for informational purposes
      handlers.onError?.(new Error("EventSource error"));
    };

    return {
      close: () => {
        // Remove all event listeners
        for (const [eventType, listener] of listeners) {
          es.removeEventListener(eventType, listener);
        }
        es.close();
        handlers.onClose?.();
      },
    };
  }
}

/**
 * Singleton DirectConnection instance.
 * Most apps only need one connection to the server.
 */
export const directConnection = new DirectConnection();
