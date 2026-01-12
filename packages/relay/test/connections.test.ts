import type Database from "better-sqlite3";
import type { WSContext } from "hono/ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "../src/connections.js";
import { createTestDb } from "../src/db.js";
import { UsernameRegistry } from "../src/registry.js";

/** Create a mock WSContext for testing */
function createMockWs(): WSContext & {
  sentMessages: (string | ArrayBuffer)[];
  closed: boolean;
  closeCode?: number;
  closeReason?: string;
} {
  const sentMessages: (string | ArrayBuffer)[] = [];
  let closed = false;
  let closeCode: number | undefined;
  let closeReason: string | undefined;

  return {
    sentMessages,
    closed,
    closeCode,
    closeReason,
    send: vi.fn((data: string | ArrayBuffer) => {
      sentMessages.push(data);
    }),
    close: vi.fn((code?: number, reason?: string) => {
      closed = true;
      closeCode = code;
      closeReason = reason;
    }),
    raw: null,
    binaryType: "arraybuffer",
    readyState: 1, // OPEN
    url: null,
    protocol: null,
  } as unknown as WSContext & {
    sentMessages: (string | ArrayBuffer)[];
    closed: boolean;
    closeCode?: number;
    closeReason?: string;
  };
}

describe("ConnectionManager", () => {
  let db: Database.Database;
  let registry: UsernameRegistry;
  let manager: ConnectionManager;

  beforeEach(() => {
    db = createTestDb();
    registry = new UsernameRegistry(db);
    manager = new ConnectionManager(registry);
  });

  afterEach(() => {
    db.close();
  });

  describe("registerServer", () => {
    it("registers server successfully", () => {
      const ws = createMockWs();
      const result = manager.registerServer(ws, "alice", "install-1");

      expect(result).toBe("registered");
      expect(manager.getWaitingCount()).toBe(1);
      expect(manager.getWaitingUsernames()).toContain("alice");
    });

    it("rejects invalid username", () => {
      const ws = createMockWs();
      const result = manager.registerServer(ws, "ab", "install-1");

      expect(result).toBe("invalid_username");
      expect(manager.getWaitingCount()).toBe(0);
    });

    it("rejects username taken by different installId", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      manager.registerServer(ws1, "alice", "install-1");
      const result = manager.registerServer(ws2, "alice", "install-2");

      expect(result).toBe("username_taken");
      expect(manager.getWaitingCount()).toBe(1);
    });

    it("replaces waiting connection for same installId", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      manager.registerServer(ws1, "alice", "install-1");
      const result = manager.registerServer(ws2, "alice", "install-1");

      expect(result).toBe("registered");
      expect(manager.getWaitingCount()).toBe(1);
      // First connection should be closed
      expect(ws1.close).toHaveBeenCalled();
    });

    it("registers multiple different usernames", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      manager.registerServer(ws1, "alice", "install-1");
      manager.registerServer(ws2, "bob", "install-2");

      expect(manager.getWaitingCount()).toBe(2);
      expect(manager.getWaitingUsernames()).toContain("alice");
      expect(manager.getWaitingUsernames()).toContain("bob");
    });
  });

  describe("connectClient", () => {
    it("connects to waiting server", () => {
      const serverWs = createMockWs();
      const clientWs = createMockWs();

      manager.registerServer(serverWs, "alice", "install-1");
      const result = manager.connectClient(clientWs, "alice");

      expect(result.status).toBe("connected");
      if (result.status === "connected") {
        expect(result.serverWs).toBe(serverWs);
      }
      expect(manager.getWaitingCount()).toBe(0);
      expect(manager.getPairCount()).toBe(1);
    });

    it("returns server_offline when no waiting connection", () => {
      const clientWs = createMockWs();

      // Register but don't have a waiting connection
      registry.register("alice", "install-1");
      const result = manager.connectClient(clientWs, "alice");

      expect(result.status).toBe("server_offline");
    });

    it("returns unknown_username for unregistered username", () => {
      const clientWs = createMockWs();
      const result = manager.connectClient(clientWs, "nonexistent");

      expect(result.status).toBe("unknown_username");
    });
  });

  describe("forward", () => {
    it("forwards string messages between pairs", () => {
      const serverWs = createMockWs();
      const clientWs = createMockWs();

      manager.registerServer(serverWs, "alice", "install-1");
      manager.connectClient(clientWs, "alice");

      // Client sends to server
      manager.forward(clientWs, "hello from client");
      expect(serverWs.send).toHaveBeenCalledWith("hello from client");

      // Server sends to client
      manager.forward(serverWs, "hello from server");
      expect(clientWs.send).toHaveBeenCalledWith("hello from server");
    });

    it("forwards binary messages between pairs", () => {
      const serverWs = createMockWs();
      const clientWs = createMockWs();

      manager.registerServer(serverWs, "alice", "install-1");
      manager.connectClient(clientWs, "alice");

      const binaryData = new ArrayBuffer(4);
      manager.forward(clientWs, binaryData);
      expect(serverWs.send).toHaveBeenCalledWith(binaryData);
    });

    it("ignores forward from unpaired connection", () => {
      const ws = createMockWs();
      manager.forward(ws, "ignored");
      // Should not throw and no message should be sent
    });
  });

  describe("handleClose", () => {
    it("removes waiting connection", () => {
      const ws = createMockWs();
      manager.registerServer(ws, "alice", "install-1");
      expect(manager.getWaitingCount()).toBe(1);

      manager.handleClose(ws, "alice");
      expect(manager.getWaitingCount()).toBe(0);
    });

    it("closes paired connection and cleans up", () => {
      const serverWs = createMockWs();
      const clientWs = createMockWs();

      manager.registerServer(serverWs, "alice", "install-1");
      manager.connectClient(clientWs, "alice");
      expect(manager.getPairCount()).toBe(1);

      // Client disconnects
      manager.handleClose(clientWs);
      expect(manager.getPairCount()).toBe(0);
      // Server should be closed
      expect(serverWs.close).toHaveBeenCalled();
    });

    it("closes paired connection when server disconnects", () => {
      const serverWs = createMockWs();
      const clientWs = createMockWs();

      manager.registerServer(serverWs, "alice", "install-1");
      manager.connectClient(clientWs, "alice");

      // Server disconnects
      manager.handleClose(serverWs, "alice");
      expect(manager.getPairCount()).toBe(0);
      // Client should be closed
      expect(clientWs.close).toHaveBeenCalled();
    });
  });

  describe("isPaired", () => {
    it("returns false for waiting connection", () => {
      const ws = createMockWs();
      manager.registerServer(ws, "alice", "install-1");
      expect(manager.isPaired(ws)).toBe(false);
    });

    it("returns true for paired connection", () => {
      const serverWs = createMockWs();
      const clientWs = createMockWs();

      manager.registerServer(serverWs, "alice", "install-1");
      manager.connectClient(clientWs, "alice");

      expect(manager.isPaired(serverWs)).toBe(true);
      expect(manager.isPaired(clientWs)).toBe(true);
    });
  });

  describe("isWaiting", () => {
    it("returns true for waiting connection", () => {
      const ws = createMockWs();
      manager.registerServer(ws, "alice", "install-1");
      expect(manager.isWaiting(ws)).toBe(true);
    });

    it("returns false for paired connection", () => {
      const serverWs = createMockWs();
      const clientWs = createMockWs();

      manager.registerServer(serverWs, "alice", "install-1");
      manager.connectClient(clientWs, "alice");

      expect(manager.isWaiting(serverWs)).toBe(false);
    });

    it("returns false for unknown connection", () => {
      const ws = createMockWs();
      expect(manager.isWaiting(ws)).toBe(false);
    });
  });

  describe("concurrent scenarios", () => {
    it("handles multiple clients trying to connect to same server", () => {
      const serverWs = createMockWs();
      const clientWs1 = createMockWs();
      const clientWs2 = createMockWs();

      manager.registerServer(serverWs, "alice", "install-1");

      // First client connects
      const result1 = manager.connectClient(clientWs1, "alice");
      expect(result1.status).toBe("connected");

      // Second client fails (server now paired)
      const result2 = manager.connectClient(clientWs2, "alice");
      expect(result2.status).toBe("server_offline");
    });

    it("handles server reconnection after client disconnects", () => {
      const serverWs1 = createMockWs();
      const clientWs1 = createMockWs();

      // First session
      manager.registerServer(serverWs1, "alice", "install-1");
      manager.connectClient(clientWs1, "alice");
      manager.handleClose(clientWs1);

      // Server reconnects with new waiting connection
      const serverWs2 = createMockWs();
      const result = manager.registerServer(serverWs2, "alice", "install-1");
      expect(result).toBe("registered");
      expect(manager.getWaitingCount()).toBe(1);

      // New client can connect
      const clientWs2 = createMockWs();
      const connectResult = manager.connectClient(clientWs2, "alice");
      expect(connectResult.status).toBe("connected");
    });
  });
});
