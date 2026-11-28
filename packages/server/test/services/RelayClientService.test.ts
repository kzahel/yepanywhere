import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_BRIDGE_CAPABILITY,
  GIT_STATUS_CAPABILITY,
  SPEECH_RELAY_CHANNEL,
} from "@yep-anywhere/shared";

// Create the mock class and instances array in hoisted scope
// Using a simple callback-based event emitter to avoid import issues
const { MockWebSocket, MockWebSocketInstances } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  const instances: MockWebSocket[] = [];

  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    sentMessages: string[] = [];
    pings: Buffer[] = [];
    OPEN = MockWebSocket.OPEN;
    private listeners: Map<string, Listener[]> = new Map();

    constructor(
      public url: string,
      public options?: { maxPayload?: number },
    ) {
      instances.push(this);
      // Simulate async connection
      setTimeout(() => {
        this.readyState = MockWebSocket.OPEN;
        this.callListeners("open");
      }, 0);
    }

    on(event: string, listener: Listener): void {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
    }

    private callListeners(event: string, ...args: unknown[]): void {
      const list = this.listeners.get(event) ?? [];
      for (const listener of list) {
        listener(...args);
      }
    }

    send(data: string): void {
      this.sentMessages.push(data);
    }

    ping(data = Buffer.alloc(0)): void {
      this.pings.push(data);
    }

    simulatePong(data = this.pings[this.pings.length - 1]): void {
      this.callListeners("pong", data);
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.callListeners("close");
    }

    removeAllListeners(): void {
      this.listeners.clear();
    }

    // Test helpers
    simulateMessage(data: string | Buffer): void {
      this.callListeners("message", data);
    }

    simulateError(error: Error): void {
      this.callListeners("error", error);
    }

    simulateClose(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.callListeners("close");
    }
  }

  return { MockWebSocket, MockWebSocketInstances: instances };
});

// Mock the ws module
vi.mock("ws", () => {
  return {
    WebSocket: MockWebSocket,
  };
});

// Import after mock setup
import { getLogger } from "../../src/logging/logger.js";
import {
  RelayClientService,
  type RelayClientConfig,
} from "../../src/services/RelayClientService.js";
import { MAX_INBOUND_WEBSOCKET_MESSAGE_BYTES } from "../../src/websocketLimits.js";

function getSocket(index: number) {
  const socket = MockWebSocketInstances.at(index);
  assert(socket, `Expected mock WebSocket at index ${index}`);
  return socket;
}

function readRegistration(socket: InstanceType<typeof MockWebSocket>): unknown {
  const [message] = socket.sentMessages;
  assert(message, "Expected registration message");
  return JSON.parse(message);
}

function createRelayConnectionMock() {
  return vi.fn<RelayClientConfig["onRelayConnection"]>();
}

function createStatusChangeMock() {
  return vi.fn<NonNullable<RelayClientConfig["onStatusChange"]>>();
}

describe("RelayClientService", () => {
  let service: RelayClientService;
  let mockOnRelayConnection: ReturnType<typeof createRelayConnectionMock>;
  let mockOnStatusChange: ReturnType<typeof createStatusChangeMock>;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocketInstances.length = 0;
    service = new RelayClientService();
    mockOnRelayConnection = createRelayConnectionMock();
    mockOnStatusChange = createStatusChangeMock();
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe("start", () => {
    it("connects to relay and registers", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
        onStatusChange: mockOnStatusChange,
      });

      // Should be connecting
      expect(service.getState().status).toBe("connecting");
      expect(mockOnStatusChange).toHaveBeenCalledWith("connecting");

      // Wait for WebSocket connection
      await vi.advanceTimersByTimeAsync(10);

      // Should have sent registration message
      expect(MockWebSocketInstances.length).toBe(1);
      const ws = getSocket(0);
      expect(ws.options?.maxPayload).toBe(MAX_INBOUND_WEBSOCKET_MESSAGE_BYTES);
      expect(ws.sentMessages.length).toBe(1);
      expect(readRegistration(ws)).toEqual({
        type: "server_register",
        username: "testuser",
        installId: "install-123",
      });

      // Status should be registering
      expect(service.getState().status).toBe("registering");
    });

    it("includes optional compatibility metadata in registration", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        appVersion: "1.2.3",
        resumeProtocolVersion: 2,
        renderProtocolVersion: 1,
        remoteCompatibilityLevel: 10,
        capabilities: [GIT_STATUS_CAPABILITY, DEVICE_BRIDGE_CAPABILITY],
        onRelayConnection: mockOnRelayConnection,
      });

      await vi.advanceTimersByTimeAsync(10);

      const ws = getSocket(0);
      expect(readRegistration(ws)).toEqual({
        type: "server_register",
        username: "testuser",
        installId: "install-123",
        appVersion: "1.2.3",
        resumeProtocolVersion: 2,
        renderProtocolVersion: 1,
        remoteCompatibilityLevel: 10,
        capabilities: [GIT_STATUS_CAPABILITY, DEVICE_BRIDGE_CAPABILITY],
      });
    });

    it("registers non-default relay channels with channel message type", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        channel: SPEECH_RELAY_CHANNEL,
        onRelayConnection: mockOnRelayConnection,
      });

      await vi.advanceTimersByTimeAsync(10);

      const ws = getSocket(0);
      expect(readRegistration(ws)).toEqual({
        type: "server_register_channel",
        channel: "speech",
        username: "testuser",
        installId: "install-123",
      });
    });

    it("transitions to waiting on server_registered response", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
        onStatusChange: mockOnStatusChange,
      });

      await vi.advanceTimersByTimeAsync(10);

      const ws = getSocket(0);
      ws.simulateMessage(JSON.stringify({ type: "server_registered" }));

      expect(service.getState().status).toBe("waiting");
      expect(mockOnStatusChange).toHaveBeenCalledWith("waiting");
    });

    it("stops previous connection when starting again", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
      });

      await vi.advanceTimersByTimeAsync(10);

      const firstWs = getSocket(0);

      // Start again with different URL
      service.start({
        relayUrl: "wss://relay2.example.com/ws",
        username: "testuser2",
        installId: "install-456",
        onRelayConnection: mockOnRelayConnection,
      });

      expect(firstWs.readyState).toBe(MockWebSocket.CLOSED);
    });

    it("ignores callbacks from a replaced connection", async () => {
      service.start({
        relayUrl: "wss://old-relay.example.com/ws",
        username: "old-user",
        installId: "old-install",
        onRelayConnection: mockOnRelayConnection,
      });
      const firstWs = getSocket(0);

      service.start({
        relayUrl: "wss://new-relay.example.com/ws",
        username: "new-user",
        installId: "new-install",
        onRelayConnection: mockOnRelayConnection,
      });
      const secondWs = getSocket(1);
      await vi.advanceTimersByTimeAsync(10);

      expect(firstWs.sentMessages).toEqual([]);
      expect(readRegistration(secondWs)).toMatchObject({
        username: "new-user",
        installId: "new-install",
      });

      firstWs.simulateMessage(JSON.stringify({ type: "server_registered" }));
      firstWs.simulateMessage(JSON.stringify({ type: "srp_hello" }));
      expect(service.getState().status).toBe("registering");
      expect(mockOnRelayConnection).not.toHaveBeenCalled();

      secondWs.simulateMessage(JSON.stringify({ type: "server_registered" }));
      expect(service.getState().status).toBe("waiting");
    });
  });

  describe("stop", () => {
    it("closes connection and sets status to disconnected", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
        onStatusChange: mockOnStatusChange,
      });

      await vi.advanceTimersByTimeAsync(10);

      const ws = getSocket(0);
      ws.simulateMessage(JSON.stringify({ type: "server_registered" }));

      expect(service.getState().status).toBe("waiting");

      service.stop();

      expect(service.getState().status).toBe("disconnected");
      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    });

    it("clears pending reconnect timer", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
      });

      await vi.advanceTimersByTimeAsync(10);

      const ws = getSocket(0);
      ws.simulateClose();

      // Reconnect should be scheduled
      const instanceCount = MockWebSocketInstances.length;

      service.stop();

      // Advance time past backoff delay
      await vi.advanceTimersByTimeAsync(5000);

      // No new connections should have been created
      expect(MockWebSocketInstances.length).toBe(instanceCount);
    });
  });

  describe("rejection handling", () => {
    it("handles username_taken rejection", async () => {
      const warn = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "taken-user",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
        onStatusChange: mockOnStatusChange,
      });

      await vi.advanceTimersByTimeAsync(10);

      const ws = getSocket(0);
      ws.simulateMessage(
        JSON.stringify({ type: "server_rejected", reason: "username_taken" }),
      );

      const state = service.getState();
      expect(state.status).toBe("rejected");
      expect(state.error).toContain("taken-user");
      expect(state.error).toContain("already registered");
      expect(warn).toHaveBeenCalledWith(
        "[RelayClient] Registration rejected: username_taken",
      );

      // Should not attempt to reconnect
      await vi.advanceTimersByTimeAsync(120000);
      expect(MockWebSocketInstances.length).toBe(1);
    });

    it("handles invalid_username rejection", async () => {
      const warn = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "bad!user",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
        onStatusChange: mockOnStatusChange,
      });

      await vi.advanceTimersByTimeAsync(10);

      const ws = getSocket(0);
      ws.simulateMessage(
        JSON.stringify({ type: "server_rejected", reason: "invalid_username" }),
      );

      const state = service.getState();
      expect(state.status).toBe("rejected");
      expect(state.error).toContain("Invalid username format");
      expect(warn).toHaveBeenCalledWith(
        "[RelayClient] Registration rejected: invalid_username",
      );
    });
  });

  describe("connection claiming", () => {
    it("detects claim on non-JSON message (SRP init)", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
        onStatusChange: mockOnStatusChange,
      });

      await vi.advanceTimersByTimeAsync(10);

      const ws = getSocket(0);
      ws.simulateMessage(JSON.stringify({ type: "server_registered" }));

      expect(service.getState().status).toBe("waiting");

      // Simulate SRP init message from phone (first message after pairing)
      const srpInit = JSON.stringify({
        type: "srp_hello",
        identity: "testuser",
        A: "some-ephemeral-key",
      });
      ws.simulateMessage(srpInit);

      // Should have called onRelayConnection with the WebSocket, first message, and isBinary flag
      expect(mockOnRelayConnection).toHaveBeenCalledTimes(1);
      expect(mockOnRelayConnection).toHaveBeenCalledWith(ws, srpInit, false);

      // Should have opened a new waiting connection
      await vi.advanceTimersByTimeAsync(10);
      expect(MockWebSocketInstances.length).toBe(2);
    });

    it("detects claim on unknown message type", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
      });

      await vi.advanceTimersByTimeAsync(10);

      const ws = getSocket(0);
      ws.simulateMessage(JSON.stringify({ type: "server_registered" }));

      // Any message that's not a relay protocol message indicates claim
      const unknownMsg = JSON.stringify({ type: "some_random_type" });
      ws.simulateMessage(unknownMsg);

      expect(mockOnRelayConnection).toHaveBeenCalledWith(ws, unknownMsg, false);
    });

    it("never logs claimed or malformed text payloads", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const warn = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      try {
        service.start({
          relayUrl: "wss://relay.example.com/ws",
          username: "testuser",
          installId: "install-123",
          onRelayConnection: mockOnRelayConnection,
        });
        await vi.advanceTimersByTimeAsync(10);

        const ws = getSocket(0);
        ws.simulateMessage(JSON.stringify({ type: "server_registered" }));
        const claimedBearer = "claimed-public-share-bearer";
        const claimedMessage = JSON.stringify({
          type: "request",
          id: "x",
          method: "GET",
          path: `/public-api/shares/${claimedBearer}/metadata`,
          headers: {},
        });
        ws.simulateMessage(claimedMessage);

        const malformedBearer = "malformed-public-share-bearer";
        getSocket(1).simulateMessage(
          `not-json /public-api/shares/${malformedBearer}/metadata`,
        );

        const logged = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
        expect(logged).not.toContain(claimedBearer);
        expect(logged).not.toContain(malformedBearer);
        expect(logged).not.toContain(claimedMessage);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(
            "[RelayClient] Received non-JSON text frame (",
          ),
        );
        expect(mockOnRelayConnection).toHaveBeenCalledWith(
          ws,
          claimedMessage,
          false,
        );
      } finally {
        log.mockRestore();
        warn.mockRestore();
      }
    });
  });

  describe("keepalive profiles", () => {
    async function waiting(profile: "default" | "battery") {
      service.stop();
      service = new RelayClientService(profile);
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
      });
      await vi.advanceTimersByTimeAsync(10);
      const ws = getSocket(-1);
      ws.simulateMessage(JSON.stringify({ type: "server_registered" }));
      return ws;
    }

    it.each(["default", "battery"] as const)(
      "%s retains its distinct recovery after a long clock gap",
      async (profile) => {
        const ws = await waiting(profile);
        await vi.advanceTimersByTimeAsync(30_000);
        ws.simulatePong();
        vi.setSystemTime(Date.now() + 75_000);
        await vi.advanceTimersByTimeAsync(30_000);
        if (profile === "default") {
          expect(ws.readyState).toBe(MockWebSocket.CLOSED);
          expect(ws.pings).toHaveLength(1);
        } else {
          expect(ws.pings).toHaveLength(2);
          ws.simulatePong();
          await vi.advanceTimersByTimeAsync(5_000);
          expect(service.getState().status).toBe("waiting");
          expect(ws.readyState).toBe(MockWebSocket.OPEN);
        }
      },
    );

    it("renews a delayed deadline and refuses a pong from the old probe", async () => {
      const ws = await waiting("battery");
      await vi.advanceTimersByTimeAsync(30_000);
      const oldPing = ws.pings[0];
      vi.setSystemTime(Date.now() + 75_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ws.pings).toHaveLength(2);
      expect(ws.readyState).toBe(MockWebSocket.OPEN);
      ws.simulatePong(oldPing);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(ws.readyState).toBe(MockWebSocket.OPEN);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
      expect(MockWebSocketInstances).toHaveLength(2);
      const replacement = getSocket(-1);
      replacement.simulateMessage(
        JSON.stringify({ type: "server_registered" }),
      );
      expect(service.getState().status).toBe("waiting");
    });

    it("reconnects within six seconds of an unanswered battery probe despite a backward clock change", async () => {
      const ws = await waiting("battery");
      await vi.advanceTimersByTimeAsync(30_000);
      vi.setSystemTime(Date.now() - 75_000);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(ws.readyState).toBe(MockWebSocket.OPEN);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
      expect(MockWebSocketInstances).toHaveLength(2);
    });

    it("releases the pending battery deadline when the socket is handed off", async () => {
      const ws = await waiting("battery");
      await vi.advanceTimersByTimeAsync(30_000);
      ws.simulateMessage(JSON.stringify({ type: "srp_hello" }));
      await vi.advanceTimersByTimeAsync(6_000);
      expect(mockOnRelayConnection).toHaveBeenCalledOnce();
      expect(ws.readyState).toBe(MockWebSocket.OPEN);
      expect(MockWebSocketInstances).toHaveLength(2);
    });
  });

  describe("exponential backoff", () => {
    it("reconnects with increasing delays", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
        onStatusChange: mockOnStatusChange,
      });

      await vi.advanceTimersByTimeAsync(10);

      // Close the first connection
      const ws1 = getSocket(0);
      ws1.simulateClose();

      expect(service.getState().reconnectAttempts).toBe(1);

      // First reconnect after 1s
      await vi.advanceTimersByTimeAsync(1000);
      expect(MockWebSocketInstances.length).toBe(2);

      // Close again
      const ws2 = getSocket(1);
      ws2.simulateClose();

      expect(service.getState().reconnectAttempts).toBe(2);

      // Second reconnect after 2s (1s * 2^1)
      await vi.advanceTimersByTimeAsync(1000);
      expect(MockWebSocketInstances.length).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(MockWebSocketInstances.length).toBe(3);
    });

    it("caps backoff at 60 seconds", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
      });

      await vi.advanceTimersByTimeAsync(10);

      // Simulate many disconnects to reach max backoff
      for (let i = 0; i < 10; i++) {
        const ws = getSocket(-1);
        ws.simulateClose();
        // Advance time to trigger reconnect
        await vi.advanceTimersByTimeAsync(60000);
        await vi.advanceTimersByTimeAsync(10); // Allow connection to open
      }

      // After 10 disconnects, delay should be capped at 60s
      // 1s * 2^9 = 512s > 60s, so should be 60s
      const lastInstance = MockWebSocketInstances.length;
      const ws = getSocket(lastInstance - 1);
      ws.simulateClose();

      // Should reconnect after max 60s
      await vi.advanceTimersByTimeAsync(60001);
      expect(MockWebSocketInstances.length).toBe(lastInstance + 1);
    });

    it("resets backoff on successful registration", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
      });

      await vi.advanceTimersByTimeAsync(10);

      // Disconnect a few times
      for (let i = 0; i < 3; i++) {
        const ws = getSocket(-1);
        ws.simulateClose();
        await vi.advanceTimersByTimeAsync(10000); // Advance past backoff
        await vi.advanceTimersByTimeAsync(10);
      }

      // Successfully register
      const ws = getSocket(-1);
      ws.simulateMessage(JSON.stringify({ type: "server_registered" }));

      expect(service.getState().reconnectAttempts).toBe(0);
    });
  });

  describe("isEnabled", () => {
    it("returns false when not started", () => {
      expect(service.isEnabled()).toBe(false);
    });

    it("returns true when started", () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
      });

      expect(service.isEnabled()).toBe(true);
    });

    it("returns false after stop", () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
      });

      service.stop();

      expect(service.isEnabled()).toBe(false);
    });
  });

  describe("updateRelayUrl", () => {
    it("does nothing if not configured", () => {
      service.updateRelayUrl("wss://new.example.com/ws");
      expect(service.isEnabled()).toBe(false);
    });

    it("reconnects to new URL", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
      });

      await vi.advanceTimersByTimeAsync(10);

      service.updateRelayUrl("wss://new-relay.example.com/ws");

      await vi.advanceTimersByTimeAsync(10);

      const lastWs = getSocket(-1);
      expect(lastWs.url).toBe("wss://new-relay.example.com/ws");
    });
  });

  describe("updateUsername", () => {
    it("does nothing if not configured", () => {
      service.updateUsername("newuser");
      expect(service.isEnabled()).toBe(false);
    });

    it("reconnects with new username", async () => {
      service.start({
        relayUrl: "wss://relay.example.com/ws",
        username: "testuser",
        installId: "install-123",
        onRelayConnection: mockOnRelayConnection,
      });

      await vi.advanceTimersByTimeAsync(10);

      service.updateUsername("newuser");

      await vi.advanceTimersByTimeAsync(10);

      const lastWs = getSocket(-1);
      expect(readRegistration(lastWs)).toMatchObject({ username: "newuser" });
    });
  });
});
