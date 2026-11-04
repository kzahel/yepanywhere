import { randomUUID } from "node:crypto";
import type {
  LookupAddress,
  LookupAllOptions,
  LookupOneOptions,
} from "node:dns";
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
  RelayUploadComplete,
  RelayUploadEnd,
  RelayUploadError,
  RelayUploadProgress,
  RelayUploadStart,
  SrpClientHello,
  SrpClientProof,
  SrpServerChallenge,
  SrpServerVerify,
  SrpSessionInvalid,
  SrpSessionResume,
  SrpSessionResumeChallenge,
  SrpSessionResumeInit,
  SrpSessionResumed,
  YepMessage,
} from "@yep-anywhere/shared";
import {
  BinaryFormat,
  encodeUploadChunkPayload,
  isSequencedEncryptedPayload,
  isSrpError,
  isSrpServerChallenge,
  isSrpServerVerify,
  isSrpSessionInvalid,
  isSrpSessionResumed,
} from "@yep-anywhere/shared";
import { getLogger } from "../../src/logging/logger.js";
import {
  SRPClientSession,
  SRPParameters,
  SRPRoutines,
  bigIntToArrayBuffer,
} from "tssrp6a";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createApp } from "../setup/create-app.js";
import { AuthService } from "../../src/auth/AuthService.js";
import {
  decrypt,
  decryptBinaryEnvelope,
  deriveSecretboxKey,
  deriveTransportKey,
  encrypt,
  encryptBytesToBinaryEnvelope,
  encryptToBinaryEnvelope,
} from "../../src/crypto/index.js";
import { attachUnifiedUpgradeHandler } from "../../src/frontend/index.js";
import { RemoteSessionService } from "../../src/remote-access/RemoteSessionService.js";
import { RemoteAccessService } from "../../src/remote-access/index.js";
import { createWsRelayRoutes } from "../../src/routes/ws-relay.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
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
// Use a non-loopback hostname allowed by host policy (*.ts.net) while routing
// DNS to loopback so tests hit the local server.
const SRP_REQUIRED_TEST_HOST = "ws-secure-test.ts.net";

// SRP parameters (same as production)
const SRP_PARAMS = new SRPParameters();
const SRP_ROUTINES = new SRPRoutines(SRP_PARAMS);

function lookupLoopback(
  _hostname: string,
  options: LookupOneOptions | LookupAllOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  if ("all" in options && options.all) {
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
    return;
  }
  callback(null, "127.0.0.1", 4);
}

describe("Secure WebSocket Transport E2E", () => {
  let testDir: string;
  let server: ReturnType<typeof serve>;
  let serverPort: number;
  let mockSdk: ScriptedClaudeProvider;
  let eventBus: EventBus;
  let authService: AuthService;
  let remoteAccessService: RemoteAccessService;
  let remoteSessionService: RemoteSessionService;

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
    mockSdk = new ScriptedClaudeProvider();
    eventBus = new EventBus();
    authService = new AuthService({
      dataDir,
      cookieSecret: "ws-secure-test-cookie-secret",
    });
    await authService.initialize();

    // Set up remote access with test credentials
    // First configure relay (relay username is used as SRP identity)
    remoteAccessService = new RemoteAccessService({ dataDir });
    await remoteAccessService.initialize();
    await remoteAccessService.setRelayConfig({
      url: "wss://test-relay.example.com/ws",
      username: TEST_USERNAME,
    });
    await remoteAccessService.configure(TEST_PASSWORD);

    remoteSessionService = new RemoteSessionService({ dataDir });
    await remoteSessionService.initialize();

    // Create the app
    const { app, supervisor } = createApp({
      provider: mockSdk,
      projectsDir: testDir,
      eventBus,
      authService,
      authDisabled: true,
    });

    // Add WebSocket support
    const wss = new WebSocketServer({ noServer: true });

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
      remoteSessionService,
    });
    app.get("/api/ws", wsRelayHandler);

    // Start server on random port
    server = serve(
      { fetch: app.fetch, websocket: { server: wss }, port: 0 },
      (info) => {
        serverPort = info.port;
        console.log(
          `[WS Secure Test] Server running on port ${serverPort} with remote access enabled`,
        );
      },
    );

    // Attach the unified upgrade handler
    attachUnifiedUpgradeHandler(server, {
      frontendProxy: undefined,
      isApiPath: (urlPath) => urlPath.startsWith("/api"),
    });

    // Wait for server to be ready
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }, 30000);

  afterAll(async () => {
    remoteSessionService?.shutdown();
    server?.close();
    await rm(testDir, { recursive: true, force: true });
  });

  /**
   * Helper to create a WebSocket connection.
   */
  function connectWebSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `ws://${SRP_REQUIRED_TEST_HOST}:${serverPort}/api/ws`,
        {
          lookup: lookupLoopback,
        },
      );
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
    });
  }

  /**
   * Helper to close a WebSocket connection and wait for the close event.
   * This ensures proper cleanup between tests.
   */
  async function closeWebSocket(ws: WebSocket): Promise<void> {
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.on("close", () => resolve());
      ws.close();
      // Fallback timeout in case close event doesn't fire
      setTimeout(resolve, 100);
    });
    // Extra delay to ensure server has processed the disconnect
    await new Promise((resolve) => setTimeout(resolve, 10));
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
    const baseSessionKey = deriveSecretboxKey(rawKey);
    if (!verify.transportNonce) {
      throw new Error("Expected transportNonce in SRP verify");
    }
    const transportSessionKey = deriveTransportKey(
      baseSessionKey,
      verify.transportNonce,
    );

    // Wait to ensure server has fully processed the handshake before
    // subsequent encrypted messages. This prevents a race condition where
    // the server's message queue hasn't finished processing the auth state.
    await new Promise((resolve) => setTimeout(resolve, 10));

    return transportSessionKey;
  }

  /**
   * Perform full SRP handshake and return session keys + sessionId.
   */
  async function performSrpHandshakeWithSession(
    ws: WebSocket,
    username: string,
    password: string,
  ): Promise<{
    sessionKey: Uint8Array;
    baseSessionKey: Uint8Array;
    sessionId: string;
  }> {
    const clientSession = new SRPClientSession(SRP_ROUTINES);
    const clientStep1 = await clientSession.step1(username, password);

    const hello: SrpClientHello = {
      type: "srp_hello",
      identity: username,
    };
    ws.send(JSON.stringify(hello));

    const challenge = await waitForMessage<SrpServerChallenge>(
      ws,
      (msg): msg is SrpServerChallenge => isSrpServerChallenge(msg),
      5000,
    );

    const saltBigInt = hexToBigInt(challenge.salt);
    const B = hexToBigInt(challenge.B);
    const clientStep2 = await clientStep1.step2(saltBigInt, B);

    const proof: SrpClientProof = {
      type: "srp_proof",
      A: bigIntToHex(clientStep2.A),
      M1: bigIntToHex(clientStep2.M1),
    };
    ws.send(JSON.stringify(proof));

    const verify = await waitForMessage<SrpServerVerify>(
      ws,
      (msg): msg is SrpServerVerify => isSrpServerVerify(msg),
      5000,
    );

    if (!verify.sessionId) {
      throw new Error("Expected sessionId in SRP verify");
    }

    const M2 = hexToBigInt(verify.M2);
    await clientStep2.step3(M2);

    const keyBuffer = bigIntToArrayBuffer(clientStep2.S);
    const rawKey = new Uint8Array(keyBuffer);
    const baseSessionKey = deriveSecretboxKey(rawKey);
    if (!verify.transportNonce) {
      throw new Error("Expected transportNonce in SRP verify");
    }
    if (!verify.serverInfoProof) {
      throw new Error("Expected serverInfoProof in SRP verify");
    }
    const proofEnvelope = JSON.parse(verify.serverInfoProof) as {
      nonce: string;
      ciphertext: string;
    };
    const proofPlaintext = decrypt(
      proofEnvelope.nonce,
      proofEnvelope.ciphertext,
      baseSessionKey,
    );
    expect(proofPlaintext).not.toBeNull();
    expect(JSON.parse(proofPlaintext ?? "{}")).toEqual({
      type: "srp_verify_server_info",
      sessionId: verify.sessionId,
      transportNonce: verify.transportNonce,
      resumeProtocolVersion: 3,
    });
    const sessionKey = deriveTransportKey(
      baseSessionKey,
      verify.transportNonce,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    return { sessionKey, baseSessionKey, sessionId: verify.sessionId };
  }

  /**
   * Helper to wait for a specific message type.
   */
  function waitForMessage<T>(
    ws: WebSocket,
    predicate: (msg: unknown) => msg is T,
    timeoutMs: number,
    options?: {
      allowSrpSessionInvalid?: boolean;
    },
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
        if (isSrpSessionInvalid(msg)) {
          if (!options?.allowSrpSessionInvalid) {
            clearTimeout(timeout);
            ws.off("message", handler);
            reject(new Error(`SRP session invalid: ${msg.reason}`));
            return;
          }
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
   * Parse a decrypted transport payload and unwrap sequence metadata when present.
   */
  function parseDecryptedTransportMessage(
    decrypted: string,
  ): YepMessage | null {
    try {
      const parsed = JSON.parse(decrypted);
      if (isSequencedEncryptedPayload(parsed)) {
        return parsed.msg as YepMessage;
      }
      return null;
    } catch {
      return null;
    }
  }

  const outboundSeqBySocket = new WeakMap<WebSocket, number>();

  function encryptSequencedClientMessage(
    ws: WebSocket,
    sessionKey: Uint8Array,
    msg: unknown,
  ): ReturnType<typeof encryptToBinaryEnvelope> {
    const seq = outboundSeqBySocket.get(ws) ?? 0;
    outboundSeqBySocket.set(ws, seq + 1);
    return encryptToBinaryEnvelope(JSON.stringify({ seq, msg }), sessionKey);
  }

  function fixedClientNonce(fill = 0x51): string {
    return Buffer.from(new Uint8Array(24).fill(fill)).toString("base64");
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
        let decrypted: string | null = null;

        if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
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
          const response = parseDecryptedTransportMessage(decrypted);
          if (
            response &&
            response.type === "response" &&
            response.id === request.id
          ) {
            clearTimeout(timeout);
            ws.off("message", handler);
            resolve(response);
          }
        } catch {
          return; // Couldn't parse decrypted content
        }
      };

      ws.on("message", handler);

      ws.send(encryptSequencedClientMessage(ws, sessionKey, request));
    });
  }

  /**
   * Wait for a specific encrypted response ID. Returns null on timeout.
   */
  async function waitForEncryptedResponseById(
    ws: WebSocket,
    sessionKey: Uint8Array,
    requestId: string,
    timeoutMs = 1000,
  ): Promise<RelayResponse | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ws.off("message", handler);
        resolve(null);
      }, timeoutMs);

      const handler = (data: WebSocket.RawData) => {
        let decrypted: string | null = null;

        if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
          const bytes =
            data instanceof ArrayBuffer ? new Uint8Array(data) : data;
          try {
            decrypted = decryptBinaryEnvelope(bytes, sessionKey);
          } catch {
            return;
          }
        }

        if (!decrypted) {
          return;
        }

        try {
          const response = parseDecryptedTransportMessage(decrypted);
          if (
            response &&
            response.type === "response" &&
            response.id === requestId
          ) {
            clearTimeout(timeout);
            ws.off("message", handler);
            resolve(response);
          }
        } catch {
          // Ignore non-JSON payloads
        }
      };

      ws.on("message", handler);
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
        await closeWebSocket(ws);
      }
    }, 15000);

    it("should reject incorrect password", async () => {
      const ws = await connectWebSocket();
      const warn = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);

      try {
        await expect(
          performSrpHandshakeV2(ws, TEST_USERNAME, "wrongpassword"),
        ).rejects.toThrow();
        expect(warn).toHaveBeenCalledWith(
          `[WS Relay] SRP authentication failed for ${TEST_USERNAME}`,
        );
      } finally {
        await closeWebSocket(ws);
        warn.mockRestore();
      }
    }, 15000);

    it("should reject unknown username", async () => {
      const ws = await connectWebSocket();

      try {
        await expect(
          performSrpHandshakeV2(ws, "unknownuser", TEST_PASSWORD),
        ).rejects.toThrow();
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);

    it("should reject a second srp_hello while waiting for proof", async () => {
      const ws = await connectWebSocket();

      try {
        const hello: SrpClientHello = {
          type: "srp_hello",
          identity: TEST_USERNAME,
        };
        ws.send(JSON.stringify(hello));

        await waitForMessage<SrpServerChallenge>(
          ws,
          (msg): msg is SrpServerChallenge => isSrpServerChallenge(msg),
          5000,
        );

        const closePromise = new Promise<{ code: number; reason: string }>(
          (resolve) => {
            ws.on("close", (code, reason) => {
              resolve({ code, reason: reason.toString() });
            });
          },
        );

        ws.send(JSON.stringify(hello));

        const closeResult = await closePromise;
        expect(closeResult.code).toBe(4008);
        expect(closeResult.reason).toBe("Authentication already in progress");
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);

    it("should reject srp_hello after authentication is complete", async () => {
      const ws = await connectWebSocket();

      try {
        await performSrpHandshakeV2(ws, TEST_USERNAME, TEST_PASSWORD);

        const hello: SrpClientHello = {
          type: "srp_hello",
          identity: TEST_USERNAME,
        };

        const closePromise = new Promise<{ code: number; reason: string }>(
          (resolve) => {
            ws.on("close", (code, reason) => {
              resolve({ code, reason: reason.toString() });
            });
          },
        );

        ws.send(JSON.stringify(hello));

        const closeResult = await closePromise;
        expect(closeResult.code).toBe(4005);
        expect(closeResult.reason).toBe("Already authenticated");
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);

    it("should close connection when SRP proof is not provided in time", async () => {
      const ws = await connectWebSocket();

      try {
        const hello: SrpClientHello = {
          type: "srp_hello",
          identity: TEST_USERNAME,
        };
        ws.send(JSON.stringify(hello));

        await waitForMessage<SrpServerChallenge>(
          ws,
          (msg): msg is SrpServerChallenge => isSrpServerChallenge(msg),
          5000,
        );

        const closeResult = await new Promise<{ code: number; reason: string }>(
          (resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Expected SRP timeout close")),
              15000,
            );
            ws.on("close", (code, reason) => {
              clearTimeout(timer);
              resolve({ code, reason: reason.toString() });
            });
          },
        );

        expect(closeResult.code).toBe(4008);
        expect(closeResult.reason).toBe("Authentication timeout");
      } finally {
        await closeWebSocket(ws);
      }
    }, 20000);
  });

  describe("Session Resume Nonce Challenge", () => {
    it("should resume session with server-issued nonce challenge", async () => {
      const ws1 = await connectWebSocket();
      const { baseSessionKey, sessionId } =
        await performSrpHandshakeWithSession(ws1, TEST_USERNAME, TEST_PASSWORD);
      await closeWebSocket(ws1);

      const ws2 = await connectWebSocket();
      try {
        const clientNonce = fixedClientNonce();
        const resumeInit: SrpSessionResumeInit = {
          type: "srp_resume_init",
          identity: TEST_USERNAME,
          sessionId,
          clientNonce,
        };
        ws2.send(JSON.stringify(resumeInit));

        const challenge = await waitForMessage<SrpSessionResumeChallenge>(
          ws2,
          (msg): msg is SrpSessionResumeChallenge =>
            typeof msg === "object" &&
            msg !== null &&
            (msg as { type?: string }).type === "srp_resume_challenge",
          5000,
        );
        expect(challenge.sessionId).toBe(sessionId);

        const proofData = JSON.stringify({
          timestamp: Date.now(),
          sessionId,
          challenge: challenge.nonce,
        });
        const { nonce, ciphertext } = encrypt(proofData, baseSessionKey);
        const resume: SrpSessionResume = {
          type: "srp_resume",
          identity: TEST_USERNAME,
          sessionId,
          proof: JSON.stringify({ nonce, ciphertext }),
        };
        ws2.send(JSON.stringify(resume));

        const resumed = await waitForMessage<SrpSessionResumed>(
          ws2,
          (msg): msg is SrpSessionResumed => isSrpSessionResumed(msg),
          5000,
        );
        expect(resumed.sessionId).toBe(sessionId);
        if (!resumed.serverProof) {
          throw new Error("Expected serverProof in SRP resume");
        }
        if (!resumed.transportNonce) {
          throw new Error("Expected transportNonce in SRP resume");
        }
        const proofEnvelope = JSON.parse(resumed.serverProof) as {
          nonce: string;
          ciphertext: string;
        };
        const proofPlaintext = decrypt(
          proofEnvelope.nonce,
          proofEnvelope.ciphertext,
          baseSessionKey,
        );
        expect(proofPlaintext).not.toBeNull();
        expect(JSON.parse(proofPlaintext ?? "{}")).toEqual({
          type: "srp_resume_server_proof",
          sessionId,
          serverNonce: challenge.nonce,
          clientNonce,
          resumeProtocolVersion: 3,
        });
        const resumedSessionKey = deriveTransportKey(
          baseSessionKey,
          resumed.transportNonce,
        );

        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };
        const response = await sendEncryptedRequest(
          ws2,
          resumedSessionKey,
          request,
        );
        expect(response.status).toBe(200);
      } finally {
        await closeWebSocket(ws2);
      }
    }, 15000);

    it("should reject resume init without client nonce", async () => {
      const ws1 = await connectWebSocket();
      const { sessionId } = await performSrpHandshakeWithSession(
        ws1,
        TEST_USERNAME,
        TEST_PASSWORD,
      );
      await closeWebSocket(ws1);

      const ws2 = await connectWebSocket();
      try {
        ws2.send(
          JSON.stringify({
            type: "srp_resume_init",
            identity: TEST_USERNAME,
            sessionId,
          }),
        );

        const invalid = await waitForMessage<SrpSessionInvalid>(
          ws2,
          (msg): msg is SrpSessionInvalid => isSrpSessionInvalid(msg),
          5000,
          { allowSrpSessionInvalid: true },
        );
        expect(invalid.reason).toBe("invalid_proof");
      } finally {
        await closeWebSocket(ws2);
      }
    }, 15000);

    it("should reject replayed resume proof from a previous challenge", async () => {
      const ws1 = await connectWebSocket();
      const { baseSessionKey, sessionId } =
        await performSrpHandshakeWithSession(ws1, TEST_USERNAME, TEST_PASSWORD);
      await closeWebSocket(ws1);

      // First resume attempt (valid) to produce a replayable captured proof.
      const ws2 = await connectWebSocket();
      let capturedProof = "";
      try {
        const resumeInit: SrpSessionResumeInit = {
          type: "srp_resume_init",
          identity: TEST_USERNAME,
          sessionId,
          clientNonce: fixedClientNonce(0x52),
        };
        ws2.send(JSON.stringify(resumeInit));

        const challenge1 = await waitForMessage<SrpSessionResumeChallenge>(
          ws2,
          (msg): msg is SrpSessionResumeChallenge =>
            typeof msg === "object" &&
            msg !== null &&
            (msg as { type?: string }).type === "srp_resume_challenge",
          5000,
        );

        const proofData1 = JSON.stringify({
          timestamp: Date.now(),
          sessionId,
          challenge: challenge1.nonce,
        });
        const { nonce, ciphertext } = encrypt(proofData1, baseSessionKey);
        capturedProof = JSON.stringify({ nonce, ciphertext });

        const resume1: SrpSessionResume = {
          type: "srp_resume",
          identity: TEST_USERNAME,
          sessionId,
          proof: capturedProof,
        };
        ws2.send(JSON.stringify(resume1));

        await waitForMessage<SrpSessionResumed>(
          ws2,
          (msg): msg is SrpSessionResumed => isSrpSessionResumed(msg),
          5000,
        );
      } finally {
        await closeWebSocket(ws2);
      }

      // Second resume attempt with a fresh challenge must reject old proof.
      const ws3 = await connectWebSocket();
      try {
        const resumeInit: SrpSessionResumeInit = {
          type: "srp_resume_init",
          identity: TEST_USERNAME,
          sessionId,
          clientNonce: fixedClientNonce(0x53),
        };
        ws3.send(JSON.stringify(resumeInit));

        await waitForMessage<SrpSessionResumeChallenge>(
          ws3,
          (msg): msg is SrpSessionResumeChallenge =>
            typeof msg === "object" &&
            msg !== null &&
            (msg as { type?: string }).type === "srp_resume_challenge",
          5000,
        );

        const replayedResume: SrpSessionResume = {
          type: "srp_resume",
          identity: TEST_USERNAME,
          sessionId,
          proof: capturedProof,
        };
        ws3.send(JSON.stringify(replayedResume));

        const invalid = await waitForMessage<SrpSessionInvalid>(
          ws3,
          (msg): msg is SrpSessionInvalid => isSrpSessionInvalid(msg),
          5000,
          { allowSrpSessionInvalid: true },
        );
        expect(invalid.reason).toBe("invalid_proof");
      } finally {
        await closeWebSocket(ws3);
      }
    }, 20000);

    it("should reject replayed resume proof on the same connection after successful resume", async () => {
      const ws1 = await connectWebSocket();
      const { baseSessionKey, sessionId } =
        await performSrpHandshakeWithSession(ws1, TEST_USERNAME, TEST_PASSWORD);
      await closeWebSocket(ws1);

      const ws2 = await connectWebSocket();
      try {
        const resumeInit: SrpSessionResumeInit = {
          type: "srp_resume_init",
          identity: TEST_USERNAME,
          sessionId,
          clientNonce: fixedClientNonce(0x54),
        };
        ws2.send(JSON.stringify(resumeInit));

        const challenge = await waitForMessage<SrpSessionResumeChallenge>(
          ws2,
          (msg): msg is SrpSessionResumeChallenge =>
            typeof msg === "object" &&
            msg !== null &&
            (msg as { type?: string }).type === "srp_resume_challenge",
          5000,
        );

        const proofData = JSON.stringify({
          timestamp: Date.now(),
          sessionId,
          challenge: challenge.nonce,
        });
        const { nonce, ciphertext } = encrypt(proofData, baseSessionKey);
        const resume: SrpSessionResume = {
          type: "srp_resume",
          identity: TEST_USERNAME,
          sessionId,
          proof: JSON.stringify({ nonce, ciphertext }),
        };

        ws2.send(JSON.stringify(resume));
        const resumed = await waitForMessage<SrpSessionResumed>(
          ws2,
          (msg): msg is SrpSessionResumed => isSrpSessionResumed(msg),
          5000,
        );

        // Replay the same proof on the same socket after challenge is consumed.
        ws2.send(JSON.stringify(resume));
        const invalid = await waitForMessage<SrpSessionInvalid>(
          ws2,
          (msg): msg is SrpSessionInvalid => isSrpSessionInvalid(msg),
          5000,
          { allowSrpSessionInvalid: true },
        );
        expect(invalid.reason).toBe("invalid_proof");

        if (!resumed.transportNonce) {
          throw new Error("Expected transportNonce in SRP resume");
        }
        const resumedSessionKey = deriveTransportKey(
          baseSessionKey,
          resumed.transportNonce,
        );
        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };
        const response = await sendEncryptedRequest(
          ws2,
          resumedSessionKey,
          request,
        );
        expect(response.status).toBe(200);
      } finally {
        await closeWebSocket(ws2);
      }
    }, 20000);

    it("should reject replayed encrypted request captured before reconnect", async () => {
      const ws1 = await connectWebSocket();
      const {
        sessionKey: initialSessionKey,
        baseSessionKey,
        sessionId,
      } = await performSrpHandshakeWithSession(
        ws1,
        TEST_USERNAME,
        TEST_PASSWORD,
      );

      const replayedRequest: RelayRequest = {
        type: "request",
        id: randomUUID(),
        method: "GET",
        path: "/health",
      };
      const replayedEnvelope = encryptSequencedClientMessage(
        ws1,
        initialSessionKey,
        replayedRequest,
      );

      ws1.send(replayedEnvelope);
      const firstResponse = await waitForEncryptedResponseById(
        ws1,
        initialSessionKey,
        replayedRequest.id,
        5000,
      );
      expect(firstResponse).not.toBeNull();
      expect(firstResponse?.status).toBe(200);
      await closeWebSocket(ws1);

      const warn = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      const ws2 = await connectWebSocket();
      try {
        const resumeInit: SrpSessionResumeInit = {
          type: "srp_resume_init",
          identity: TEST_USERNAME,
          sessionId,
          clientNonce: fixedClientNonce(0x55),
        };
        ws2.send(JSON.stringify(resumeInit));
        const challenge = await waitForMessage<SrpSessionResumeChallenge>(
          ws2,
          (msg): msg is SrpSessionResumeChallenge =>
            typeof msg === "object" &&
            msg !== null &&
            (msg as { type?: string }).type === "srp_resume_challenge",
          5000,
        );

        const proofData = JSON.stringify({
          timestamp: Date.now(),
          sessionId,
          challenge: challenge.nonce,
        });
        const { nonce, ciphertext } = encrypt(proofData, baseSessionKey);
        const resume: SrpSessionResume = {
          type: "srp_resume",
          identity: TEST_USERNAME,
          sessionId,
          proof: JSON.stringify({ nonce, ciphertext }),
        };
        ws2.send(JSON.stringify(resume));

        await waitForMessage<SrpSessionResumed>(
          ws2,
          (msg): msg is SrpSessionResumed => isSrpSessionResumed(msg),
          5000,
        );

        // Replay ciphertext captured on a different connection: should fail
        // decryption and close the socket.
        const closePromise = new Promise<{ code: number; reason: string }>(
          (resolve) => {
            ws2.once("close", (code, reason) => {
              resolve({ code, reason: reason.toString() });
            });
          },
        );
        ws2.send(replayedEnvelope);
        const closeResult = await closePromise;
        expect(closeResult.code).toBe(4004);
        expect(closeResult.reason).toBe("Decryption failed");
        expect(warn).toHaveBeenCalledWith(
          "[WS Relay] Failed to decrypt binary envelope",
        );
      } finally {
        await closeWebSocket(ws2);
        warn.mockRestore();
      }

      // Reconnect again and verify fresh resume traffic works as expected.
      const ws3 = await connectWebSocket();
      try {
        const resumeInit: SrpSessionResumeInit = {
          type: "srp_resume_init",
          identity: TEST_USERNAME,
          sessionId,
          clientNonce: fixedClientNonce(0x56),
        };
        ws3.send(JSON.stringify(resumeInit));
        const challenge = await waitForMessage<SrpSessionResumeChallenge>(
          ws3,
          (msg): msg is SrpSessionResumeChallenge =>
            typeof msg === "object" &&
            msg !== null &&
            (msg as { type?: string }).type === "srp_resume_challenge",
          5000,
        );

        const proofData = JSON.stringify({
          timestamp: Date.now(),
          sessionId,
          challenge: challenge.nonce,
        });
        const { nonce, ciphertext } = encrypt(proofData, baseSessionKey);
        const resume: SrpSessionResume = {
          type: "srp_resume",
          identity: TEST_USERNAME,
          sessionId,
          proof: JSON.stringify({ nonce, ciphertext }),
        };
        ws3.send(JSON.stringify(resume));

        const resumed = await waitForMessage<SrpSessionResumed>(
          ws3,
          (msg): msg is SrpSessionResumed => isSrpSessionResumed(msg),
          5000,
        );
        if (!resumed.transportNonce) {
          throw new Error("Expected transportNonce in SRP resume");
        }
        const resumedSessionKey = deriveTransportKey(
          baseSessionKey,
          resumed.transportNonce,
        );
        const request: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };
        const response = await sendEncryptedRequest(
          ws3,
          resumedSessionKey,
          request,
        );
        expect(response.status).toBe(200);
      } finally {
        await closeWebSocket(ws3);
      }
    }, 20000);
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
        await closeWebSocket(ws);
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
        expect(response.body).toHaveProperty("resumeProtocolVersion", 3);
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);

    it("should close connection with code 4001 when plaintext message sent without auth", async () => {
      const warn = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
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
      expect(warn).toHaveBeenCalledWith(
        "[WS Relay] Received plaintext message but auth required",
      );
      warn.mockRestore();
    }, 5000);

    it("should close connection with code 4005 when plaintext message sent after auth", async () => {
      const warn = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      const ws = await connectWebSocket();

      await performSrpHandshakeV2(ws, TEST_USERNAME, TEST_PASSWORD);

      const closePromise = new Promise<{ code: number; reason: string }>(
        (resolve) => {
          ws.on("close", (code, reason) => {
            resolve({ code, reason: reason.toString() });
          });
        },
      );

      const request: RelayRequest = {
        type: "request",
        id: randomUUID(),
        method: "GET",
        path: "/health",
      };

      ws.send(JSON.stringify(request));

      const closeResult = await closePromise;
      expect(closeResult.code).toBe(4005);
      expect(closeResult.reason).toBe("Encrypted message required");
      expect(warn).toHaveBeenCalledWith(
        "[WS Relay] Received plaintext message after authentication",
      );
      warn.mockRestore();
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

        // Set up event collector for binary encrypted responses
        const events: RelayEvent[] = [];
        const eventHandler = (data: WebSocket.RawData) => {
          let decrypted: string | null = null;

          if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
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
            const event = parseDecryptedTransportMessage(decrypted);
            if (!event) return;
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
        ws.send(encryptSequencedClientMessage(ws, sessionKey, subscribe));

        // Wait for connected event
        await new Promise((resolve) => setTimeout(resolve, 500));

        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events[0].eventType).toBe("connected");
      } finally {
        await closeWebSocket(ws);
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

            const response = parseDecryptedTransportMessage(decrypted);
            if (
              response &&
              response.type === "response" &&
              response.id === request.id
            ) {
              clearTimeout(timeout);
              ws.off("message", handler);
              resolve(response);
            }
          } catch {
            // Decryption or parsing failed, keep waiting
          }
        };

        ws.on("message", handler);

        ws.send(encryptSequencedClientMessage(ws, sessionKey, request));
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
        await closeWebSocket(ws);
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
        expect(response.body).toHaveProperty("resumeProtocolVersion", 3);
      } finally {
        await closeWebSocket(ws);
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

            const event = parseDecryptedTransportMessage(decrypted);
            if (!event) return;
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
        ws.send(encryptSequencedClientMessage(ws, sessionKey, subscribe));

        // Wait for connected event
        await new Promise((resolve) => setTimeout(resolve, 2000));

        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events[0].eventType).toBe("connected");
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);

    it("should reject JSON encrypted envelopes after authentication", async () => {
      const warn = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      const ws = await connectWebSocket();

      try {
        const sessionKey = await performSrpHandshakeV2(
          ws,
          TEST_USERNAME,
          TEST_PASSWORD,
        );

        const request1: RelayRequest = {
          type: "request",
          id: randomUUID(),
          method: "GET",
          path: "/health",
        };

        const closedPromise = new Promise<{ code: number; reason: string }>(
          (resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("Timeout waiting for close")),
              5000,
            );
            ws.once("close", (code, reasonBuffer) => {
              clearTimeout(timeout);
              resolve({ code, reason: reasonBuffer.toString() });
            });
          },
        );

        const { nonce, ciphertext } = encrypt(
          JSON.stringify({ seq: 0, msg: request1 }),
          sessionKey,
        );
        ws.send(JSON.stringify({ type: "encrypted", nonce, ciphertext }));

        const closed = await closedPromise;
        expect(closed.code).toBe(4005);
        expect(closed.reason).toBe("Binary encrypted message required");
        expect(warn).toHaveBeenCalledWith(
          "[WS Relay] Received obsolete encrypted text envelope",
        );
      } finally {
        await closeWebSocket(ws);
        warn.mockRestore();
      }

      const ws2 = await connectWebSocket();
      try {
        const sessionKey = await performSrpHandshakeV2(
          ws2,
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
          ws2,
          sessionKey,
          request,
        );
        expect(response.status).toBe(200);
      } finally {
        await closeWebSocket(ws2);
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
      timeoutMs = 10000,
    ): Promise<YepMessage[]> {
      return new Promise((resolve, reject) => {
        const messages: YepMessage[] = [];
        const timeout = setTimeout(() => {
          ws.off("message", handler);
          reject(
            new Error(
              `Timed out waiting for upload_complete after ${timeoutMs}ms. Got ${messages.length} messages: [${messages.map((m) => m.type).join(", ")}]`,
            ),
          );
        }, timeoutMs);

        const handler = (data: WebSocket.RawData) => {
          let decrypted: string | null = null;

          if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
            const bytes =
              data instanceof ArrayBuffer ? new Uint8Array(data) : data;
            try {
              decrypted = decryptBinaryEnvelope(bytes, sessionKey);
            } catch {
              // Not a valid binary envelope
            }
          }

          if (!decrypted) return;

          try {
            const msg = parseDecryptedTransportMessage(decrypted);
            if (!msg) return;
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
        const startEnvelope = encryptSequencedClientMessage(
          ws,
          sessionKey,
          startMsg,
        );
        ws.send(startEnvelope);

        // Wait for start to process
        await new Promise((resolve) => setTimeout(resolve, 100));

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
        const endEnvelope = encryptSequencedClientMessage(
          ws,
          sessionKey,
          endMsg,
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
        await closeWebSocket(ws);
      }
    }, 15000);

    // Skip: Timing-sensitive test that's flaky on slow CI runners.
    // Same issue as above - message timeout races with server processing.
    it.skip("should upload larger file with multiple encrypted binary chunks", async () => {
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
        ws.send(encryptSequencedClientMessage(ws, sessionKey, startMsg));

        await new Promise((resolve) => setTimeout(resolve, 100));

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
        }

        // Send encrypted upload_end
        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        ws.send(encryptSequencedClientMessage(ws, sessionKey, endMsg));

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
        await closeWebSocket(ws);
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
        await closeWebSocket(ws);
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
        ws.send(encryptSequencedClientMessage(ws, sessionKey, startMsg));

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
        ws.send(encryptSequencedClientMessage(ws, sessionKey, endMsg));

        // Wait for completion
        const messages = await messagesPromise;

        expect(messages.length).toBeGreaterThanOrEqual(1);
        const lastMsg = messages[messages.length - 1];
        expect(lastMsg.type).toBe("upload_complete");

        const completeMsg = lastMsg as RelayUploadComplete;
        expect(completeMsg.file.size).toBe(fileSize);
      } finally {
        await closeWebSocket(ws);
      }
    }, 15000);
  });
});
