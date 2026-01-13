/**
 * Connections API - List connected browser profiles
 *
 * GET /api/connections - List all connected browser profiles with metadata
 */

import type { ConnectionInfo, ConnectionsResponse } from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { PushService } from "../push/index.js";
import type { ConnectedBrowsersService } from "../services/ConnectedBrowsersService.js";

export interface ConnectionsDeps {
  connectedBrowsers: ConnectedBrowsersService;
  pushService?: PushService;
}

export function createConnectionsRoutes(deps: ConnectionsDeps) {
  const { connectedBrowsers, pushService } = deps;
  const app = new Hono();

  /**
   * GET / - List all connected browser profiles
   */
  app.get("/", async (c) => {
    // Get all connections from the service
    const allConnections = connectedBrowsers.getAllConnections();

    // Group connections by browserProfileId
    const profileMap = new Map<
      string,
      { connectionCount: number; connectedAt: string }
    >();

    for (const conn of allConnections) {
      const existing = profileMap.get(conn.browserProfileId);
      if (!existing) {
        profileMap.set(conn.browserProfileId, {
          connectionCount: 1,
          connectedAt: conn.connectedAt,
        });
      } else {
        existing.connectionCount++;
        // Keep the earliest connectedAt
        if (conn.connectedAt < existing.connectedAt) {
          existing.connectedAt = conn.connectedAt;
        }
      }
    }

    // Get device names from push subscriptions if available
    const subscriptions = pushService?.getSubscriptions() ?? {};

    // Build the response
    const connections: ConnectionInfo[] = [];
    for (const [browserProfileId, info] of profileMap) {
      const subscription = subscriptions[browserProfileId];
      connections.push({
        browserProfileId,
        connectionCount: info.connectionCount,
        connectedAt: info.connectedAt,
        deviceName: subscription?.deviceName,
      });
    }

    // Sort by connectedAt (oldest first)
    connections.sort((a, b) => a.connectedAt.localeCompare(b.connectedAt));

    const response: ConnectionsResponse = { connections };
    return c.json(response);
  });

  return app;
}
