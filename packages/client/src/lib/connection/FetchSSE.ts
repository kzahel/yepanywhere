/**
 * FetchSSE - A fetch-based Server-Sent Events implementation.
 *
 * Unlike the browser's native EventSource, this implementation:
 * - Exposes HTTP status codes (can detect 401, 403, etc.)
 * - Has controllable reconnection (can stop on auth errors)
 * - Can include credentials and custom headers
 *
 * The API mirrors EventSource for easy drop-in replacement.
 */

import { authEvents } from "../authEvents";

export interface FetchSSEOptions {
  /** Include credentials (cookies) in requests. Default: true */
  credentials?: RequestCredentials;
  /** Custom headers to include */
  headers?: Record<string, string>;
  /** Reconnect delay in ms. Default: 2000 */
  reconnectDelay?: number;
  /** Whether to auto-reconnect on error. Default: true */
  autoReconnect?: boolean;
}

export interface SSEError extends Error {
  /** HTTP status code if available */
  status?: number;
  /** Whether this error should prevent reconnection */
  isAuthError?: boolean;
}

/**
 * Parsed SSE event from the stream.
 */
interface SSEEvent {
  event: string;
  data: string;
  id?: string;
}

/**
 * FetchSSE - fetch-based EventSource replacement.
 *
 * Usage:
 * ```typescript
 * const sse = new FetchSSE('/api/events');
 * sse.onopen = () => console.log('Connected');
 * sse.onerror = (err) => console.error('Error:', err.status);
 * sse.addEventListener('message', (e) => console.log(e.data));
 * // Later:
 * sse.close();
 * ```
 */
export class FetchSSE {
  private url: string;
  private options: FetchSSEOptions;
  private abortController: AbortController | null = null;
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private _closed = false;
  private _lastEventId: string | null = null;
  private _readyState = 0; // 0=CONNECTING, 1=OPEN, 2=CLOSED
  private connectionId = 0;
  private static nextId = 1;

  /** Called when connection opens */
  onopen: (() => void) | null = null;
  /** Called on error (includes status code for HTTP errors) */
  onerror: ((error: SSEError) => void) | null = null;

  /** Connection state (mirrors EventSource): 0=CONNECTING, 1=OPEN, 2=CLOSED */
  get readyState(): number {
    return this._readyState;
  }

  /** The last event ID received (for reconnection) */
  get lastEventId(): string | null {
    return this._lastEventId;
  }

  constructor(url: string, options: FetchSSEOptions = {}) {
    this.url = url;
    this.options = {
      credentials: "include",
      reconnectDelay: 2000,
      autoReconnect: true,
      ...options,
    };
    this.connectionId = FetchSSE.nextId++;
    this.log("created");
    this.connect();
  }

  /** Log with connection ID for easy filtering */
  private log(message: string, ...args: unknown[]): void {
    const shortUrl = this.url.split("?")[0]; // Strip query params for readability
    console.log(`[SSE#${this.connectionId}] ${message}`, shortUrl, ...args);
  }

  /**
   * Add an event listener for a specific event type.
   */
  addEventListener(
    type: string,
    listener: (event: MessageEvent) => void,
  ): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  /**
   * Remove an event listener.
   */
  removeEventListener(
    type: string,
    listener: (event: MessageEvent) => void,
  ): void {
    const set = this.listeners.get(type);
    if (set) {
      set.delete(listener);
    }
  }

  /**
   * Close the connection and stop reconnection attempts.
   */
  close(): void {
    this._closed = true;
    this._readyState = 2;
    this.log("closed");
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Connect to the SSE endpoint.
   */
  private async connect(): Promise<void> {
    if (this._closed) return;

    // Don't connect if login is already required
    if (authEvents.loginRequired) {
      this.log("skipped - login required");
      return;
    }

    this._readyState = 0;
    this.log("connecting");
    this.abortController = new AbortController();

    // Build URL with lastEventId if we're reconnecting
    let connectUrl = this.url;
    if (this._lastEventId) {
      const separator = this.url.includes("?") ? "&" : "?";
      connectUrl = `${this.url}${separator}lastEventId=${encodeURIComponent(this._lastEventId)}`;
    }

    try {
      const res = await fetch(connectUrl, {
        credentials: this.options.credentials,
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Yep-Anywhere": "true",
          ...this.options.headers,
        },
        signal: this.abortController.signal,
      });

      if (!res.ok) {
        const error = new Error(
          `SSE connection failed: ${res.status} ${res.statusText}`,
        ) as SSEError;
        error.status = res.status;

        // Check for auth errors
        if (res.status === 401 || res.status === 403) {
          error.isAuthError = true;
          this.log("auth error", res.status);
          this._readyState = 2;
          authEvents.signalLoginRequired();
          this.onerror?.(error);
          // Don't reconnect for auth errors
          return;
        }

        this.log("error", res.status, res.statusText);
        this.onerror?.(error);
        this.scheduleReconnect();
        return;
      }

      // Connection successful
      this._readyState = 1;
      this.log("open");
      this.onopen?.();

      // Read the stream
      if (res.body) {
        await this.readStream(res.body);
      }
    } catch (err) {
      if (this._closed) return;

      // AbortError is expected when we close the connection
      if (err instanceof Error && err.name === "AbortError") {
        this.log("aborted");
        return;
      }

      this.log("error", err instanceof Error ? err.message : err);
      const error = new Error(
        err instanceof Error ? err.message : "SSE connection error",
      ) as SSEError;
      this.onerror?.(error);
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule a reconnection attempt.
   */
  private scheduleReconnect(): void {
    if (this._closed || !this.options.autoReconnect) return;

    // Don't reconnect if login is required
    if (authEvents.loginRequired) {
      this.log("not reconnecting - login required");
      return;
    }

    this.log("reconnecting in", this.options.reconnectDelay, "ms");
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, this.options.reconnectDelay);
  }

  /**
   * Read and parse the SSE stream.
   */
  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!this._closed) {
        const { done, value } = await reader.read();

        if (done) {
          // Stream ended - attempt reconnect
          this.log("stream ended");
          this.scheduleReconnect();
          return;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete events (separated by double newlines)
        const events = this.parseEvents(buffer);
        buffer = events.remaining;

        for (const event of events.parsed) {
          this.dispatchEvent(event);
        }
      }
    } catch (err) {
      if (this._closed) return;

      this.log("stream error", err instanceof Error ? err.message : err);
      const error = new Error(
        err instanceof Error ? err.message : "Stream read error",
      ) as SSEError;
      this.onerror?.(error);
      this.scheduleReconnect();
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Parse SSE events from the buffer.
   * Returns parsed events and any remaining incomplete data.
   */
  private parseEvents(buffer: string): {
    parsed: SSEEvent[];
    remaining: string;
  } {
    const parsed: SSEEvent[] = [];

    // SSE events are separated by double newlines
    const parts = buffer.split(/\r?\n\r?\n/);

    // Last part might be incomplete
    const remaining = parts.pop() || "";

    for (const part of parts) {
      if (!part.trim()) continue;

      const event = this.parseEvent(part);
      if (event) {
        parsed.push(event);
      }
    }

    return { parsed, remaining };
  }

  /**
   * Parse a single SSE event block.
   */
  private parseEvent(block: string): SSEEvent | null {
    let eventType = "message";
    let data = "";
    let id: string | undefined;

    const lines = block.split(/\r?\n/);

    for (const line of lines) {
      if (line.startsWith(":")) {
        // Comment, ignore
        continue;
      }

      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) {
        // Field with no value
        continue;
      }

      const field = line.slice(0, colonIndex);
      // Value starts after colon, with optional leading space
      let value = line.slice(colonIndex + 1);
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }

      switch (field) {
        case "event":
          eventType = value;
          break;
        case "data":
          // Multiple data fields are concatenated with newlines
          data = data ? `${data}\n${value}` : value;
          break;
        case "id":
          id = value;
          break;
        case "retry":
          // Could update reconnect delay here
          break;
      }
    }

    // Only return if we have data
    if (!data && eventType === "message") {
      return null;
    }

    return { event: eventType, data, id };
  }

  /**
   * Dispatch an SSE event to listeners.
   */
  private dispatchEvent(event: SSEEvent): void {
    // Update last event ID for reconnection
    if (event.id) {
      this._lastEventId = event.id;
    }

    // Create a MessageEvent-like object
    const messageEvent = new MessageEvent(event.event, {
      data: event.data,
      lastEventId: event.id || "",
    });

    // Dispatch to specific event type listeners
    const listeners = this.listeners.get(event.event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(messageEvent);
        } catch (err) {
          console.error("[FetchSSE] Listener error:", err);
        }
      }
    }
  }
}
