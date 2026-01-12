import { isValidRelayUsername } from "@yep-anywhere/shared";
import type { WSContext } from "hono/ws";
import type { UsernameRegistry } from "./registry.js";

export type RegistrationResult =
  | "registered"
  | "username_taken"
  | "invalid_username";

export type ConnectionResult =
  | { status: "connected"; serverWs: WSContext }
  | { status: "server_offline" }
  | { status: "unknown_username" };

interface Pair {
  server: WSContext;
  client: WSContext;
}

/**
 * Manages WebSocket connections for the relay.
 *
 * Responsibilities:
 * - Track waiting server connections (one per username)
 * - Match clients to waiting servers
 * - Forward messages between paired connections
 * - Clean up on disconnect
 */
export class ConnectionManager {
  /** Waiting server connections by username */
  private waiting = new Map<string, WSContext>();
  /** Active server/client pairs */
  private pairs = new Set<Pair>();
  /** Lookup from WebSocket to its pair (for forwarding) */
  private pairLookup = new Map<WSContext, Pair>();
  /** Registry for username validation */
  private registry: UsernameRegistry;

  constructor(registry: UsernameRegistry) {
    this.registry = registry;
  }

  /**
   * Register a server's waiting connection.
   *
   * @param ws - The WebSocket connection
   * @param username - Username to register
   * @param installId - Installation ID for ownership verification
   * @returns Registration result
   */
  registerServer(
    ws: WSContext,
    username: string,
    installId: string,
  ): RegistrationResult {
    // Validate username format
    if (!isValidRelayUsername(username)) {
      return "invalid_username";
    }

    // Check registry (persistent ownership)
    if (!this.registry.canRegister(username, installId)) {
      return "username_taken";
    }

    // Register in persistent storage
    if (!this.registry.register(username, installId)) {
      return "username_taken";
    }

    // Close existing waiting connection for this username (same installId reconnecting)
    const existingWaiting = this.waiting.get(username);
    if (existingWaiting) {
      try {
        existingWaiting.close(1000, "Replaced by new connection");
      } catch {
        // Ignore close errors
      }
    }

    // Store as waiting connection
    this.waiting.set(username, ws);

    return "registered";
  }

  /**
   * Connect a client to a waiting server.
   *
   * @param ws - The client WebSocket connection
   * @param username - Username to connect to
   * @returns Connection result with server WebSocket on success
   */
  connectClient(ws: WSContext, username: string): ConnectionResult {
    // Check if username is registered at all
    if (!this.registry.isRegistered(username)) {
      return { status: "unknown_username" };
    }

    // Check if server is currently online (has a waiting connection)
    const serverWs = this.waiting.get(username);
    if (!serverWs) {
      return { status: "server_offline" };
    }

    // Remove from waiting map (server is now paired)
    this.waiting.delete(username);

    // Create pair
    const pair: Pair = { server: serverWs, client: ws };
    this.pairs.add(pair);
    this.pairLookup.set(serverWs, pair);
    this.pairLookup.set(ws, pair);

    // Update last seen for the username
    this.registry.updateLastSeen(username);

    return { status: "connected", serverWs };
  }

  /**
   * Forward data from one WebSocket to its pair.
   *
   * @param ws - Source WebSocket
   * @param data - Data to forward (binary or string)
   */
  forward(ws: WSContext, data: ArrayBuffer | string): void {
    const pair = this.pairLookup.get(ws);
    if (!pair) {
      return; // Not paired, ignore
    }

    // Determine the other end
    const target = pair.server === ws ? pair.client : pair.server;

    try {
      if (typeof data === "string") {
        target.send(data);
      } else {
        target.send(data);
      }
    } catch {
      // Ignore send errors - connection may have closed
    }
  }

  /**
   * Handle WebSocket close event.
   * Cleans up waiting/paired state and closes the other end if paired.
   *
   * @param ws - The WebSocket that closed
   * @param username - Username associated with this connection (if known)
   */
  handleClose(ws: WSContext, username?: string): void {
    // Check if this was a waiting connection
    if (username) {
      const waitingWs = this.waiting.get(username);
      if (waitingWs === ws) {
        this.waiting.delete(username);
        return;
      }
    }

    // Check if this was part of a pair
    const pair = this.pairLookup.get(ws);
    if (pair) {
      this.pairs.delete(pair);
      this.pairLookup.delete(pair.server);
      this.pairLookup.delete(pair.client);

      // Close the other end
      const other = pair.server === ws ? pair.client : pair.server;
      try {
        other.close(1000, "Peer disconnected");
      } catch {
        // Ignore close errors
      }
    }
  }

  /**
   * Check if a WebSocket is currently paired.
   */
  isPaired(ws: WSContext): boolean {
    return this.pairLookup.has(ws);
  }

  /**
   * Check if a WebSocket is waiting for a client.
   */
  isWaiting(ws: WSContext): boolean {
    for (const waitingWs of this.waiting.values()) {
      if (waitingWs === ws) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get the number of waiting connections.
   */
  getWaitingCount(): number {
    return this.waiting.size;
  }

  /**
   * Get the number of active pairs.
   */
  getPairCount(): number {
    return this.pairs.size;
  }

  /**
   * Get all waiting usernames (for debugging/admin).
   */
  getWaitingUsernames(): string[] {
    return Array.from(this.waiting.keys());
  }
}
