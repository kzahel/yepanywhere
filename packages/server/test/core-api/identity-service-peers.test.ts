import { identityServiceFixture } from "./identity-service-fixture.js";
import { SRPClientSession } from "tssrp6a";
import { createRelayServer } from "../../../relay/src/server.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SUPERUSER } from "../../src/auth/principal.js";
import { PeerAccessStore } from "../../src/peer-api/state.js";
import { createAgentApiRuntime } from "../../src/agent-api/runtime.js";
import type { AccessRelationship } from "../../src/identity-service/contracts.js";
import type { Operation } from "../../src/core-api/contracts.js";
import { nativeRequest } from "./peer-fixture.js";
import { SrpPeerTransport } from "../../src/peer-api/srp-client.js";
import { PeerChannelBudget } from "../../src/peer-api/srp-protocol.js";
import {
  signIdentityServiceJwt,
  importIdentityServiceKey,
  publicIdentityServiceKey,
  generateIdentityServicePrivateKey,
  identityServiceDigest,
} from "../../src/identity-service/crypto.js";
import * as jose from "jose";
import WebSocket from "ws";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const operations: Operation[] = [
  "server",
  "access",
  "capabilities",
  "projects",
  "sessions",
  "session",
  "conversation",
  "followConversation",
  "createSession",
  "sendMessage",
  "receipt",
  "followReceipt",
  "relationships",
];
const fixture = () => identityServiceFixture(cleanup);

// CI 41287615314 exceeded 5,000 ms for this real multi-handshake workflow;
// the focused macOS run took 3,622 ms. Allow 4x the observed CI lower
// bound while retaining real SRP, persistence and revocation assertions.
it("uses real basic enrollment and protected SRP for native create/message/follow while retaining manual standby access", async () => {
  const f = await fixture(),
    source = await f.make(),
    target = await f.make();
  const policy = {
    projects: ["p"],
    operations,
    expiresAt: Date.now() + 600_000,
  };
  const manual = await target.manager.issue({
    sourceServerId: source.id,
    ...policy,
    acknowledgeExecutionAuthority: "server-account",
  });
  await source.manager.importOutgoing({
    invitation: manual,
    route: target.route,
    operations,
    allowAgentSessions: true,
    replace: false,
  });
  const relay = await createRelayServer({
    inMemoryDb: true,
    disableTelemetry: true,
    logLevel: "silent",
    disablePrettyPrint: true,
    webSocketMaxMessageBytes: 384 * 1024,
  });
  cleanup.push(() => relay.close());
  const relayRoute = {
    kind: "relay",
    url: `ws://127.0.0.1:${relay.port}/ws`,
    username: "fleet-integration",
  };
  await target.manager.store.configureRelay({
    url: relayRoute.url,
    username: relayRoute.username,
  });
  await vi.waitFor(() =>
    expect(target.manager.publicState().relay?.status).toBe("waiting"),
  );
  const r = (await source.json("/fleet/relationships", "POST", {
    targetClientId: target.client.id,
    policy,
  })) as AccessRelationship;
  const issued = await target.json("/fleet/accept", "POST", {
    relationshipId: r.id,
    policy,
    route: relayRoute,
    acknowledgeExecutionAuthority: "server-account",
  });
  await source.json("/fleet/adopt", "POST", {
    envelopeId: issued.envelopeId,
    allowAgentSessions: true,
  });
  await source.json("/fleet/adopt", "POST", {
    envelopeId: issued.envelopeId,
    allowAgentSessions: true,
  });
  expect(source.manager.store.read().outgoing).toHaveLength(2);
  expect(source.manager.store.read().selected[target.id]).toBe(
    manual.credentialId,
  );
  const fleet = source.manager.store
    .read()
    .outgoing.find((p) => p.origin === "fleet")!;
  expect(JSON.stringify(target.manager.store.read())).not.toContain(
    fleet.invitation.secret,
  );
  expect(JSON.stringify(f.store.read())).not.toContain(fleet.invitation.secret);
  expect(JSON.stringify(await source.json("/"))).not.toContain(
    fleet.invitation.secret,
  );
  await source.json(`/outgoing/${target.id}/select`, "POST", {
    credentialId: fleet.invitation.credentialId,
  });
  await source.manager.setAgentAccess({ enabled: true });
  const runtime = await createAgentApiRuntime({ serverId: source.id });
  cleanup.push(() => runtime.close());
  runtime.attachController(source.router);
  const lease = runtime.issue({
    principal: SUPERUSER,
    sessionId: () => "parent",
    management: true,
    peerAccess: true,
    peerGrantId: source.manager.agentAccess().grantId,
  });
  const token = lease.environment.AGENT_YA_V0_AUTHORIZATION!,
    base = `/v0/servers/${target.id}`;
  const created = await nativeRequest(runtime, token, base + "/sessions", {
    requestId: "fleet-native-create",
    projectId: "p",
    provider: "codex",
    message: "Review this change",
  });
  expect(created.status).toBe(202);
  expect(created.body.creator).toMatchObject({
    serverId: source.id,
    sessionId: "parent",
    authentication: { sessionAttribution: "source-attested" },
  });
  const receipt = await nativeRequest(
      runtime,
      token,
      `${base}/receipts/${created.body.id}/follow?waitMs=0`,
    ),
    sid = receipt.body.receipt.sessionId;
  expect(sid).toBe("created-1");
  const followed = await nativeRequest(
    runtime,
    token,
    `${base}/sessions/${sid}/conversation/follow?waitMs=0`,
  );
  expect(followed.status).toBe(200);
  expect(JSON.stringify(followed.body)).toContain(
    "Protected fleet workflow completed.",
  );
  const sent = await nativeRequest(
    runtime,
    token,
    `${base}/sessions/${sid}/messages`,
    { requestId: "fleet-native-message", message: "Continue" },
  );
  expect(sent.status).toBe(202);
  expect(target.starts()).toBe(1);
  expect(target.sends()).toBe(1);
  if (fleet.origin !== "fleet") throw new Error("Expected fleet credential");
  const cachedAuthority = await source.manager.delegatedAccess
    .transport(fleet)
    .token(new AbortController().signal);
  f.offline();
  expect((await nativeRequest(runtime, token, base + "/projects")).status).toBe(
    200,
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(cachedAuthority.expiresAt + 1);
    expect(
      (await nativeRequest(runtime, token, base + "/projects")).status,
    ).toBe(503);
    expect(source.manager.store.read().selected[target.id]).toBe(
      fleet.invitation.credentialId,
    );
  } finally {
    vi.useRealTimers();
    f.online();
  }
  const relationship = await source.read("relationships", {
    serverId: source.id,
    sessionId: "parent",
  });
  expect(JSON.stringify(relationship)).toContain(target.id);
  const revoked = await target.json(`/fleet/relationships/${r.id}`, "DELETE");
  expect(revoked).toMatchObject({
    localRemoved: true,
    remoteRevocation: "confirmed",
  });
  expect((await nativeRequest(runtime, token, base + "/projects")).status).toBe(
    401,
  );
  expect(source.manager.store.read().selected[target.id]).toBe(
    fleet.invitation.credentialId,
  );
  await source.json(`/outgoing/${target.id}/select`, "POST", {
    credentialId: manual.credentialId,
  });
  f.offline();
  expect((await nativeRequest(runtime, token, base + "/projects")).status).toBe(
    200,
  );
  expect(await source.json("/fleet", "DELETE")).toMatchObject({
    localRemoved: true,
    remoteRevocation: "unconfirmed",
  });
  expect(source.manager.store.read().outgoing).toHaveLength(1);
  expect(source.manager.store.read().selected[target.id]).toBe(
    manual.credentialId,
  );
  expect((await nativeRequest(runtime, token, base + "/projects")).status).toBe(
    200,
  );
}, 20_000);

it("migrates complete v1 manual state atomically without changing IDs or its selected route", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ya-peer-v1-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const source = new PeerAccessStore(randomUUID(), directory);
  await source.initialize();
  const targetId = randomUUID();
  await source.setAgentAccess(true);
  const saved = structuredClone(source.read());
  await source.close();
  const legacy = {
    version: 1,
    serverId: saved.serverId,
    decoySecret: saved.decoySecret,
    agentAccess: saved.agentAccess,
    incoming: [],
    outgoing: [],
    relay: saved.relay,
  };
  const id = randomUUID();
  const outgoing = {
    invitation: {
      version: 1,
      sourceServerId: saved.serverId,
      targetServerId: targetId,
      credentialId: id,
      generation: 3,
      username: `peer-${id}`,
      secret: "a".repeat(43),
      expiresAt: Date.now() + 60_000,
    },
    route: { kind: "direct", url: "ws://127.0.0.1:12345/peer/ws" },
    operations: ["server"],
    allowAgentSessions: false,
  };
  Object.assign(legacy, { outgoing: [outgoing] });
  await writeFile(source.path, JSON.stringify(legacy), { mode: 0o600 });
  const migrated = new PeerAccessStore(saved.serverId, directory);
  await migrated.initialize();
  expect(migrated.read()).toMatchObject({
    version: 3,
    agentAccess: saved.agentAccess,
    selected: { [targetId]: id },
    outgoing: [{ ...outgoing, origin: "manual" }],
  });
  const first = await readFile(source.path, "utf8");
  await migrated.close();
  const resumed = new PeerAccessStore(saved.serverId, directory);
  await resumed.initialize();
  expect(await readFile(source.path, "utf8")).toBe(first);
  await resumed.close();
});

// CI 41288604016 exhausted 5,000 ms during real delivery recovery and
// repeated SRP rejection checks; focused macOS took 3,402 ms. Allow 4x
// the observed CI lower bound without replacing the crypto or fault paths.
it("recovers lost opaque delivery replies and rejects peer token/credential downgrade and widened scope", async () => {
  const f = await fixture(),
    source = await f.make(),
    target = await f.make();
  const policy = {
    projects: ["p"],
    operations,
    expiresAt: Date.now() + 600_000,
  };
  const r = (await source.json("/fleet/relationships", "POST", {
    targetClientId: target.client.id,
    policy,
  })) as AccessRelationship;
  const body = {
    relationshipId: r.id,
    policy,
    route: target.route,
    acknowledgeExecutionAuthority: "server-account",
  };
  f.loseUpload();
  expect((await target.call("/fleet/accept", "POST", body)).status).toBe(503);
  expect(target.manager.store.read().incoming).toHaveLength(1);
  expect(target.manager.store.read().fleet.outbox).toHaveLength(1);
  const ciphertext = target.manager.store.read().fleet.outbox[0]!.ciphertext;
  const delivered = await target.json("/fleet/accept", "POST", body);
  expect(target.manager.store.read().fleet.outbox[0]!.ciphertext).toBe(
    ciphertext,
  );
  const receiverKeys = source.manager.store.read().fleet.enrollment!.keys;
  const decrypted = await jose.compactDecrypt(
    ciphertext,
    await importIdentityServiceKey(receiverKeys.encryption, "ECDH-ES"),
  );
  const forgedSignature = await signIdentityServiceJwt(
    await generateIdentityServicePrivateKey(),
    jose.decodeJwt(new TextDecoder().decode(decrypted.plaintext)),
    "ya-peer-invitation+jwt",
  );
  const forgedEnvelope = await new jose.CompactEncrypt(
    new TextEncoder().encode(forgedSignature),
  )
    .setProtectedHeader({
      alg: "ECDH-ES",
      enc: "A256GCM",
      typ: "ya-peer-envelope+jwe",
      kid: source.client.encryptionJkt,
    })
    .encrypt(
      await importIdentityServiceKey(
        publicIdentityServiceKey(receiverKeys.encryption),
        "ECDH-ES",
      ),
    );
  await f.store.mutate((state) => {
    state.mailbox[0]!.ciphertext = forgedEnvelope;
    state.relationships[0]!.accepted!.digest =
      identityServiceDigest(forgedEnvelope);
  });
  const blockedPreflight = vi.spyOn(SRPClientSession.prototype, "step1");
  try {
    expect(
      (
        await source.call("/fleet/adopt", "POST", {
          envelopeId: delivered.envelopeId,
        })
      ).status,
    ).toBe(401);
    expect(blockedPreflight).not.toHaveBeenCalled();
  } finally {
    blockedPreflight.mockRestore();
  }
  expect(source.manager.store.read().outgoing).toEqual([]);
  await f.store.mutate((state) => {
    state.mailbox[0]!.ciphertext = ciphertext;
    state.relationships[0]!.accepted!.digest =
      identityServiceDigest(ciphertext);
  });
  let enteredPreflight!: () => void, releasePreflight!: () => void;
  const startedPreflight = new Promise<void>((resolve) => {
      enteredPreflight = resolve;
    }),
    heldPreflight = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
  const originalStep = SRPClientSession.prototype.step1;
  const preflight = vi
    .spyOn(SRPClientSession.prototype, "step1")
    .mockImplementationOnce(async function (this: SRPClientSession, ...args) {
      enteredPreflight();
      await heldPreflight;
      return originalStep.apply(this, args);
    });
  const staleImport = source.call("/fleet/adopt", "POST", {
    envelopeId: delivered.envelopeId,
  });
  try {
    await startedPreflight;
    await source.json(`/outgoing/${target.id}`, "DELETE");
  } finally {
    releasePreflight();
  }
  try {
    expect((await staleImport).status).toBe(409);
    expect(source.manager.store.read().outgoing).toEqual([]);
  } finally {
    preflight.mockRestore();
  }
  f.loseAck();
  expect(
    await source.json("/fleet/adopt", "POST", {
      envelopeId: delivered.envelopeId,
    }),
  ).toMatchObject({ imported: true, acknowledged: false });
  expect(f.store.read().mailbox).toEqual([]);
  expect(
    await source.json("/fleet/adopt", "POST", {
      envelopeId: delivered.envelopeId,
    }),
  ).toMatchObject({ imported: true, acknowledged: true });
  expect(source.manager.store.read().outgoing).toHaveLength(1);
  const peer = source.manager.store.read().outgoing[0]!;
  const issued = (await source.manager.delegatedAccess.request(
    `/relationships/${r.id}/token`,
    "POST",
  )) as { token: string; expiresAt: number };
  const claims = jose.decodeJwt(issued.token),
    ya = claims.ya as Record<string, unknown>;
  const budget = new PeerChannelBudget();
  cleanup.push(() => budget.close());
  await expect(
    new SrpPeerTransport(peer.invitation, peer.route, budget).request(
      "projects",
      { serverId: target.id },
      { sessionId: null, launchId: null },
    ),
  ).rejects.toMatchObject({ code: "peer_identity_mismatch" });
  const request = (token: string, secret = peer.invitation.secret) =>
    new SrpPeerTransport({ ...peer.invitation, secret }, peer.route, budget, {
      token: async () => ({ token, expiresAt: Date.now() + 20_000 }),
      assertActive() {},
    }).request(
      "projects",
      { serverId: target.id },
      { sessionId: null, launchId: null },
    );
  await expect(request(issued.token, "b".repeat(43))).rejects.toMatchObject({
    code: "unauthorized",
  });
  for (const altered of [
    { iss: "https://wrong.invalid" },
    { aud: `urn:yep-anywhere:peer:${randomUUID()}` },
    { ya: { ...ya, credentialGeneration: 2 } },
    { ya: { ...ya, policy: { ...policy, projects: ["secret"] } } },
  ]) {
    const invalid = await signIdentityServiceJwt(
      f.store.read().signingKey,
      { ...claims, ...altered },
      "ya-peer-grant+jwt",
    );
    await expect(request(invalid)).rejects.toMatchObject({
      code: "unauthorized",
    });
  }
  expect(target.starts()).toBe(0);
  await source.json(`/outgoing/${target.id}/select`, "POST", {
    credentialId: peer.invitation.credentialId,
  });
  expect(await source.read("projects", { serverId: target.id })).toMatchObject({
    items: [{ id: "p" }],
  });
  await target.json("/fleet", "DELETE");
  await expect(
    source.read("projects", { serverId: target.id }),
  ).rejects.toMatchObject({ code: "unauthorized" });
}, 20_000);

it("refuses observation after fleet token expiry while retaining native work already admitted", async () => {
  const f = await fixture(),
    source = await f.make(),
    target = await f.make();
  const policy = {
    projects: ["p"],
    operations,
    expiresAt: Date.now() + 600_000,
  };
  const r = (await source.json("/fleet/relationships", "POST", {
    targetClientId: target.client.id,
    policy,
  })) as AccessRelationship;
  const delivered = await target.json("/fleet/accept", "POST", {
    relationshipId: r.id,
    policy,
    route: target.route,
    acknowledgeExecutionAuthority: "server-account",
  });
  await source.json("/fleet/adopt", "POST", {
    envelopeId: delivered.envelopeId,
  });
  const peer = source.manager.store.read().outgoing[0]!;
  const issued = (await source.manager.delegatedAccess.request(
    `/relationships/${r.id}/token`,
    "POST",
  )) as { token: string };
  const expiresAt = (Math.floor(Date.now() / 1000) + 2) * 1000;
  const short = await signIdentityServiceJwt(
    f.store.read().signingKey,
    { ...jose.decodeJwt(issued.token), exp: expiresAt / 1000 },
    "ya-peer-grant+jwt",
  );
  const budget = new PeerChannelBudget();
  cleanup.push(() => budget.close());
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    target.onStart(() => vi.setSystemTime(expiresAt + 1));
    const transport = new SrpPeerTransport(
      peer.invitation,
      peer.route,
      budget,
      { token: async () => ({ token: short, expiresAt }), assertActive() {} },
    );
    await expect(
      transport.request(
        "createSession",
        {
          serverId: target.id,
          body: {
            requestId: "fleet-expiry-create",
            projectId: "p",
            provider: "codex",
            message: "accepted work",
          },
        },
        { sessionId: "parent", launchId: null },
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(target.starts()).toBe(1);
    expect(
      (await target.sources.sessions()).items.some(
        (session) => session.id === "created-1",
      ),
    ).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("renews fleet account tokens during adoption without invalidating the peer-policy revision fence", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const f = await fixture(),
      source = await f.make(),
      target = await f.make();
    const policy = {
      projects: ["p"],
      operations,
      expiresAt: Date.now() + 600_000,
    };
    const r = (await source.json("/fleet/relationships", "POST", {
      targetClientId: target.client.id,
      policy,
    })) as AccessRelationship;
    const delivered = await target.json("/fleet/accept", "POST", {
      relationshipId: r.id,
      policy,
      route: target.route,
      acknowledgeExecutionAuthority: "server-account",
    });
    const oldToken =
        source.manager.store.read().fleet.enrollment!.credentials!.accessToken,
      revision = source.manager.store.currentRevision();
    vi.setSystemTime(Date.now() + 286_000);
    expect(
      await source.json("/fleet/adopt", "POST", {
        envelopeId: delivered.envelopeId,
      }),
    ).toMatchObject({ imported: true, acknowledged: true });
    expect(
      source.manager.store.read().fleet.enrollment!.credentials!.accessToken,
    ).not.toBe(oldToken);
    expect(source.manager.store.currentRevision()).toBe(revision + 1);
  } finally {
    vi.useRealTimers();
  }
});

it("does not confirm an expired source reply even before its expiry timer runs", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const f = await fixture(),
      source = await f.make(),
      target = await f.make();
    const policy = {
      projects: ["p"],
      operations,
      expiresAt: Date.now() + 600_000,
    };
    const r = (await source.json("/fleet/relationships", "POST", {
      targetClientId: target.client.id,
      policy,
    })) as AccessRelationship;
    const delivered = await target.json("/fleet/accept", "POST", {
      relationshipId: r.id,
      policy,
      route: target.route,
      acknowledgeExecutionAuthority: "server-account",
    });
    await source.json("/fleet/adopt", "POST", {
      envelopeId: delivered.envelopeId,
      allowAgentSessions: true,
    });
    const peer = source.manager.store
      .read()
      .outgoing.find((p) => p.origin === "fleet")!;
    if (peer.origin !== "fleet") throw new Error("Expected fleet credential");
    const authority = await source.manager.delegatedAccess
      .transport(peer)
      .token(new AbortController().signal);
    await source.json(`/outgoing/${target.id}/select`, "POST", {
      credentialId: peer.invitation.credentialId,
    });
    await source.manager.setAgentAccess({ enabled: true });
    const runtime = await createAgentApiRuntime({ serverId: source.id });
    cleanup.push(() => runtime.close());
    runtime.attachController(source.router);
    const lease = runtime.issue({
        principal: SUPERUSER,
        sessionId: () => "parent",
        management: true,
        peerAccess: true,
        peerGrantId: source.manager.agentAccess().grantId,
      }),
      token = lease.environment.AGENT_YA_V0_AUTHORIZATION!;
    const original = WebSocket.prototype.emit;
    spy = vi.spyOn(WebSocket.prototype, "emit").mockImplementation(function (
      this: WebSocket,
      ...args: Parameters<WebSocket["emit"]>
    ) {
      if (
        this.url === target.route.url &&
        args[0] === "message" &&
        args[2] === true
      )
        vi.setSystemTime(authority.expiresAt + 1);
      return original.apply(this, args);
    });
    const result = await nativeRequest(
      runtime,
      token,
      `/v0/servers/${target.id}/sessions`,
      {
        requestId: "fleet-source-late-reply",
        projectId: "p",
        provider: "codex",
        message: "accepted before response",
      },
    );
    expect(result.status).toBe(401);
    expect(target.starts()).toBe(1);
    const relationships = await nativeRequest(
      runtime,
      token,
      `/v0/servers/${source.id}/sessions/parent/relationships`,
    );
    expect(relationships.body.outbound.items).toMatchObject([
      { requestId: "fleet-source-late-reply", state: "uncertain" },
    ]);
  } finally {
    spy?.mockRestore();
    vi.useRealTimers();
  }
});

it("admits manual standby at 64 mixed credentials, retains the 64-target bound and permits replacement at 128", async () => {
  const f = await fixture(),
    source = await f.make(),
    target = await f.make();
  const policy = {
    projects: ["p"],
    operations,
    expiresAt: Date.now() + 600_000,
  };
  const r = (await source.json("/fleet/relationships", "POST", {
    targetClientId: target.client.id,
    policy,
  })) as AccessRelationship;
  const delivered = await target.json("/fleet/accept", "POST", {
    relationshipId: r.id,
    policy,
    route: target.route,
    acknowledgeExecutionAuthority: "server-account",
  });
  await source.json("/fleet/adopt", "POST", {
    envelopeId: delivered.envelopeId,
  });
  const original = source.manager.store.read().outgoing[0]!;
  if (original.origin !== "fleet") throw new Error("Expected fleet peer");
  await source.manager.store.mutate((next) => {
    for (let i = 0; i < 63; i++) {
      const id = randomUUID();
      next.outgoing.push({
        origin: "manual",
        invitation: {
          ...original.invitation,
          targetServerId: randomUUID(),
          credentialId: id,
          username: `peer-${id}`,
        },
        route: target.route,
        operations,
        allowAgentSessions: false,
      });
    }
  });
  const invitation = await target.manager.issue({
    sourceServerId: source.id,
    ...policy,
    acknowledgeExecutionAuthority: "server-account",
  });
  await source.manager.importOutgoing({
    invitation,
    route: target.route,
    operations,
    allowAgentSessions: false,
    replace: false,
  });
  expect(source.manager.store.read().outgoing).toHaveLength(65);
  expect(
    new Set(
      source.manager.store
        .read()
        .outgoing.map((p) => p.invitation.targetServerId),
    ).size,
  ).toBe(64);
  const excessId = randomUUID();
  await expect(
    source.manager.store.importOutgoing(
      {
        invitation: {
          ...invitation,
          targetServerId: randomUUID(),
          credentialId: excessId,
          username: `peer-${excessId}`,
        },
        route: target.route,
        operations,
        allowAgentSessions: false,
        replace: false,
      },
      source.manager.store.currentRevision(),
    ),
  ).rejects.toMatchObject({ code: "command_capacity" });
  await source.manager.store.mutate((next) => {
    for (const manual of next.outgoing.filter(
      (p) => p.origin === "manual" && p.invitation.targetServerId !== target.id,
    )) {
      const id = randomUUID();
      next.outgoing.push({
        ...original,
        invitation: {
          ...original.invitation,
          targetServerId: manual.invitation.targetServerId,
          credentialId: id,
          username: `peer-${id}`,
        },
        envelopeId: randomUUID(),
        binding: {
          ...original.binding,
          relationshipId: randomUUID(),
          target: {
            ...original.binding.target,
            id: randomUUID(),
            profileId: manual.invitation.targetServerId,
          },
        },
      });
    }
  });
  expect(source.manager.store.read().outgoing).toHaveLength(128);
  await source.manager.importOutgoing({
    invitation,
    route: target.route,
    operations,
    allowAgentSessions: false,
    replace: true,
  });
  expect(source.manager.store.read().outgoing).toHaveLength(128);
});
