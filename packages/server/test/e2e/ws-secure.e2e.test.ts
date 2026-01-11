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
  SrpClientHello,
  SrpClientProof,
  SrpError,
  SrpServerChallenge,
  SrpServerVerify,
  YepMessage,
} from "@yep-anywhere/shared";
import {
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
  deriveSecretboxKey,
  encrypt,
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
    remoteAccessService = new RemoteAccessService({ dataDir });
    await remoteAccessService.initialize();
    await remoteAccessService.configure(TEST_USERNAME, TEST_PASSWORD);

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
        const msg = JSON.parse(data.toString());

        if (!isEncryptedEnvelope(msg)) {
          // Skip non-encrypted messages during SRP
          return;
        }

        const decrypted = decrypt(msg.nonce, msg.ciphertext, sessionKey);
        if (!decrypted) {
          clearTimeout(timeout);
          ws.off("message", handler);
          reject(new Error("Failed to decrypt response"));
          return;
        }

        const response = JSON.parse(decrypted) as YepMessage;
        if (response.type === "response" && response.id === request.id) {
          clearTimeout(timeout);
          ws.off("message", handler);
          resolve(response);
        }
      };

      ws.on("message", handler);

      // Send encrypted request
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

        // Set up event collector
        const events: RelayEvent[] = [];
        const eventHandler = (data: WebSocket.RawData) => {
          const msg = JSON.parse(data.toString());
          if (!isEncryptedEnvelope(msg)) return;

          const decrypted = decrypt(msg.nonce, msg.ciphertext, sessionKey);
          if (!decrypted) return;

          const event = JSON.parse(decrypted) as YepMessage;
          if (
            event.type === "event" &&
            event.subscriptionId === subscriptionId
          ) {
            events.push(event);
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
});
