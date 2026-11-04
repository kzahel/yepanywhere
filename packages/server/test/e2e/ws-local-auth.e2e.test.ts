import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { upgradeWebSocket } from "@hono/node-server";
import { WebSocketServer } from "ws";
import type {
  RelayRequest,
  RelayResponse,
  YepMessage,
} from "@yep-anywhere/shared";
import { decodeJsonFrame, encodeJsonFrame } from "@yep-anywhere/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../setup/create-app.js";
import { AuthService } from "../../src/auth/AuthService.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/routes.js";
import { attachUnifiedUpgradeHandler } from "../../src/frontend/index.js";
import { RemoteAccessService } from "../../src/remote-access/index.js";
import { createWsRelayRoutes } from "../../src/routes/ws-relay.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { UploadManager } from "../../src/uploads/manager.js";
import { EventBus } from "../../src/watcher/index.js";

describe("WebSocket Local Cookie Auth E2E", () => {
  let testDir: string;
  let server: ReturnType<typeof serve>;
  let serverPort: number;
  let cookieHeader: string;
  let mockSdk: ScriptedClaudeProvider;
  let eventBus: EventBus;

  beforeAll(async () => {
    testDir = join(tmpdir(), `ws-local-auth-test-${randomUUID()}`);
    const projectPath = "/home/user/testproject";
    const encodedPath = projectPath.replaceAll("/", "-");

    await mkdir(join(testDir, "localhost", encodedPath), { recursive: true });
    await writeFile(
      join(testDir, "localhost", encodedPath, "test-session.jsonl"),
      `{"type":"user","cwd":"${projectPath}","message":{"content":"Hello"}}\n`,
    );

    const dataDir = join(testDir, "data");
    await mkdir(dataDir, { recursive: true });

    mockSdk = new ScriptedClaudeProvider();
    eventBus = new EventBus();

    const authService = new AuthService({
      dataDir,
      cookieSecret: "ws-local-auth-cookie-secret",
    });
    await authService.initialize();
    await authService.enableAuth("local-auth-password");
    const sessionId = await authService.createSession("ws-local-auth-test");
    cookieHeader = `${SESSION_COOKIE_NAME}=${sessionId}`;

    const remoteAccessService = new RemoteAccessService({ dataDir });
    await remoteAccessService.initialize();
    await remoteAccessService.setRelayConfig({
      url: "wss://test-relay.example.com/ws",
      username: "local-auth-user",
    });
    await remoteAccessService.configure("local-auth-remote-password");

    const { app, supervisor } = createApp({
      provider: mockSdk,
      projectsDir: testDir,
      eventBus,
      authService,
      authDisabled: false,
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
      remoteAccessService,
    });
    app.get("/api/ws", wsRelayHandler);

    server = serve(
      { fetch: app.fetch, websocket: { server: wss }, port: 0 },
      (info) => {
        serverPort = info.port;
      },
    );
    attachUnifiedUpgradeHandler(server, {
      frontendProxy: undefined,
      isApiPath: (urlPath) => urlPath.startsWith("/api"),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  });

  afterAll(async () => {
    server?.close();
    await rm(testDir, { recursive: true, force: true });
  });

  function connectWebSocket(cookie?: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${serverPort}/api/ws`, {
        headers: cookie ? { Cookie: cookie } : undefined,
      });
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
    });
  }

  it("rejects unauthenticated localhost websocket upgrade", async () => {
    await expect(connectWebSocket()).rejects.toThrow(
      /Unexpected server response/,
    );
  });

  it("allows cookie-authenticated localhost websocket without SRP handshake", async () => {
    const ws = await connectWebSocket(cookieHeader);
    const request: RelayRequest = {
      type: "request",
      id: randomUUID(),
      method: "GET",
      path: "/health",
    };

    const response = await new Promise<RelayResponse>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for WS response")),
        5000,
      );

      ws.on("message", (data) => {
        try {
          const msg: YepMessage =
            typeof data === "string"
              ? (JSON.parse(data) as YepMessage)
              : decodeJsonFrame<YepMessage>(data);
          if (msg.type === "response" && msg.id === request.id) {
            clearTimeout(timeout);
            resolve(msg);
          }
        } catch {
          // Ignore unrelated frames
        }
      });

      ws.send(encodeJsonFrame(request));
    });

    expect(response.status).toBe(200);
    ws.close();
  });
});
