import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type {
  RelayRequest,
  RelayResponse,
  YepMessage,
} from "@yep-anywhere/shared";
import { decodeJsonFrame } from "@yep-anywhere/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../setup/create-app.js";
import { attachUnifiedUpgradeHandler } from "../../src/frontend/index.js";
import { RemoteAccessService } from "../../src/remote-access/index.js";
import { createWsRelayRoutes } from "../../src/routes/ws-relay.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { UploadManager } from "../../src/uploads/manager.js";
import { EventBus } from "../../src/watcher/index.js";

describe("WebSocket Loopback Policy E2E", () => {
  let testDir: string;
  let server: ReturnType<typeof serve>;
  let serverPort: number;
  let mockSdk: ScriptedClaudeProvider;
  let eventBus: EventBus;

  beforeAll(async () => {
    testDir = join(tmpdir(), `ws-loopback-policy-test-${randomUUID()}`);
    const projectPath = "/home/user/testproject";
    const encodedPath = projectPath.replaceAll("/", "-");

    await mkdir(join(testDir, "localhost", encodedPath), { recursive: true });
    await writeFile(
      join(testDir, "localhost", encodedPath, "test-session.jsonl"),
      `{"type":"user","cwd":"${projectPath}","message":{"content":"Hello"}}\n`,
    );

    mockSdk = new ScriptedClaudeProvider();
    eventBus = new EventBus();

    const dataDir = join(testDir, "data");
    await mkdir(dataDir, { recursive: true });

    const remoteAccessService = new RemoteAccessService({ dataDir });
    await remoteAccessService.initialize();
    await remoteAccessService.setRelayConfig({
      url: "wss://test-relay.example.com/ws",
      username: "loopback-test-user",
    });
    await remoteAccessService.configure("loopback-test-password");

    const { app, supervisor } = createApp({
      provider: mockSdk,
      projectsDir: testDir,
      eventBus,
    });

    const { upgradeWebSocket, wss } = createNodeWebSocket({ app });
    const uploadManager = new UploadManager({
      uploadsDir: join(testDir, "uploads"),
    });
    const wsRelayHandler = createWsRelayRoutes({
      upgradeWebSocket,
      app,
      baseUrl: "http://localhost:0",
      supervisor,
      eventBus,
      uploadManager,
      remoteAccessService,
    });
    app.get("/api/ws", wsRelayHandler);

    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      serverPort = info.port;
    });
    attachUnifiedUpgradeHandler(server, {
      frontendProxy: undefined,
      isApiPath: (urlPath) => urlPath.startsWith("/api"),
      app,
      wss,
    });

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
        () => reject(new Error("Timed out waiting for WS response")),
        5000,
      );

      const onMessage = (data: WebSocket.RawData) => {
        try {
          let msg: YepMessage;
          if (typeof data === "string") {
            msg = JSON.parse(data) as YepMessage;
          } else {
            try {
              msg = JSON.parse(data.toString()) as YepMessage;
            } catch {
              msg = decodeJsonFrame<YepMessage>(data);
            }
          }
          if (msg.type === "response" && msg.id === request.id) {
            clearTimeout(timeout);
            ws.off("message", onMessage);
            ws.off("close", onClose);
            resolve(msg);
          }
        } catch {
          // Ignore unrelated frames
        }
      };

      const onClose = (_code: number, reason: Buffer) => {
        clearTimeout(timeout);
        ws.off("message", onMessage);
        reject(new Error(`WebSocket closed: ${reason.toString()}`));
      };

      ws.on("message", onMessage);
      ws.on("close", onClose);
      ws.send(JSON.stringify(request));
    });
  }

  it("allows localhost plaintext WS when remote access is enabled", async () => {
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
});
