/**
 * E2E tests for the relay server (Phase 6).
 *
 * These tests spin up a relay server and simulate both yepanywhere servers
 * and phone clients connecting through it.
 *
 * Test scenarios:
 * 1. Server registration flow
 * 2. Client connection flow
 * 3. Message forwarding
 * 4. Server offline
 * 5. Username taken
 * 6. Same installId replacement
 * 7. Reconnection after disconnect
 * 8. Full relay flow (server -> relay -> client)
 */

import { randomUUID } from "node:crypto";
import {
  type RelayClientConnect,
  type RelayServerRegister,
  isRelayClientConnected,
  isRelayClientError,
  isRelayServerRegistered,
  isRelayServerRejected,
} from "@yep-anywhere/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type RelayServer, createRelayServer } from "../../src/server.js";

describe("Relay Server E2E", () => {
  let relay: RelayServer;
  let relayUrl: string;

  // Track WebSocket connections for cleanup
  const openConnections: WebSocket[] = [];

  beforeAll(async () => {
    // Start relay server with in-memory database
    relay = await createRelayServer({
      inMemoryDb: true,
      logLevel: "warn",
      disablePrettyPrint: true,
      // Use short ping intervals for faster tests
      pingIntervalMs: 5000,
      pongTimeoutMs: 2000,
    });
    relayUrl = `ws://localhost:${relay.port}/ws`;
    console.log(`[Relay E2E] Server running on port ${relay.port}`);
  });

  afterAll(async () => {
    // Close all open connections
    for (const ws of openConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    openConnections.length = 0;

    await relay.close();
  });

  afterEach(() => {
    // Close any connections that weren't cleaned up
    for (const ws of openConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    openConnections.length = 0;
  });

  /**
   * Helper to create a WebSocket connection to the relay.
   */
  function connectToRelay(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relayUrl);
      openConnections.push(ws);

      const timeout = setTimeout(() => {
        reject(new Error("WebSocket connection timeout"));
      }, 5000);

      ws.on("open", () => {
        clearTimeout(timeout);
        resolve(ws);
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Helper to wait for a message matching a predicate.
   */
  function waitForMessage<T>(
    ws: WebSocket,
    predicate: (msg: unknown) => msg is T,
    timeoutMs = 5000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.off("message", handler);
        reject(new Error("Message wait timeout"));
      }, timeoutMs);

      const handler = (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          if (predicate(msg)) {
            clearTimeout(timeout);
            ws.off("message", handler);
            resolve(msg);
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.on("message", handler);
    });
  }

  /**
   * Helper to register a server with the relay.
   */
  async function registerServer(
    ws: WebSocket,
    username: string,
    installId: string,
  ): Promise<void> {
    const register: RelayServerRegister = {
      type: "server_register",
      username,
      installId,
    };

    const registeredPromise = waitForMessage(ws, isRelayServerRegistered);
    ws.send(JSON.stringify(register));
    await registeredPromise;
  }

  /**
   * Helper to connect a client to a server via the relay.
   */
  async function connectClient(ws: WebSocket, username: string): Promise<void> {
    const connect: RelayClientConnect = {
      type: "client_connect",
      username,
    };

    const connectedPromise = waitForMessage(ws, isRelayClientConnected);
    ws.send(JSON.stringify(connect));
    await connectedPromise;
  }

  /**
   * Helper to collect all messages for a duration.
   */
  function collectMessages(
    ws: WebSocket,
    durationMs: number,
  ): Promise<string[]> {
    return new Promise((resolve) => {
      const messages: string[] = [];

      const handler = (data: WebSocket.RawData) => {
        if (typeof data === "string") {
          messages.push(data);
        } else {
          messages.push(data.toString());
        }
      };

      ws.on("message", handler);

      setTimeout(() => {
        ws.off("message", handler);
        resolve(messages);
      }, durationMs);
    });
  }

  describe("Server Registration Flow", () => {
    it("should successfully register a server with valid username", async () => {
      const ws = await connectToRelay();

      const username = `server-${randomUUID().slice(0, 8)}`;
      const installId = randomUUID();

      const register: RelayServerRegister = {
        type: "server_register",
        username,
        installId,
      };

      const responsePromise = waitForMessage(ws, isRelayServerRegistered);
      ws.send(JSON.stringify(register));

      const response = await responsePromise;
      expect(response.type).toBe("server_registered");

      // Verify server is in waiting state
      expect(relay.connectionManager.getWaitingUsernames()).toContain(username);
    });

    it("should receive server_registered response", async () => {
      const ws = await connectToRelay();

      const username = `srv-${randomUUID().slice(0, 8)}`;
      const installId = randomUUID();

      const register: RelayServerRegister = {
        type: "server_register",
        username,
        installId,
      };

      const responsePromise = waitForMessage(ws, isRelayServerRegistered);
      ws.send(JSON.stringify(register));

      const response = await responsePromise;
      expect(response).toEqual({ type: "server_registered" });
    });

    it("should keep connection open (waiting) after registration", async () => {
      const ws = await connectToRelay();

      const username = `wait-${randomUUID().slice(0, 8)}`;
      const installId = randomUUID();

      await registerServer(ws, username, installId);

      // Connection should still be open
      expect(ws.readyState).toBe(WebSocket.OPEN);

      // Server should be waiting
      expect(relay.connectionManager.getWaitingCount()).toBeGreaterThanOrEqual(
        1,
      );
    });
  });

  describe("Client Connection Flow", () => {
    it("should connect client to waiting server", async () => {
      const serverWs = await connectToRelay();
      const clientWs = await connectToRelay();

      const username = `pair-${randomUUID().slice(0, 8)}`;
      const installId = randomUUID();

      // Register server
      await registerServer(serverWs, username, installId);

      // Connect client
      const connect: RelayClientConnect = {
        type: "client_connect",
        username,
      };

      const connectedPromise = waitForMessage(clientWs, isRelayClientConnected);
      clientWs.send(JSON.stringify(connect));

      const response = await connectedPromise;
      expect(response.type).toBe("client_connected");
    });

    it("should receive client_connected response", async () => {
      const serverWs = await connectToRelay();
      const clientWs = await connectToRelay();

      const username = `conn-${randomUUID().slice(0, 8)}`;
      const installId = randomUUID();

      await registerServer(serverWs, username, installId);

      const connect: RelayClientConnect = {
        type: "client_connect",
        username,
      };

      const connectedPromise = waitForMessage(clientWs, isRelayClientConnected);
      clientWs.send(JSON.stringify(connect));

      const response = await connectedPromise;
      expect(response).toEqual({ type: "client_connected" });
    });

    it("should remove server from waiting after pairing", async () => {
      const serverWs = await connectToRelay();
      const clientWs = await connectToRelay();

      const username = `remove-${randomUUID().slice(0, 8)}`;
      const installId = randomUUID();

      await registerServer(serverWs, username, installId);
      expect(relay.connectionManager.getWaitingUsernames()).toContain(username);

      await connectClient(clientWs, username);

      // Server should no longer be waiting
      expect(relay.connectionManager.getWaitingUsernames()).not.toContain(
        username,
      );
    });
  });

  describe("Message Forwarding", () => {
    it("should forward message from client to server", async () => {
      const serverWs = await connectToRelay();
      const clientWs = await connectToRelay();

      const username = `fwd1-${randomUUID().slice(0, 8)}`;
      const installId = randomUUID();

      await registerServer(serverWs, username, installId);
      await connectClient(clientWs, username);

      // Set up message receiver on server
      const messagePromise = new Promise<string>((resolve) => {
        serverWs.once("message", (data) => resolve(data.toString()));
      });

      // Client sends message
      const testMessage = JSON.stringify({ test: "hello from client" });
      clientWs.send(testMessage);

      // Server should receive it
      const received = await messagePromise;
      expect(received).toBe(testMessage);
    });

    it("should forward message from server to client", async () => {
      const serverWs = await connectToRelay();
      const clientWs = await connectToRelay();

      const username = `fwd2-${randomUUID().slice(0, 8)}`;
      const installId = randomUUID();

      await registerServer(serverWs, username, installId);
      await connectClient(clientWs, username);

      // Set up message receiver on client
      const messagePromise = new Promise<string>((resolve) => {
        clientWs.once("message", (data) => resolve(data.toString()));
      });

      // Server sends message
      const testMessage = JSON.stringify({ test: "hello from server" });
      serverWs.send(testMessage);

      // Client should receive it
      const received = await messagePromise;
      expect(received).toBe(testMessage);
    });

    it("should forward binary data correctly", async () => {
      const serverWs = await connectToRelay();
      const clientWs = await connectToRelay();

      const username = `bin-${randomUUID().slice(0, 8)}`;
      const installId = randomUUID();

      await registerServer(serverWs, username, installId);
      await connectClient(clientWs, username);

      // Set up message receiver on server
      const messagePromise = new Promise<Buffer>((resolve) => {
        serverWs.once("message", (data) =>
          resolve(Buffer.from(data as Buffer)),
        );
      });

      // Client sends binary data
      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
      clientWs.send(binaryData);

      // Server should receive it
      const received = await messagePromise;
      expect(received).toEqual(binaryData);
    });

    it("should handle multiple messages in sequence", async () => {
      const serverWs = await connectToRelay();
      const clientWs = await connectToRelay();

      const username = `seq-${randomUUID().slice(0, 8)}`;
      const installId = randomUUID();

      await registerServer(serverWs, username, installId);
      await connectClient(clientWs, username);

      // Collect messages on server
      const messages: string[] = [];
      serverWs.on("message", (data) => messages.push(data.toString()));

      // Send multiple messages
      clientWs.send("message1");
      clientWs.send("message2");
      clientWs.send("message3");

      // Wait for messages to arrive
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(messages).toEqual(["message1", "message2", "message3"]);
    });
  });

  describe("Server Offline", () => {
    it("should return server_offline for unregistered username", async () => {
      const clientWs = await connectToRelay();

      const connect: RelayClientConnect = {
        type: "client_connect",
        username: "nonexistent-username",
      };

      // Should get error response (unknown_username since not registered at all)
      const responsePromise = waitForMessage(clientWs, isRelayClientError);
      clientWs.send(JSON.stringify(connect));

      const response = await responsePromise;
      expect(response.type).toBe("client_error");
      expect(response.reason).toBe("unknown_username");
    });

    it("should return server_offline when server registered but not connected", async () => {
      const serverWs = await connectToRelay();
      const clientWs = await connectToRelay();

      const username = `offline-${randomUUID().slice(0, 8)}`;
      const installId = randomUUID();

      // Register server
      await registerServer(serverWs, username, installId);

      // Disconnect server
      serverWs.close();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Try to connect client
      const connect: RelayClientConnect = {
        type: "client_connect",
        username,
      };

      const responsePromise = waitForMessage(clientWs, isRelayClientError);
      clientWs.send(JSON.stringify(connect));

      const response = await responsePromise;
      expect(response.type).toBe("client_error");
      expect(response.reason).toBe("server_offline");
    });
  });

  describe("Username Taken", () => {
    it("should reject registration with different installId", async () => {
      const serverWs1 = await connectToRelay();
      const serverWs2 = await connectToRelay();

      const username = `taken-${randomUUID().slice(0, 8)}`;
      const installId1 = randomUUID();
      const installId2 = randomUUID();

      // First server registers successfully
      await registerServer(serverWs1, username, installId1);

      // Second server tries to register same username with different installId
      const register: RelayServerRegister = {
        type: "server_register",
        username,
        installId: installId2,
      };

      const responsePromise = waitForMessage(serverWs2, isRelayServerRejected);
      serverWs2.send(JSON.stringify(register));

      const response = await responsePromise;
      expect(response.type).toBe("server_rejected");
      expect(response.reason).toBe("username_taken");
    });

    it("should close connection after username_taken rejection", async () => {
      const serverWs1 = await connectToRelay();
      const serverWs2 = await connectToRelay();

      const username = `close-${randomUUID().slice(0, 8)}`;
      const installId1 = randomUUID();
      const installId2 = randomUUID();

      await registerServer(serverWs1, username, installId1);

      const register: RelayServerRegister = {
        type: "server_register",
        username,
        installId: installId2,
      };

      const closePromise = new Promise<void>((resolve) => {
        serverWs2.on("close", () => resolve());
      });

      serverWs2.send(JSON.stringify(register));

      await closePromise;
      expect(serverWs2.readyState).toBe(WebSocket.CLOSED);
    });
  });

  describe("Same installId Replacement", () => {
    it("should replace waiting connection with same installId", async () => {
      const serverWs1 = await connectToRelay();

      const username = `replace-${randomUUID().slice(0, 8)}`;
      const installId = randomUUID();

      // First connection registers
      await registerServer(serverWs1, username, installId);
      expect(relay.connectionManager.getWaitingUsernames()).toContain(username);

      // Second connection with same installId
      const serverWs2 = await connectToRelay();
      await registerServer(serverWs2, username, installId);

      // Should still have exactly one waiting connection for this username
      const waitingUsernames = relay.connectionManager.getWaitingUsernames();
      expect(waitingUsernames.filter((u) => u === username).length).toBe(1);
    });

    it("should close old connection when replaced", async () => {
      const serverWs1 = await connectToRelay();

      const username = `closeold-${randomUUID().slice(0, 8)}`;
      const installId = randomUUID();

      await registerServer(serverWs1, username, installId);

      const closePromise = new Promise<void>((resolve) => {
        serverWs1.on("close", () => resolve());
      });

      // Second connection with same installId should close the first
      const serverWs2 = await connectToRelay();
      await registerServer(serverWs2, username, installId);

      await closePromise;
      expect(serverWs1.readyState).toBe(WebSocket.CLOSED);
      expect(serverWs2.readyState).toBe(WebSocket.OPEN);
    });

    it("should allow new client to connect after replacement", async () => {
      const serverWs1 = await connectToRelay();

      const username = `newcli-${randomUUID().slice(0, 8)}`;
      const installId = randomUUID();

      await registerServer(serverWs1, username, installId);

      // Replace with new connection
      const serverWs2 = await connectToRelay();
      await registerServer(serverWs2, username, installId);

      // Wait for first connection to close
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Client should be able to connect
      const clientWs = await connectToRelay();
      await connectClient(clientWs, username);

      // Verify forwarding works to the new server
      const messagePromise = new Promise<string>((resolve) => {
        serverWs2.once("message", (data) => resolve(data.toString()));
      });

      clientWs.send("test message");
      const received = await messagePromise;
      expect(received).toBe("test message");
    });
  });

  describe("Reconnection after Disconnect", () => {
    it("should allow server to reconnect after disconnect", async () => {
      const username = `recon-${randomUUID().slice(0, 8)}`;
      const installId = randomUUID();

      // First connection
      let serverWs = await connectToRelay();
      await registerServer(serverWs, username, installId);
      serverWs.close();

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Reconnect
      serverWs = await connectToRelay();
      await registerServer(serverWs, username, installId);

      // Should be waiting again
      expect(relay.connectionManager.getWaitingUsernames()).toContain(username);
    });

    it("should allow client to connect after server reconnects", async () => {
      const username = `reconn-${randomUUID().slice(0, 8)}`;
      const installId = randomUUID();

      // Server connects and disconnects
      let serverWs = await connectToRelay();
      await registerServer(serverWs, username, installId);
      serverWs.close();

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Server reconnects
      serverWs = await connectToRelay();
      await registerServer(serverWs, username, installId);

      // Client should be able to connect
      const clientWs = await connectToRelay();
      await connectClient(clientWs, username);

      // Verify forwarding works
      const messagePromise = new Promise<string>((resolve) => {
        serverWs.once("message", (data) => resolve(data.toString()));
      });

      clientWs.send("reconnect test");
      const received = await messagePromise;
      expect(received).toBe("reconnect test");
    });
  });

  describe("Full Relay Flow", () => {
    it("should complete full server -> relay -> client flow", async () => {
      const serverWs = await connectToRelay();
      const clientWs = await connectToRelay();

      const username = `full-${randomUUID().slice(0, 8)}`;
      const installId = randomUUID();

      // 1. Server registers
      await registerServer(serverWs, username, installId);

      // 2. Client connects
      await connectClient(clientWs, username);

      // 3. Bidirectional communication
      const serverReceivedPromise = new Promise<string>((resolve) => {
        serverWs.once("message", (data) => resolve(data.toString()));
      });

      const clientReceivedPromise = new Promise<string>((resolve) => {
        clientWs.once("message", (data) => resolve(data.toString()));
      });

      // Client sends to server
      clientWs.send('{"type":"client_message"}');
      const serverReceived = await serverReceivedPromise;
      expect(JSON.parse(serverReceived)).toEqual({ type: "client_message" });

      // Server responds to client
      serverWs.send('{"type":"server_response"}');
      const clientReceived = await clientReceivedPromise;
      expect(JSON.parse(clientReceived)).toEqual({ type: "server_response" });
    });

    it("should handle client disconnection", async () => {
      const serverWs = await connectToRelay();
      const clientWs = await connectToRelay();

      const username = `disc-${randomUUID().slice(0, 8)}`;
      const installId = randomUUID();

      await registerServer(serverWs, username, installId);
      await connectClient(clientWs, username);

      // Set up close handler on server
      const serverClosePromise = new Promise<void>((resolve) => {
        serverWs.on("close", () => resolve());
      });

      // Client disconnects
      clientWs.close();

      // Server should be notified (connection closed)
      await serverClosePromise;
      expect(serverWs.readyState).toBe(WebSocket.CLOSED);
    });

    it("should handle server disconnection", async () => {
      const serverWs = await connectToRelay();
      const clientWs = await connectToRelay();

      const username = `servdisc-${randomUUID().slice(0, 8)}`;
      const installId = randomUUID();

      await registerServer(serverWs, username, installId);
      await connectClient(clientWs, username);

      // Set up close handler on client
      const clientClosePromise = new Promise<void>((resolve) => {
        clientWs.on("close", () => resolve());
      });

      // Server disconnects
      serverWs.close();

      // Client should be notified (connection closed)
      await clientClosePromise;
      expect(clientWs.readyState).toBe(WebSocket.CLOSED);
    });
  });

  describe("Invalid Username", () => {
    it("should reject invalid username format", async () => {
      const ws = await connectToRelay();

      const register: RelayServerRegister = {
        type: "server_register",
        username: "ab", // Too short (minimum 3 characters)
        installId: randomUUID(),
      };

      const responsePromise = waitForMessage(ws, isRelayServerRejected);
      ws.send(JSON.stringify(register));

      const response = await responsePromise;
      expect(response.type).toBe("server_rejected");
      expect(response.reason).toBe("invalid_username");
    });

    it("should reject username with invalid characters", async () => {
      const ws = await connectToRelay();

      const register: RelayServerRegister = {
        type: "server_register",
        username: "user_name", // Underscore not allowed
        installId: randomUUID(),
      };

      const responsePromise = waitForMessage(ws, isRelayServerRejected);
      ws.send(JSON.stringify(register));

      const response = await responsePromise;
      expect(response.type).toBe("server_rejected");
      expect(response.reason).toBe("invalid_username");
    });

    it("should reject username starting with hyphen", async () => {
      const ws = await connectToRelay();

      const register: RelayServerRegister = {
        type: "server_register",
        username: "-invalid-name",
        installId: randomUUID(),
      };

      const responsePromise = waitForMessage(ws, isRelayServerRejected);
      ws.send(JSON.stringify(register));

      const response = await responsePromise;
      expect(response.type).toBe("server_rejected");
      expect(response.reason).toBe("invalid_username");
    });
  });

  describe("Health Endpoint", () => {
    it("should report correct waiting count", async () => {
      // Get initial health
      const initialHealth = await fetch(
        `http://localhost:${relay.port}/health`,
      ).then((r) => r.json());
      const initialWaiting = initialHealth.waiting;

      // Register a server
      const ws = await connectToRelay();
      const username = `health-${randomUUID().slice(0, 8)}`;
      await registerServer(ws, username, randomUUID());

      // Check health again
      const newHealth = await fetch(
        `http://localhost:${relay.port}/health`,
      ).then((r) => r.json());
      expect(newHealth.waiting).toBe(initialWaiting + 1);
    });

    it("should report correct pair count", async () => {
      // Get initial health
      const initialHealth = await fetch(
        `http://localhost:${relay.port}/health`,
      ).then((r) => r.json());
      const initialPairs = initialHealth.pairs;

      // Create a pair
      const serverWs = await connectToRelay();
      const clientWs = await connectToRelay();
      const username = `pair-health-${randomUUID().slice(0, 8)}`;

      await registerServer(serverWs, username, randomUUID());
      await connectClient(clientWs, username);

      // Check health again
      const newHealth = await fetch(
        `http://localhost:${relay.port}/health`,
      ).then((r) => r.json());
      expect(newHealth.pairs).toBe(initialPairs + 1);
    });
  });
});
