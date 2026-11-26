import { RECOVERY_POLICY, RecoveryScheduler } from "./RecoveryScheduler";
import { observeRecoverySignals } from "./recoverySignals";
import { isNonRetryableError } from "./types";

export type ConnectionState = "connected" | "reconnecting" | "disconnected";

export type SendPingFn = (id: string) => void;

export interface ConnectionManagerConfig {
  /** Base delay for exponential backoff (default: 1000ms) */
  baseDelayMs?: number;
  /** Maximum delay between reconnect attempts (default: 30000ms) */
  maxDelayMs?: number;
  /** Rapid retry budget before visible-only slow probes (default: 10) */
  maxAttempts?: number;
  recoveryDelayMs?: number;
  /** Jitter factor for backoff randomization (default: 0.3) */
  jitterFactor?: number;
  /** Time without events before connection is considered stale (default: 45000ms) */
  staleThresholdMs?: number;
  /** Interval for checking stale connections (default: 10000ms) */
  staleCheckIntervalMs?: number;
  /** Timeout waiting for pong response before forcing reconnect (default: 2000ms) */
  pongTimeoutMs?: number;
  /** Injectable timer interface for testing */
  timers?: TimerInterface;
  /** Injectable visibility interface for testing */
  visibility?: VisibilityInterface;
}

export type ReconnectFn = () => Promise<void>;

export interface ConnectionManagerStartOptions {
  /**
   * Optional function to send a keepalive ping with a given ID. When provided,
   * visibility changes trigger a ping/pong check instead of blindly forcing
   * reconnect.
   */
  sendPing?: SendPingFn;
  /** Optional label for log messages (e.g., "ws", "relay"). */
  label?: string;
  /**
   * Whether this manager is allowed to execute reconnectFn from background
   * health signals. SourceTransport facades created before T6/T7 start their
   * managers in passive mode so they can observe the same socket as the legacy
   * singleton without becoming a second reconnect driver.
   */
  driveReconnect?: boolean;
}

/**
 * Injectable timer interface for deterministic testing.
 */
export interface TimerInterface {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
  now(): number;
}

/**
 * Injectable visibility interface for testing.
 */
export interface VisibilityInterface {
  isVisible(): boolean;
  onVisibilityChange(cb: (visible: boolean) => void): () => void;
  onRecoveryOpportunity?(cb: () => void): () => void;
}

type EventMap = {
  stateChange: (state: ConnectionState, prev: ConnectionState) => void;
  reconnectFailed: (error: Error) => void;
  visibilityRestored: () => void;
};

const DEFAULT_CONFIG = {
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  maxAttempts: 10,
  recoveryDelayMs: RECOVERY_POLICY.slowProbeMs,
  jitterFactor: RECOVERY_POLICY.slowProbeJitter,
  staleThresholdMs: 45000,
  staleCheckIntervalMs: 10000,
  pongTimeoutMs: 2000,
} as const;

/**
 * Default timer implementation using real browser timers.
 */
const realTimers: TimerInterface = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (id) => window.clearInterval(id),
  now: () => Date.now(),
};

/**
 * Default visibility implementation using the Page Visibility API.
 */
const realVisibility: VisibilityInterface = {
  onRecoveryOpportunity: observeRecoverySignals,
  isVisible: () => typeof document !== "undefined" && !document.hidden,
  onVisibilityChange(cb) {
    if (typeof document === "undefined") return () => {};
    const handler = () => cb(!document.hidden);
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  },
};

/**
 * Centralized connection state machine that manages reconnection.
 *
 * Replaces the multiple overlapping reconnection systems (stale timers,
 * visibility handlers, backoff logic) scattered across ActivityBus and
 * legacy connection consumers.
 *
 * States:
 * - connected: socket is up, events flowing
 * - reconnecting: attempting to re-establish connection with backoff
 * - disconnected: stopped or non-retryable error
 * Exhausted rapid retries remain reconnecting; visible sources probe slowly.
 *
 * Consumers call handleClose/handleError to report problems.
 * ConnectionManager decides when and how to reconnect via the provided reconnectFn.
 */
export class ConnectionManager {
  private _state: ConnectionState = "disconnected";
  private _reconnectAttempts = 0;
  private _reconnectFn: ReconnectFn | null = null;
  private _sendPing: SendPingFn | null = null;
  private _label: string | null = null;
  private _driveReconnect = true;
  private _started = false;
  private _waitingForRecovery = false;
  private readonly _recovery: RecoveryScheduler<number>;
  private _removeRecoveryListener: (() => void) | null = null;

  // Stale detection
  private _lastEventTime = 0;
  private _hasReceivedHeartbeat = false;
  private _staleCheckIntervalId: number | null = null;

  // Visibility ping/pong
  private _hiddenSince: number | null = null;
  private _removeVisibilityListener: (() => void) | null = null;
  private _pendingPingId: string | null = null;
  private _pongTimeoutId: number | null = null;
  private _pingCounter = 0;

  // Backoff
  private _backoffTimerId: number | null = null;

  // In-flight reconnect dedup
  private _reconnectPromise: Promise<void> | null = null;

  // Health-check reconnects should not preempt high-volume operations such as
  // uploads, where the same socket is busy but still making progress.
  private _criticalOperationDepth = 0;

  // Event listeners
  private _listeners: {
    stateChange: Set<EventMap["stateChange"]>;
    reconnectFailed: Set<EventMap["reconnectFailed"]>;
    visibilityRestored: Set<EventMap["visibilityRestored"]>;
  } = {
    stateChange: new Set(),
    reconnectFailed: new Set(),
    visibilityRestored: new Set(),
  };

  // Config
  private readonly config: Required<
    Omit<ConnectionManagerConfig, "timers" | "visibility">
  >;
  private readonly timers: TimerInterface;
  private readonly visibility: VisibilityInterface;

  constructor(config: ConnectionManagerConfig = {}) {
    this.config = {
      baseDelayMs: config.baseDelayMs ?? DEFAULT_CONFIG.baseDelayMs,
      maxDelayMs: config.maxDelayMs ?? DEFAULT_CONFIG.maxDelayMs,
      maxAttempts: config.maxAttempts ?? DEFAULT_CONFIG.maxAttempts,
      recoveryDelayMs: config.recoveryDelayMs ?? DEFAULT_CONFIG.recoveryDelayMs,
      jitterFactor: config.jitterFactor ?? DEFAULT_CONFIG.jitterFactor,
      staleThresholdMs:
        config.staleThresholdMs ?? DEFAULT_CONFIG.staleThresholdMs,
      staleCheckIntervalMs:
        config.staleCheckIntervalMs ?? DEFAULT_CONFIG.staleCheckIntervalMs,
      pongTimeoutMs: config.pongTimeoutMs ?? DEFAULT_CONFIG.pongTimeoutMs,
    };
    this.timers = config.timers ?? realTimers;
    this.visibility = config.visibility ?? realVisibility;
    this._recovery = new RecoveryScheduler(() => this._executeReconnect(), {
      clock: this.timers,
      isVisible: () => this.visibility.isVisible(),
      policy: {
        slowProbeMs: this.config.recoveryDelayMs,
        slowProbeJitter: this.config.jitterFactor,
        cooldownMs: RECOVERY_POLICY.cooldownMs,
      },
    });
  }

  get state(): ConnectionState {
    return this._state;
  }

  get waitingForRecovery(): boolean {
    return this._waitingForRecovery;
  }

  get reconnectAttempts(): number {
    return this._reconnectAttempts;
  }

  /**
   * Start the connection manager with a reconnect function.
   * Idempotent — calling multiple times updates the reconnectFn but
   * doesn't create duplicate listeners.
   *
   * @param reconnectFn - Function to call when reconnecting.
   * @param options.sendPing - Optional function to send a keepalive ping with a given ID.
   *   When provided, visibility changes trigger a ping/pong check instead of
   *   blindly forcing reconnect.
   * @param options.label - Optional label for log messages (e.g., "ws", "relay").
   */
  start(
    reconnectFn: ReconnectFn,
    options?: ConnectionManagerStartOptions,
  ): void {
    this._reconnectFn = reconnectFn;
    this._sendPing = options?.sendPing ?? null;
    this._label = options?.label ?? null;
    this._driveReconnect = options?.driveReconnect ?? true;
    if (this._started) return;
    this._started = true;
    this._leaveRecovery();
    this._setState("connected");
    this._startStaleCheck();
    this._startVisibilityListener();
  }

  /**
   * Stop the connection manager, clearing all timers and listeners.
   */
  stop(): void {
    this._started = false;
    this._leaveRecovery();
    this._reconnectFn = null;
    this._sendPing = null;
    this._label = null;
    this._driveReconnect = true;
    this._stopStaleCheck();
    this._stopVisibilityListener();
    this._cancelBackoff();
    this._cancelPongTimeout();
    this._reconnectPromise = null;
    this._hasReceivedHeartbeat = false;
    this._hiddenSince = null;
    this._setState("disconnected");
  }

  /**
   * Record that an event was received. Resets the stale timer.
   */
  recordEvent(): void {
    this._lastEventTime = this.timers.now();
  }

  /**
   * Record that a heartbeat was received. Enables stale detection.
   */
  recordHeartbeat(): void {
    this._hasReceivedHeartbeat = true;
    this._lastEventTime = this.timers.now();
  }

  /**
   * Mark a socket-heavy operation that should suppress health-check reconnects.
   * Returns an idempotent cleanup callback.
   */
  beginCriticalOperation(label?: string): () => void {
    this._criticalOperationDepth += 1;
    this._pendingPingId = null;
    this._cancelPongTimeout();
    this._log(
      `critical operation started${label ? `: ${label}` : ""} (depth=${this._criticalOperationDepth})`,
    );

    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this._criticalOperationDepth = Math.max(
        0,
        this._criticalOperationDepth - 1,
      );
      this._log(
        `critical operation ended${label ? `: ${label}` : ""} (depth=${this._criticalOperationDepth})`,
      );
    };
  }

  /**
   * Mark the connection as connected. Resets backoff counter.
   * Called by consumers when their subscription's onOpen fires.
   */
  markConnected(): void {
    if (!this._started) return;
    this._reconnectAttempts = 0;
    this._leaveRecovery();
    this._reconnectPromise = null;
    this._cancelBackoff();
    this._setState("connected");
  }

  /**
   * Handle a pong response from the server.
   * Only acts if the ID matches the current pending ping (ignores stale pongs).
   */
  receivePong(id: string): void {
    if (id !== this._pendingPingId) return;
    this._cancelPongTimeout();
    this._pendingPingId = null;
    this._log("pong received, connection verified");
  }

  /**
   * Handle an error from a consumer. Triggers reconnect for retryable errors,
   * transitions to disconnected for non-retryable ones.
   */
  handleError(error: Error): void {
    const retryable = !isNonRetryableError(error);
    this._log(`error: ${error.message}, retryable=${retryable}`);
    if (this._state === "reconnecting") return; // already reconnecting
    if (!retryable) {
      this._setState("disconnected", `error: ${error.message}`);
      this._emitReconnectFailed(error);
      return;
    }
    this._startReconnecting(`error: ${error.message}`);
  }

  /**
   * Handle a close event from a consumer. Optionally pass the close error
   * to check retryability (e.g., WebSocketCloseError with code 4001).
   */
  handleClose(error?: Error): void {
    const retryable = !error || !isNonRetryableError(error);
    const detail = error?.message ?? "no error";
    this._log(`close: ${detail}, retryable=${retryable}`);
    if (this._state === "reconnecting") return; // already reconnecting
    if (error && !retryable) {
      this._setState("disconnected", `close: ${detail}`);
      this._emitReconnectFailed(error);
      return;
    }
    this._startReconnecting(`close: ${detail}`);
  }

  /**
   * Force an immediate reconnect, resetting backoff.
   * Useful for user-initiated reconnection.
   */
  forceReconnect(reason?: string): void {
    if (this._shouldSuppressHealthReconnect(reason)) {
      this._log(
        `suppressing health reconnect during critical operation: ${reason}`,
      );
      return;
    }
    this._log(`force reconnect${reason ? `: ${reason}` : ""}`);
    if (!this._started) return;
    this._reconnectAttempts = 0;
    this._leaveRecovery();
    this._cancelBackoff();
    this._reconnectPromise = null;
    this._startReconnecting(reason ?? "force");
  }

  /**
   * Subscribe to events. Returns an unsubscribe function.
   */
  on(event: "stateChange", cb: EventMap["stateChange"]): () => void;
  on(event: "reconnectFailed", cb: EventMap["reconnectFailed"]): () => void;
  on(
    event: "visibilityRestored",
    cb: EventMap["visibilityRestored"],
  ): () => void;
  on(event: keyof EventMap, cb: (...args: never[]) => void): () => void {
    const set = this._listeners[event] as Set<(...args: never[]) => void>;
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  // --- Private methods ---

  private _log(msg: string): void {
    const prefix = this._label
      ? `[ConnectionManager:${this._label}]`
      : "[ConnectionManager]";
    console.log(`${prefix} ${msg}`);
  }

  private _setState(newState: ConnectionState, reason?: string): void {
    if (newState === this._state) return;
    const prev = this._state;
    this._state = newState;
    const suffix = reason ? ` (${reason})` : "";
    this._log(`${prev} → ${newState}${suffix}`);
    for (const cb of this._listeners.stateChange) {
      cb(newState, prev);
    }
  }

  private _emitReconnectFailed(error: Error): void {
    this._leaveRecovery();
    this._cancelBackoff();
    this._reconnectPromise = null;
    for (const cb of this._listeners.reconnectFailed) {
      cb(error);
    }
  }

  private _emitVisibilityRestored(): void {
    for (const cb of this._listeners.visibilityRestored) {
      cb();
    }
  }

  private _startReconnecting(reason?: string): void {
    this._cancelPongTimeout();
    this._pendingPingId = null;
    this._setState("reconnecting", reason);
    this._scheduleReconnect();
  }

  private _scheduleReconnect(): void {
    if (!this._started || !this._reconnectFn) return;

    if (!this._driveReconnect) {
      this._log("passive manager observing reconnect state");
      return;
    }

    if (this._reconnectAttempts >= this.config.maxAttempts) {
      if (!this._waitingForRecovery) {
        this._log(
          "rapid retry budget exhausted; waiting for recovery opportunity",
        );
      }
      this._waitingForRecovery = true;
      this._cancelBackoff();
      this._recovery.arm();
      return;
    }

    const delay = this._getBackoffDelay(this._reconnectAttempts);
    this._reconnectAttempts++;
    this._log(
      `attempt ${this._reconnectAttempts}/${this.config.maxAttempts}, delay ${Math.round(delay)}ms`,
    );

    this._backoffTimerId = this.timers.setTimeout(() => {
      this._backoffTimerId = null;
      this._executeReconnect();
    }, delay);
  }

  private _executeReconnect(): void {
    if (!this._started || !this._reconnectFn) return;

    // Dedup: if a reconnect is already in-flight, don't start another
    if (this._reconnectPromise) return;

    const fn = this._reconnectFn;
    const reconnectPromise = fn();
    this._reconnectPromise = reconnectPromise;

    reconnectPromise
      .then(() => {
        // Ignore stale outcomes from superseded reconnect attempts.
        if (this._reconnectPromise !== reconnectPromise) return;
        // Transport reconnected — transition to connected so consumers
        // (e.g. ActivityBus stateChange listener) can re-subscribe.
        // The new subscription's onOpen will call markConnected() again (no-op).
        this.markConnected();
      })
      .catch((error: unknown) => {
        // Ignore stale outcomes from superseded reconnect attempts.
        if (this._reconnectPromise !== reconnectPromise) return;
        this._reconnectPromise = null;
        const err = error instanceof Error ? error : new Error(String(error));
        this._log(`reconnect failed: ${err.message}`);
        if (isNonRetryableError(err)) {
          this._setState("disconnected");
          this._emitReconnectFailed(err);
          return;
        }
        // Schedule next attempt
        this._scheduleReconnect();
      });
  }

  private _getBackoffDelay(attempt: number): number {
    const base = this.config.baseDelayMs * 2 ** attempt;
    const jitter = 1 + Math.random() * this.config.jitterFactor;
    return Math.min(this.config.maxDelayMs, base * jitter);
  }

  private _leaveRecovery(): void {
    this._waitingForRecovery = false;
    this._recovery.disarm();
  }

  private _cancelBackoff(): void {
    if (this._backoffTimerId !== null) {
      this.timers.clearTimeout(this._backoffTimerId);
      this._backoffTimerId = null;
    }
  }

  // --- Stale detection ---

  private _startStaleCheck(): void {
    this._stopStaleCheck();
    this._lastEventTime = this.timers.now();
    this._staleCheckIntervalId = this.timers.setInterval(() => {
      this._checkStale();
    }, this.config.staleCheckIntervalMs);
  }

  private _stopStaleCheck(): void {
    if (this._staleCheckIntervalId !== null) {
      this.timers.clearInterval(this._staleCheckIntervalId);
      this._staleCheckIntervalId = null;
    }
  }

  private _checkStale(): void {
    if (this._state !== "connected") return;
    if (!this._hasReceivedHeartbeat) return;
    if (this._criticalOperationDepth > 0) return;
    const elapsed = this.timers.now() - this._lastEventTime;
    if (elapsed >= this.config.staleThresholdMs) {
      this._log(`stale (${elapsed}ms since last event)`);
      this.forceReconnect("stale");
    }
  }

  // --- Visibility ---

  /** Request one recovery probe, coalescing bursty browser/user signals. */
  requestRecovery(): void {
    if (
      !this._started ||
      !this._driveReconnect ||
      !this._waitingForRecovery ||
      this._state !== "reconnecting"
    )
      return;
    this._recovery.signal();
  }

  private _startVisibilityListener(): void {
    this._removeRecoveryListener =
      this.visibility.onRecoveryOpportunity?.(() => this.requestRecovery()) ??
      null;
    this._removeVisibilityListener = this.visibility.onVisibilityChange(
      (visible) => {
        if (!visible) {
          this._recovery.visibilityChanged();
          this._hiddenSince = this.timers.now();
          this._log(`visibility hidden (${this._formatReconnectContext()})`);
        } else {
          this._handleBecameVisible();
        }
      },
    );
  }

  private _stopVisibilityListener(): void {
    this._removeRecoveryListener?.();
    this._removeRecoveryListener = null;
    if (this._removeVisibilityListener) {
      this._removeVisibilityListener();
      this._removeVisibilityListener = null;
    }
  }

  private _handleBecameVisible(): void {
    const hiddenDuration =
      this._hiddenSince !== null ? this.timers.now() - this._hiddenSince : null;
    const visiblePrefix = `visibility visible${
      hiddenDuration != null ? ` after ${hiddenDuration}ms hidden` : ""
    }`;

    this._hiddenSince = null;
    if (this._waitingForRecovery) {
      this._recovery.visibilityChanged();
      return;
    }
    if (this._state !== "connected") {
      const context = this._formatReconnectContext();
      this._log(`${visiblePrefix}, no wake ping (${context})`);
      return;
    }

    // Notify consumers immediately so they can refresh data in parallel
    // with the ping/pong health check below.
    this._emitVisibilityRestored();

    if (!this._sendPing) {
      // No ping function provided — skip connectivity check
      const context = this._formatReconnectContext();
      this._log(`${visiblePrefix}, no ping function (${context})`);
      return;
    }

    if (this._criticalOperationDepth > 0) {
      const context = this._formatReconnectContext();
      this._log(
        `${visiblePrefix}, skipping ping during critical operation (${context})`,
      );
      return;
    }

    // Cancel any previous pending ping (handles rapid visible/hidden toggling)
    this._cancelPongTimeout();

    const pingId = String(++this._pingCounter);
    this._pendingPingId = pingId;

    this._log(`${visiblePrefix}, pinging (${this._formatReconnectContext()})`);

    try {
      this._sendPing(pingId);
    } catch {
      this._pendingPingId = null;
      this._log("ping send failed");
      this.forceReconnect("ping-failed");
      return;
    }

    this._pongTimeoutId = this.timers.setTimeout(() => {
      this._pongTimeoutId = null;
      if (this._pendingPingId === pingId) {
        this._log("pong timeout");
        this._pendingPingId = null;
        this.forceReconnect("pong-timeout");
      }
    }, this.config.pongTimeoutMs);
  }

  private _cancelPongTimeout(): void {
    if (this._pongTimeoutId !== null) {
      this.timers.clearTimeout(this._pongTimeoutId);
      this._pongTimeoutId = null;
    }
  }

  private _shouldSuppressHealthReconnect(reason?: string): boolean {
    return (
      this._criticalOperationDepth > 0 &&
      (reason === "stale" ||
        reason === "ping-failed" ||
        reason === "pong-timeout")
    );
  }

  private _formatReconnectContext(): string {
    const parts = [`state=${this._state}`];
    if (this._waitingForRecovery) parts.push("waitingForRecovery=true");
    if (this._reconnectAttempts > 0) {
      parts.push(`attempts=${this._reconnectAttempts}`);
    }
    if (this._backoffTimerId !== null) {
      parts.push("backoff=pending");
    }
    if (this._reconnectPromise) {
      parts.push("reconnect=in-flight");
    }
    if (this._pendingPingId) {
      parts.push(`pendingPing=${this._pendingPingId}`);
    }
    if (this._criticalOperationDepth > 0) {
      parts.push(`criticalDepth=${this._criticalOperationDepth}`);
    }
    return parts.join(", ");
  }
}
