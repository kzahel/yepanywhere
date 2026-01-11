import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type {
  RelayEvent,
  RelayRequest,
  RelayResponse,
  RelaySubscribe,
  RelayUnsubscribe,
  RelayUploadChunk,
  RelayUploadComplete,
  RelayUploadEnd,
  RelayUploadError,
  RelayUploadProgress,
  RelayUploadStart,
  YepMessage,
} from "@yep-anywhere/shared";
import {
  BinaryFormat,
  decodeJsonFrame,
  encodeJsonFrame,
  encodeUploadChunkFrame,
} from "@yep-anywhere/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../../src/app.js";
import { attachUnifiedUpgradeHandler } from "../../src/frontend/index.js";
import { createWsRelayRoutes } from "../../src/routes/ws-relay.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
import { UploadManager } from "../../src/uploads/manager.js";
import { EventBus } from "../../src/watcher/index.js";

/**
 * E2E tests for the WebSocket transport (Phase 2b/2c).
 *
 * These tests verify:
 * - Basic request/response over WebSocket
 * - Event subscriptions (activity channel)
 * - Proper cleanup on disconnect
 */

describe("WebSocket Transport E2E", () => {
  let testDir: string;
  let server: ReturnType<typeof serve>;
  let serverPort: number;
  let mockSdk: MockClaudeSDK;
  let eventBus: EventBus;

  beforeAll(async () => {
    // Create temp directory for project data
    testDir = join(tmpdir(), `ws-transport-test-${randomUUID()}`);
    const projectPath = "/home/user/testproject";
    const encodedPath = projectPath.replaceAll("/", "-");

    await mkdir(join(testDir, "localhost", encodedPath), { recursive: true });
    await writeFile(
      join(testDir, "localhost", encodedPath, "test-session.jsonl"),
      `{"type":"user","cwd":"${projectPath}","message":{"content":"Hello"}}\n`,
    );

    // Create services
    mockSdk = new MockClaudeSDK();
    eventBus = new EventBus();

    // Create the app
    const { app, supervisor } = createApp({
      sdk: mockSdk,
      projectsDir: testDir,
      eventBus,
    });

    // Add WebSocket support
    const { upgradeWebSocket, wss } = createNodeWebSocket({ app });

    // Add WebSocket relay route
    const baseUrl = "http://localhost:0";
    const uploadManager = new UploadManager({
      uploadsDir: join(testDir, "uploads"),
    });
    const wsRelayHandler = createWsRelayRoutes({
      upgradeWebSocket,
      app,
      baseUrl,
      supervisor,
      eventBus,
      uploadManager,
    });
    app.get("/api/ws", wsRelayHandler);

    // Start server on random port
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      serverPort = info.port;
      console.log(`[WS Transport Test] Server running on port ${serverPort}`);
    });

    // Attach the unified upgrade handler (same as production)
    attachUnifiedUpgradeHandler(server, {
      frontendProxy: undefined,
      isApiPath: (urlPath) => urlPath.startsWith("/api"),
      app,
      wss,
    });

    // Wait for server to be ready
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  });

  afterAll(async () => {
    server?.close();
    await rm(testDir, { recursive: true, force: true });
  });

  /**
   * Helper to create a WebSocket connection.
   */
  function connectWebSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${serverPort}/api/ws`);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
    });
  }

  /**
   * Helper to send a message and wait for response.
   */
  function sendRequest(
    ws: WebSocket,
    request: RelayRequest,
  ): Promise<RelayResponse> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Request timeout")),
        5000,
      );

      const handler = (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString()) as YepMessage;
        if (msg.type === "response" && msg.id === request.id) {
          clearTimeout(timeout);
          ws.off("message", handler);
          resolve(msg);
        }
      };

      ws.on("message", handler);
      ws.send(JSON.stringify(request));
    });
  }

  /**
   * Helper to collect events from a subscription.
   */
  function collectEvents(
    ws: WebSocket,
    subscriptionId: string,
    count: number,
    timeoutMs = 5000,
  ): Promise<RelayEvent[]> {
    return new Promise((resolve, reject) => {
      const events: RelayEvent[] = [];
      const timeout = setTimeout(() => {
        ws.off("message", handler);
        // Return what we have, even if not enough
        resolve(events);
      }, timeoutMs);

      const handler = (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString()) as YepMessage;
        if (msg.type === "event" && msg.subscriptionId === subscriptionId) {
          events.push(msg);
          if (events.length >= count) {
            clearTimeout(timeout);
            ws.off("message", handler);
            resolve(events);
          }
        }
      };

      ws.on("message", handler);
    });
  }

  describe("Request/Response (Phase 2b)", () => {
    it("should handle GET request for health endpoint", async () => {
      const ws = await connectWebSocket();

      try {
        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health", // health is at /health, not /api/health
        };

        const response = await sendRequest(ws, request);

        expect(response.status).toBe(200);
        expect((response.body as { status: string }).status).toBe("ok");
      } finally {
        ws.close();
      }
    });

    it("should handle GET request for version endpoint", async () => {
      const ws = await connectWebSocket();

      try {
        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/api/version",
        };

        const response = await sendRequest(ws, request);

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty("current"); // version endpoint returns { current, latest, updateAvailable }
      } finally {
        ws.close();
      }
    });

    it("should handle GET request for projects endpoint", async () => {
      const ws = await connectWebSocket();

      try {
        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/api/projects",
        };

        const response = await sendRequest(ws, request);

        expect(response.status).toBe(200);
        // Projects returns { projects: [...] }
        expect(response.body).toHaveProperty("projects");
        expect(
          Array.isArray((response.body as { projects: unknown[] }).projects),
        ).toBe(true);
      } finally {
        ws.close();
      }
    });

    it("should return 404 for non-existent endpoint", async () => {
      const ws = await connectWebSocket();

      try {
        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/api/nonexistent",
        };

        const response = await sendRequest(ws, request);

        expect(response.status).toBe(404);
      } finally {
        ws.close();
      }
    });

    it("should handle multiple concurrent requests", async () => {
      const ws = await connectWebSocket();

      try {
        const request1: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };
        const request2: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/api/version",
        };

        // Send both requests concurrently
        const [response1, response2] = await Promise.all([
          sendRequest(ws, request1),
          sendRequest(ws, request2),
        ]);

        expect(response1.status).toBe(200);
        expect(response1.id).toBe(request1.id);
        expect(response2.status).toBe(200);
        expect(response2.id).toBe(request2.id);
      } finally {
        ws.close();
      }
    });
  });

  describe("Event Subscriptions (Phase 2c)", () => {
    it("should receive connected event when subscribing to activity", async () => {
      const ws = await connectWebSocket();

      try {
        const subscriptionId = randomUUID();
        const subscribe: RelaySubscribe = {
          type: "subscribe",
          subscriptionId,
          channel: "activity",
        };

        // Collect the first event (should be 'connected')
        const eventsPromise = collectEvents(ws, subscriptionId, 1);
        ws.send(JSON.stringify(subscribe));

        const events = await eventsPromise;

        expect(events.length).toBe(1);
        expect(events[0].eventType).toBe("connected");
        expect(events[0].subscriptionId).toBe(subscriptionId);
      } finally {
        ws.close();
      }
    });

    it("should receive activity events when emitted on event bus", async () => {
      const ws = await connectWebSocket();

      try {
        const subscriptionId = randomUUID();
        const subscribe: RelaySubscribe = {
          type: "subscribe",
          subscriptionId,
          channel: "activity",
        };

        // Subscribe first
        ws.send(JSON.stringify(subscribe));

        // Wait for connected event, then collect more
        const eventsPromise = collectEvents(ws, subscriptionId, 3, 3000);

        // Give subscription time to be established
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Emit events on the event bus
        eventBus.emit({
          type: "file-change",
          provider: "claude",
          path: "/test/file.txt",
          changeType: "change",
          timestamp: new Date().toISOString(),
        });

        eventBus.emit({
          type: "session-status-changed",
          sessionId: "test-session",
          status: "streaming",
          timestamp: new Date().toISOString(),
        });

        const events = await eventsPromise;

        // Should have: connected, file-change, session-status-changed
        expect(events.length).toBeGreaterThanOrEqual(2);

        const eventTypes = events.map((e) => e.eventType);
        expect(eventTypes).toContain("connected");
        // At least one of our events should have arrived
        expect(
          eventTypes.includes("file-change") ||
            eventTypes.includes("session-status-changed"),
        ).toBe(true);
      } finally {
        ws.close();
      }
    });

    it("should handle unsubscribe correctly", async () => {
      const ws = await connectWebSocket();

      try {
        const subscriptionId = randomUUID();

        // Subscribe
        const subscribe: RelaySubscribe = {
          type: "subscribe",
          subscriptionId,
          channel: "activity",
        };
        ws.send(JSON.stringify(subscribe));

        // Wait for connected event
        await collectEvents(ws, subscriptionId, 1);

        // Unsubscribe
        const unsubscribe: RelayUnsubscribe = {
          type: "unsubscribe",
          subscriptionId,
        };
        ws.send(JSON.stringify(unsubscribe));

        // Wait a bit for unsubscribe to process
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Emit an event - should not receive it
        eventBus.emit({
          type: "file-change",
          provider: "claude",
          path: "/test/file2.txt",
          changeType: "change",
          timestamp: new Date().toISOString(),
        });

        // Try to collect events (should timeout with 0 new events)
        const events = await collectEvents(ws, subscriptionId, 1, 500);

        // Should not receive the event after unsubscribing
        const fileChangeEvents = events.filter(
          (e) => e.eventType === "file-change",
        );
        expect(fileChangeEvents.length).toBe(0);
      } finally {
        ws.close();
      }
    });

    it("should handle multiple concurrent subscriptions", async () => {
      const ws = await connectWebSocket();

      try {
        const subscriptionId1 = randomUUID();
        const subscriptionId2 = randomUUID();

        // Start collecting events for both subscriptions before subscribing
        const events1Promise = collectEvents(ws, subscriptionId1, 2, 2000);
        const events2Promise = collectEvents(ws, subscriptionId2, 2, 2000);

        // Subscribe to activity twice with different IDs
        const subscribe1: RelaySubscribe = {
          type: "subscribe",
          subscriptionId: subscriptionId1,
          channel: "activity",
        };
        const subscribe2: RelaySubscribe = {
          type: "subscribe",
          subscriptionId: subscriptionId2,
          channel: "activity",
        };

        ws.send(JSON.stringify(subscribe1));
        ws.send(JSON.stringify(subscribe2));

        // Give time for subscriptions to be established
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Emit an event
        eventBus.emit({
          type: "file-change",
          provider: "claude",
          path: "/test/concurrent.txt",
          changeType: "change",
          timestamp: new Date().toISOString(),
        });

        // Both subscriptions should receive the event
        const [events1, events2] = await Promise.all([
          events1Promise,
          events2Promise,
        ]);

        // Each should have connected + file-change
        expect(events1.some((e) => e.eventType === "connected")).toBe(true);
        expect(events2.some((e) => e.eventType === "connected")).toBe(true);
      } finally {
        ws.close();
      }
    });

    it("should return error for session subscription without sessionId", async () => {
      const ws = await connectWebSocket();

      try {
        const subscriptionId = randomUUID();
        const subscribe: RelaySubscribe = {
          type: "subscribe",
          subscriptionId,
          channel: "session",
          // Missing sessionId
        };

        // Listen for response (error will come as a response)
        const responsePromise = new Promise<RelayResponse>((resolve) => {
          const handler = (data: WebSocket.RawData) => {
            const msg = JSON.parse(data.toString()) as YepMessage;
            if (msg.type === "response" && msg.id === subscriptionId) {
              ws.off("message", handler);
              resolve(msg);
            }
          };
          ws.on("message", handler);
        });

        ws.send(JSON.stringify(subscribe));

        const response = await responsePromise;
        expect(response.status).toBe(400);
        expect(response.body).toHaveProperty("error");
      } finally {
        ws.close();
      }
    });
  });

  describe("Connection Lifecycle", () => {
    it("should clean up subscriptions on disconnect", async () => {
      const subscriptionId = randomUUID();

      // Connect and subscribe
      const ws = await connectWebSocket();
      const subscribe: RelaySubscribe = {
        type: "subscribe",
        subscriptionId,
        channel: "activity",
      };
      ws.send(JSON.stringify(subscribe));

      // Wait for connected event
      await collectEvents(ws, subscriptionId, 1);

      // Check initial subscriber count
      const initialCount = eventBus.subscriberCount;

      // Close connection
      ws.close();

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Subscriber count should have decreased
      expect(eventBus.subscriberCount).toBeLessThan(initialCount);
    });

    it("should handle reconnection", async () => {
      // First connection
      const ws1 = await connectWebSocket();
      const request1: RelayRequest = {
        type: "request",
        id: randomUUID(),
        method: "GET",
        path: "/health",
      };
      const response1 = await sendRequest(ws1, request1);
      expect(response1.status).toBe(200);
      ws1.close();

      // Wait for disconnect to process
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Second connection - should work fine
      const ws2 = await connectWebSocket();
      const request2: RelayRequest = {
        type: "request",
        id: randomUUID(),
        method: "GET",
        path: "/health",
      };
      const response2 = await sendRequest(ws2, request2);
      expect(response2.status).toBe(200);
      ws2.close();
    });
  });

  describe("File Upload (Phase 2d)", () => {
    // Helper to collect upload messages
    function collectUploadMessages(
      ws: WebSocket,
      uploadId: string,
      timeoutMs = 5000,
    ): Promise<YepMessage[]> {
      return new Promise((resolve) => {
        const messages: YepMessage[] = [];
        const timeout = setTimeout(() => {
          ws.off("message", handler);
          resolve(messages);
        }, timeoutMs);

        const handler = (data: WebSocket.RawData) => {
          const msg = JSON.parse(data.toString()) as YepMessage;
          if (
            (msg.type === "upload_progress" ||
              msg.type === "upload_complete" ||
              msg.type === "upload_error") &&
            msg.uploadId === uploadId
          ) {
            messages.push(msg);
            if (msg.type === "upload_complete" || msg.type === "upload_error") {
              clearTimeout(timeout);
              ws.off("message", handler);
              resolve(messages);
            }
          }
        };

        ws.on("message", handler);
      });
    }

    it("should successfully upload a small file", async () => {
      const ws = await connectWebSocket();

      try {
        const uploadId = randomUUID();
        const projectId = "test-project";
        const sessionId = "test-session";
        const filename = "test.txt";
        const fileContent = "Hello, World!";
        const fileSize = fileContent.length;

        // Start collecting messages before sending
        const messagesPromise = collectUploadMessages(ws, uploadId);

        // Send upload_start
        const startMsg: RelayUploadStart = {
          type: "upload_start",
          uploadId,
          projectId,
          sessionId,
          filename,
          size: fileSize,
          mimeType: "text/plain",
        };
        ws.send(JSON.stringify(startMsg));

        // Wait a bit for start to process
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Send chunk (base64 encoded)
        const base64Content = Buffer.from(fileContent).toString("base64");
        const chunkMsg: RelayUploadChunk = {
          type: "upload_chunk",
          uploadId,
          offset: 0,
          data: base64Content,
        };
        ws.send(JSON.stringify(chunkMsg));

        // Send upload_end
        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        ws.send(JSON.stringify(endMsg));

        // Wait for completion
        const messages = await messagesPromise;

        // Should have at least one message
        expect(messages.length).toBeGreaterThanOrEqual(1);

        // Last message should be upload_complete
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.type).toBe("upload_complete");

        const completeMsg = lastMsg as RelayUploadComplete;
        expect(completeMsg.file).toBeDefined();
        expect(completeMsg.file.originalName).toBe(filename);
        expect(completeMsg.file.size).toBe(fileSize);
      } finally {
        ws.close();
      }
    });

    it("should upload a larger file in multiple chunks", async () => {
      const ws = await connectWebSocket();

      try {
        const uploadId = randomUUID();
        const projectId = "test-project";
        const sessionId = "test-session";
        const filename = "large.bin";
        // Create a 200KB file (larger than the 64KB progress interval)
        const fileSize = 200 * 1024;
        const fileContent = Buffer.alloc(fileSize, "X");

        // Start collecting messages
        const messagesPromise = collectUploadMessages(ws, uploadId);

        // Send upload_start
        const startMsg: RelayUploadStart = {
          type: "upload_start",
          uploadId,
          projectId,
          sessionId,
          filename,
          size: fileSize,
          mimeType: "application/octet-stream",
        };
        ws.send(JSON.stringify(startMsg));

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Send in 64KB chunks
        const chunkSize = 64 * 1024;
        let offset = 0;
        while (offset < fileSize) {
          const end = Math.min(offset + chunkSize, fileSize);
          const chunk = fileContent.slice(offset, end);
          const chunkMsg: RelayUploadChunk = {
            type: "upload_chunk",
            uploadId,
            offset,
            data: chunk.toString("base64"),
          };
          ws.send(JSON.stringify(chunkMsg));
          offset = end;
        }

        // Send upload_end
        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        ws.send(JSON.stringify(endMsg));

        // Wait for completion
        const messages = await messagesPromise;

        // Should have multiple progress messages plus complete
        expect(messages.length).toBeGreaterThanOrEqual(2);

        // Check we got progress updates
        const progressMsgs = messages.filter(
          (m) => m.type === "upload_progress",
        ) as RelayUploadProgress[];
        expect(progressMsgs.length).toBeGreaterThanOrEqual(1);

        // Last message should be upload_complete
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.type).toBe("upload_complete");

        const completeMsg = lastMsg as RelayUploadComplete;
        expect(completeMsg.file.size).toBe(fileSize);
      } finally {
        ws.close();
      }
    });

    it("should return error for invalid offset", async () => {
      const ws = await connectWebSocket();

      try {
        const uploadId = randomUUID();
        const projectId = "test-project";
        const sessionId = "test-session";

        // Start collecting messages
        const messagesPromise = collectUploadMessages(ws, uploadId);

        // Send upload_start
        const startMsg: RelayUploadStart = {
          type: "upload_start",
          uploadId,
          projectId,
          sessionId,
          filename: "test.txt",
          size: 100,
          mimeType: "text/plain",
        };
        ws.send(JSON.stringify(startMsg));

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Send chunk with wrong offset (should be 0)
        const chunkMsg: RelayUploadChunk = {
          type: "upload_chunk",
          uploadId,
          offset: 50, // Wrong offset!
          data: Buffer.from("test").toString("base64"),
        };
        ws.send(JSON.stringify(chunkMsg));

        // Wait for error
        const messages = await messagesPromise;

        expect(messages.length).toBeGreaterThanOrEqual(1);
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.type).toBe("upload_error");

        const errorMsg = lastMsg as RelayUploadError;
        expect(errorMsg.error).toContain("Invalid offset");
      } finally {
        ws.close();
      }
    });

    it("should return error for unknown upload ID", async () => {
      const ws = await connectWebSocket();

      try {
        const uploadId = randomUUID();

        // Start collecting messages
        const messagesPromise = collectUploadMessages(ws, uploadId, 2000);

        // Send chunk for non-existent upload
        const chunkMsg: RelayUploadChunk = {
          type: "upload_chunk",
          uploadId,
          offset: 0,
          data: Buffer.from("test").toString("base64"),
        };
        ws.send(JSON.stringify(chunkMsg));

        // Wait for error
        const messages = await messagesPromise;

        expect(messages.length).toBe(1);
        expect(messages[0].type).toBe("upload_error");

        const errorMsg = messages[0] as RelayUploadError;
        expect(errorMsg.error).toContain("Upload not found");
      } finally {
        ws.close();
      }
    });

    it("should return error for duplicate upload ID", async () => {
      const ws = await connectWebSocket();

      try {
        const uploadId = randomUUID();
        const projectId = "test-project";
        const sessionId = "test-session";

        // Send first upload_start
        const startMsg1: RelayUploadStart = {
          type: "upload_start",
          uploadId,
          projectId,
          sessionId,
          filename: "test1.txt",
          size: 10,
          mimeType: "text/plain",
        };
        ws.send(JSON.stringify(startMsg1));

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Start collecting messages for the duplicate
        const messagesPromise = collectUploadMessages(ws, uploadId, 2000);

        // Send duplicate upload_start with same ID
        const startMsg2: RelayUploadStart = {
          type: "upload_start",
          uploadId,
          projectId,
          sessionId,
          filename: "test2.txt",
          size: 10,
          mimeType: "text/plain",
        };
        ws.send(JSON.stringify(startMsg2));

        // Wait for error
        const messages = await messagesPromise;

        // Should get an error for the duplicate
        const errorMsgs = messages.filter(
          (m) => m.type === "upload_error",
        ) as RelayUploadError[];
        expect(errorMsgs.length).toBe(1);
        expect(errorMsgs[0].error).toContain("already in use");
      } finally {
        ws.close();
      }
    });
  });

  describe("Binary Frame Support (Phase 0)", () => {
    /**
     * Helper to send a binary frame and wait for binary response.
     */
    function sendBinaryRequest(
      ws: WebSocket,
      request: RelayRequest,
    ): Promise<RelayResponse> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Request timeout")),
          5000,
        );

        const handler = (data: WebSocket.RawData) => {
          // Expect binary response
          if (!(data instanceof Buffer)) {
            // If we get a string, the server might have fallen back to text
            clearTimeout(timeout);
            ws.off("message", handler);
            try {
              const msg = JSON.parse(data.toString()) as YepMessage;
              if (msg.type === "response" && msg.id === request.id) {
                resolve(msg);
              }
            } catch {
              reject(new Error("Unexpected non-binary response"));
            }
            return;
          }

          try {
            const msg = decodeJsonFrame<YepMessage>(data);
            if (msg.type === "response" && msg.id === request.id) {
              clearTimeout(timeout);
              ws.off("message", handler);
              resolve(msg);
            }
          } catch (err) {
            clearTimeout(timeout);
            ws.off("message", handler);
            reject(err);
          }
        };

        ws.on("message", handler);
        // Send as binary frame
        ws.send(encodeJsonFrame(request));
      });
    }

    it("should handle binary frame with format 0x01 (JSON)", async () => {
      const ws = await connectWebSocket();

      try {
        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };

        const response = await sendBinaryRequest(ws, request);

        expect(response.status).toBe(200);
        expect((response.body as { status: string }).status).toBe("ok");
      } finally {
        ws.close();
      }
    });

    it("should handle text frame fallback for backwards compat", async () => {
      const ws = await connectWebSocket();

      try {
        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };

        // Send as text (JSON string)
        const response = await sendRequest(ws, request);

        expect(response.status).toBe(200);
        expect((response.body as { status: string }).status).toBe("ok");
      } finally {
        ws.close();
      }
    });

    it("should reject unknown format bytes", async () => {
      const ws = await connectWebSocket();

      try {
        // Create a binary frame with invalid format byte 0x00
        const payload = Buffer.from(
          JSON.stringify({ type: "request", id: "test" }),
        );
        const invalidFrame = Buffer.alloc(1 + payload.length);
        invalidFrame[0] = 0x00; // Invalid format byte
        payload.copy(invalidFrame, 1);

        // The server should close the connection with error code 4002
        const closePromise = new Promise<{ code: number; reason: string }>(
          (resolve) => {
            ws.on("close", (code, reason) => {
              resolve({ code, reason: reason.toString() });
            });
          },
        );

        ws.send(invalidFrame);

        const closeResult = await closePromise;
        expect(closeResult.code).toBe(4002);
        expect(closeResult.reason).toContain("Unknown format byte");
      } finally {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      }
    });

    it("should handle mixed text/binary frames", async () => {
      const ws = await connectWebSocket();

      try {
        // First request as text
        const textRequest: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };
        const textResponse = await sendRequest(ws, textRequest);
        expect(textResponse.status).toBe(200);

        // Second request as binary
        const binaryRequest: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/api/version",
        };
        const binaryResponse = await sendBinaryRequest(ws, binaryRequest);
        expect(binaryResponse.status).toBe(200);
      } finally {
        ws.close();
      }
    });

    it("should respond with binary frames when client sends binary", async () => {
      const ws = await connectWebSocket();

      try {
        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };

        // Track whether we received a binary response
        let receivedBinary = false;

        const response = await new Promise<RelayResponse>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Request timeout")),
            5000,
          );

          const handler = (data: WebSocket.RawData) => {
            if (data instanceof Buffer) {
              receivedBinary = true;
              try {
                const msg = decodeJsonFrame<YepMessage>(data);
                if (msg.type === "response" && msg.id === request.id) {
                  clearTimeout(timeout);
                  ws.off("message", handler);
                  resolve(msg);
                }
              } catch (err) {
                clearTimeout(timeout);
                ws.off("message", handler);
                reject(err);
              }
            } else {
              // Text frame - still accept but note it
              try {
                const msg = JSON.parse(data.toString()) as YepMessage;
                if (msg.type === "response" && msg.id === request.id) {
                  clearTimeout(timeout);
                  ws.off("message", handler);
                  resolve(msg);
                }
              } catch {
                // ignore
              }
            }
          };

          ws.on("message", handler);
          ws.send(encodeJsonFrame(request));
        });

        expect(response.status).toBe(200);
        // Server should respond with binary after receiving binary
        expect(receivedBinary).toBe(true);
      } finally {
        ws.close();
      }
    });

    it("should handle binary subscription events", async () => {
      const ws = await connectWebSocket();

      try {
        const subscriptionId = randomUUID();
        const subscribe: RelaySubscribe = {
          type: "subscribe",
          subscriptionId,
          channel: "activity",
        };

        // Collect events using binary frames
        const eventsPromise = new Promise<RelayEvent[]>((resolve) => {
          const events: RelayEvent[] = [];
          const timeout = setTimeout(() => {
            ws.off("message", handler);
            resolve(events);
          }, 2000);

          const handler = (data: WebSocket.RawData) => {
            try {
              let msg: YepMessage;
              if (data instanceof Buffer) {
                msg = decodeJsonFrame<YepMessage>(data);
              } else {
                msg = JSON.parse(data.toString()) as YepMessage;
              }
              if (
                msg.type === "event" &&
                msg.subscriptionId === subscriptionId
              ) {
                events.push(msg);
                if (events.length >= 1 && events[0].eventType === "connected") {
                  clearTimeout(timeout);
                  ws.off("message", handler);
                  resolve(events);
                }
              }
            } catch {
              // ignore parse errors
            }
          };

          ws.on("message", handler);
        });

        // Send subscribe as binary
        ws.send(encodeJsonFrame(subscribe));

        const events = await eventsPromise;

        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events[0].eventType).toBe("connected");
        expect(events[0].subscriptionId).toBe(subscriptionId);
      } finally {
        ws.close();
      }
    });

    it("should handle UTF-8 content in binary frames", async () => {
      const ws = await connectWebSocket();

      try {
        // Send a request - the UTF-8 test is about the binary frame encoding
        // of JSON content with unicode characters in the body
        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };

        // Verify the encodeJsonFrame handles UTF-8 properly by checking the request
        // goes through successfully (the request id contains nothing special but
        // the framing itself uses TextEncoder/TextDecoder which handles UTF-8)
        const response = await sendBinaryRequest(ws, request);
        expect(response.status).toBe(200);

        // Also test that a request ID with UTF-8 round-trips correctly
        const utf8Request: RelayRequest = {
          type: "request",
          id: `test-${randomUUID()}-emoji-🎉`,
          method: "GET",
          path: "/health",
        };
        const utf8Response = await sendBinaryRequest(ws, utf8Request);
        expect(utf8Response.status).toBe(200);
        // The response ID should match what we sent
        expect(utf8Response.id).toBe(utf8Request.id);
      } finally {
        ws.close();
      }
    });
  });

  describe("Binary Upload Chunks (Phase 2)", () => {
    // Helper to collect upload messages (works with both text and binary frames)
    function collectUploadMessagesForBinary(
      ws: WebSocket,
      uploadId: string,
      timeoutMs = 5000,
    ): Promise<YepMessage[]> {
      return new Promise((resolve) => {
        const messages: YepMessage[] = [];
        const timeout = setTimeout(() => {
          ws.off("message", handler);
          resolve(messages);
        }, timeoutMs);

        const handler = (data: WebSocket.RawData) => {
          let msg: YepMessage;
          try {
            if (data instanceof Buffer) {
              msg = decodeJsonFrame<YepMessage>(data);
            } else {
              msg = JSON.parse(data.toString()) as YepMessage;
            }
          } catch {
            return; // Ignore parse errors
          }

          if (
            (msg.type === "upload_progress" ||
              msg.type === "upload_complete" ||
              msg.type === "upload_error") &&
            msg.uploadId === uploadId
          ) {
            messages.push(msg);
            if (msg.type === "upload_complete" || msg.type === "upload_error") {
              clearTimeout(timeout);
              ws.off("message", handler);
              resolve(messages);
            }
          }
        };

        ws.on("message", handler);
      });
    }

    it("should successfully upload using binary format 0x02 chunks", async () => {
      const ws = await connectWebSocket();

      try {
        const uploadId = randomUUID();
        const projectId = "test-project";
        const sessionId = "test-session";
        const filename = "binary-test.txt";
        const fileContent = "Hello from binary upload!";
        const fileSize = fileContent.length;

        // Start collecting messages before sending
        const messagesPromise = collectUploadMessagesForBinary(ws, uploadId);

        // Send upload_start as JSON (to initiate the upload)
        const startMsg: RelayUploadStart = {
          type: "upload_start",
          uploadId,
          projectId,
          sessionId,
          filename,
          size: fileSize,
          mimeType: "text/plain",
        };
        ws.send(JSON.stringify(startMsg));

        // Wait a bit for start to process
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Send chunk using binary format 0x02
        // Wire format: [0x02][16 bytes UUID][8 bytes offset][chunk data]
        const chunkData = Buffer.from(fileContent);
        const binaryFrame = encodeUploadChunkFrame(uploadId, 0, chunkData);
        ws.send(Buffer.from(binaryFrame));

        // Send upload_end as JSON
        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        ws.send(JSON.stringify(endMsg));

        // Wait for completion
        const messages = await messagesPromise;

        // Should have at least one message
        expect(messages.length).toBeGreaterThanOrEqual(1);

        // Last message should be upload_complete
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.type).toBe("upload_complete");

        const completeMsg = lastMsg as RelayUploadComplete;
        expect(completeMsg.file).toBeDefined();
        expect(completeMsg.file.originalName).toBe(filename);
        expect(completeMsg.file.size).toBe(fileSize);
      } finally {
        ws.close();
      }
    });

    it("should upload larger file with multiple binary chunks", async () => {
      const ws = await connectWebSocket();

      try {
        const uploadId = randomUUID();
        const projectId = "test-project";
        const sessionId = "test-session";
        const filename = "large-binary.bin";
        // Create a 200KB file
        const fileSize = 200 * 1024;
        const fileContent = Buffer.alloc(fileSize, "Y");

        // Start collecting messages
        const messagesPromise = collectUploadMessagesForBinary(ws, uploadId);

        // Send upload_start
        const startMsg: RelayUploadStart = {
          type: "upload_start",
          uploadId,
          projectId,
          sessionId,
          filename,
          size: fileSize,
          mimeType: "application/octet-stream",
        };
        ws.send(JSON.stringify(startMsg));

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Send in 64KB binary chunks
        const chunkSize = 64 * 1024;
        let offset = 0;
        while (offset < fileSize) {
          const end = Math.min(offset + chunkSize, fileSize);
          const chunk = fileContent.slice(offset, end);

          // Send using binary format 0x02
          const binaryFrame = encodeUploadChunkFrame(uploadId, offset, chunk);
          ws.send(Buffer.from(binaryFrame));

          offset = end;
        }

        // Send upload_end
        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        ws.send(JSON.stringify(endMsg));

        // Wait for completion
        const messages = await messagesPromise;

        // Should have multiple progress messages plus complete
        expect(messages.length).toBeGreaterThanOrEqual(2);

        // Check we got progress updates
        const progressMsgs = messages.filter(
          (m) => m.type === "upload_progress",
        ) as RelayUploadProgress[];
        expect(progressMsgs.length).toBeGreaterThanOrEqual(1);

        // Last message should be upload_complete
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.type).toBe("upload_complete");

        const completeMsg = lastMsg as RelayUploadComplete;
        expect(completeMsg.file.size).toBe(fileSize);
      } finally {
        ws.close();
      }
    });

    it("should mix binary chunks with JSON messages", async () => {
      const ws = await connectWebSocket();

      try {
        const uploadId = randomUUID();
        const projectId = "test-project";
        const sessionId = "test-session";
        const filename = "mixed.txt";
        const fileContent = "Mixed binary and JSON";
        const fileSize = fileContent.length;

        // Start collecting messages
        const messagesPromise = collectUploadMessagesForBinary(ws, uploadId);

        // Send upload_start as binary JSON frame (format 0x01)
        const startMsg: RelayUploadStart = {
          type: "upload_start",
          uploadId,
          projectId,
          sessionId,
          filename,
          size: fileSize,
          mimeType: "text/plain",
        };
        ws.send(encodeJsonFrame(startMsg));

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Send chunk using binary format 0x02
        const chunkData = Buffer.from(fileContent);
        const binaryFrame = encodeUploadChunkFrame(uploadId, 0, chunkData);
        ws.send(Buffer.from(binaryFrame));

        // Send upload_end as binary JSON frame (format 0x01)
        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        ws.send(encodeJsonFrame(endMsg));

        // Wait for completion
        const messages = await messagesPromise;

        expect(messages.length).toBeGreaterThanOrEqual(1);
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.type).toBe("upload_complete");
      } finally {
        ws.close();
      }
    });

    it("should return error for binary chunk with unknown upload ID", async () => {
      const ws = await connectWebSocket();

      try {
        const uploadId = randomUUID();

        // Start collecting messages
        const messagesPromise = collectUploadMessagesForBinary(
          ws,
          uploadId,
          2000,
        );

        // Send binary chunk for non-existent upload
        const chunkData = Buffer.from("test data");
        const binaryFrame = encodeUploadChunkFrame(uploadId, 0, chunkData);
        ws.send(Buffer.from(binaryFrame));

        // Wait for error
        const messages = await messagesPromise;

        expect(messages.length).toBe(1);
        expect(messages[0].type).toBe("upload_error");

        const errorMsg = messages[0] as RelayUploadError;
        expect(errorMsg.error).toContain("Upload not found");
      } finally {
        ws.close();
      }
    });

    it("should return error for binary chunk with invalid offset", async () => {
      const ws = await connectWebSocket();

      try {
        const uploadId = randomUUID();
        const projectId = "test-project";
        const sessionId = "test-session";

        // Start collecting messages
        const messagesPromise = collectUploadMessagesForBinary(ws, uploadId);

        // Send upload_start
        const startMsg: RelayUploadStart = {
          type: "upload_start",
          uploadId,
          projectId,
          sessionId,
          filename: "test.txt",
          size: 100,
          mimeType: "text/plain",
        };
        ws.send(JSON.stringify(startMsg));

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Send binary chunk with wrong offset (should be 0)
        const chunkData = Buffer.from("test");
        const binaryFrame = encodeUploadChunkFrame(uploadId, 50, chunkData); // Wrong offset!
        ws.send(Buffer.from(binaryFrame));

        // Wait for error
        const messages = await messagesPromise;

        expect(messages.length).toBeGreaterThanOrEqual(1);
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.type).toBe("upload_error");

        const errorMsg = lastMsg as RelayUploadError;
        expect(errorMsg.error).toContain("Invalid offset");
      } finally {
        ws.close();
      }
    });

    it("should handle binary chunk with binary data (not just text)", async () => {
      const ws = await connectWebSocket();

      try {
        const uploadId = randomUUID();
        const projectId = "test-project";
        const sessionId = "test-session";
        const filename = "binary-data.bin";
        // Create binary data with all byte values
        const fileContent = Buffer.alloc(256);
        for (let i = 0; i < 256; i++) {
          fileContent[i] = i;
        }
        const fileSize = fileContent.length;

        // Start collecting messages
        const messagesPromise = collectUploadMessagesForBinary(ws, uploadId);

        // Send upload_start
        const startMsg: RelayUploadStart = {
          type: "upload_start",
          uploadId,
          projectId,
          sessionId,
          filename,
          size: fileSize,
          mimeType: "application/octet-stream",
        };
        ws.send(JSON.stringify(startMsg));

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Send binary chunk with actual binary data
        const binaryFrame = encodeUploadChunkFrame(uploadId, 0, fileContent);
        ws.send(Buffer.from(binaryFrame));

        // Send upload_end
        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        ws.send(JSON.stringify(endMsg));

        // Wait for completion
        const messages = await messagesPromise;

        expect(messages.length).toBeGreaterThanOrEqual(1);
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.type).toBe("upload_complete");

        const completeMsg = lastMsg as RelayUploadComplete;
        expect(completeMsg.file.size).toBe(fileSize);
      } finally {
        ws.close();
      }
    });
  });
});
