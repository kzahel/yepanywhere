import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { upgradeWebSocket } from "@hono/node-server";
import { WebSocketServer } from "ws";
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
  decodeJsonFrame,
  encodeJsonFrame,
  encodeUploadChunkFrame,
} from "@yep-anywhere/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createApp } from "../setup/create-app.js";
import { attachUnifiedUpgradeHandler } from "../../src/frontend/index.js";
import { getLogger } from "../../src/logging/logger.js";
import { createWsRelayRoutes } from "../../src/routes/ws-relay.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { UploadManager } from "../../src/uploads/manager.js";
import { EventBus } from "../../src/watcher/index.js";

describe("WebSocket Transport E2E", () => {
  let testDir: string;
  let server: ReturnType<typeof serve>;
  let serverPort: number;
  let mockSdk: ScriptedClaudeProvider;
  let eventBus: EventBus;

  beforeAll(async () => {
    testDir = join(tmpdir(), `ws-transport-test-${randomUUID()}`);
    const projectPath = "/home/user/testproject";
    const encodedPath = projectPath.replaceAll("/", "-");

    await mkdir(join(testDir, "localhost", encodedPath), { recursive: true });
    await writeFile(
      join(testDir, "localhost", encodedPath, "test-session.jsonl"),
      `{"type":"user","cwd":"${projectPath}","message":{"content":"Hello"}}\n`,
    );

    mockSdk = new ScriptedClaudeProvider();
    eventBus = new EventBus();

    const { app, supervisor } = createApp({
      provider: mockSdk,
      projectsDir: testDir,
      eventBus,
    });

    const wss = new WebSocketServer({ noServer: true });

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

    server = serve(
      { fetch: app.fetch, websocket: { server: wss }, port: 0 },
      (info) => {
        serverPort = info.port;
        console.log(`[WS Transport Test] Server running on port ${serverPort}`);
      },
    );

    // Attach the unified upgrade handler (same as production)
    attachUnifiedUpgradeHandler(server, {
      frontendProxy: undefined,
      isApiPath: (urlPath) => urlPath.startsWith("/api"),
    });

    // Wait for server to be ready
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  });

  afterAll(async () => {
    server?.close();
    await rm(testDir, { recursive: true, force: true });
  });

  function connectWebSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${serverPort}/api/ws`);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
    });
  }

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

  function collectEvents(
    ws: WebSocket,
    subscriptionId: string,
    count: number,
    timeoutMs = 5000,
  ): Promise<RelayEvent[]> {
    return new Promise((resolve, _reject) => {
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
          path: "/health",
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
        expect(response.body).toHaveProperty("current");
        expect(response.body).toHaveProperty("resumeProtocolVersion", 3);
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

        ws.send(JSON.stringify(subscribe));

        const eventsPromise = collectEvents(ws, subscriptionId, 3, 3000);

        // Give subscription time to be established
        await new Promise((resolve) => setTimeout(resolve, 100));

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

        expect(events.length).toBeGreaterThanOrEqual(2);

        const eventTypes = events.map((e) => e.eventType);
        expect(eventTypes).toContain("connected");
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

        const subscribe: RelaySubscribe = {
          type: "subscribe",
          subscriptionId,
          channel: "activity",
        };
        ws.send(JSON.stringify(subscribe));

        await collectEvents(ws, subscriptionId, 1);

        const unsubscribe: RelayUnsubscribe = {
          type: "unsubscribe",
          subscriptionId,
        };
        ws.send(JSON.stringify(unsubscribe));

        // Wait a bit for unsubscribe to process
        await new Promise((resolve) => setTimeout(resolve, 100));

        eventBus.emit({
          type: "file-change",
          provider: "claude",
          path: "/test/file2.txt",
          changeType: "change",
          timestamp: new Date().toISOString(),
        });

        const events = await collectEvents(ws, subscriptionId, 1, 500);

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

        eventBus.emit({
          type: "file-change",
          provider: "claude",
          path: "/test/concurrent.txt",
          changeType: "change",
          timestamp: new Date().toISOString(),
        });

        const [events1, events2] = await Promise.all([
          events1Promise,
          events2Promise,
        ]);

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
        };

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

      const ws = await connectWebSocket();
      const subscribe: RelaySubscribe = {
        type: "subscribe",
        subscriptionId,
        channel: "activity",
      };
      ws.send(JSON.stringify(subscribe));

      await collectEvents(ws, subscriptionId, 1);

      const initialCount = eventBus.subscriberCount;

      ws.close();

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(eventBus.subscriberCount).toBeLessThan(initialCount);
    });

    it("should handle reconnection", async () => {
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

        const messagesPromise = collectUploadMessages(ws, uploadId);

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

        const base64Content = Buffer.from(fileContent).toString("base64");
        const chunkMsg: RelayUploadChunk = {
          type: "upload_chunk",
          uploadId,
          offset: 0,
          data: base64Content,
        };
        ws.send(JSON.stringify(chunkMsg));

        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        ws.send(JSON.stringify(endMsg));

        const messages = await messagesPromise;

        expect(messages.length).toBeGreaterThanOrEqual(1);

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

        const messagesPromise = collectUploadMessages(ws, uploadId);

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

        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        ws.send(JSON.stringify(endMsg));

        const messages = await messagesPromise;

        expect(messages.length).toBeGreaterThanOrEqual(2);

        const progressMsgs = messages.filter(
          (m) => m.type === "upload_progress",
        ) as RelayUploadProgress[];
        expect(progressMsgs.length).toBeGreaterThanOrEqual(1);

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

        const messagesPromise = collectUploadMessages(ws, uploadId);

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

        const messagesPromise = collectUploadMessages(ws, uploadId, 2000);

        const chunkMsg: RelayUploadChunk = {
          type: "upload_chunk",
          uploadId,
          offset: 0,
          data: Buffer.from("test").toString("base64"),
        };
        ws.send(JSON.stringify(chunkMsg));

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

        const messagesPromise = collectUploadMessages(ws, uploadId, 2000);

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

        const messages = await messagesPromise;

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

        const response = await sendRequest(ws, request);

        expect(response.status).toBe(200);
        expect((response.body as { status: string }).status).toBe("ok");
      } finally {
        ws.close();
      }
    });

    it("should reject unknown format bytes", async () => {
      const warn = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      const ws = await connectWebSocket();

      try {
        const payload = Buffer.from(
          JSON.stringify({ type: "request", id: "test" }),
        );
        const invalidFrame = Buffer.alloc(1 + payload.length);
        invalidFrame[0] = 0x00;
        payload.copy(invalidFrame, 1);

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
        expect(warn).toHaveBeenCalledWith(
          { code: "UNKNOWN_FORMAT", error: "Unknown format byte: 0x00" },
          "[WS Relay] Binary frame error",
        );
      } finally {
        warn.mockRestore();
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      }
    });

    it("should handle mixed text/binary frames", async () => {
      const ws = await connectWebSocket();

      try {
        const textRequest: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };
        const textResponse = await sendRequest(ws, textRequest);
        expect(textResponse.status).toBe(200);

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
              try {
                const msg = JSON.parse(data.toString()) as YepMessage;
                if (msg.type === "response" && msg.id === request.id) {
                  clearTimeout(timeout);
                  ws.off("message", handler);
                  resolve(msg);
                }
              } catch {}
            }
          };

          ws.on("message", handler);
          ws.send(encodeJsonFrame(request));
        });

        expect(response.status).toBe(200);
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
            } catch {}
          };

          ws.on("message", handler);
        });

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
        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };

        const response = await sendBinaryRequest(ws, request);
        expect(response.status).toBe(200);

        const utf8Request: RelayRequest = {
          type: "request",
          id: `test-${randomUUID()}-emoji-🎉`,
          method: "GET",
          path: "/health",
        };
        const utf8Response = await sendBinaryRequest(ws, utf8Request);
        expect(utf8Response.status).toBe(200);
        expect(utf8Response.id).toBe(utf8Request.id);
      } finally {
        ws.close();
      }
    });
  });

  describe("Binary Upload Chunks (Phase 2)", () => {
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
            return;
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

        const messagesPromise = collectUploadMessagesForBinary(ws, uploadId);

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

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Send chunk using binary format 0x02
        // Wire format: [0x02][16 bytes UUID][8 bytes offset][chunk data]
        const chunkData = Buffer.from(fileContent);
        const binaryFrame = encodeUploadChunkFrame(uploadId, 0, chunkData);
        ws.send(Buffer.from(binaryFrame));

        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        ws.send(JSON.stringify(endMsg));

        const messages = await messagesPromise;

        expect(messages.length).toBeGreaterThanOrEqual(1);

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
        const fileSize = 200 * 1024;
        const fileContent = Buffer.alloc(fileSize, "Y");

        const messagesPromise = collectUploadMessagesForBinary(ws, uploadId);

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

        const chunkSize = 64 * 1024;
        let offset = 0;
        while (offset < fileSize) {
          const end = Math.min(offset + chunkSize, fileSize);
          const chunk = fileContent.slice(offset, end);

          const binaryFrame = encodeUploadChunkFrame(uploadId, offset, chunk);
          ws.send(Buffer.from(binaryFrame));

          offset = end;
        }

        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        ws.send(JSON.stringify(endMsg));

        const messages = await messagesPromise;

        expect(messages.length).toBeGreaterThanOrEqual(2);

        const progressMsgs = messages.filter(
          (m) => m.type === "upload_progress",
        ) as RelayUploadProgress[];
        expect(progressMsgs.length).toBeGreaterThanOrEqual(1);

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

        const messagesPromise = collectUploadMessagesForBinary(ws, uploadId);

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

        const chunkData = Buffer.from(fileContent);
        const binaryFrame = encodeUploadChunkFrame(uploadId, 0, chunkData);
        ws.send(Buffer.from(binaryFrame));

        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        ws.send(encodeJsonFrame(endMsg));

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

        const messagesPromise = collectUploadMessagesForBinary(
          ws,
          uploadId,
          2000,
        );

        const chunkData = Buffer.from("test data");
        const binaryFrame = encodeUploadChunkFrame(uploadId, 0, chunkData);
        ws.send(Buffer.from(binaryFrame));

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

        const messagesPromise = collectUploadMessagesForBinary(ws, uploadId);

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
        const binaryFrame = encodeUploadChunkFrame(uploadId, 50, chunkData);
        ws.send(Buffer.from(binaryFrame));

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
        const fileContent = Buffer.alloc(256);
        for (let i = 0; i < 256; i++) {
          fileContent[i] = i;
        }
        const fileSize = fileContent.length;

        const messagesPromise = collectUploadMessagesForBinary(ws, uploadId);

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

        const binaryFrame = encodeUploadChunkFrame(uploadId, 0, fileContent);
        ws.send(Buffer.from(binaryFrame));

        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        ws.send(JSON.stringify(endMsg));

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
