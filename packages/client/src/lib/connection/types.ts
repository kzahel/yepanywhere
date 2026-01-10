import type { UploadedFile } from "@yep-anywhere/shared";

/**
 * Handle for an active event subscription.
 */
export interface Subscription {
  /** Stop receiving events and close the connection */
  close(): void;
}

/**
 * Handlers for stream events (session or activity).
 */
export interface StreamHandlers {
  /** Called for each event with type, optional ID, and data */
  onEvent: (
    eventType: string,
    eventId: string | undefined,
    data: unknown,
  ) => void;
  /** Called when connection opens */
  onOpen?: () => void;
  /** Called on error (will attempt reconnect for recoverable errors) */
  onError?: (error: Error) => void;
  /** Called when stream ends normally */
  onClose?: () => void;
}

/**
 * Options for file upload.
 */
export interface UploadOptions {
  /** Progress callback with bytes uploaded so far */
  onProgress?: (bytesUploaded: number) => void;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Chunk size in bytes (default 64KB) */
  chunkSize?: number;
}

/**
 * Connection abstraction for client-server communication.
 *
 * Two implementations:
 * - DirectConnection: Uses native fetch, EventSource, WebSocket (direct to server)
 * - SecureConnection: Multiplexes everything over encrypted WebSocket (via relay)
 *
 * The interface abstracts HTTP requests, SSE subscriptions, and file uploads
 * so they can be routed through different transports.
 */
export interface Connection {
  /** Connection mode identifier */
  readonly mode: "direct" | "secure";

  /**
   * Make a JSON API request.
   *
   * @param path - Request path (e.g., "/sessions")
   * @param init - Fetch options (method, body, headers, etc.)
   * @returns Parsed JSON response
   * @throws Error with status property on HTTP errors
   */
  fetch<T>(path: string, init?: RequestInit): Promise<T>;

  /**
   * Subscribe to session events (replaces SSE to /api/sessions/:id/stream).
   *
   * Events include: message, status, connected, error, complete, heartbeat,
   * markdown-augment, pending, edit-augment, session-id-changed, etc.
   *
   * @param sessionId - Session to subscribe to
   * @param handlers - Event callbacks
   * @param lastEventId - Resume from this event ID (optional)
   * @returns Subscription handle with close() method
   */
  subscribeSession(
    sessionId: string,
    handlers: StreamHandlers,
    lastEventId?: string,
  ): Subscription;

  /**
   * Subscribe to activity events (replaces SSE to /api/activity/events).
   *
   * Events include: file-change, session-status-changed, session-created,
   * session-updated, session-seen, process-state-changed, etc.
   *
   * @param handlers - Event callbacks
   * @returns Subscription handle with close() method
   */
  subscribeActivity(handlers: StreamHandlers): Subscription;

  /**
   * Upload a file to a session.
   *
   * @param projectId - Project ID (URL-encoded format)
   * @param sessionId - Session ID
   * @param file - File to upload
   * @param options - Upload options (progress, abort signal)
   * @returns Uploaded file metadata
   */
  upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile>;
}
