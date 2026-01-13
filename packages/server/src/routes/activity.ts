import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ConnectedBrowsersService } from "../services/index.js";
import type { BusEvent, EventBus } from "../watcher/index.js";

export interface ActivityDeps {
  eventBus: EventBus;
  connectedBrowsers?: ConnectedBrowsersService;
}

export function createActivityRoutes(deps: ActivityDeps): Hono {
  const routes = new Hono();

  // GET /api/activity/events - SSE endpoint for all real-time events
  routes.get("/events", async (c) => {
    // Extract browserProfileId from query string for connection tracking
    const browserProfileId = c.req.query("browserProfileId");

    // Register connection if we have tracking and a browserProfileId
    let connectionId: number | undefined;
    if (deps.connectedBrowsers && browserProfileId) {
      connectionId = deps.connectedBrowsers.connect(browserProfileId, "sse");
    }

    return streamSSE(c, async (stream) => {
      let eventId = 0;

      // Send initial connection event
      await stream.writeSSE({
        id: String(eventId++),
        event: "connected",
        data: JSON.stringify({
          timestamp: new Date().toISOString(),
        }),
      });

      // Heartbeat interval
      const heartbeatInterval = setInterval(async () => {
        try {
          await stream.writeSSE({
            id: String(eventId++),
            event: "heartbeat",
            data: JSON.stringify({ timestamp: new Date().toISOString() }),
          });
        } catch {
          clearInterval(heartbeatInterval);
        }
      }, 30000); // 30 second heartbeat

      let closed = false;

      // Subscribe to bus events (file changes and session status)
      const unsubscribe = deps.eventBus.subscribe(async (event: BusEvent) => {
        if (closed) return;

        try {
          // Use the event's type as the SSE event name
          await stream.writeSSE({
            id: String(eventId++),
            event: event.type,
            data: JSON.stringify(event),
          });
        } catch {
          // Stream closed
          closed = true;
          clearInterval(heartbeatInterval);
          unsubscribe();
        }
      });

      // Cleanup function to unregister connection
      const cleanup = () => {
        if (connectionId !== undefined && deps.connectedBrowsers) {
          deps.connectedBrowsers.disconnect(connectionId);
        }
      };

      // Handle stream close
      stream.onAbort(() => {
        closed = true;
        clearInterval(heartbeatInterval);
        unsubscribe();
        cleanup();
      });

      // Keep stream open indefinitely (until client disconnects)
      await new Promise<void>((resolve) => {
        const checkClosed = setInterval(() => {
          if (closed) {
            clearInterval(checkClosed);
            resolve();
          }
        }, 1000);

        stream.onAbort(() => {
          clearInterval(checkClosed);
          resolve();
        });
      });
    });
  });

  // GET /api/activity/status - Get watcher status
  routes.get("/status", (c) => {
    return c.json({
      subscribers: deps.eventBus.subscriberCount,
      timestamp: new Date().toISOString(),
    });
  });

  // GET /api/activity/connections - Get snapshot of connected browser tabs
  routes.get("/connections", (c) => {
    if (!deps.connectedBrowsers) {
      return c.json({
        connections: [],
        deviceCount: 0,
        totalTabCount: 0,
      });
    }

    return c.json({
      connections: deps.connectedBrowsers.getAllConnections(),
      browserProfileCount:
        deps.connectedBrowsers.getConnectedBrowserProfileIds().length,
      totalTabCount: deps.connectedBrowsers.getTotalTabCount(),
    });
  });

  return routes;
}
