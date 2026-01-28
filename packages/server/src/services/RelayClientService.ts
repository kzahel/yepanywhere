/**
 * RelayClientService manages the connection from a yepanywhere server to a relay server.
 *
 * The relay enables phone clients to connect to yepanywhere servers behind NAT.
 * This service:
 * - Maintains a persistent "waiting" connection to the relay
 * - Handles registration with the relay using username and installId
 * - Detects when the connection is "claimed" by a phone client
 * - Hands off claimed connections to the WebSocket relay handler
 * - Automatically reconnects with exponential backoff
 */

import {
  type RelayServerRegister,
  type RelayServerRejected,
  isRelayServerRegistered,
  isRelayServerRejected,
} from "@yep-anywhere/shared";
import { WebSocket } from "ws";

export interface RelayClientConfig {
  /** WebSocket URL of the relay server (e.g., wss://relay.yepanywhere.com/ws) */
  relayUrl: string;
  /** Username to register with the relay */
  username: string;
  /** Installation ID for ownership verification */
  installId: string;
  /**
   * Called when a connection is claimed by a phone client.
   * The first message (SRP init) is passed along with the WebSocket.
   * @param ws - The WebSocket connection
   * @param firstMessage - The first message from the phone client
   * @param isBinary - Whether the first message was a binary frame
   */
  onRelayConnection: (
    ws: WebSocket,
    firstMessage: Buffer,
    isBinary: boolean,
  ) => void;
  /** Called when connection status changes (for UI updates) */
  onStatusChange?: (status: RelayClientStatus) => void;
}

export type RelayClientStatus =
  | "disconnected"
  | "connecting"
  | "registering"
  | "waiting"
  | "rejected";

export interface RelayClientState {
  status: RelayClientStatus;
  /** Error message if status is "rejected" */
  error?: string;
  /** Number of consecutive reconnection attempts */
  reconnectAttempts: number;
}

/**
 * Exponential backoff calculator for reconnection delays.
 */
class ExponentialBackoff {
  private attempts = 0;

  constructor(
    private readonly initialDelay: number = 1000,
    private readonly maxDelay: number = 60_000,
    private readonly multiplier: number = 2,
  ) {}

  /**
   * Get the next delay and increment the attempt counter.
   */
  next(): number {
    const delay = Math.min(
      this.initialDelay * this.multiplier ** this.attempts,
      this.maxDelay,
    );
    this.attempts++;
    return delay;
  }

  /**
   * Reset the backoff counter (call on successful connection).
   */
  reset(): void {
    this.attempts = 0;
  }

  /**
   * Get current attempt count for status reporting.
   */
  getAttempts(): number {
    return this.attempts;
  }
}

/** Keepalive configuration */
const PING_INTERVAL_MS = 30_000; // Send ping every 30 seconds
const PONG_TIMEOUT_MS = 10_000; // Expect pong within 10 seconds

export class RelayClientService {
  /** WebSocket that has completed registration and is waiting for a client */
  private waitingWs: WebSocket | null = null;
  /** WebSocket that is currently connecting/registering (not yet waiting) */
  private connectingWs: WebSocket | null = null;
  private backoff: ExponentialBackoff;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastPingTime: number | null = null;
  private state: RelayClientState = {
    status: "disconnected",
    reconnectAttempts: 0,
  };
  private enabled = false;
  private config: RelayClientConfig | null = null;

  constructor() {
    this.backoff = new ExponentialBackoff(1000, 60_000, 2);
  }

  /**
   * Configure and start the relay client.
   * Call this when relay settings are updated.
   */
  start(config: RelayClientConfig): void {
    // Stop any existing connection
    this.stop();

    this.config = config;
    this.enabled = true;
    this.connect();
  }

  /**
   * Stop the relay client and disconnect.
   */
  stop(): void {
    this.enabled = false;
    this.clearReconnectTimer();
    this.stopKeepalive();

    if (this.connectingWs) {
      this.connectingWs.close();
      this.connectingWs = null;
    }

    if (this.waitingWs) {
      this.waitingWs.close();
      this.waitingWs = null;
    }

    this.updateState({ status: "disconnected", reconnectAttempts: 0 });
  }

  /**
   * Get the current connection state.
   */
  getState(): RelayClientState {
    return { ...this.state };
  }

  /**
   * Check if the relay client is enabled and configured.
   */
  isEnabled(): boolean {
    return this.enabled && this.config !== null;
  }

  /**
   * Update the relay URL without changing other settings.
   * Reconnects if already connected.
   */
  updateRelayUrl(relayUrl: string): void {
    if (!this.config) return;
    this.start({ ...this.config, relayUrl });
  }

  /**
   * Update the username without changing other settings.
   * Reconnects if already connected.
   */
  updateUsername(username: string): void {
    if (!this.config) return;
    this.start({ ...this.config, username });
  }

  private connect(): void {
    if (!this.enabled || !this.config) return;

    this.updateState({ status: "connecting" });

    try {
      const ws = new WebSocket(this.config.relayUrl);
      this.connectingWs = ws;

      ws.on("open", () => {
        this.handleOpen(ws);
      });

      ws.on("message", (data: Buffer, isBinary: boolean) => {
        this.handleMessage(ws, data, isBinary);
      });

      ws.on("close", () => {
        this.handleClose(ws);
      });

      ws.on("error", (error: Error) => {
        this.handleError(ws, error);
      });

      ws.on("pong", () => {
        this.handlePong(ws);
      });
    } catch (error) {
      console.error("[RelayClient] Failed to create WebSocket:", error);
      this.scheduleReconnect();
    }
  }

  private handleOpen(ws: WebSocket): void {
    if (!this.config) return;

    console.log(`[RelayClient] Connected to relay: ${this.config.relayUrl}`);
    this.updateState({ status: "registering" });

    // Send registration message
    const register: RelayServerRegister = {
      type: "server_register",
      username: this.config.username,
      installId: this.config.installId,
    };
    ws.send(JSON.stringify(register));
  }

  private handleMessage(ws: WebSocket, data: Buffer, isBinary: boolean): void {
    // If it's a binary frame, it's the first message from a phone client
    // (after pairing, relay forwards messages with preserved frame types)
    if (isBinary) {
      this.handleClaimed(ws, data, true);
      return;
    }

    // Text frame - could be relay protocol or first message from phone client
    const str = data.toString("utf-8");

    // Try to parse as JSON for relay protocol messages
    let parsed: unknown;
    try {
      parsed = JSON.parse(str);
    } catch {
      // Not valid JSON - shouldn't happen for relay protocol, log and ignore
      console.warn("[RelayClient] Received non-JSON text frame:", str);
      return;
    }

    // Handle relay protocol responses
    if (isRelayServerRegistered(parsed)) {
      console.log(
        `[RelayClient] Registered with relay as: ${this.config?.username}`,
      );
      // Transition from connecting to waiting
      this.connectingWs = null;
      this.waitingWs = ws;
      this.backoff.reset();
      this.updateState({ status: "waiting", reconnectAttempts: 0 });
      // Start keepalive pings for waiting connections
      this.startKeepalive(ws);
      return;
    }

    if (isRelayServerRejected(parsed)) {
      this.handleRejection(ws, parsed);
      return;
    }

    // Unknown JSON message type - this is the first message from a phone client
    // (e.g., SRP hello). Pass as Buffer with isBinary=false since it's a text frame.
    // Relay switches to passthrough mode after pairing.
    this.handleClaimed(ws, data, false);
  }

  private handleRejection(ws: WebSocket, msg: RelayServerRejected): void {
    console.warn(`[RelayClient] Registration rejected: ${msg.reason}`);

    // Close the connection
    ws.close();

    if (msg.reason === "username_taken") {
      // Permanent error - don't reconnect
      this.updateState({
        status: "rejected",
        error: `Username "${this.config?.username}" is already registered by another server`,
      });
      // Disable auto-reconnect for this error
      this.enabled = false;
    } else if (msg.reason === "invalid_username") {
      // Permanent error - username format is wrong
      this.updateState({
        status: "rejected",
        error: `Invalid username format: "${this.config?.username}"`,
      });
      this.enabled = false;
    } else {
      // Unknown rejection reason - try to reconnect
      this.scheduleReconnect();
    }
  }

  private handleClaimed(
    ws: WebSocket,
    firstMessage: Buffer,
    isBinary: boolean,
  ): void {
    if (!this.config) return;

    const preview = firstMessage.toString("utf-8").slice(0, 100);
    console.log(
      `[RelayClient] Connection claimed by phone client, firstMessage: Buffer(${firstMessage.length}), isBinary: ${isBinary}, preview: ${preview}`,
    );

    // Stop keepalive for this connection (it's being handed off)
    this.stopKeepalive();

    // Remove from waiting state (it's now claimed)
    this.waitingWs = null;

    // Remove all listeners before handoff - the new handler will attach its own
    // This prevents duplicate message processing
    ws.removeAllListeners();

    // Hand off to the WebSocket relay handler with frame type info
    this.config.onRelayConnection(ws, firstMessage, isBinary);

    // Immediately open a new waiting connection
    this.connect();
  }

  private handleClose(ws: WebSocket): void {
    // Only handle close for connections we're managing
    // Claimed connections are handed off and managed elsewhere
    if (ws === this.connectingWs) {
      console.log("[RelayClient] Connecting socket closed");
      this.connectingWs = null;
      this.scheduleReconnect();
      return;
    }

    if (ws === this.waitingWs) {
      console.log("[RelayClient] Connection closed");
      this.stopKeepalive();
      this.waitingWs = null;
      this.scheduleReconnect();
      return;
    }

    // Not our connection (either claimed or already replaced), ignore
  }

  private handleError(ws: WebSocket, error: Error): void {
    // Only log errors for connections we're managing
    if (ws !== this.waitingWs && ws !== this.connectingWs) return;

    console.error("[RelayClient] WebSocket error:", error.message);
    // Close event will trigger reconnection
  }

  private scheduleReconnect(): void {
    if (!this.enabled) return;

    this.clearReconnectTimer();

    const delay = this.backoff.next();
    const attempts = this.backoff.getAttempts();

    console.log(
      `[RelayClient] Reconnecting in ${delay}ms (attempt ${attempts})`,
    );
    this.updateState({
      status: "disconnected",
      reconnectAttempts: attempts,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private updateState(updates: Partial<RelayClientState>): void {
    const newState = { ...this.state, ...updates };

    // Only notify if status changed
    if (
      newState.status !== this.state.status ||
      newState.error !== this.state.error
    ) {
      this.state = newState;
      this.config?.onStatusChange?.(newState.status);
    } else {
      this.state = newState;
    }
  }

  /**
   * Start sending keepalive pings to detect dead connections.
   * This is essential for detecting when the connection dies due to
   * network changes (e.g., laptop sleep/wake).
   */
  private startKeepalive(ws: WebSocket): void {
    this.stopKeepalive(); // Clear any existing keepalive

    this.pingInterval = setInterval(() => {
      // Check for wall-clock drift (system was likely asleep)
      const now = Date.now();
      if (
        this.lastPingTime !== null &&
        now - this.lastPingTime > PING_INTERVAL_MS * 2
      ) {
        console.log(
          `[RelayClient] Detected clock drift (${now - this.lastPingTime}ms since last ping), connection likely stale`,
        );
        this.handleKeepaliveTimeout();
        return;
      }

      this.lastPingTime = now;

      // Send ping
      try {
        ws.ping();
      } catch {
        // Ping failed, connection is dead
        console.log("[RelayClient] Ping failed, connection dead");
        this.handleKeepaliveTimeout();
        return;
      }

      // Set pong timeout
      this.pongTimeout = setTimeout(() => {
        console.log("[RelayClient] Pong timeout, connection dead");
        this.handleKeepaliveTimeout();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  /**
   * Stop the keepalive ping interval.
   */
  private stopKeepalive(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
    this.lastPingTime = null;
  }

  /**
   * Handle pong response from the relay.
   */
  private handlePong(ws: WebSocket): void {
    // Only handle pong for our waiting connection
    if (ws !== this.waitingWs) return;

    // Clear the pong timeout
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  /**
   * Handle keepalive timeout - close and reconnect.
   */
  private handleKeepaliveTimeout(): void {
    this.stopKeepalive();

    if (this.waitingWs) {
      // Force close the connection
      try {
        this.waitingWs.close();
      } catch {
        // Ignore close errors
      }
      this.waitingWs = null;
    }

    // Reconnect immediately (reset backoff since this wasn't a network error)
    this.backoff.reset();
    this.scheduleReconnect();
  }
}
