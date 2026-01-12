import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type {
  EncryptedEnvelope,
  RelayEvent,
  RelayRequest,
  RelayResponse,
  RelaySubscribe,
  RelayUploadComplete,
  RelayUploadEnd,
  RelayUploadError,
  RelayUploadProgress,
  RelayUploadStart,
  SrpClientHello,
  SrpClientProof,
  SrpError,
  SrpServerChallenge,
  SrpServerVerify,
  YepMessage,
} from "@yep-anywhere/shared";
import {
  BinaryFormat,
  encodeUploadChunkPayload,
  isBinaryData,
  isEncryptedEnvelope,
  isSrpError,
  isSrpServerChallenge,
  isSrpServerVerify,
} from "@yep-anywhere/shared";
import {
  SRPClientSession,
  SRPParameters,
  SRPRoutines,
  bigIntToArrayBuffer,
} from "tssrp6a";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../../src/app.js";
import {
  decrypt,
  decryptBinaryEnvelope,
  decryptBinaryEnvelopeRaw,
  deriveSecretboxKey,
  encrypt,
  encryptBytesToBinaryEnvelope,
  encryptToBinaryEnvelope,
} from "../../src/crypto/index.js";
import { attachUnifiedUpgradeHandler } from "../../src/frontend/index.js";
import { RemoteAccessService } from "../../src/remote-access/index.js";
import { createWsRelayRoutes } from "../../src/routes/ws-relay.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
import { UploadManager } from "../../src/uploads/manager.js";
import { EventBus } from "../../src/watcher/index.js";

/**
 * E2E tests for secure WebSocket transport (Phase 3).
 *
 * These tests verify:
 * - SRP authentication handshake
 * - Encrypted request/response over WebSocket
 * - Encrypted event subscriptions
 */

// Test credentials
const TEST_USERNAME = "testuser";
const TEST_PASSWORD = "testpassword123";

// SRP parameters (same as production)
const SRP_PARAMS = new SRPParameters();
const SRP_ROUTINES = new SRPRoutines(SRP_PARAMS);

describe("Secure WebSocket Transport E2E", () => {
  let testDir: string;
  let server: ReturnType<typeof serve>;
  let serverPort: number;
  let mockSdk: MockClaudeSDK;
  let eventBus: EventBus;
  let remoteAccessService: RemoteAccessService;

  beforeAll(async () => {
    // Create temp directory for project data
    testDir = join(tmpdir(), `ws-secure-test-${randomUUID()}`);
    const projectPath = "/home/user/testproject";
    const encodedPath = projectPath.replaceAll("/", "-");

    await mkdir(join(testDir, "localhost", encodedPath), { recursive: true });
    await writeFile(
      join(testDir, "localhost", encodedPath, "test-session.jsonl"),
      `{"type":"user","cwd":"${projectPath}","message":{"content":"Hello"}}\n`,
    );

    // Create data dir for remote access
    const dataDir = join(testDir, "data");
    await mkdir(dataDir, { recursive: true });

    // Create services
    mockSdk = new MockClaudeSDK();
    eventBus = new EventBus();

    // Set up remote access with test credentials
    // First configure relay (relay username is used as SRP identity)
    remoteAccessService = new RemoteAccessService({ dataDir });
    await remoteAccessService.initialize();
    await remoteAccessService.setRelayConfig({
      url: "wss://test-relay.example.com/ws",
      username: TEST_USERNAME,
    });
    await remoteAccessService.configure(TEST_PASSWORD);

    // Create the app
    const { app, supervisor } = createApp({
      sdk: mockSdk,
      projectsDir: testDir,
      eventBus,
    });

    // Add WebSocket support
    const { upgradeWebSocket, wss } = createNodeWebSocket({ app });

    // Add WebSocket relay route with remote access enabled
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
      remoteAccessService,
    });
    app.get("/api/ws", wsRelayHandler);

    // Start server on random port
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      serverPort = info.port;
      console.log(
        `[WS Secure Test] Server running on port ${serverPort} with remote access enabled`,
      );
    });

    // Attach the unified upgrade handler
    attachUnifiedUpgradeHandler(server, {
      frontendProxy: undefined,
      isApiPath: (urlPath) => urlPath.startsWith("/api"),
      app,
      wss,
    });

    // Wait for server to be ready
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }, 30000);

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
   * Convert bigint to hex string.
   */
  function bigIntToHex(n: bigint): string {
    return n.toString(16);
  }

  /**
   * Convert hex string to bigint.
   */
  function hexToBigInt(hex: string): bigint {
    return BigInt(`0x${hex}`);
  }

  /**
   * Perform full SRP handshake and return session key.
   */
  async function performSrpHandshake(
    ws: WebSocket,
    username: string,
    password: string,
  ): Promise<Uint8Array> {
    // Create SRP client session before entering promise
    const clientSession = new SRPClientSession(SRP_ROUTINES);
    const clientStep1 = await clientSession.step1(username, password);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("SRP handshake timeout")),
        10000,
      );

      // Send hello
      const hello: SrpClientHello = {
        type: "srp_hello",
        identity: username,
      };
      ws.send(JSON.stringify(hello));

      // Handle messages
      const messageHandler = async (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());

          if (isSrpError(msg)) {
            clearTimeout(timeout);
            ws.off("message", messageHandler);
            reject(new Error(`SRP error: ${msg.message}`));
            return;
          }

          if (isSrpServerChallenge(msg)) {
            // Process challenge
            const saltBigInt = hexToBigInt(msg.salt);
            const B = hexToBigInt(msg.B);
            const clientStep2 = await clientStep1.step2(saltBigInt, B);

            // Send proof
            const proof: SrpClientProof = {
              type: "srp_proof",
              A: bigIntToHex(clientStep2.A),
              M1: bigIntToHex(clientStep2.M1),
            };
            ws.send(JSON.stringify(proof));
            return;
          }

          if (isSrpServerVerify(msg)) {
            // Verify server (we trust it in tests, but verify anyway)
            // Note: In real client, we'd verify M2
            clearTimeout(timeout);
            ws.off("message", messageHandler);

            // Get client's S value and derive key
            // We need to get S from clientStep2, which requires re-doing step2
            // Actually, let's just re-do the handshake properly
            const saltBigInt = hexToBigInt(msg.M2.split(":")[0] || "0");
            // This is a simplification - in real code we'd keep clientStep2 around

            // For testing, let's just derive a key from our password flow
            // Re-run step2 to get S
            const creds = remoteAccessService.getCredentials();
            const serverStep1 = await clientStep1.step2(
              hexToBigInt(creds?.salt ?? "0"),
              hexToBigInt("1"), // Placeholder - we need the actual B
            );

            // Actually, let's store the step2 result in the handler closure
            reject(new Error("Need to refactor - see comment"));
            return;
          }
        } catch (err) {
          clearTimeout(timeout);
          ws.off("message", messageHandler);
          reject(err);
        }
      };

      ws.on("message", messageHandler);
    });
  }

  /**
   * Perform full SRP handshake and return session key.
   * Refactored version with proper state handling.
   */
  async function performSrpHandshakeV2(
    ws: WebSocket,
    username: string,
    password: string,
  ): Promise<Uint8Array> {
    const clientSession = new SRPClientSession(SRP_ROUTINES);
    const clientStep1 = await clientSession.step1(username, password);

    // Send hello
    const hello: SrpClientHello = {
      type: "srp_hello",
      identity: username,
    };
    ws.send(JSON.stringify(hello));

    // Wait for challenge
    const challenge = await waitForMessage<SrpServerChallenge>(
      ws,
      (msg): msg is SrpServerChallenge => isSrpServerChallenge(msg),
      5000,
    );

    // Process challenge
    const saltBigInt = hexToBigInt(challenge.salt);
    const B = hexToBigInt(challenge.B);
    const clientStep2 = await clientStep1.step2(saltBigInt, B);

    // Send proof
    const proof: SrpClientProof = {
      type: "srp_proof",
      A: bigIntToHex(clientStep2.A),
      M1: bigIntToHex(clientStep2.M1),
    };
    ws.send(JSON.stringify(proof));

    // Wait for verify
    const verify = await waitForMessage<SrpServerVerify>(
      ws,
      (msg): msg is SrpServerVerify => isSrpServerVerify(msg),
      5000,
    );

    // Verify server proof
    const M2 = hexToBigInt(verify.M2);
    await clientStep2.step3(M2);

    // Derive session key
    const keyBuffer = bigIntToArrayBuffer(clientStep2.S);
    const rawKey = new Uint8Array(keyBuffer);
    return deriveSecretboxKey(rawKey);
  }

  /**
   * Helper to wait for a specific message type.
   */
  function waitForMessage<T>(
    ws: WebSocket,
    predicate: (msg: unknown) => msg is T,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Message wait timeout")),
        timeoutMs,
      );

      const handler = (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString());
        if (isSrpError(msg)) {
          clearTimeout(timeout);
          ws.off("message", handler);
          reject(new Error(`SRP error: ${msg.message}`));
          return;
        }
        if (predicate(msg)) {
          clearTimeout(timeout);
          ws.off("message", handler);
          resolve(msg);
        }
      };

      ws.on("message", handler);
    });
  }

  /**
   * Send an encrypted request and wait for encrypted response.
   * Handles both JSON envelope (legacy) and binary envelope (Phase 1) responses.
   */
  async function sendEncryptedRequest(
    ws: WebSocket,
    sessionKey: Uint8Array,
    request: RelayRequest,
  ): Promise<RelayResponse> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Request timeout")),
        5000,
      );

      const handler = (data: WebSocket.RawData) => {
        let decrypted: string | null = null;

        // The ws library may send data as Buffer even for text frames
        // Try JSON envelope first (text format), then binary envelope
        const dataStr = data.toString();

        // First try to parse as JSON envelope (legacy format)
        try {
          const msg = JSON.parse(dataStr);
          if (isEncryptedEnvelope(msg)) {
            decrypted = decrypt(msg.nonce, msg.ciphertext, sessionKey);
          }
        } catch {
          // Not valid JSON, might be binary envelope
        }

        // If not JSON, try binary envelope (Phase 1)
        if (
          !decrypted &&
          (Buffer.isBuffer(data) || data instanceof ArrayBuffer)
        ) {
          const bytes =
            data instanceof ArrayBuffer ? new Uint8Array(data) : data;
          try {
            decrypted = decryptBinaryEnvelope(bytes, sessionKey);
          } catch {
            return; // Not a valid binary envelope, skip
          }
        }

        if (!decrypted) {
          return; // Skip messages we couldn't decrypt
        }

        try {
          const response = JSON.parse(decrypted) as YepMessage;
          if (response.type === "response" && response.id === request.id) {
            clearTimeout(timeout);
            ws.off("message", handler);
            resolve(response);
          }
        } catch {
          return; // Couldn't parse decrypted content
        }
      };

      ws.on("message", handler);

      // Send encrypted request (JSON envelope format)
      const plaintext = JSON.stringify(request);
      const { nonce, ciphertext } = encrypt(plaintext, sessionKey);
      const envelope: EncryptedEnvelope = {
        type: "encrypted",
        nonce,
        ciphertext,
      };
      ws.send(JSON.stringify(envelope));
    });
  }

  describe("SRP Authentication", () => {
    it("should complete SRP handshake with correct credentials", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        expect(sessionKey).toBeDefined();
        expect(sessionKey.length).toBe(32); // NaCl secretbox key is 32 bytes
      } finally {
        ws.close();
      }
    }, 15000);

    it("should reject incorrect password", async () => {
      const ws = await connectWebSocket();

      try {
        await expect(
          performSrpHandshakeV2(ws, TEST_USERNAME, "wrongpassword"),
        ).rejects.toThrow();
      } finally {
        ws.close();
      }
    }, 15000);

    it("should reject unknown username", async () => {
      const ws = await connectWebSocket();

      try {
        await expect(
          performSrpHandshakeV2(ws, "unknownuser", TEST_PASSWORD),
        ).rejects.toThrow();
      } finally {
        ws.close();
      }
    }, 15000);
  });

  describe("Encrypted Request/Response", () => {
    it("should handle encrypted GET request", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };

        const response = await sendEncryptedRequest(ws, sessionKey, request);

        expect(response.status).toBe(200);
        expect((response.body as { status: string }).status).toBe("ok");
      } finally {
        ws.close();
      }
    }, 15000);

    it("should handle encrypted request for version endpoint", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/api/version",
        };

        const response = await sendEncryptedRequest(ws, sessionKey, request);

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty("current");
      } finally {
        ws.close();
      }
    }, 15000);

    it("should close connection with code 4001 when plaintext message sent without auth", async () => {
      const ws = await connectWebSocket();

      // Set up close handler before sending message
      const closePromise = new Promise<{ code: number; reason: string }>(
        (resolve) => {
          ws.on("close", (code, reason) => {
            resolve({ code, reason: reason.toString() });
          });
        },
      );

      // Don't authenticate, just try to send plaintext request
      const request: RelayRequest = {
        type: "request",
        id: randomUUID(),
        method: "GET",
        path: "/health",
      };

      // Send plaintext (should trigger connection close)
      ws.send(JSON.stringify(request));

      // Wait for the close event
      const closeResult = await closePromise;

      expect(closeResult.code).toBe(4001);
      expect(closeResult.reason).toBe("Authentication required");
    }, 5000);
  });

  describe("Encrypted Event Subscriptions", () => {
    it("should receive encrypted events when subscribing to activity", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const subscriptionId = randomUUID();

        // Set up event collector - handle both binary and JSON responses
        const events: RelayEvent[] = [];
        const eventHandler = (data: WebSocket.RawData) => {
          let decrypted: string | null = null;
          const dataStr = data.toString();

          // First try to parse as JSON envelope (legacy format)
          try {
            const msg = JSON.parse(dataStr);
            if (isEncryptedEnvelope(msg)) {
              decrypted = decrypt(msg.nonce, msg.ciphertext, sessionKey);
            }
          } catch {
            // Not valid JSON, might be binary envelope
          }

          // If not JSON, try binary envelope (Phase 1)
          if (
            !decrypted &&
            (Buffer.isBuffer(data) || data instanceof ArrayBuffer)
          ) {
            const bytes =
              data instanceof ArrayBuffer ? new Uint8Array(data) : data;
            try {
              decrypted = decryptBinaryEnvelope(bytes, sessionKey);
            } catch {
              return;
            }
          }

          if (!decrypted) return;

          try {
            const event = JSON.parse(decrypted) as YepMessage;
            if (
              event.type === "event" &&
              event.subscriptionId === subscriptionId
            ) {
              events.push(event);
            }
          } catch {
            return;
          }
        };
        ws.on("message", eventHandler);

        // Send encrypted subscribe
        const subscribe: RelaySubscribe = {
          type: "subscribe",
          subscriptionId,
          channel: "activity",
        };
        const plaintext = JSON.stringify(subscribe);
        const { nonce, ciphertext } = encrypt(plaintext, sessionKey);
        ws.send(JSON.stringify({ type: "encrypted", nonce, ciphertext }));

        // Wait for connected event
        await new Promise((resolve) => setTimeout(resolve, 500));

        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events[0].eventType).toBe("connected");
      } finally {
        ws.close();
      }
    }, 15000);
  });

  describe("Binary Encrypted Transport (Phase 1)", () => {
    /**
     * Send a binary encrypted request and wait for binary encrypted response.
     */
    async function sendBinaryEncryptedRequest(
      ws: WebSocket,
      sessionKey: Uint8Array,
      request: RelayRequest,
    ): Promise<RelayResponse> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Request timeout")),
          5000,
        );

        const handler = (data: WebSocket.RawData) => {
          // Expect binary response
          if (!Buffer.isBuffer(data) && !(data instanceof ArrayBuffer)) {
            // Skip non-binary messages (shouldn't happen after we send binary)
            return;
          }

          const bytes =
            data instanceof ArrayBuffer ? new Uint8Array(data) : data;

          try {
            const decrypted = decryptBinaryEnvelope(bytes, sessionKey);
            if (!decrypted) {
              return;
            }

            const response = JSON.parse(decrypted) as YepMessage;
            if (response.type === "response" && response.id === request.id) {
              clearTimeout(timeout);
              ws.off("message", handler);
              resolve(response);
            }
          } catch {
            // Decryption or parsing failed, keep waiting
          }
        };

        ws.on("message", handler);

        // Send binary encrypted request
        const plaintext = JSON.stringify(request);
        const envelope = encryptToBinaryEnvelope(plaintext, sessionKey);
        ws.send(envelope);
      });
    }

    it("should handle binary encrypted GET request", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };

        const response = await sendBinaryEncryptedRequest(
          ws,
          sessionKey,
          request,
        );

        expect(response.status).toBe(200);
        expect((response.body as { status: string }).status).toBe("ok");
      } finally {
        ws.close();
      }
    }, 15000);

    it("should handle binary encrypted request for version endpoint", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/api/version",
        };

        const response = await sendBinaryEncryptedRequest(
          ws,
          sessionKey,
          request,
        );

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty("current");
      } finally {
        ws.close();
      }
    }, 15000);

    it("should receive binary encrypted events when subscribing with binary", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const subscriptionId = randomUUID();

        // Set up event collector for binary responses
        const events: RelayEvent[] = [];
        const eventHandler = (data: WebSocket.RawData) => {
          if (!Buffer.isBuffer(data) && !(data instanceof ArrayBuffer)) {
            return;
          }

          const bytes =
            data instanceof ArrayBuffer ? new Uint8Array(data) : data;

          try {
            const decrypted = decryptBinaryEnvelope(bytes, sessionKey);
            if (!decrypted) return;

            const event = JSON.parse(decrypted) as YepMessage;
            if (
              event.type === "event" &&
              event.subscriptionId === subscriptionId
            ) {
              events.push(event);
            }
          } catch {
            return;
          }
        };
        ws.on("message", eventHandler);

        // Send binary encrypted subscribe
        const subscribe: RelaySubscribe = {
          type: "subscribe",
          subscriptionId,
          channel: "activity",
        };
        const envelope = encryptToBinaryEnvelope(
          JSON.stringify(subscribe),
          sessionKey,
        );
        ws.send(envelope);

        // Wait for connected event
        await new Promise((resolve) => setTimeout(resolve, 500));

        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events[0].eventType).toBe("connected");
      } finally {
        ws.close();
      }
    }, 15000);

    it("should switch from JSON to binary envelope format correctly", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        // First, send a JSON encrypted request (legacy)
        const request1: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };

        // Wait for encrypted response (can be JSON or binary)
        const response1Promise = new Promise<RelayResponse>(
          (resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("Timeout waiting for response")),
              5000,
            );

            const handler = (data: WebSocket.RawData) => {
              let decrypted: string | null = null;
              const dataStr = data.toString();

              // First try to parse as JSON envelope (legacy format)
              try {
                const msg = JSON.parse(dataStr);
                if (isEncryptedEnvelope(msg)) {
                  decrypted = decrypt(msg.nonce, msg.ciphertext, sessionKey);
                }
              } catch {
                // Not valid JSON, might be binary envelope
              }

              // If not JSON, try binary envelope (Phase 1)
              if (
                !decrypted &&
                (Buffer.isBuffer(data) || data instanceof ArrayBuffer)
              ) {
                const bytes =
                  data instanceof ArrayBuffer ? new Uint8Array(data) : data;
                try {
                  decrypted = decryptBinaryEnvelope(bytes, sessionKey);
                } catch {
                  return;
                }
              }

              if (!decrypted) return;

              try {
                const response = JSON.parse(decrypted) as YepMessage;
                if (
                  response.type === "response" &&
                  response.id === request1.id
                ) {
                  clearTimeout(timeout);
                  ws.off("message", handler);
                  resolve(response);
                }
              } catch {
                // Keep waiting
              }
            };

            ws.on("message", handler);
          },
        );

        // Send JSON encrypted request
        const { nonce, ciphertext } = encrypt(
          JSON.stringify(request1),
          sessionKey,
        );
        ws.send(JSON.stringify({ type: "encrypted", nonce, ciphertext }));

        const response1 = await response1Promise;
        expect(response1.status).toBe(200);

        // Now send a binary encrypted request
        const request2: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/api/version",
        };

        const response2 = await sendBinaryEncryptedRequest(
          ws,
          sessionKey,
          request2,
        );
        expect(response2.status).toBe(200);
      } finally {
        ws.close();
      }
    }, 15000);
  });

  describe("Encrypted Binary Upload Chunks (Phase 2)", () => {
    /**
     * Helper to collect upload messages from encrypted responses.
     */
    function collectEncryptedUploadMessages(
      ws: WebSocket,
      sessionKey: Uint8Array,
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
          let decrypted: string | null = null;

          // Try binary envelope first (most common after auth)
          if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
            const bytes =
              data instanceof ArrayBuffer ? new Uint8Array(data) : data;
            try {
              decrypted = decryptBinaryEnvelope(bytes, sessionKey);
            } catch {
              // Not a valid binary envelope
            }
          }

          // Try JSON envelope as fallback
          if (!decrypted) {
            const dataStr = data.toString();
            try {
              const msg = JSON.parse(dataStr);
              if (isEncryptedEnvelope(msg)) {
                decrypted = decrypt(msg.nonce, msg.ciphertext, sessionKey);
              }
            } catch {
              // Not valid JSON
            }
          }

          if (!decrypted) return;

          try {
            const msg = JSON.parse(decrypted) as YepMessage;
            if (
              (msg.type === "upload_progress" ||
                msg.type === "upload_complete" ||
                msg.type === "upload_error") &&
              msg.uploadId === uploadId
            ) {
              messages.push(msg);
              if (
                msg.type === "upload_complete" ||
                msg.type === "upload_error"
              ) {
                clearTimeout(timeout);
                ws.off("message", handler);
                resolve(messages);
              }
            }
          } catch {
            // Parsing failed
          }
        };

        ws.on("message", handler);
      });
    }

    it("should upload file using encrypted binary format 0x02 chunks", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const uploadId = randomUUID();
        const projectId = "test-project";
        const sessionId = "test-session";
        const filename = "secure-binary.txt";
        const fileContent = "Hello from encrypted binary upload!";
        const fileSize = fileContent.length;

        // Start collecting messages
        const messagesPromise = collectEncryptedUploadMessages(
          ws,
          sessionKey,
          uploadId,
        );

        // Send encrypted upload_start
        const startMsg: RelayUploadStart = {
          type: "upload_start",
          uploadId,
          projectId,
          sessionId,
          filename,
          size: fileSize,
          mimeType: "text/plain",
        };
        const startEnvelope = encryptToBinaryEnvelope(
          JSON.stringify(startMsg),
          sessionKey,
        );
        ws.send(startEnvelope);

        // Wait for start to process
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Send encrypted binary chunk (format 0x02)
        // Payload format: [16 bytes UUID][8 bytes offset][chunk data]
        const chunkData = Buffer.from(fileContent);
        const payload = encodeUploadChunkPayload(uploadId, 0, chunkData);
        const chunkEnvelope = encryptBytesToBinaryEnvelope(
          payload,
          BinaryFormat.BINARY_UPLOAD,
          sessionKey,
        );
        ws.send(chunkEnvelope);

        // Send encrypted upload_end
        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        const endEnvelope = encryptToBinaryEnvelope(
          JSON.stringify(endMsg),
          sessionKey,
        );
        ws.send(endEnvelope);

        // Wait for completion
        const messages = await messagesPromise;

        expect(messages.length).toBeGreaterThanOrEqual(1);
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.type).toBe("upload_complete");

        const completeMsg = lastMsg as RelayUploadComplete;
        expect(completeMsg.file.originalName).toBe(filename);
        expect(completeMsg.file.size).toBe(fileSize);
      } finally {
        ws.close();
      }
    }, 15000);

    it("should upload larger file with multiple encrypted binary chunks", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const uploadId = randomUUID();
        const projectId = "test-project";
        const sessionId = "test-session";
        const filename = "large-secure.bin";
        // Create a 200KB file
        const fileSize = 200 * 1024;
        const fileContent = Buffer.alloc(fileSize, "Z");

        // Start collecting messages
        const messagesPromise = collectEncryptedUploadMessages(
          ws,
          sessionKey,
          uploadId,
        );

        // Send encrypted upload_start
        const startMsg: RelayUploadStart = {
          type: "upload_start",
          uploadId,
          projectId,
          sessionId,
          filename,
          size: fileSize,
          mimeType: "application/octet-stream",
        };
        ws.send(encryptToBinaryEnvelope(JSON.stringify(startMsg), sessionKey));

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Send in 64KB encrypted binary chunks
        const chunkSize = 64 * 1024;
        let offset = 0;
        while (offset < fileSize) {
          const end = Math.min(offset + chunkSize, fileSize);
          const chunk = fileContent.slice(offset, end);

          // Encrypt binary chunk payload
          const payload = encodeUploadChunkPayload(uploadId, offset, chunk);
          const envelope = encryptBytesToBinaryEnvelope(
            payload,
            BinaryFormat.BINARY_UPLOAD,
            sessionKey,
          );
          ws.send(envelope);

          offset = end;

          // Small delay to let server process each chunk
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        // Small delay before sending end to ensure all chunks processed
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Send encrypted upload_end
        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        ws.send(encryptToBinaryEnvelope(JSON.stringify(endMsg), sessionKey));

        // Wait for completion
        const messages = await messagesPromise;

        expect(messages.length).toBeGreaterThanOrEqual(2);

        // Check progress updates
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
    }, 15000);

    it("should handle error for encrypted binary chunk with unknown upload ID", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const uploadId = randomUUID();

        // Start collecting messages
        const messagesPromise = collectEncryptedUploadMessages(
          ws,
          sessionKey,
          uploadId,
          2000,
        );

        // Send encrypted binary chunk without starting upload
        const chunkData = Buffer.from("test data");
        const payload = encodeUploadChunkPayload(uploadId, 0, chunkData);
        const envelope = encryptBytesToBinaryEnvelope(
          payload,
          BinaryFormat.BINARY_UPLOAD,
          sessionKey,
        );
        ws.send(envelope);

        // Wait for error
        const messages = await messagesPromise;

        expect(messages.length).toBe(1);
        expect(messages[0].type).toBe("upload_error");

        const errorMsg = messages[0] as RelayUploadError;
        expect(errorMsg.error).toContain("Upload not found");
      } finally {
        ws.close();
      }
    }, 15000);

    it("should handle binary data in encrypted chunks", async () => {
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const uploadId = randomUUID();
        const projectId = "test-project";
        const sessionId = "test-session";
        const filename = "binary-data-secure.bin";
        // Create binary data with all byte values
        const fileContent = Buffer.alloc(256);
        for (let i = 0; i < 256; i++) {
          fileContent[i] = i;
        }
        const fileSize = fileContent.length;

        // Start collecting messages
        const messagesPromise = collectEncryptedUploadMessages(
          ws,
          sessionKey,
          uploadId,
        );

        // Send encrypted upload_start
        const startMsg: RelayUploadStart = {
          type: "upload_start",
          uploadId,
          projectId,
          sessionId,
          filename,
          size: fileSize,
          mimeType: "application/octet-stream",
        };
        ws.send(encryptToBinaryEnvelope(JSON.stringify(startMsg), sessionKey));

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Send encrypted binary chunk
        const payload = encodeUploadChunkPayload(uploadId, 0, fileContent);
        ws.send(
          encryptBytesToBinaryEnvelope(
            payload,
            BinaryFormat.BINARY_UPLOAD,
            sessionKey,
          ),
        );

        // Send encrypted upload_end
        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        ws.send(encryptToBinaryEnvelope(JSON.stringify(endMsg), sessionKey));

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
    }, 15000);
  });
});
