import type { ConnectionsResponse } from "@yep-anywhere/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PushService } from "../../src/push/index.js";
import type { StoredSubscription } from "../../src/push/types.js";
import { createConnectionsRoutes } from "../../src/routes/connections.js";
import type { ConnectedBrowsersService } from "../../src/services/ConnectedBrowsersService.js";

describe("Connections Routes", () => {
  let mockConnectedBrowsers: ConnectedBrowsersService;
  let mockPushService: PushService;

  beforeEach(() => {
    mockConnectedBrowsers = {
      getAllConnections: vi.fn(() => []),
    } as unknown as ConnectedBrowsersService;

    mockPushService = {
      getSubscriptions: vi.fn(() => ({})),
    } as unknown as PushService;
  });

  async function makeRequest(
    connectedBrowsers: ConnectedBrowsersService,
    pushService?: PushService,
  ): Promise<ConnectionsResponse> {
    const routes = createConnectionsRoutes({ connectedBrowsers, pushService });
    const response = await routes.request("/");
    expect(response.status).toBe(200);
    return response.json();
  }

  describe("GET /", () => {
    it("returns empty connections when no browsers connected", async () => {
      const result = await makeRequest(mockConnectedBrowsers, mockPushService);

      expect(result.connections).toEqual([]);
    });

    it("returns connected browser profiles", async () => {
      vi.mocked(mockConnectedBrowsers.getAllConnections).mockReturnValue([
        {
          connectionId: 1,
          browserProfileId: "profile-1",
          connectedAt: "2024-01-01T10:00:00.000Z",
          transport: "sse",
        },
      ]);

      const result = await makeRequest(mockConnectedBrowsers, mockPushService);

      expect(result.connections).toHaveLength(1);
      expect(result.connections[0]).toEqual({
        browserProfileId: "profile-1",
        connectionCount: 1,
        connectedAt: "2024-01-01T10:00:00.000Z",
        deviceName: undefined,
      });
    });

    it("aggregates multiple connections for same browser profile", async () => {
      vi.mocked(mockConnectedBrowsers.getAllConnections).mockReturnValue([
        {
          connectionId: 1,
          browserProfileId: "profile-1",
          connectedAt: "2024-01-01T10:00:00.000Z",
          transport: "sse",
        },
        {
          connectionId: 2,
          browserProfileId: "profile-1",
          connectedAt: "2024-01-01T10:05:00.000Z",
          transport: "ws",
        },
        {
          connectionId: 3,
          browserProfileId: "profile-1",
          connectedAt: "2024-01-01T09:55:00.000Z",
          transport: "sse",
        },
      ]);

      const result = await makeRequest(mockConnectedBrowsers, mockPushService);

      expect(result.connections).toHaveLength(1);
      expect(result.connections[0].browserProfileId).toBe("profile-1");
      expect(result.connections[0].connectionCount).toBe(3);
      // Should use the earliest connectedAt timestamp
      expect(result.connections[0].connectedAt).toBe(
        "2024-01-01T09:55:00.000Z",
      );
    });

    it("returns multiple browser profiles separately", async () => {
      vi.mocked(mockConnectedBrowsers.getAllConnections).mockReturnValue([
        {
          connectionId: 1,
          browserProfileId: "profile-1",
          connectedAt: "2024-01-01T10:00:00.000Z",
          transport: "sse",
        },
        {
          connectionId: 2,
          browserProfileId: "profile-2",
          connectedAt: "2024-01-01T09:00:00.000Z",
          transport: "ws",
        },
      ]);

      const result = await makeRequest(mockConnectedBrowsers, mockPushService);

      expect(result.connections).toHaveLength(2);
      // Should be sorted by connectedAt (oldest first)
      expect(result.connections[0].browserProfileId).toBe("profile-2");
      expect(result.connections[1].browserProfileId).toBe("profile-1");
    });

    it("includes device name from push subscriptions", async () => {
      vi.mocked(mockConnectedBrowsers.getAllConnections).mockReturnValue([
        {
          connectionId: 1,
          browserProfileId: "profile-1",
          connectedAt: "2024-01-01T10:00:00.000Z",
          transport: "sse",
        },
      ]);

      vi.mocked(mockPushService.getSubscriptions).mockReturnValue({
        "profile-1": {
          subscription: {
            endpoint: "https://example.com/push",
            keys: { p256dh: "key1", auth: "key2" },
          },
          createdAt: "2024-01-01T09:00:00.000Z",
          deviceName: "My iPhone",
        } satisfies StoredSubscription,
      });

      const result = await makeRequest(mockConnectedBrowsers, mockPushService);

      expect(result.connections).toHaveLength(1);
      expect(result.connections[0].deviceName).toBe("My iPhone");
    });

    it("works without push service", async () => {
      vi.mocked(mockConnectedBrowsers.getAllConnections).mockReturnValue([
        {
          connectionId: 1,
          browserProfileId: "profile-1",
          connectedAt: "2024-01-01T10:00:00.000Z",
          transport: "sse",
        },
      ]);

      // No push service provided
      const result = await makeRequest(mockConnectedBrowsers);

      expect(result.connections).toHaveLength(1);
      expect(result.connections[0].deviceName).toBeUndefined();
    });

    it("handles browser profile with no push subscription", async () => {
      vi.mocked(mockConnectedBrowsers.getAllConnections).mockReturnValue([
        {
          connectionId: 1,
          browserProfileId: "profile-1",
          connectedAt: "2024-01-01T10:00:00.000Z",
          transport: "sse",
        },
        {
          connectionId: 2,
          browserProfileId: "profile-2",
          connectedAt: "2024-01-01T11:00:00.000Z",
          transport: "sse",
        },
      ]);

      // Only profile-1 has a push subscription
      vi.mocked(mockPushService.getSubscriptions).mockReturnValue({
        "profile-1": {
          subscription: {
            endpoint: "https://example.com/push",
            keys: { p256dh: "key1", auth: "key2" },
          },
          createdAt: "2024-01-01T09:00:00.000Z",
          deviceName: "My iPhone",
        } satisfies StoredSubscription,
      });

      const result = await makeRequest(mockConnectedBrowsers, mockPushService);

      expect(result.connections).toHaveLength(2);
      const profile1 = result.connections.find(
        (c) => c.browserProfileId === "profile-1",
      );
      const profile2 = result.connections.find(
        (c) => c.browserProfileId === "profile-2",
      );

      expect(profile1?.deviceName).toBe("My iPhone");
      expect(profile2?.deviceName).toBeUndefined();
    });
  });
});
