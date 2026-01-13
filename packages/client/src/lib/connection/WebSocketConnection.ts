import type {
  RelayEvent,
  RelayRequest,
  RelayResponse,
  RelaySubscribe,
  RelayUnsubscribe,
  RelayUploadComplete,
  RelayUploadEnd,
  RelayUploadError,
  RelayUploadProgress,
  RelayUploadStart,
  RemoteClientMessage,
  UploadedFile,
  YepMessage,
} from "@yep-anywhere/shared";
import {
  BinaryFrameError,
  decodeJsonFrame,
  encodeJsonFrame,
  encodeUploadChunkFrame,
  isBinaryData,
} from "@yep-anywhere/shared";
import { LEGACY_KEYS, getServerScoped } from "../storageKeys";
import {
  type Connection,
  type StreamHandlers,
  type Subscription,
  type UploadOptions,
  WebSocketCloseError,
} from "./types";

/**
 * Generate a unique ID for request correlation.
 */
function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Connection to yepanywhere server using WebSocket transport.
 *
 * This implements the relay protocol for HTTP-like request/response
 * over a single WebSocket connection. Currently only supports fetch().
 * Subscriptions and uploads will be added in Phase 2c and 2d.
 *
 * The WebSocket transport is useful for:
 * - Testing the relay protocol without encryption
 * - Environments where SSE is problematic
 * - Future relay/secure connection support
 */
/** Default chunk size for file uploads (64KB) */
const DEFAULT_CHUNK_SIZE = 64 * 1024;

/** Handlers for pending uploads */
interface PendingUpload {
  resolve: (file: UploadedFile) => void;
  reject: (error: Error) => void;
  onProgress?: (bytesUploaded: number) => void;
}

export class WebSocketConnection implements Connection {
  readonly mode = "direct" as const; // Will change to "secure" in Phase 3

  private ws: WebSocket | null = null;
  private pendingRequests = new Map<
    string,
    {
      resolve: (response: RelayResponse) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private pendingUploads = new Map<string, PendingUpload>();
  private subscriptions = new Map<string, StreamHandlers>();
  private connectionPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private reconnectDelay = 1000;

  /**
   * Get the WebSocket URL based on current location.
   */
  private getWsUrl(): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/api/ws`;
  }

  /**
   * Ensure WebSocket is connected, reconnecting if necessary.
   */
  private async ensureConnected(): Promise<void> {
    // If already connected and open, return immediately
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    // If connection is in progress, wait for it
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    // Start new connection
    this.connectionPromise = this.connect();
    try {
      await this.connectionPromise;
    } finally {
      this.connectionPromise = null;
    }
  }

  /**
   * Connect to the WebSocket server.
   */
  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.getWsUrl();
      console.log("[WebSocketConnection] Connecting to", wsUrl);

      const ws = new WebSocket(wsUrl);
      // Set binaryType to receive ArrayBuffer instead of Blob for binary frames
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        console.log("[WebSocketConnection] Connected");
        this.ws = ws;
        this.reconnectAttempts = 0;
        resolve();
      };

      ws.onerror = (event) => {
        console.error("[WebSocketConnection] Error:", event);
      };

      ws.onclose = (event) => {
        console.log("[WebSocketConnection] Closed:", event.code, event.reason);
        this.ws = null;

        // Create error with close code and reason
        const closeError = new WebSocketCloseError(event.code, event.reason);

        // Reject any pending requests
        for (const [id, pending] of this.pendingRequests) {
          clearTimeout(pending.timeout);
          pending.reject(closeError);
          this.pendingRequests.delete(id);
        }

        // Reject any pending uploads
        for (const [id, pending] of this.pendingUploads) {
          pending.reject(closeError);
          this.pendingUploads.delete(id);
        }

        // Notify all subscriptions of closure
        for (const [id, handlers] of this.subscriptions) {
          handlers.onError?.(closeError);
          handlers.onClose?.();
        }
        this.subscriptions.clear();
      };

      ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      // Handle initial connection failure
      const timeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close();
          reject(new Error("WebSocket connection timeout"));
        }
      }, 10000);

      ws.onopen = () => {
        clearTimeout(timeout);
        this.ws = ws;
        this.reconnectAttempts = 0;
        resolve();
      };
    });
  }

  /**
   * Handle incoming WebSocket messages.
   * Supports both text frames (JSON) and binary frames (format byte + payload).
   */
  private handleMessage(data: unknown): void {
    let msg: YepMessage;

    // Handle binary frames (ArrayBuffer from server)
    if (isBinaryData(data)) {
      try {
        msg = decodeJsonFrame<YepMessage>(data);
      } catch (err) {
        if (err instanceof BinaryFrameError) {
          console.warn(
            `[WebSocketConnection] Binary frame error (${err.code}):`,
            err.message,
          );
        } else {
          console.warn(
            "[WebSocketConnection] Failed to decode binary frame:",
            err,
          );
        }
        return;
      }
    } else if (typeof data === "string") {
      // Handle text frames (JSON string, for backwards compatibility)
      try {
        msg = JSON.parse(data) as YepMessage;
      } catch {
        console.warn("[WebSocketConnection] Failed to parse message:", data);
        return;
      }
    } else {
      console.warn("[WebSocketConnection] Ignoring unknown message type");
      return;
    }

    switch (msg.type) {
      case "response":
        this.handleResponse(msg);
        break;

      case "event":
        this.handleEvent(msg);
        break;

      case "upload_progress":
        this.handleUploadProgress(msg);
        break;

      case "upload_complete":
        this.handleUploadComplete(msg);
        break;

      case "upload_error":
        this.handleUploadError(msg);
        break;

      default:
        console.warn(
          "[WebSocketConnection] Unknown message type:",
          (msg as { type?: string }).type,
        );
    }
  }

  /**
   * Handle an event message by routing to subscription handlers.
   */
  private handleEvent(event: RelayEvent): void {
    const handlers = this.subscriptions.get(event.subscriptionId);
    if (!handlers) {
      console.warn(
        "[WebSocketConnection] Received event for unknown subscription:",
        event.subscriptionId,
      );
      return;
    }

    // Route special events
    if (event.eventType === "connected") {
      handlers.onOpen?.();
    }

    // Forward all events (including connected) to the handler
    handlers.onEvent(event.eventType, event.eventId, event.data);
  }

  /**
   * Handle a response message.
   */
  private handleResponse(response: RelayResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      console.warn(
        "[WebSocketConnection] Received response for unknown request:",
        response.id,
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);
    pending.resolve(response);
  }

  /**
   * Handle upload progress message.
   */
  private handleUploadProgress(msg: RelayUploadProgress): void {
    const pending = this.pendingUploads.get(msg.uploadId);
    if (pending?.onProgress) {
      pending.onProgress(msg.bytesReceived);
    }
  }

  /**
   * Handle upload complete message.
   */
  private handleUploadComplete(msg: RelayUploadComplete): void {
    const pending = this.pendingUploads.get(msg.uploadId);
    if (pending) {
      this.pendingUploads.delete(msg.uploadId);
      pending.resolve(msg.file);
    }
  }

  /**
   * Handle upload error message.
   */
  private handleUploadError(msg: RelayUploadError): void {
    const pending = this.pendingUploads.get(msg.uploadId);
    if (pending) {
      this.pendingUploads.delete(msg.uploadId);
      pending.reject(new Error(msg.error));
    }
  }

  /**
   * Send a message over the WebSocket as a binary frame.
   * Uses format byte 0x01 (JSON) for all messages.
   */
  private send(msg: RemoteClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    // Send as binary frame with format byte 0x01
    this.ws.send(encodeJsonFrame(msg));
  }

  /**
   * Make a JSON API request over WebSocket.
   */
  async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    await this.ensureConnected();

    const id = generateId();
    const method = (init?.method ?? "GET") as RelayRequest["method"];

    // Parse body if present
    let body: unknown;
    if (init?.body) {
      if (typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      } else {
        body = init.body;
      }
    }

    // Build headers
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) {
          headers[key] = value;
        }
      } else {
        Object.assign(headers, init.headers);
      }
    }

    // Add default headers
    headers["Content-Type"] = "application/json";
    headers["X-Yep-Anywhere"] = "true";

    const request: RelayRequest = {
      type: "request",
      id,
      method,
      path: path.startsWith("/api") ? path : `/api${path}`,
      headers,
      body,
    };

    return new Promise<T>((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error("Request timeout"));
      }, 30000);

      // Store pending request
      this.pendingRequests.set(id, {
        resolve: (response: RelayResponse) => {
          if (response.status >= 400) {
            const error = new Error(
              `API error: ${response.status}`,
            ) as Error & { status: number; setupRequired?: boolean };
            error.status = response.status;
            if (response.headers?.["X-Setup-Required"] === "true") {
              error.setupRequired = true;
            }
            reject(error);
          } else {
            resolve(response.body as T);
          }
        },
        reject,
        timeout,
      });

      // Send request
      try {
        this.send(request);
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Subscribe to session events.
   */
  subscribeSession(
    sessionId: string,
    handlers: StreamHandlers,
    lastEventId?: string,
  ): Subscription {
    const subscriptionId = generateId();

    // Store handlers for routing events
    this.subscriptions.set(subscriptionId, handlers);

    // Send subscribe message (async, but we return synchronously)
    this.ensureConnected()
      .then(() => {
        const msg: RelaySubscribe = {
          type: "subscribe",
          subscriptionId,
          channel: "session",
          sessionId,
          lastEventId,
        };
        this.send(msg);
      })
      .catch((err) => {
        handlers.onError?.(err);
        this.subscriptions.delete(subscriptionId);
      });

    return {
      close: () => {
        this.subscriptions.delete(subscriptionId);
        // Send unsubscribe message if connected
        if (this.ws?.readyState === WebSocket.OPEN) {
          const msg: RelayUnsubscribe = {
            type: "unsubscribe",
            subscriptionId,
          };
          try {
            this.send(msg);
          } catch {
            // Ignore send errors on close
          }
        }
        handlers.onClose?.();
      },
    };
  }

  /**
   * Subscribe to activity events.
   */
  subscribeActivity(handlers: StreamHandlers): Subscription {
    const subscriptionId = generateId();
    const browserProfileId =
      getServerScoped("browserProfileId", LEGACY_KEYS.browserProfileId) ??
      undefined;

    // Store handlers for routing events
    this.subscriptions.set(subscriptionId, handlers);

    // Send subscribe message (async, but we return synchronously)
    this.ensureConnected()
      .then(() => {
        const msg: RelaySubscribe = {
          type: "subscribe",
          subscriptionId,
          channel: "activity",
          browserProfileId,
        };
        this.send(msg);
      })
      .catch((err) => {
        handlers.onError?.(err);
        this.subscriptions.delete(subscriptionId);
      });

    return {
      close: () => {
        this.subscriptions.delete(subscriptionId);
        // Send unsubscribe message if connected
        if (this.ws?.readyState === WebSocket.OPEN) {
          const msg: RelayUnsubscribe = {
            type: "unsubscribe",
            subscriptionId,
          };
          try {
            this.send(msg);
          } catch {
            // Ignore send errors on close
          }
        }
        handlers.onClose?.();
      },
    };
  }

  /**
   * Upload a file to a session via WebSocket relay protocol.
   */
  async upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile> {
    await this.ensureConnected();

    const uploadId = generateId();
    const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;

    // Create promise that will resolve when upload completes
    const uploadPromise = new Promise<UploadedFile>((resolve, reject) => {
      this.pendingUploads.set(uploadId, {
        resolve,
        reject,
        onProgress: options?.onProgress,
      });

      // Handle abort signal
      if (options?.signal) {
        options.signal.addEventListener("abort", () => {
          this.pendingUploads.delete(uploadId);
          reject(new Error("Upload aborted"));
        });
      }
    });

    try {
      // Send upload_start
      const startMsg: RelayUploadStart = {
        type: "upload_start",
        uploadId,
        projectId,
        sessionId,
        filename: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
      };
      this.send(startMsg);

      // Read and send chunks
      let offset = 0;
      const reader = file.stream().getReader();

      while (true) {
        // Check if aborted
        if (options?.signal?.aborted) {
          reader.cancel();
          throw new Error("Upload aborted");
        }

        const { done, value } = await reader.read();
        if (done) break;

        // Process the chunk (may be larger than chunkSize, so we split it)
        let chunkOffset = 0;
        while (chunkOffset < value.length) {
          const chunkEnd = Math.min(chunkOffset + chunkSize, value.length);
          const chunk = value.slice(chunkOffset, chunkEnd);

          // Send binary chunk (format 0x02) directly
          // Wire format: [0x02][16 bytes UUID][8 bytes offset][chunk data]
          const binaryFrame = encodeUploadChunkFrame(uploadId, offset, chunk);
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket not connected");
          }
          this.ws.send(binaryFrame);

          offset += chunk.length;
          chunkOffset = chunkEnd;
        }
      }

      // Send upload_end
      const endMsg: RelayUploadEnd = {
        type: "upload_end",
        uploadId,
      };
      this.send(endMsg);

      // Wait for completion
      return await uploadPromise;
    } catch (err) {
      // Clean up pending upload on error
      this.pendingUploads.delete(uploadId);
      throw err;
    }
  }

  /**
   * Close the WebSocket connection.
   */
  close(): void {
    // Notify and clear subscriptions
    for (const [id, handlers] of this.subscriptions) {
      handlers.onClose?.();
    }
    this.subscriptions.clear();

    // Clear pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Connection closed"));
    }
    this.pendingRequests.clear();

    // Clear pending uploads
    for (const [id, pending] of this.pendingUploads) {
      pending.reject(new Error("Connection closed"));
    }
    this.pendingUploads.clear();

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

/**
 * Singleton WebSocketConnection instance.
 * Created lazily to avoid connecting until needed.
 */
let wsConnectionInstance: WebSocketConnection | null = null;

export function getWebSocketConnection(): WebSocketConnection {
  if (!wsConnectionInstance) {
    wsConnectionInstance = new WebSocketConnection();
  }
  return wsConnectionInstance;
}
