import { protectedProfile, nativeRequest } from "./peer-fixture.js";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { SRPClientSession } from "tssrp6a";
import { createRelayServer } from "../../../relay/src/server.js";
import { SUPERUSER } from "../../src/auth/principal.js";
import type { Operation } from "../../src/core-api/contracts.js";
import { createAgentApiRuntime } from "../../src/agent-api/runtime.js";
import {
  PeerChannelBudget,
  awaitPeerWork,
} from "../../src/peer-api/srp-protocol.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("bounds native crypto that remains pending after its callers cancel", async () => {
  const budget = new PeerChannelBudget();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const jobs = Array.from({ length: 32 }, () => budget.crypto(() => held));
  try {
    const cancelled = AbortSignal.abort();
    const results = await Promise.allSettled(
      jobs.map((job) => awaitPeerWork(job, cancelled)),
    );
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    await expect(budget.crypto(async () => undefined)).rejects.toMatchObject({
      code: "command_capacity",
    });
  } finally {
    release();
    await Promise.all(jobs);
  }
  expect(await budget.crypto(async () => "released")).toBe("released");
  budget.close();
});
const operations: Operation[] = [
  "projects",
  "sessions",
  "session",
  "createSession",
  "prompt",
  "receipt",
  "followReceipt",
  "relationships",
];
const grant = (sourceServerId: string) => ({
  sourceServerId,
  projects: ["p"],
  operations,
  expiresAt: Date.now() + 600_000,
  acknowledgeExecutionAuthority: "server-account",
});
const profile = () => protectedProfile(cleanup);

// CI 41287615314 exceeded 5,000 ms for this real multi-handshake workflow;
// the focused macOS run took 3,346 ms. Allow 4x the observed CI lower
// bound while retaining real SRP, persistence and revocation assertions.
it("enrolls actual private profiles over mutually authenticated direct SRP and retains directional receipt provenance", async () => {
  const a = await profile(),
    b = await profile();
  const invitation = await b.manager.issue(grant(a.id));
  await a.manager.importOutgoing({
    invitation,
    route: b.route,
    operations,
    allowAgentSessions: true,
    replace: false,
  });
  expect(await a.read("servers")).toMatchObject({
    items: [{ id: a.id }, { id: b.id }],
  });
  expect(await a.read("projects", { serverId: b.id })).toMatchObject({
    items: [{ id: "p" }],
  });
  let cryptoEntered!: () => void, releaseCrypto!: () => void;
  const startedCrypto = new Promise<void>((resolve) => {
    cryptoEntered = resolve;
  });
  const heldCrypto = new Promise<void>((resolve) => {
    releaseCrypto = resolve;
  });
  const originalStep1 = SRPClientSession.prototype.step1;
  const crypto = vi
    .spyOn(SRPClientSession.prototype, "step1")
    .mockImplementationOnce(async function (this: SRPClientSession, ...args) {
      cryptoEntered();
      await heldCrypto;
      return originalStep1.apply(this, args);
    });
  const cancelledCrypto = new AbortController();
  const settingUp = a.read("projects", {
    serverId: b.id,
    signal: cancelledCrypto.signal,
  });
  try {
    await startedCrypto;
    cancelledCrypto.abort();
    await expect(settingUp).rejects.toMatchObject({ code: "peer_unavailable" });
    // Cancellation returns and another request succeeds before native crypto settles.
    expect(await a.read("projects", { serverId: b.id })).toMatchObject({
      items: [{ id: "p" }],
    });
  } finally {
    releaseCrypto();
    crypto.mockRestore();
  }
  await expect(b.read("projects", { serverId: a.id })).rejects.toMatchObject({
    code: "server_not_found",
  });
  const body = {
    requestId: "protected-create-001",
    projectId: "p",
    provider: "codex",
    prompt: "Review the change",
    permissionMode: "default",
  };
  const created = (await a.read("createSession", { serverId: b.id, body })) as {
    id: string;
    sessionId: string | null;
  };
  expect(created).toMatchObject({
    creator: {
      serverId: a.id,
      authentication: { generation: 1, sessionAttribution: "source-attested" },
    },
    destinationServerId: b.id,
  });
  await a.read("createSession", { serverId: b.id, body });
  expect(b.starts()).toBe(1);
  const receipt = (await a.read("followReceipt", {
    serverId: b.id,
    receiptId: created.id,
    query: { waitMs: "0" },
  })) as { receipt: { sessionId: string } };
  expect(receipt.receipt.sessionId).toBe("created-1");
  await a.read("prompt", {
    serverId: b.id,
    sessionId: receipt.receipt.sessionId,
    body: { requestId: "protected-message-001", prompt: "Please continue" },
  });
  expect(b.sends()).toBe(1);
  const { sourceServerId: _source, ...rotation } = grant(a.id);
  const rotated = await b.manager.issue(rotation, invitation.credentialId);
  await expect(a.read("projects", { serverId: b.id })).rejects.toMatchObject({
    code: "unauthorized",
  });
  await a.manager.importOutgoing({
    invitation: rotated,
    route: b.route,
    operations,
    allowAgentSessions: true,
    replace: true,
  });
  expect(await a.read("projects", { serverId: b.id })).toMatchObject({
    items: [{ id: "p" }],
  });
  await b.manager.store.revokeIncoming(invitation.credentialId);
  await expect(a.read("projects", { serverId: b.id })).rejects.toMatchObject({
    code: "unauthorized",
  });
}, 20_000);

it("rejects a misbound authenticated identity before importing or admitting any mutation", async () => {
  const a = await profile(),
    b = await profile(),
    c = await profile();
  const invitation = await b.manager.issue(grant(a.id));
  await expect(
    a.manager.importOutgoing({
      invitation: { ...invitation, targetServerId: c.id },
      route: b.route,
      operations,
      allowAgentSessions: true,
      replace: false,
    }),
  ).rejects.toMatchObject({ code: "peer_identity_mismatch" });
  expect(a.manager.publicState().outgoing).toEqual([]);
  expect(b.starts()).toBe(0);
  await expect(
    c.manager.importOutgoing({
      invitation,
      route: b.route,
      operations,
      allowAgentSessions: true,
      replace: false,
    }),
  ).rejects.toMatchObject({ code: "invalid_request" });
});

// CI 41287615314 took 4,794 ms for poisoned-route recovery and parallel
// real SRP calls, near the default 5,000 ms. Allow 4x that measured time.
it("uses an owned real relay and replenishes poisoned claimed routes without sharing browser registration", async () => {
  const relay = await createRelayServer({
    inMemoryDb: true,
    disableTelemetry: true,
    logLevel: "silent",
    disablePrettyPrint: true,
    webSocketMaxMessageBytes: 384 * 1024,
  });
  cleanup.push(() => relay.close());
  const a = await profile(),
    b = await profile();
  const url = `ws://127.0.0.1:${relay.port}/ws`,
    username = "peer-protected-test";
  await b.manager.store.configureRelay({ url, username });
  const ready = () =>
    vi.waitFor(() =>
      expect(b.manager.publicState().relay?.status).toBe("waiting"),
    );
  await ready();
  for (const poison of [
    "{invalid JSON",
    JSON.stringify({ type: "server_registered", username }),
  ]) {
    const client = new WebSocket(url);
    client.on("error", () => {});
    const closed = once(client, "close");
    await once(client, "open");
    const paired = once(client, "message");
    client.send(JSON.stringify({ type: "client_connect", username }));
    await paired;
    client.send(poison);
    await closed;
    await ready();
  }
  const invitation = await b.manager.issue(grant(a.id));
  await a.manager.importOutgoing({
    invitation,
    route: { kind: "relay", url, username },
    operations,
    allowAgentSessions: false,
    replace: false,
  });
  expect(await a.read("projects", { serverId: b.id })).toMatchObject({
    items: [{ id: "p" }],
  });
  const parallel = await Promise.all(
    Array.from({ length: 6 }, () => a.read("projects", { serverId: b.id })),
  );
  expect(parallel).toHaveLength(6);
  expect(
    parallel.every(
      (result) => (result as { items: { id: string }[] }).items[0]?.id === "p",
    ),
  ).toBe(true);
  const body = {
    requestId: "relay-create-001",
    projectId: "p",
    provider: "codex",
    prompt: "Review via relay",
    permissionMode: "default",
  };
  await a.read("createSession", { serverId: b.id, body });
  expect(b.starts()).toBe(1);
  await b.manager.store.removeRelay();
  await expect(a.read("projects", { serverId: b.id })).rejects.toMatchObject({
    code: "peer_unavailable",
  });
}, 20_000);

it("discovers and creates through private native HTTP, fences old grants across re-enable and preserves self context during controller loss", async () => {
  const a = await profile(),
    b = await profile();
  const invitation = await b.manager.issue(grant(a.id));
  await a.manager.importOutgoing({
    invitation,
    route: b.route,
    operations,
    allowAgentSessions: true,
    replace: false,
  });
  const runtime = await createAgentApiRuntime({ serverId: a.id });
  cleanup.push(() => runtime.close());
  const detach = runtime.attachController(a.router);
  const issue = (peer = false) =>
    runtime.issue({
      principal: SUPERUSER,
      sessionId: () => "parent",
      management: true,
      peerAccess: peer,
      peerGrantId: a.manager.agentAccess().grantId,
    });
  const local = issue(),
    localToken = local.environment.AGENT_YA_V0_AUTHORIZATION!;
  await a.manager.setAgentAccess({ enabled: true });
  const first = issue(true),
    token = first.environment.AGENT_YA_V0_AUTHORIZATION!;
  expect(
    (await nativeRequest(runtime, localToken, "/v0/servers")).body.items,
  ).toHaveLength(1);
  expect(
    (await nativeRequest(runtime, token, "/v0/servers")).body.items,
  ).toHaveLength(2);
  const path = `/v0/servers/${b.id}/sessions`;
  const response = await nativeRequest(runtime, token, path, {
    requestId: "native-peer-create-001",
    projectId: "p",
    provider: "codex",
    prompt: "Review from a native owner",
  });
  expect(response.status).toBe(202);
  expect(response.body.creator).toMatchObject({
    serverId: a.id,
    sessionId: "parent",
    authentication: { sessionAttribution: "source-attested" },
  });
  const observed = await nativeRequest(
    runtime,
    token,
    `/v0/servers/${b.id}/receipts/${response.body.id}/follow?waitMs=0`,
  );
  expect(observed.body.receipt.sessionId).toBe("created-1");
  const relationship = await nativeRequest(
    runtime,
    token,
    `/v0/servers/${a.id}/sessions/parent/relationships`,
  );
  expect(relationship.body.outbound.items).toMatchObject([
    {
      destinationServerId: b.id,
      destinationSessionId: "created-1",
      sourceSessionId: "parent",
    },
  ]);
  await a.manager.setAgentAccess({ enabled: false });
  await a.manager.setAgentAccess({ enabled: true });
  expect((await nativeRequest(runtime, token, path)).status).toBe(403);
  expect((await nativeRequest(runtime, localToken, "/v0/me")).status).toBe(200);
  const fresh = issue(true),
    freshToken = fresh.environment.AGENT_YA_V0_AUTHORIZATION!;
  expect((await nativeRequest(runtime, freshToken, path)).status).toBe(200);
  detach();
  expect((await nativeRequest(runtime, freshToken, "/v0/servers")).status).toBe(
    503,
  );
  expect((await nativeRequest(runtime, freshToken, "/v0/me")).status).toBe(200);
  expect((await nativeRequest(runtime, localToken, "/v0/servers")).status).toBe(
    200,
  );
});

it("recovers a protected mutation's lost reply with its identical key and reports oversized replies explicitly", async () => {
  const a = await profile(),
    b = await profile();
  const invitation = await b.manager.issue(grant(a.id));
  await a.manager.importOutgoing({
    invitation,
    route: b.route,
    operations,
    allowAgentSessions: false,
    replace: false,
  });
  const cancellation = new AbortController();
  b.onStart(() => cancellation.abort());
  const body = {
    requestId: "protected-lost-reply",
    projectId: "p",
    provider: "codex",
    prompt: "Accept once",
  };
  await expect(
    a.read("createSession", {
      serverId: b.id,
      body,
      signal: cancellation.signal,
    }),
  ).rejects.toMatchObject({ code: "peer_unavailable" });
  expect(b.starts()).toBe(1);
  await a.read("createSession", { serverId: b.id, body });
  expect(b.starts()).toBe(1);
  b.sources.projects = async () => ({
    items: [
      { id: "p", path: "/fixture/project", name: "x".repeat(256 * 1024) },
    ],
  });
  await expect(a.read("projects", { serverId: b.id })).rejects.toMatchObject({
    code: "peer_response_too_large",
  });
});

it("cancels a protected observation on credential revocation even if the catalog ignores its abort signal", async () => {
  const a = await profile(),
    b = await profile();
  const invitation = await b.manager.issue(grant(a.id));
  await a.manager.importOutgoing({
    invitation,
    route: b.route,
    operations,
    allowAgentSessions: false,
    replace: false,
  });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  b.sources.projects = async () => {
    entered();
    await held;
    return { items: [] };
  };
  const pending = a
    .read("projects", { serverId: b.id })
    .catch((error: unknown) => error);
  try {
    await started;
    await b.manager.store.revokeIncoming(invitation.credentialId);
    expect(await pending).toMatchObject({ code: "peer_unavailable" });
  } finally {
    release();
  }
});
