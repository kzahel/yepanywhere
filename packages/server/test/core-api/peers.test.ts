import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { SUPERUSER } from "../../src/auth/principal.js";
import { CoreApi, type CoreApiSources } from "../../src/core-api/service.js";
import {
  operationIds,
  type ApiLaunchContext,
  type ApiSession,
} from "../../src/core-api/contracts.js";
import {
  createConversationFollow,
  createConversationRead,
} from "../../src/core-api/conversation.js";
import { ApiReceiptStore } from "../../src/core-api/receipt-store.js";
import { SessionCommands } from "../../src/core-api/session-commands.js";
import { ConversationSubscriptions } from "../../src/experimental/conversation-subscriptions.js";
import { createV0Routes } from "../../src/routes/v0/index.js";
import { openSqliteOrThrow } from "../../src/storage/sqlite.js";
import { migrateDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import {
  PeerDirectory,
  fixturePeerGrant,
} from "../../src/peer-api/directory.js";
import { createPeerReceiver } from "../../src/peer-api/http.js";
import { PeerApiRouter } from "../../src/peer-api/router.js";
import { PeerOutboundStore } from "../../src/peer-api/outbound-store.js";
import { HttpPeerTransport } from "../../src/peer-api/transport.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const project = { id: "p", name: "Project", path: "/fixture/project" };
const body = {
  requestId: "peer-create-001",
  projectId: "p",
  provider: "codex",
  message: "Review the change",
  permissionMode: "default",
};
function fixture(id: string) {
  const database = openSqliteOrThrow(":memory:");
  migrateDiscoveryDatabase(database);
  const receipts = new ApiReceiptStore(database),
    outbound = new PeerOutboundStore(database);
  const sessions: ApiSession[] = ["parent", "private"].map((sid) => ({
    id: sid,
    projectId: sid === "private" ? "secret" : "p",
    title: sid,
    provider: "codex",
    state: "idle",
    updatedAt: "",
  }));
  let starts = 0,
    sends = 0;
  const subscriptions = new ConversationSubscriptions(async (sessionId) => ({
    close() {},
    async read() {
      return {
        sessionId,
        activity: "idle",
        pendingRequests: [],
        sourceCoverage: { complete: true, earlierOutsideScope: "no" },
        messages: [
          {
            type: "assistant",
            uuid: "answer",
            content: [{ type: "text", text: "Reviewed **the change**." }],
          },
        ],
      };
    },
  }));
  const commands = new SessionCommands(
    id,
    receipts,
    {
      async start(_project, _request, _receipt, _settled, _failed, consumed) {
        starts++;
        const sessionId = `created-${starts}`;
        sessions.push({ ...sessions[0]!, id: sessionId });
        consumed?.();
        return { sessionId };
      },
      canSend: (sid) => sessions.some((s) => s.id === sid),
      send(_id, _request, _receipt, consumed) {
        sends++;
        consumed();
        return { accepted: true };
      },
    },
    () => true,
  );
  const sources: CoreApiSources = {
    commands,
    projects: async () => ({ items: [project, { ...project, id: "secret" }] }),
    sessions: async () => ({ items: sessions }),
    providers: async () => [
      {
        id: "codex",
        name: "Codex",
        supportsSteering: true,
        supportsPermissionMode: true,
      },
    ],
    conversation: createConversationRead(subscriptions),
    followConversation: createConversationFollow(subscriptions, id),
  };
  const core = new CoreApi(id, sources),
    directory = new PeerDirectory();
  const receiver = createPeerReceiver(core, directory);
  const router = new PeerApiRouter(
    core,
    outbound,
    [],
    (sid) => receipts.resolveId(sid),
    () => ({ enabled: true }),
  );
  let launch: ApiLaunchContext | undefined;
  const app = new Hono<{
    Variables: {
      yaPrincipal: typeof SUPERUSER;
      yaApiLaunch: ApiLaunchContext;
      yaApiOwnerAuthenticated: true;
    };
  }>();
  app.use("*", async (c, next) => {
    c.set("yaPrincipal", SUPERUSER);
    c.set("yaApiOwnerAuthenticated", true);
    if (launch) c.set("yaApiLaunch", launch);
    await next();
  });
  app.route("/v0", createV0Routes(router));
  cleanups.push(async () => {
    router.close();
    directory.close();
    subscriptions.close();
    commands.close();
    await commands.idle();
    outbound.close();
    receipts.close();
    database.close();
  });
  return {
    id,
    app,
    receiver,
    router,
    directory,
    sources,
    commands,
    receipts,
    outbound,
    sessions,
    starts: () => starts,
    sends: () => sends,
    launch: (value?: ApiLaunchContext) => {
      launch = value;
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function connect(
  a: Fixture,
  b: Fixture,
  fetcher?: typeof fetch,
  origin = "http://127.0.0.1",
) {
  const token = randomBytes(32).toString("base64url");
  const grant = fixturePeerGrant(a.id, token, ["p"], [...operationIds]);
  b.directory.put(grant);
  const dispatch: typeof fetch = async (request, init) =>
    b.receiver.request(request, init);
  const transport = new HttpPeerTransport(
    b.id,
    origin,
    token,
    fetcher ?? dispatch,
    true,
  );
  a.router.put({
    serverId: b.id,
    operations: [...operationIds],
    transport,
    allowAgentSessions: true,
  });
  return { grant, token, transport, dispatch };
}
const post = (fixture: Fixture, path: string, payload: unknown = body) =>
  fixture.app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
const peerHeaders = (
  token: string,
  context = { sessionId: "parent", launchId: "launch-A" },
) => ({
  Authorization: `Bearer ${token}`,
  "X-YA-Peer-Context": Buffer.from(JSON.stringify(context)).toString(
    "base64url",
  ),
});

it("creates, messages and follows across real v0 authentication, with separate directional authority and provenance", async () => {
  const a = fixture("A"),
    b = fixture("B");
  connect(a, b);
  a.launch({
    id: "parent",
    launchId: "launch-A",
    management: true,
    peerAccess: true,
  });
  const listed = await (await a.app.request("/v0/servers")).json();
  expect(listed.items).toEqual([
    { id: "A", local: true },
    { id: "B", local: false },
  ]);
  expect((await b.app.request("/v0/servers/A/sessions")).status).toBe(404);
  const accepted = await post(a, "/v0/servers/B/sessions");
  expect(accepted.status).toBe(202);
  const first = await accepted.json();
  await b.commands.idle();
  const receipt = await (
    await a.app.request(`/v0/servers/B/receipts/${first.id}`)
  ).json();
  expect(receipt.creator).toMatchObject({
    serverId: "A",
    sessionId: "parent",
    principal: { kind: "peer" },
    authentication: { sessionAttribution: "source-attested" },
  });
  expect(receipt.destinationServerId).toBe("B");
  expect(receipt.sessionId).toBe("created-1");
  const message = await post(a, "/v0/servers/B/sessions/created-1/messages", {
    requestId: "peer-message-001",
    message: "Please explain",
    delivery: "queue",
  });
  expect(message.status).toBe(202);
  expect(b.sends()).toBe(1);
  const follow = await (
    await a.app.request(
      "/v0/servers/B/sessions/created-1/conversation/follow?waitMs=0",
    )
  ).json();
  expect(follow.conversation.messages[0].content[0].text).toContain("Reviewed");
  const outbound = (
    await (
      await a.app.request("/v0/servers/A/sessions/parent/relationships")
    ).json()
  ).outbound.items;
  expect(outbound).toHaveLength(2);
  expect(
    outbound.every(
      (r: { destinationServerId: string }) => r.destinationServerId === "B",
    ),
  ).toBe(true);
  a.launch({ id: "parent", launchId: "old-local-lease", management: true });
  expect(
    (
      await (
        await a.app.request("/v0/servers/A/sessions/parent/relationships")
      ).json()
    ).outbound,
  ).toBeUndefined();
  a.launch({
    id: "parent",
    launchId: "launch-A",
    management: true,
    peerAccess: true,
  });
  expect(
    (
      await (
        await b.app.request("/v0/servers/B/sessions/parent/relationships")
      ).json()
    ).initiated,
  ).toEqual([]);
  b.receipts.remap("parent", "local-renamed");
  expect(b.receipts.get(first.id)?.creator.sessionId).toBe("parent");
  expect(
    (await (await a.app.request("/v0/servers/B/projects")).json()).items.map(
      (p: { id: string }) => p.id,
    ),
  ).toEqual(["p"]);
  expect(
    (await a.app.request("/v0/servers/B/sessions/private/conversation")).status,
  ).toBe(404);
  expect(
    (
      await post(a, "/v0/servers/B/sessions", {
        ...body,
        requestId: "peer-private-001",
        projectId: "secret",
      })
    ).status,
  ).toBe(404);
});

it("does not widen local read or management leases, trust identity headers, or expose legacy routes", async () => {
  const a = fixture("A"),
    b = fixture("B"),
    c = fixture("C");
  const link = connect(a, b);
  connect(b, c);
  for (const management of [undefined, true] as const) {
    a.launch({ id: "parent", launchId: "old-lease", management });
    expect(
      (await (await a.app.request("/v0/servers")).json()).items,
    ).toHaveLength(1);
    expect((await post(a, "/v0/servers/B/sessions")).status).toBe(403);
  }
  expect(b.starts()).toBe(0);
  expect(
    (
      await b.receiver.request("/v0/servers/B/projects", {
        headers: { Authorization: "Bearer invalid", "X-YA-Server-ID": "A" },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await b.receiver.request("/api/sessions", {
        headers: peerHeaders(link.token),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await b.receiver.request("/v0/servers/C/projects", {
        headers: peerHeaders(link.token),
      })
    ).status,
  ).toBe(404);
  expect((await b.receiver.request("/v0/me")).status).toBe(401);
  expect(
    (
      await b.receiver.request("/v0/servers/B/projects", {
        headers: { ...peerHeaders(link.token), Origin: "https://example.com" },
      })
    ).status,
  ).toBe(403);
});

it("persists uncertain intent before sending, recovers a lost response with one retry key and retains original attestation across source remaps", async () => {
  const a = fixture("A"),
    b = fixture("B");
  let lose = true;
  const link = connect(a, b, async (request, init) => {
    if (init?.method === "POST")
      expect(a.outbound.list("parent", 0, 10).items[0]?.state).toBe(
        "uncertain",
      );
    const response = await b.receiver.request(request, init);
    if (init?.method === "POST" && lose) {
      lose = false;
      throw new Error("response lost after acceptance");
    }
    return response;
  });
  a.launch({
    id: "parent",
    launchId: "original",
    management: true,
    peerAccess: true,
  });
  expect((await post(a, "/v0/servers/B/sessions")).status).toBe(503);
  await b.commands.idle();
  expect(a.outbound.list("parent", 0, 10).items[0]?.state).toBe("uncertain");
  a.outbound.remap("parent", "canonical");
  a.launch({
    id: "canonical",
    launchId: "new-launch",
    management: true,
    peerAccess: true,
  });
  // Remove the diagnostic assertion that intentionally observed the old source id.
  a.router.put({
    serverId: "B",
    operations: [...operationIds],
    allowAgentSessions: true,
    transport: new HttpPeerTransport(
      "B",
      "http://127.0.0.1",
      link.token,
      link.dispatch,
      true,
    ),
  });
  const retried = await post(a, "/v0/servers/B/sessions");
  expect(retried.status).toBe(202);
  const receipt = await retried.json();
  expect(b.starts()).toBe(1);
  expect(receipt.creator.sessionId).toBe("parent");
  const records = a.outbound.list("canonical", 0, 10).items;
  expect(records).toHaveLength(1);
  expect(records[0]?.state).toBe("confirmed");
  expect(
    (
      await post(a, "/v0/servers/B/sessions", {
        ...body,
        message: "Different prompt",
      })
    ).status,
  ).toBe(409);
});

it("keeps same-project peer receipts private and rechecks grants on replay and pending observation", async () => {
  const a = fixture("A"),
    b = fixture("B"),
    c = fixture("C");
  const ab = connect(a, b),
    cb = connect(c, b);
  const created = await (await post(a, "/v0/servers/B/sessions")).json();
  await b.commands.idle();
  expect(
    (await c.app.request(`/v0/servers/B/receipts/${created.id}`)).status,
  ).toBe(404);
  expect(
    (
      await c.app.request(
        `/v0/servers/B/receipts/${created.id}/follow?waitMs=0`,
      )
    ).status,
  ).toBe(404);
  const relationships = await (
    await c.app.request("/v0/servers/B/sessions/created-1/relationships")
  ).json();
  expect(relationships.creation).toBeNull();
  b.directory.put({ ...ab.grant, projects: [] });
  expect((await post(a, "/v0/servers/B/sessions")).status).toBe(404);
  expect(
    (await a.app.request(`/v0/servers/B/receipts/${created.id}`)).status,
  ).toBe(404);
  expect(
    (
      await post(a, "/v0/servers/B/sessions/created-1/messages", {
        requestId: "revoked-input-001",
        message: "No",
      })
    ).status,
  ).toBe(404);
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let aborted = false;
  b.sources.followConversation = async (_id, _query, signal) => {
    entered();
    return new Promise((_resolve, reject) => {
      signal!.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(signal!.reason);
        },
        { once: true },
      );
    });
  };
  const pending = c.app.request(
    "/v0/servers/B/sessions/created-1/conversation/follow?waitMs=4000",
  );
  await waiting;
  b.directory.revoke(cb.grant.id);
  expect((await pending).status).toBe(401);
  expect(aborted).toBe(true);
  expect(b.starts()).toBe(1);
});

it("fences target revocation while a create waits on its catalog before durable admission", async () => {
  const a = fixture("A"),
    b = fixture("B");
  const { grant } = connect(a, b);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  b.sources.projects = async () => {
    enter();
    await held;
    return { items: [project] };
  };
  const pending = post(a, "/v0/servers/B/sessions");
  await entered;
  b.directory.revoke(grant.id);
  release();
  expect((await pending).status).toBe(401);
  expect(b.starts()).toBe(0);
});

it("checks a receipt's current session project and outgoing revocation before releasing a result", async () => {
  const a = fixture("A"),
    b = fixture("B");
  connect(a, b);
  a.launch({
    id: "parent",
    launchId: "source-revocation",
    management: true,
    peerAccess: true,
  });
  const first = await (await post(a, "/v0/servers/B/sessions")).json();
  await b.commands.idle();
  b.sessions.find((s) => s.id === "created-1")!.projectId = "secret";
  expect(
    (await a.app.request(`/v0/servers/B/receipts/${first.id}`)).status,
  ).toBe(404);
  expect((await post(a, "/v0/servers/B/sessions")).status).toBe(404);
  b.sessions.find((s) => s.id === "created-1")!.projectId = "p";
  const link = connect(a, b);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  a.router.put({
    serverId: "B",
    operations: [...operationIds],
    allowAgentSessions: true,
    transport: {
      serverId: "B",
      async request(...args) {
        const result = await link.transport.request(...args);
        entered();
        await held;
        return result;
      },
    },
  });
  const pending = post(a, "/v0/servers/B/sessions", {
    ...body,
    requestId: "source-revoke-001",
  });
  await ready;
  a.outbound.remap("parent", "canonical-parent");
  a.router.revoke("B");
  release();
  expect((await pending).status).toBe(403);
  await b.commands.idle();
  expect(b.starts()).toBe(2);
  // Revocation before the reply keeps source outcome uncertain; target work remains.
  expect(
    a.outbound
      .list("canonical-parent", 0, 10)
      .items.find((r) => r.requestId === "source-revoke-001")?.state,
  ).toBe("uncertain");
  expect(
    a.outbound
      .list("canonical-parent", 0, 10)
      .items.every(
        (r) =>
          r.sourceSessionId === "canonical-parent" &&
          r.attestedSessionId === "parent",
      ),
  ).toBe(true);
});

it("authorizes conflicting receipts before disclosing mismatch and accepts target-canonical message retries", async () => {
  const a = fixture("A"),
    b = fixture("B");
  const { grant, token } = connect(a, b);
  const created = await (await post(a, "/v0/servers/B/sessions")).json();
  await b.commands.idle();
  b.sessions.find((s) => s.id === "created-1")!.projectId = "secret";
  const direct = (path: string, payload: unknown) =>
    b.receiver.request(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  for (const message of [body.message, "Conflicting private request"])
    expect(
      (await direct("/v0/servers/B/sessions", { ...body, message })).status,
    ).toBe(404);
  const input = {
    requestId: "canonical-input-001",
    message: "Explain",
    delivery: "queue",
  };
  expect(
    (await post(a, "/v0/servers/B/sessions/parent/messages", input)).status,
  ).toBe(202);
  b.receipts.remap("parent", "canonical-target");
  b.sessions.find((s) => s.id === "parent")!.id = "canonical-target";
  const retry = await post(a, "/v0/servers/B/sessions/parent/messages", input);
  expect(retry.status).toBe(202);
  expect(await retry.json()).toMatchObject({
    requestedSessionId: "parent",
    sessionId: "canonical-target",
  });
  expect(b.sends()).toBe(1);
  expect(b.receipts.get(created.id)?.creator.sessionId).toBeNull();
  b.directory.put({ ...grant, projects: [] });
  for (const message of [input.message, "Conflicting private input"])
    expect(
      (
        await direct("/v0/servers/B/sessions/parent/messages", {
          ...input,
          message,
        })
      ).status,
    ).toBe(404);
});

it("releases all receiver slots on revocation of unfinished request bodies, even if stream cancellation stalls", async () => {
  const a = fixture("A"),
    b = fixture("B"),
    c = fixture("C");
  const ab = connect(a, b),
    cb = connect(c, b);
  const pending = Array.from({ length: 128 }, () => {
    const stream = new ReadableStream<Uint8Array>({
      cancel: () => new Promise<void>(() => {}),
    });
    return b.receiver.request(
      new Request("http://127.0.0.1/v0/servers/B/sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${ab.token}` },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
  });
  expect(
    (
      await b.receiver.request("/v0/servers/B/projects", {
        headers: peerHeaders(cb.token),
      })
    ).status,
  ).toBe(503);
  b.directory.revoke(ab.grant.id);
  expect(
    (await Promise.all(pending)).every((response) => response.status === 401),
  ).toBe(true);
  expect(
    (
      await b.receiver.request("/v0/servers/B/projects", {
        headers: peerHeaders(cb.token),
      })
    ).status,
  ).toBe(200);
});

it("rejects wrong-target responses before credential release and blocks unprotected non-loopback transports", async () => {
  expect(
    () => new HttpPeerTransport("B", "http://192.0.2.1", "secret", fetch, true),
  ).toThrow();
  const a = fixture("A"),
    b = fixture("B");
  let leaked = false;
  connect(a, b, async (_request, init) => {
    leaked ||= Boolean(new Headers(init?.headers).get("Authorization"));
    return Response.json({ serverId: "C" });
  });
  expect((await post(a, "/v0/servers/B/sessions")).status).toBe(502);
  expect(leaked).toBe(false);
  expect(b.starts()).toBe(0);
});

it("repeats create/message/follow over two owned ephemeral loopback TCP listeners", async () => {
  const a = fixture("A"),
    b = fixture("B");
  const target = serve({
    fetch: b.receiver.fetch,
    hostname: "127.0.0.1",
    port: 0,
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        if ("closeAllConnections" in target) target.closeAllConnections();
        target.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  await once(target, "listening");
  const targetAddress = target.address();
  if (!targetAddress || typeof targetAddress === "string")
    throw new Error("Missing TCP target");
  connect(a, b, fetch, `http://127.0.0.1:${targetAddress.port}`);
  const source = serve({ fetch: a.app.fetch, hostname: "127.0.0.1", port: 0 });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        if ("closeAllConnections" in source) source.closeAllConnections();
        source.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  await once(source, "listening");
  const address = source.address();
  if (!address || typeof address === "string")
    throw new Error("Missing TCP source");
  const origin = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${origin}/v0/servers/B/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(202);
  await response.json();
  await b.commands.idle();
  const input = await fetch(
    `${origin}/v0/servers/B/sessions/created-1/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "tcp-message-001",
        message: "Explain",
      }),
    },
  );
  expect(input.status).toBe(202);
  await input.json();
  const following = await fetch(
    `${origin}/v0/servers/B/sessions/created-1/conversation/follow?waitMs=0`,
  );
  expect(following.status).toBe(200);
  expect(
    (await following.json()).conversation.messages[0].content[0].text,
  ).toContain("Reviewed");
});
