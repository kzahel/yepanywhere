import WebSocket from "ws";
import { SRPClientSession, SRPRoutines, SRPParameters } from "tssrp6a";
import { afterEach, expect, it } from "vitest";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { attachUnifiedUpgradeHandler } from "../../src/frontend/index.js";
import { Hono } from "hono";

import type { HttpBindings } from "@hono/node-server";
import {
  createAcceptRelayConnection,
  createWsRelayRoutes,
} from "../../src/routes/ws-relay.js";
import { createPeerManagementRoutes } from "../../src/peer-api/routes.js";
import { getAuthenticatedSrpTransport } from "../../src/middleware/authenticated-transport.js";
import { RemoteAccessService } from "../../src/remote-access/RemoteAccessService.js";
import { RemoteSessionService } from "../../src/remote-access/RemoteSessionService.js";
import { PeerConnections } from "../../src/peer-api/connections.js";
import { PeerOwnerClient } from "../../src/peer-api/owner-client.js";
import { RelayClientService } from "../../src/services/RelayClientService.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import { UploadManager } from "../../src/uploads/manager.js";
import { CoreApiError } from "../../src/core-api/errors.js";
import { createRelayServer } from "../../../relay/src/server.js";
import { protectedProfile, nativeRequest } from "./peer-fixture.js";
import { createAgentApiRuntime } from "../../src/agent-api/runtime.js";
import { SUPERUSER } from "../../src/auth/principal.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function ownerProfile(runtimeControl?: { envOverride?: boolean }) {
  const profile = await protectedProfile(cleanup, {
    ...(runtimeControl ? { runtimeControl } : {}),
  });
  const access = new RemoteAccessService({ dataDir: profile.directory });
  await access.initialize();
  await access.setRelayConfig({
    url: "ws://127.0.0.1:1/ws",
    username: "owner-pair-test",
  });
  await access.configure("pair-test-password");
  const sessions = new RemoteSessionService({ dataDir: profile.directory });
  await sessions.initialize();
  cleanup.push(() => sessions.shutdown());
  const app = new Hono<{ Bindings: HttpBindings }>();
  const binding = (c: Parameters<typeof getAuthenticatedSrpTransport>[0]) =>
    getAuthenticatedSrpTransport(c)?.sessionId ?? null;
  app.route(
    "/api/peers",
    createPeerManagementRoutes(
      profile.manager,
      async (c) => getAuthenticatedSrpTransport(c.env)?.isActive?.() === true,
      (c) => binding(c.env),
      async (c) => {
        const context = getAuthenticatedSrpTransport(c.env)!;
        await sessions.deleteSession(context.sessionId);
        context.closeAfterResponse();
      },
    ),
  );
  // These ports are deliberately unreachable: pairing must not subscribe to
  // providers, upload files, or start the full app/scanner to authenticate.
  const deps = {
    app,
    baseUrl: "http://127.0.0.1",
    remoteAccessService: access,
    remoteSessionService: sessions,
    eventBus: new EventBus(),
    uploadManager: new UploadManager({ uploadsDir: profile.directory }),
    supervisor: new Proxy(
      {},
      {
        get() {
          throw new Error("Pairing touched the provider supervisor");
        },
      },
    ) as Parameters<typeof createAcceptRelayConnection>[0]["supervisor"],
  };
  const accept = createAcceptRelayConnection(deps);
  const { upgradeWebSocket, wss } = createNodeWebSocket({ app });
  app.get("/api/ws", createWsRelayRoutes({ ...deps, upgradeWebSocket }));
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  attachUnifiedUpgradeHandler(server, {
    app,
    wss,
    isApiPath: (path) => path.startsWith("/api"),
    peerUpgrade: (req, socket, head) =>
      profile.manager.handleUpgrade(req, socket, head),
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No server");
  cleanup.push(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    ...profile,
    route: {
      kind: "direct" as const,
      url: `ws://127.0.0.1:${address.port}/peer/ws`,
    },
    access,
    sessions,
    accept,
    ownerRoute: {
      kind: "direct" as const,
      url: `ws://127.0.0.1:${address.port}/api/ws`,
    },
  };
}
const guard = () => {};
it("pairs through real ordinary SRP, verifies both directions and preserves peer access across owner-password changes", async () => {
  const a = await ownerProfile(),
    b = await ownerProfile(),
    controller = new PeerConnections(a.manager);
  const result = await controller.connect(
    {
      route: b.ownerRoute,
      username: "owner-pair-test",
      password: "pair-test-password",
      bidirectional: true,
      returnRoute: a.route,
    },
    guard,
    AbortSignal.timeout(10_000),
  );
  expect(result.issue).toBeUndefined();
  expect(result).toMatchObject({
    outcome: "connected",
    outgoing: "confirmed",
    incoming: "confirmed",
    ownerSessionCleanup: "confirmed",
  });
  expect(b.sessions.listSessions()).toHaveLength(0);
  b.addProject("created-after-pairing");
  expect(await a.read("projects", { serverId: b.id })).toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({ id: "created-after-pairing" }),
    ]),
  });
  expect(a.manager.store.read().incoming[0]?.allProjects).toBe(true);
  const access = await a.read("access", { serverId: b.id });
  expect(access).toMatchObject({ scope: "all-projects" });
  const created = await a.router.read("createSession", SUPERUSER, {
    serverId: b.id,
    ownerAuthenticated: true,
    body: {
      requestId: "connection-test-create",
      projectId: "p",
      provider: "codex",
      message: "Review through UI-created credentials",
    },
  });
  expect(created).toMatchObject({ state: "dispatching" });
  await expect
    .poll(() => b.receipts.get((created as { id: string }).id)?.sessionId)
    .toBe("created-1");
  const observed = (await a.read("followReceipt", {
    serverId: b.id,
    receiptId: (created as { id: string }).id,
    query: { waitMs: "0" },
  })) as { receipt: { sessionId: string } };
  await a.read("sendMessage", {
    serverId: b.id,
    sessionId: observed.receipt.sessionId,
    body: { requestId: "pair-message-test", message: "Please continue" },
  });
  expect(b.sends()).toBe(1);
  expect(
    await a.read("conversation", {
      serverId: b.id,
      sessionId: observed.receipt.sessionId,
    }),
  ).toBeTruthy();
  expect(b.manager.connectionActivity(a.id).incoming).toHaveLength(1);
  expect(a.manager.connectionActivity(b.id).outgoing).toHaveLength(1);
  await b.access.configure("changed-owner-password");
  await controller.test(b.id, guard, AbortSignal.timeout(5000));
  const incoming = a.manager.store.read().incoming[0]!;
  await controller.remove(
    b.id,
    "incoming",
    incoming.id,
    incoming.generation,
    guard,
  );
  await expect(b.read("access", { serverId: a.id })).rejects.toBeInstanceOf(
    CoreApiError,
  );
  expect(await a.read("access", { serverId: b.id })).toBeTruthy();
  const stateText = JSON.stringify(controller.overview());
  expect(stateText).not.toContain("pair-test-password");
  expect(stateText).not.toContain('"secret"');
  expect(stateText).toContain('"hostname"');
}, 15_000);
it("uses a real relay for owner login and dedicated bidirectional peer registrations", async () => {
  const relay = await createRelayServer({
    inMemoryDb: true,
    disableTelemetry: true,
    logLevel: "silent",
    disablePrettyPrint: true,
    webSocketMaxMessageBytes: 384 * 1024,
  });
  cleanup.push(() => relay.close());
  const a = await ownerProfile(),
    b = await ownerProfile(),
    url = `ws://127.0.0.1:${relay.port}/ws`;
  const ownerRelay = new RelayClientService();
  cleanup.push(() => ownerRelay.stop());
  ownerRelay.start({
    relayUrl: url,
    username: "owner-pair-test",
    installId: b.id,
    onRelayConnection: b.accept,
  });
  await expect.poll(() => ownerRelay.getState().status).toBe("waiting");
  const result = await new PeerConnections(a.manager).connect(
    {
      route: { kind: "relay", url, username: "owner-pair-test" },
      username: "owner-pair-test",
      password: "pair-test-password",
      bidirectional: true,
    },
    guard,
    AbortSignal.timeout(15_000),
  );
  expect(result.issue).toBeUndefined();
  expect(result).toMatchObject({
    outcome: "connected",
    incoming: "confirmed",
    ownerSessionCleanup: "confirmed",
  });
  expect(a.manager.store.read().relay?.username).not.toBe("owner-pair-test");
  expect(b.manager.store.read().relay?.username).not.toBe("owner-pair-test");
  expect(await a.read("access", { serverId: b.id })).toBeTruthy();
  expect(await b.read("access", { serverId: a.id })).toBeTruthy();
}, 20_000);
it("refuses wrong identity/self pairing and cleans only its own owner session", async () => {
  const a = await ownerProfile(),
    b = await ownerProfile();
  const existing = await b.sessions.createSession(
    "owner-pair-test",
    new Uint8Array(32),
  );
  await expect(
    new PeerConnections(a.manager).connect(
      {
        route: b.ownerRoute,
        username: "owner-pair-test",
        password: "pair-test-password",
        expectedServerId: a.id,
      },
      guard,
      AbortSignal.timeout(5000),
    ),
  ).rejects.toMatchObject({ code: "peer_identity_mismatch" });
  expect(b.sessions.listSessions().map((s) => s.sessionId)).toEqual([existing]);
  expect(b.manager.store.read().incoming).toHaveLength(0);
  await expect(
    new PeerConnections(a.manager).connect(
      {
        route: a.ownerRoute,
        username: "owner-pair-test",
        password: "pair-test-password",
      },
      guard,
      AbortSignal.timeout(5000),
    ),
  ).rejects.toMatchObject({ code: "peer_identity_mismatch" });
  expect(a.manager.store.read().incoming).toHaveLength(0);
  const client = new PeerOwnerClient(b.ownerRoute, guard);
  await client.connect(
    "owner-pair-test",
    "pair-test-password",
    AbortSignal.timeout(5000),
  );
  await expect(
    client.request(`/api/remote-access/sessions/${existing}`, "DELETE"),
  ).rejects.toMatchObject({ code: "invalid_request" });
  await client.close();
}, 10_000);

it("adds and renews the reverse direction without rotating the working outgoing credential", async () => {
  const a = await ownerProfile(),
    b = await ownerProfile(),
    controller = new PeerConnections(a.manager);
  const credentials = {
    route: b.ownerRoute,
    username: "owner-pair-test",
    password: "pair-test-password",
  };
  expect(
    await controller.connect(credentials, guard, AbortSignal.timeout(5000)),
  ).toMatchObject({ outcome: "connected" });
  const outgoing = structuredClone(a.manager.store.read().outgoing[0]);
  expect(
    await controller.connect(
      {
        ...credentials,
        expectedServerId: b.id,
        direction: "incoming",
        returnRoute: a.route,
      },
      guard,
      AbortSignal.timeout(5000),
    ),
  ).toMatchObject({
    outcome: "connected",
    outgoing: "unchanged",
    incoming: "confirmed",
  });
  expect(a.manager.store.read().outgoing[0]).toEqual(outgoing);
  expect(
    await controller.connect(
      {
        ...credentials,
        expectedServerId: b.id,
        direction: "incoming",
        returnRoute: a.route,
        replace: true,
      },
      guard,
      AbortSignal.timeout(5000),
    ),
  ).toMatchObject({ outcome: "connected" });
  expect(a.manager.store.read().incoming[0]?.generation).toBe(2);
  expect(a.manager.store.read().outgoing[0]).toEqual(outgoing);
  expect(
    await controller.connect(
      { ...credentials, expectedServerId: b.id, replace: true },
      guard,
      AbortSignal.timeout(5000),
    ),
  ).toMatchObject({ outcome: "connected" });
  expect(a.manager.store.read().outgoing[0]?.invitation.generation).toBe(2);
}, 15_000);
it("fences runtime disable and owner logout during pending setup without publishing or re-enabling", async () => {
  const a = await ownerProfile({}),
    b = await ownerProfile(),
    controller = new PeerConnections(a.manager);
  expect(a.manager.isEnabled()).toBe(false);
  let owner = true;
  const started = controller.connect(
    {
      route: b.ownerRoute,
      username: "owner-pair-test",
      password: "pair-test-password",
    },
    () => {
      if (!owner) throw new CoreApiError("forbidden", "Owner logged out", 403);
    },
    AbortSignal.timeout(5000),
  );
  await a.manager.setEnabled(false);
  owner = false;
  await expect(started).rejects.toBeInstanceOf(CoreApiError);
  expect(a.manager.isEnabled()).toBe(false);
  expect(a.manager.store.read().outgoing).toHaveLength(0);
  expect(b.manager.store.read().incoming).toHaveLength(0);
  owner = true;
  expect(
    await controller.connect(
      {
        route: b.ownerRoute,
        username: "owner-pair-test",
        password: "pair-test-password",
      },
      guard,
      AbortSignal.timeout(5000),
    ),
  ).toMatchObject({ outcome: "connected" });
  await a.manager.setEnabled(false);
  await expect(a.read("access", { serverId: b.id })).rejects.toBeInstanceOf(
    CoreApiError,
  );
  await expect(
    a.manager.issue({
      sourceServerId: b.id,
      allProjects: true,
      projects: [],
      operations: ["access"],
      expiresAt: Date.now() + 10000,
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
  await a.manager.setEnabled(true);
  expect(await a.read("access", { serverId: b.id })).toBeTruthy();
}, 10_000);
it("invalid routes do not consume setup capacity and failed reverse reachability preserves the first leg", async () => {
  const a = await ownerProfile(),
    b = await ownerProfile(),
    controller = new PeerConnections(a.manager);
  for (let n = 0; n < 5; n++)
    await expect(
      controller.connect(
        {
          route: { kind: "direct", url: "ftp://localhost/" },
          username: "owner-pair-test",
          password: "pair-test-password",
        },
        guard,
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  const result = await controller.connect(
    {
      route: b.ownerRoute,
      username: "owner-pair-test",
      password: "pair-test-password",
      bidirectional: true,
      returnRoute: { kind: "direct", url: "ws://127.0.0.1:1/peer/ws" },
    },
    guard,
    AbortSignal.timeout(5000),
  );
  expect(result).toMatchObject({
    outcome: "partial",
    outgoing: "confirmed",
    incoming: "unknown",
  });
  expect(await a.read("access", { serverId: b.id })).toBeTruthy();
  expect(a.manager.store.read().incoming).toHaveLength(1);
  expect(b.manager.store.read().outgoing).toHaveLength(0);
}, 10_000);

it("rejects target policy changes between bootstrap and grant without undoing disable", async () => {
  const a = await ownerProfile(),
    b = await ownerProfile({});
  const controller = new PeerConnections(b.manager),
    before = controller.bootstrap(a.id);
  await b.manager.setEnabled(false);
  await expect(
    controller.grant(
      {
        identity: a.manager.identity(),
        operationId: crypto.randomUUID(),
        expectedPolicyRevision: before.policyRevision,
        expectedCredential: null,
      },
      guard,
      AbortSignal.timeout(5000),
    ),
  ).rejects.toMatchObject({ code: "peer_record_conflict" });
  expect(b.manager.isEnabled()).toBe(false);
  expect(b.manager.store.read().incoming).toHaveLength(0);
});
it("preserves scoped read-only grants during owner renewal", async () => {
  const a = await ownerProfile(),
    b = await ownerProfile(),
    controller = new PeerConnections(a.manager);
  await b.manager.issue({
    sourceServerId: a.id,
    projects: ["p"],
    operations: ["projects"],
    expiresAt: Date.now() + 60000,
  });
  const result = await controller.connect(
    {
      route: b.ownerRoute,
      username: "owner-pair-test",
      password: "pair-test-password",
      expectedServerId: b.id,
      replace: true,
    },
    guard,
    AbortSignal.timeout(5000),
  );
  expect(result.outcome).toBe("connected");
  expect(b.manager.store.read().incoming[0]).toMatchObject({
    projects: ["p"],
    operations: ["server", "access", "capabilities", "projects"],
  });
  expect(b.manager.store.read().incoming[0]?.allProjects).toBeUndefined();
  await expect(
    a.read("createSession", {
      serverId: b.id,
      body: {
        requestId: "read-only-no-create",
        projectId: "p",
        provider: "codex",
        message: "Not authorized",
      },
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
}, 10_000);

it("lets a qualified native session create, message and follow through owner-paired credentials with provenance", async () => {
  const a = await ownerProfile({}),
    b = await ownerProfile({});
  expect(
    await new PeerConnections(a.manager).connect(
      {
        route: b.ownerRoute,
        username: "owner-pair-test",
        password: "pair-test-password",
      },
      guard,
      AbortSignal.timeout(5000),
    ),
  ).toMatchObject({ outcome: "connected" });
  await a.manager.setAgentAccess({ enabled: true });
  const runtime = await createAgentApiRuntime({ serverId: a.id });
  cleanup.push(() => runtime.close());
  const detach = runtime.attachController(a.router);
  cleanup.push(detach);
  const lease = runtime.issue({
    principal: SUPERUSER,
    sessionId: () => "parent",
    management: true,
    peerAccess: true,
    peerGrantId: a.manager.agentAccess().grantId,
  });
  const token = lease.environment.AGENT_YA_V0_AUTHORIZATION!;
  const created = await nativeRequest(
    runtime,
    token,
    `/v0/servers/${b.id}/sessions`,
    {
      requestId: "paired-native-create",
      projectId: "p",
      provider: "codex",
      message: "Create through paired API",
    },
  );
  expect(created.status).toBe(202);
  expect(created.body.creator).toMatchObject({
    serverId: a.id,
    sessionId: "parent",
    authentication: { sessionAttribution: "source-attested" },
  });
  const observed = await nativeRequest(
    runtime,
    token,
    `/v0/servers/${b.id}/receipts/${created.body.id}/follow?waitMs=0`,
  );
  expect(observed.body.receipt.sessionId).toBe("created-1");
  const sent = await nativeRequest(
    runtime,
    token,
    `/v0/servers/${b.id}/sessions/created-1/messages`,
    { requestId: "paired-native-message", message: "Continue" },
  );
  expect(sent.status).toBe(202);
  const followed = await nativeRequest(
    runtime,
    token,
    `/v0/servers/${b.id}/sessions/created-1/conversation/follow?waitMs=0`,
  );
  expect(followed.status).toBe(200);
  await a.manager.setEnabled(false);
  expect(
    (await nativeRequest(runtime, token, `/v0/servers/${b.id}/access`)).status,
  ).toBe(403);
  await a.manager.setEnabled(true);
  await a.manager.setAgentAccess({ enabled: true });
  expect(
    (await nativeRequest(runtime, token, `/v0/servers/${b.id}/access`)).status,
  ).toBe(403);
  expect(await a.read("access", { serverId: b.id })).toBeTruthy();
}, 10_000);

it("preserves each server’s narrower outgoing policy independently on renewal", async () => {
  const a = await ownerProfile(),
    b = await ownerProfile(),
    controller = new PeerConnections(a.manager);
  const input = {
    route: b.ownerRoute,
    username: "owner-pair-test",
    password: "pair-test-password",
  };
  expect(
    await controller.connect(input, guard, AbortSignal.timeout(5000)),
  ).toMatchObject({ outcome: "connected" });
  await a.manager.store.mutate((next) => {
    next.outgoing[0]!.operations = [
      "server",
      "access",
      "capabilities",
      "projects",
    ];
    next.outgoing[0]!.allowAgentSessions = false;
  });
  expect(
    await controller.connect(
      { ...input, replace: true },
      guard,
      AbortSignal.timeout(5000),
    ),
  ).toMatchObject({ outcome: "connected" });
  expect(a.manager.store.read().outgoing[0]).toMatchObject({
    operations: ["server", "access", "capabilities", "projects"],
    allowAgentSessions: false,
  });
  expect(
    await controller.connect(
      { ...input, direction: "incoming", returnRoute: a.route },
      guard,
      AbortSignal.timeout(5000),
    ),
  ).toMatchObject({ outcome: "connected" });
  expect(b.manager.store.read().outgoing[0]?.operations).toContain(
    "createSession",
  );
  expect(b.manager.store.read().outgoing[0]?.allowAgentSessions).toBe(true);
  await b.manager.store.mutate((next) => {
    next.outgoing[0]!.operations = [
      "server",
      "access",
      "capabilities",
      "providers",
    ];
    next.outgoing[0]!.allowAgentSessions = false;
  });
  expect(
    await controller.connect(
      { ...input, direction: "incoming", returnRoute: a.route, replace: true },
      guard,
      AbortSignal.timeout(5000),
    ),
  ).toMatchObject({ outcome: "connected" });
  expect(b.manager.store.read().outgoing[0]).toMatchObject({
    operations: ["server", "access", "capabilities", "providers"],
    allowAgentSessions: false,
  });
  expect(a.manager.store.read().outgoing[0]).toMatchObject({
    operations: ["server", "access", "capabilities", "projects"],
    allowAgentSessions: false,
  });
}, 15_000);
it("rejects an old-password proof after credentials change during an ordinary owner handshake", async () => {
  const b = await ownerProfile();
  const step1 = await new SRPClientSession(
    new SRPRoutines(new SRPParameters()),
  ).step1("owner-pair-test", "pair-test-password");
  const ws = new WebSocket(b.ownerRoute.url);
  cleanup.push(() => ws.terminate());
  await once(ws, "open");
  const challengeReply = once(ws, "message");
  ws.send(JSON.stringify({ type: "srp_hello", identity: "owner-pair-test" }));
  const challenge = JSON.parse(String((await challengeReply)[0]));
  expect(challenge.type).toBe("srp_challenge");
  const step2 = await step1.step2(
    BigInt(`0x${challenge.salt}`),
    BigInt(`0x${challenge.B}`),
  );
  await b.access.configure("changed-during-proof");
  const closed = once(ws, "close");
  ws.send(
    JSON.stringify({
      type: "srp_proof",
      A: step2.A.toString(16),
      M1: step2.M1.toString(16),
    }),
  );
  expect((await closed)[0]).toBe(4001);
  expect(b.sessions.listSessions()).toHaveLength(0);
}, 5000);
