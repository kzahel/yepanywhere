import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedBrowsersService } from "../../src/services/ConnectedBrowsersService.js";
import type { EventBus } from "../../src/watcher/index.js";

describe("ConnectedBrowsersService", () => {
  let service: ConnectedBrowsersService;
  let mockEventBus: EventBus;
  let emittedEvents: unknown[];

  beforeEach(() => {
    emittedEvents = [];
    mockEventBus = {
      emit: vi.fn((event) => emittedEvents.push(event)),
      subscribe: vi.fn(),
      subscriberCount: 0,
    } as unknown as EventBus;
    service = new ConnectedBrowsersService(mockEventBus);
  });

  describe("connect", () => {
    it("returns unique connection IDs", () => {
      const id1 = service.connect("profile-1", "sse");
      const id2 = service.connect("profile-1", "sse");
      const id3 = service.connect("profile-2", "ws");

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
    });

    it("emits browser-tab-connected event", () => {
      service.connect("profile-1", "sse");

      expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
      const event = emittedEvents[0] as Record<string, unknown>;
      expect(event.type).toBe("browser-tab-connected");
      expect(event.browserProfileId).toBe("profile-1");
      expect(event.transport).toBe("sse");
      expect(event.tabCount).toBe(1);
      expect(event.totalTabCount).toBe(1);
    });

    it("tracks multiple tabs for same device", () => {
      service.connect("profile-1", "sse");
      service.connect("profile-1", "sse");

      expect(service.getTabCount("profile-1")).toBe(2);
      expect(service.getTotalTabCount()).toBe(2);

      // Second event should have tabCount: 2
      const event = emittedEvents[1] as Record<string, unknown>;
      expect(event.tabCount).toBe(2);
    });

    it("tracks different devices independently", () => {
      service.connect("profile-1", "sse");
      service.connect("profile-2", "ws");

      expect(service.getTabCount("profile-1")).toBe(1);
      expect(service.getTabCount("profile-2")).toBe(1);
      expect(service.getTotalTabCount()).toBe(2);
    });
  });

  describe("disconnect", () => {
    it("emits browser-tab-disconnected event", () => {
      const connId = service.connect("profile-1", "sse");
      emittedEvents.length = 0; // Clear connect events

      service.disconnect(connId);

      expect(mockEventBus.emit).toHaveBeenCalled();
      const event = emittedEvents[0] as Record<string, unknown>;
      expect(event.type).toBe("browser-tab-disconnected");
      expect(event.browserProfileId).toBe("profile-1");
      expect(event.connectionId).toBe(connId);
      expect(event.tabCount).toBe(0);
      expect(event.totalTabCount).toBe(0);
    });

    it("does nothing for unknown connection ID", () => {
      service.disconnect(999);
      expect(emittedEvents).toHaveLength(0);
    });

    it("updates tab counts correctly", () => {
      const id1 = service.connect("profile-1", "sse");
      service.connect("profile-1", "sse");

      expect(service.getTabCount("profile-1")).toBe(2);

      service.disconnect(id1);

      expect(service.getTabCount("profile-1")).toBe(1);
      expect(service.getTotalTabCount()).toBe(1);
    });

    it("removes device when last tab disconnects", () => {
      const connId = service.connect("profile-1", "sse");

      expect(service.isBrowserProfileConnected("profile-1")).toBe(true);

      service.disconnect(connId);

      expect(service.isBrowserProfileConnected("profile-1")).toBe(false);
      expect(service.getConnectedBrowserProfileIds()).not.toContain(
        "profile-1",
      );
    });
  });

  describe("isBrowserProfileConnected", () => {
    it("returns false for unconnected device", () => {
      expect(service.isBrowserProfileConnected("profile-1")).toBe(false);
    });

    it("returns true for connected device", () => {
      service.connect("profile-1", "sse");
      expect(service.isBrowserProfileConnected("profile-1")).toBe(true);
    });

    it("returns false after all tabs disconnect", () => {
      const id1 = service.connect("profile-1", "sse");
      const id2 = service.connect("profile-1", "sse");

      service.disconnect(id1);
      expect(service.isBrowserProfileConnected("profile-1")).toBe(true);

      service.disconnect(id2);
      expect(service.isBrowserProfileConnected("profile-1")).toBe(false);
    });
  });

  describe("getConnectedBrowserProfileIds", () => {
    it("returns empty array when no connections", () => {
      expect(service.getConnectedBrowserProfileIds()).toEqual([]);
    });

    it("returns all connected device IDs", () => {
      service.connect("profile-1", "sse");
      service.connect("profile-2", "ws");
      service.connect("profile-3", "sse");

      const browserProfileIds = service.getConnectedBrowserProfileIds();
      expect(browserProfileIds).toHaveLength(3);
      expect(browserProfileIds).toContain("profile-1");
      expect(browserProfileIds).toContain("profile-2");
      expect(browserProfileIds).toContain("profile-3");
    });

    it("does not duplicate device IDs for multiple tabs", () => {
      service.connect("profile-1", "sse");
      service.connect("profile-1", "ws");
      service.connect("profile-1", "sse");

      const browserProfileIds = service.getConnectedBrowserProfileIds();
      expect(browserProfileIds).toEqual(["profile-1"]);
    });
  });

  describe("getTabCount", () => {
    it("returns 0 for unconnected device", () => {
      expect(service.getTabCount("profile-1")).toBe(0);
    });

    it("returns correct count for connected device", () => {
      service.connect("profile-1", "sse");
      service.connect("profile-1", "ws");
      service.connect("profile-1", "sse");

      expect(service.getTabCount("profile-1")).toBe(3);
    });
  });

  describe("getTotalTabCount", () => {
    it("returns 0 when no connections", () => {
      expect(service.getTotalTabCount()).toBe(0);
    });

    it("returns total count across all devices", () => {
      service.connect("profile-1", "sse");
      service.connect("profile-1", "sse");
      service.connect("profile-2", "ws");

      expect(service.getTotalTabCount()).toBe(3);
    });
  });

  describe("getAllConnections", () => {
    it("returns empty array when no connections", () => {
      expect(service.getAllConnections()).toEqual([]);
    });

    it("returns all connection details", () => {
      const id1 = service.connect("profile-1", "sse");
      const id2 = service.connect("profile-2", "ws");

      const connections = service.getAllConnections();
      expect(connections).toHaveLength(2);

      const conn1 = connections.find((c) => c.connectionId === id1);
      expect(conn1).toBeDefined();
      expect(conn1?.browserProfileId).toBe("profile-1");
      expect(conn1?.transport).toBe("sse");
      expect(conn1?.connectedAt).toBeDefined();

      const conn2 = connections.find((c) => c.connectionId === id2);
      expect(conn2).toBeDefined();
      expect(conn2?.browserProfileId).toBe("profile-2");
      expect(conn2?.transport).toBe("ws");
    });
  });
});
