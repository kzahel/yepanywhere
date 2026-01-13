/**
 * Tracks which browser tabs have active SSE/WebSocket connections to the server.
 * This enables:
 * - Skipping push notifications for already-connected browser profiles
 * - Showing "X active sessions" in Settings > Remote Access
 * - Real-time updates when tabs connect/disconnect
 *
 * A browserProfileId identifies a browser profile (stored in localStorage, shared across tabs).
 * Each tab creates a separate connection, so one browser profile can have multiple connections.
 */

import type { EventBus } from "../watcher/index.js";

/** Transport type for the connection */
export type BrowserConnectionTransport = "sse" | "ws";

/** Information about a single browser tab connection */
export interface BrowserTabConnection {
  connectionId: number;
  browserProfileId: string;
  connectedAt: string;
  transport: BrowserConnectionTransport;
}

/**
 * Service to track connected browser tabs by browserProfileId.
 *
 * A browserProfileId identifies a browser profile (stored in localStorage, shared across tabs).
 * Each tab creates a separate connection, so one browser profile can have multiple connections.
 */
export class ConnectedBrowsersService {
  private nextConnectionId = 1;
  /** Map from connectionId to connection info */
  private connections = new Map<number, BrowserTabConnection>();
  /** Map from browserProfileId to set of connectionIds */
  private browserProfileConnections = new Map<string, Set<number>>();

  constructor(private eventBus: EventBus) {}

  /**
   * Register a new browser tab connection.
   * @param browserProfileId - Unique identifier for the browser profile
   * @param transport - Connection type (sse or ws)
   * @returns connectionId for tracking (use when disconnecting)
   */
  connect(
    browserProfileId: string,
    transport: BrowserConnectionTransport,
  ): number {
    const connectionId = this.nextConnectionId++;
    const connection: BrowserTabConnection = {
      connectionId,
      browserProfileId,
      connectedAt: new Date().toISOString(),
      transport,
    };

    this.connections.set(connectionId, connection);

    // Add to browser profile's connection set
    let profileSet = this.browserProfileConnections.get(browserProfileId);
    if (!profileSet) {
      profileSet = new Set();
      this.browserProfileConnections.set(browserProfileId, profileSet);
    }
    profileSet.add(connectionId);

    // Emit connected event
    this.eventBus.emit({
      type: "browser-tab-connected",
      browserProfileId,
      connectionId,
      transport,
      tabCount: this.getTabCount(browserProfileId),
      totalTabCount: this.getTotalTabCount(),
      timestamp: new Date().toISOString(),
    });

    return connectionId;
  }

  /**
   * Unregister a browser tab connection.
   * @param connectionId - The ID returned from connect()
   */
  disconnect(connectionId: number): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const { browserProfileId } = connection;

    // Remove from connections map
    this.connections.delete(connectionId);

    // Remove from browser profile's connection set
    const profileSet = this.browserProfileConnections.get(browserProfileId);
    if (profileSet) {
      profileSet.delete(connectionId);
      if (profileSet.size === 0) {
        this.browserProfileConnections.delete(browserProfileId);
      }
    }

    // Emit disconnected event
    this.eventBus.emit({
      type: "browser-tab-disconnected",
      browserProfileId,
      connectionId,
      tabCount: this.getTabCount(browserProfileId),
      totalTabCount: this.getTotalTabCount(),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Check if a browser profile has any active connections.
   */
  isBrowserProfileConnected(browserProfileId: string): boolean {
    const profileSet = this.browserProfileConnections.get(browserProfileId);
    return profileSet !== undefined && profileSet.size > 0;
  }

  /**
   * Get all browser profile IDs with active connections.
   */
  getConnectedBrowserProfileIds(): string[] {
    return Array.from(this.browserProfileConnections.keys());
  }

  /**
   * Get the number of active connections for a browser profile.
   */
  getTabCount(browserProfileId: string): number {
    return this.browserProfileConnections.get(browserProfileId)?.size ?? 0;
  }

  /**
   * Get the total number of active connections across all devices.
   */
  getTotalTabCount(): number {
    return this.connections.size;
  }

  /**
   * Get all active connections (for debugging/status endpoint).
   */
  getAllConnections(): BrowserTabConnection[] {
    return Array.from(this.connections.values());
  }
}
