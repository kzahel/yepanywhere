import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { upgradeWebSocket } from "@hono/node-server";
import { WebSocketServer } from "ws";
import type {
  RelayRequest,
  RelayResponse,
  RelaySubscribe,
  YepMessage,
} from "@yep-anywhere/shared";
import { decodeJsonFrame, encodeJsonFrame } from "@yep-anywhere/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../setup/create-app.js";
import { AuthService } from "../../src/auth/AuthService.js";
import { LimitedUsersService } from "../../src/auth/LimitedUsersService.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/routes.js";
import { attachUnifiedUpgradeHandler } from "../../src/frontend/index.js";
import { RemoteAccessService } from "../../src/remote-access/index.js";
import { createWsRelayRoutes } from "../../src/routes/ws-relay.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import { UploadManager } from "../../src/uploads/manager.js";
import { EventBus } from "../../src/watcher/index.js";

/**
 * A limited user who logs in directly and opens `/api/ws` keeps their own
 * authority: the socket's login decides who acts, not the headers a client
 * puts on a tunneled request. topics/limited-users.md § Delivery v1 —
 * Authorization.
 */
describe("WebSocket limited-user login E2E", () => {
  let testDir: string;
  let server: ReturnType<typeof serve>;
  let serverPort: number;
  let limitedCookie: string;
  let superuserCookie: string;
  let serverSettingsService: ServerSettingsService;
  let eventBus: EventBus;

  beforeAll(async () => {
    testDir = join(tmpdir(), `ws-limited-user-test-${randomUUID()}`);
    const dataDir = join(testDir, "data");
    await mkdir(dataDir, { recursive: true });

    const authService = new AuthService({
      dataDir,
      cookieSecret: "ws-limited-user-cookie-secret",
    });
    await authService.initialize();
    await authService.enableAuth("superuser-password");
    superuserCookie = `${SESSION_COOKIE_NAME}=${await authService.createSession("superuser")}`;
    limitedCookie = `${SESSION_COOKIE_NAME}=${await authService.createSession("bob", "bob")}`;

    const limitedUsersService = new LimitedUsersService({ dataDir });
    await limitedUsersService.initialize();
    await limitedUsersService.create({
      username: "bob",
      password: "correct-horse-battery",
      viewProjects: ["granted-project"],
      joinProjects: [],
      joinStaleOffsetMinutes: 0,
    });

    serverSettingsService = new ServerSettingsService({ dataDir });
    await serverSettingsService.initialize();
    await serverSettingsService.updateSettings({ limitedUsersEnabled: true });

    const remoteAccessService = new RemoteAccessService({ dataDir });
    await remoteAccessService.initialize();
    await remoteAccessService.setRelayConfig({
      url: "wss://test-relay.example.com/ws",
      username: "owner",
    });
    await remoteAccessService.configure("owner-remote-password");

    eventBus = new EventBus();
    const { app, supervisor, authorizeSubscription, activityEventForIdentity } =
      createApp({
        provider: new ScriptedClaudeProvider(),
        projectsDir: testDir,
        eventBus,
        authService,
        authDisabled: false,
        limitedUsersService,
        serverSettingsService,
        remoteAccessService,
      });

    const wss = new WebSocketServer({ noServer: true });
    const wsRelayHandler = createWsRelayRoutes({
      upgradeWebSocket,
      app,
      baseUrl: "http://localhost:0",
      supervisor,
      eventBus,
      uploadManager: new UploadManager({
        uploadsDir: join(testDir, "uploads"),
      }),
      remoteAccessService,
      authorizeSubscription,
      activityEventForIdentity,
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

  function connectWebSocket(cookie: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${serverPort}/api/ws`, {
        headers: { Cookie: cookie },
      });
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
    });
  }

  function awaitResponse(
    ws: WebSocket,
    id: string,
    frame: RelayRequest | RelaySubscribe,
  ): Promise<RelayResponse> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for WS response")),
        5000,
      );
      const onMessage = (data: WebSocket.RawData) => {
        try {
          const msg: YepMessage =
            typeof data === "string"
              ? (JSON.parse(data) as YepMessage)
              : decodeJsonFrame<YepMessage>(data as Buffer);
          if (msg.type === "response" && msg.id === id) {
            clearTimeout(timeout);
            ws.off("message", onMessage);
            resolve(msg);
          }
        } catch {
          // Ignore unrelated frames
        }
      };
      ws.on("message", onMessage);
      ws.send(encodeJsonFrame(frame));
    });
  }

  function tunnel(
    ws: WebSocket,
    path: string,
    headers?: Record<string, string>,
  ): Promise<RelayResponse> {
    const request: RelayRequest = {
      type: "request",
      id: randomUUID(),
      method: "GET",
      path,
      ...(headers ? { headers } : {}),
    };
    return awaitResponse(ws, request.id, request);
  }

  it("keeps a tunneled request that sends no cookie within the limited login", async () => {
    const ws = await connectWebSocket(limitedCookie);
    try {
      // User administration is the superuser's alone.
      expect((await tunnel(ws, "/api/users")).status).toBe(403);
    } finally {
      ws.close();
    }
  });

  it("ignores a superuser session cookie a limited socket puts on a request", async () => {
    const ws = await connectWebSocket(limitedCookie);
    try {
      const response = await tunnel(ws, "/api/users", {
        Cookie: superuserCookie,
      });
      expect(response.status).toBe(403);
    } finally {
      ws.close();
    }
  });

  it("refuses a session subscription outside the limited login's grants", async () => {
    const ws = await connectWebSocket(limitedCookie);
    try {
      const subscriptionId = randomUUID();
      const response = await awaitResponse(ws, subscriptionId, {
        type: "subscribe",
        subscriptionId,
        channel: "session",
        sessionId: "some-other-users-session",
      });
      expect(response.status).toBe(403);
    } finally {
      ws.close();
    }
  });

  it("judges a session subscription by its session, not a granted projectId beside it", async () => {
    const ws = await connectWebSocket(limitedCookie);
    try {
      const subscribe = (frame: Omit<RelaySubscribe, "subscriptionId">) => {
        const subscriptionId = randomUUID();
        return awaitResponse(ws, subscriptionId, {
          ...frame,
          subscriptionId,
        } as RelaySubscribe);
      };
      // Each channel reads the session it names; a granted projectId riding
      // along opens nothing.
      expect(
        (
          await subscribe({
            type: "subscribe",
            channel: "session",
            sessionId: "some-other-users-session",
            projectId: "granted-project",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await subscribe({
            type: "subscribe",
            channel: "session-watch",
            sessionId: "some-other-users-session",
            projectId: "granted-project",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await subscribe({
            type: "subscribe",
            channel: "/api/experimental/conversation/subscribe",
            projectId: "granted-project",
            query: {
              sessionId: "some-other-users-session",
              maxMessages: 10,
              anchorMessageId: null,
            },
          })
        ).status,
      ).toBe(403);
      // A channel this server does not know grants a limited login nothing.
      expect(
        (
          await subscribe({
            type: "subscribe",
            channel: "not-a-channel" as RelaySubscribe["channel"],
            projectId: "granted-project",
          })
        ).status,
      ).toBe(403);
      // A project channel on a granted project stays open to the login.
      expect(
        (
          await subscribe({
            type: "subscribe",
            channel: "glossary",
            projectId: "granted-project",
          })
        ).status,
      ).not.toBe(403);
    } finally {
      ws.close();
    }
  });

  it("delivers a limited login only the activity events of its projects", async () => {
    const ws = await connectWebSocket(limitedCookie);
    try {
      const subscriptionId = randomUUID();
      const received: Array<{ eventType: string; data: unknown }> = [];
      let onEvent = () => {};
      ws.on("message", (raw: WebSocket.RawData) => {
        const msg: YepMessage =
          typeof raw === "string"
            ? (JSON.parse(raw) as YepMessage)
            : decodeJsonFrame<YepMessage>(raw as Buffer);
        if (msg.type !== "event" || msg.subscriptionId !== subscriptionId) {
          return;
        }
        received.push({ eventType: msg.eventType, data: msg.data });
        onEvent();
      });
      const waitFor = (eventType: string) =>
        new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () =>
              reject(
                new Error(
                  `Timed out waiting for ${eventType}; received ${received
                    .map((event) => event.eventType)
                    .join(", ")}`,
                ),
              ),
            4000,
          );
          onEvent = () => {
            if (received.some((event) => event.eventType === eventType)) {
              clearTimeout(timeout);
              resolve();
            }
          };
          onEvent();
        });

      ws.send(
        encodeJsonFrame({
          type: "subscribe",
          subscriptionId,
          channel: "activity",
        } satisfies RelaySubscribe),
      );
      await waitFor("connected");

      const timestamp = new Date().toISOString();
      eventBus.emit({
        type: "session-created",
        session: {
          id: "other-session",
          projectId: "other-project",
          title: "Other project's secret title",
        } as never,
        timestamp,
      });
      eventBus.emit({
        type: "file-change",
        provider: "claude",
        path: "/home/owner/.claude/projects/other/other-session.jsonl",
        relativePath: "projects/other/other-session.jsonl",
        changeType: "modify",
        fileType: "session",
        timestamp,
      });
      eventBus.emit({
        type: "session-metadata-changed",
        sessionId: "unknown-session",
        title: "Unattributed title",
        timestamp,
      });
      eventBus.emit({
        type: "projects-changed",
        projectIds: ["other-project", "granted-project"],
        timestamp,
      });
      eventBus.emit({
        type: "process-state-changed",
        sessionId: "granted-session",
        projectId: "granted-project" as never,
        activity: "idle",
        timestamp,
      });
      await waitFor("process-state-changed");

      // Startup catalog refreshes may also arrive; judge only what was sent.
      const emittedTypes = new Set([
        "session-created",
        "file-change",
        "session-metadata-changed",
        "projects-changed",
        "process-state-changed",
      ]);
      const delivered = received.filter((event) =>
        emittedTypes.has(event.eventType),
      );
      expect(delivered.map((event) => event.eventType)).toEqual([
        "projects-changed",
        "process-state-changed",
      ]);
      expect(delivered[0]?.data).toMatchObject({
        projectIds: ["granted-project"],
      });
    } finally {
      ws.close();
    }
  });

  it("leaves a superuser login's socket unrestricted", async () => {
    const ws = await connectWebSocket(superuserCookie);
    try {
      expect((await tunnel(ws, "/api/users")).status).toBe(200);
    } finally {
      ws.close();
    }
  });

  it("refuses a live limited login once the feature is turned off", async () => {
    const ws = await connectWebSocket(limitedCookie);
    await serverSettingsService.updateSettings({ limitedUsersEnabled: false });
    try {
      // Turning the feature off must lock bob out, not make him the superuser.
      expect((await tunnel(ws, "/api/users")).status).toBe(401);
      const subscriptionId = randomUUID();
      const subscription = await awaitResponse(ws, subscriptionId, {
        type: "subscribe",
        subscriptionId,
        channel: "activity",
      });
      expect(subscription.status).toBe(403);

      const direct = await fetch(`http://localhost:${serverPort}/api/users`, {
        headers: { Cookie: limitedCookie, "X-Yep-Anywhere": "true" },
      });
      expect(direct.status).toBe(401);
      await expect(connectWebSocket(limitedCookie)).rejects.toThrow();

      const owner = await fetch(`http://localhost:${serverPort}/api/users`, {
        headers: { Cookie: superuserCookie, "X-Yep-Anywhere": "true" },
      });
      expect(owner.status).toBe(200);
    } finally {
      ws.close();
      await serverSettingsService.updateSettings({ limitedUsersEnabled: true });
    }
  });
});
