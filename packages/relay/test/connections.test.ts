import type { SqliteDatabase } from "@yep-anywhere/shared/sqlite";
import { SPEECH_RELAY_CHANNEL } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { ConnectionManager } from "../src/connections.js";
import { createTestDb } from "../src/db.js";
import { UsernameRegistry } from "../src/registry.js";

function createMockWs(): WebSocket {
  type SendParameters = Parameters<WebSocket["send"]>;
  const ws: Pick<WebSocket, "send" | "close"> = {
    send: vi.fn<
      (
        data: SendParameters[0],
        optionsOrCallback?: SendParameters[1] | SendParameters[2],
        callback?: SendParameters[2],
      ) => void
    >(),
    close: vi.fn<WebSocket["close"]>(),
  };
  // ConnectionManager uses these methods and the socket's object identity.
  return ws as WebSocket;
}

describe("ConnectionManager", () => {
  let db: SqliteDatabase;
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

    it("allows the same install to reserve app and speech channels", () => {
      const appWs = createMockWs();
      const speechWs = createMockWs();

      expect(manager.registerServer(appWs, "alice", "install-1")).toBe(
        "registered",
      );
      expect(
        manager.registerServer(
          speechWs,
          "alice",
          "install-1",
          {},
          SPEECH_RELAY_CHANNEL,
        ),
      ).toBe("registered");

      expect(manager.getWaitingCount()).toBe(2);
      expect(manager.isWaiting("alice")).toBe(true);
      expect(manager.isWaiting("alice", SPEECH_RELAY_CHANNEL)).toBe(true);
      expect(manager.getWaitingUsernames()).toEqual(["alice"]);
    });

    it("rejects speech channel registration from another install", () => {
      const appWs = createMockWs();
      const speechWs = createMockWs();

      manager.registerServer(appWs, "alice", "install-1");
      const result = manager.registerServer(
        speechWs,
        "alice",
        "install-2",
        {},
        SPEECH_RELAY_CHANNEL,
      );

      expect(result).toBe("username_taken");
      expect(manager.isWaiting("alice", SPEECH_RELAY_CHANNEL)).toBe(false);
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
        expect(result.server?.installId).toBe("install-1");
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

    it("connects clients to the requested channel only", () => {
      const appWs = createMockWs();
      const speechWs = createMockWs();
      const clientWs = createMockWs();

      manager.registerServer(appWs, "alice", "install-1");
      manager.registerServer(
        speechWs,
        "alice",
        "install-1",
        {},
        SPEECH_RELAY_CHANNEL,
      );

      const result = manager.connectClientChannel(
        clientWs,
        "alice",
        SPEECH_RELAY_CHANNEL,
      );

      expect(result.status).toBe("connected");
      if (result.status === "connected") {
        expect(result.serverWs).toBe(speechWs);
      }
      expect(manager.isWaiting("alice")).toBe(true);
      expect(manager.isWaiting("alice", SPEECH_RELAY_CHANNEL)).toBe(false);
    });

    it("pairs a logical client endpoint without requiring a client WebSocket", () => {
      const serverWs = createMockWs();
      const endpointKey = {};
      const endpoint = {
        key: endpointKey,
        close: vi.fn(),
        send: vi.fn(),
      };

      manager.registerServer(serverWs, "alice", "install-1");
      expect(manager.connectClientEndpoint(endpoint, "alice").status).toBe(
        "connected",
      );

      manager.forward(serverWs, Buffer.from("from server"), false);
      expect(endpoint.send).toHaveBeenCalledWith(
        Buffer.from("from server"),
        false,
      );

      manager.forward(endpointKey, Buffer.from("from client"), true);
      expect(serverWs.send).toHaveBeenCalledWith(Buffer.from("from client"), {
        binary: true,
      });

      expect(manager.handleClientEndpointClose(endpointKey)).toMatchObject({
        kind: "pair_disconnected",
        initiator: "client",
      });
      expect(serverWs.close).toHaveBeenCalled();
      expect(manager.getPairCount()).toBe(0);
    });
  });

  describe("forward", () => {
    it("forwards string messages between pairs", () => {
      const serverWs = createMockWs();
      const clientWs = createMockWs();

      manager.registerServer(serverWs, "alice", "install-1");
      manager.connectClient(clientWs, "alice");

      // Client sends to server (isBinary: false for text)
      manager.forward(clientWs, Buffer.from("hello from client"), false);
      expect(serverWs.send).toHaveBeenCalledWith(
        Buffer.from("hello from client"),
        { binary: false },
      );

      // Server sends to client
      manager.forward(serverWs, Buffer.from("hello from server"), false);
      expect(clientWs.send).toHaveBeenCalledWith(
        Buffer.from("hello from server"),
        { binary: false },
      );
    });

    it("forwards binary messages between pairs", () => {
      const serverWs = createMockWs();
      const clientWs = createMockWs();

      manager.registerServer(serverWs, "alice", "install-1");
      manager.connectClient(clientWs, "alice");

      const binaryData = Buffer.from([0, 0, 0, 0]);
      manager.forward(clientWs, binaryData, true);
      expect(serverWs.send).toHaveBeenCalledWith(binaryData, { binary: true });
    });

    it("ignores forward from unpaired connection", () => {
      const ws = createMockWs();
      manager.forward(ws, Buffer.from("ignored"), false);
      // Should not throw and no message should be sent
    });
  });

  describe("handleClose", () => {
    it("removes waiting connection", () => {
      const ws = createMockWs();
      manager.registerServer(ws, "alice", "install-1");
      expect(manager.getWaitingCount()).toBe(1);

      const result = manager.handleClose(ws, "alice");
      expect(result).toEqual({
        kind: "waiting_server_closed",
        server: expect.objectContaining({
          username: "alice",
          installId: "install-1",
          state: "waiting",
        }),
      });
      expect(manager.getWaitingCount()).toBe(0);
    });

    it("closes paired connection and cleans up", () => {
      const serverWs = createMockWs();
      const clientWs = createMockWs();

      manager.registerServer(serverWs, "alice", "install-1");
      manager.connectClient(clientWs, "alice");
      expect(manager.getPairCount()).toBe(1);

      // Client disconnects
      const result = manager.handleClose(clientWs);
      expect(result).toEqual({
        kind: "pair_disconnected",
        initiator: "client",
        server: expect.objectContaining({
          username: "alice",
          installId: "install-1",
          state: "paired",
        }),
      });
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
      const result = manager.handleClose(serverWs, "alice");
      expect(result).toEqual({
        kind: "pair_disconnected",
        initiator: "server",
        server: expect.objectContaining({
          username: "alice",
          installId: "install-1",
          state: "paired",
        }),
      });
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

  describe("isWaitingWs", () => {
    it("returns true for waiting connection", () => {
      const ws = createMockWs();
      manager.registerServer(ws, "alice", "install-1");
      expect(manager.isWaitingWs(ws)).toBe(true);
    });

    it("returns false for paired connection", () => {
      const serverWs = createMockWs();
      const clientWs = createMockWs();

      manager.registerServer(serverWs, "alice", "install-1");
      manager.connectClient(clientWs, "alice");

      expect(manager.isWaitingWs(serverWs)).toBe(false);
    });

    it("returns false for unknown connection", () => {
      const ws = createMockWs();
      expect(manager.isWaitingWs(ws)).toBe(false);
    });
  });

  describe("isWaiting (by username)", () => {
    it("returns true for username with waiting server", () => {
      const ws = createMockWs();
      manager.registerServer(ws, "alice", "install-1");
      expect(manager.isWaiting("alice")).toBe(true);
    });

    it("returns false for username without waiting server", () => {
      expect(manager.isWaiting("bob")).toBe(false);
    });

    it("returns false after server is paired", () => {
      const serverWs = createMockWs();
      const clientWs = createMockWs();

      manager.registerServer(serverWs, "alice", "install-1");
      manager.connectClient(clientWs, "alice");

      expect(manager.isWaiting("alice")).toBe(false);
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
