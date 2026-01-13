/**
 * Tracks which browser tabs have active SSE/WebSocket connections to the server.
 * This enables:
 * - Skipping push notifications for already-connected devices
 * - Showing "X active sessions" in Settings > Remote Access
 * - Real-time updates when tabs connect/disconnect
 */

import type { EventBus } from "../watcher/index.js";

/** Transport type for the connection */
export type BrowserConnectionTransport = "sse" | "ws";

/** Information about a single browser tab connection */
export interface BrowserTabConnection {
  connectionId: number;
  deviceId: string;
  connectedAt: string;
  transport: BrowserConnectionTransport;
}

/**
 * Service to track connected browser tabs by deviceId.
 *
 * A deviceId identifies a browser profile (stored in localStorage, shared across tabs).
 * Each tab creates a separate connection, so one device can have multiple connections.
 */
export class ConnectedBrowsersService {
  private nextConnectionId = 1;
  /** Map from connectionId to connection info */
  private connections = new Map<number, BrowserTabConnection>();
  /** Map from deviceId to set of connectionIds */
  private deviceConnections = new Map<string, Set<number>>();

  constructor(private eventBus: EventBus) {}

  /**
   * Register a new browser tab connection.
   * @param deviceId - Unique identifier for the browser profile
   * @param transport - Connection type (sse or ws)
   * @returns connectionId for tracking (use when disconnecting)
   */
  connect(deviceId: string, transport: BrowserConnectionTransport): number {
    const connectionId = this.nextConnectionId++;
    const connection: BrowserTabConnection = {
      connectionId,
      deviceId,
      connectedAt: new Date().toISOString(),
      transport,
    };

    this.connections.set(connectionId, connection);

    // Add to device's connection set
    let deviceSet = this.deviceConnections.get(deviceId);
    if (!deviceSet) {
      deviceSet = new Set();
      this.deviceConnections.set(deviceId, deviceSet);
    }
    deviceSet.add(connectionId);

    // Emit connected event
    this.eventBus.emit({
      type: "browser-tab-connected",
      deviceId,
      connectionId,
      transport,
      tabCount: this.getTabCount(deviceId),
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

    const { deviceId } = connection;

    // Remove from connections map
    this.connections.delete(connectionId);

    // Remove from device's connection set
    const deviceSet = this.deviceConnections.get(deviceId);
    if (deviceSet) {
      deviceSet.delete(connectionId);
      if (deviceSet.size === 0) {
        this.deviceConnections.delete(deviceId);
      }
    }

    // Emit disconnected event
    this.eventBus.emit({
      type: "browser-tab-disconnected",
      deviceId,
      connectionId,
      tabCount: this.getTabCount(deviceId),
      totalTabCount: this.getTotalTabCount(),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Check if a device has any active connections.
   */
  isDeviceConnected(deviceId: string): boolean {
    const deviceSet = this.deviceConnections.get(deviceId);
    return deviceSet !== undefined && deviceSet.size > 0;
  }

  /**
   * Get all device IDs with active connections.
   */
  getConnectedDeviceIds(): string[] {
    return Array.from(this.deviceConnections.keys());
  }

  /**
   * Get the number of active connections for a device.
   */
  getTabCount(deviceId: string): number {
    return this.deviceConnections.get(deviceId)?.size ?? 0;
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
