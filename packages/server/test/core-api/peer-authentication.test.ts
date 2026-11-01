import { CoreApiError } from "../../src/core-api/errors.js";
import { PeerConnections } from "../../src/peer-api/connections.js";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PeerAccessStore } from "../../src/peer-api/state.js";
import { hashPeerToken } from "../../src/peer-api/directory.js";
import {
  PEER_ACCESS_MS,
  PEER_AUTHENTICATION,
  PEER_IDLE_MS,
} from "../../src/peer-api/authentication-contracts.js";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it("durably replays refresh without sliding time, rejects stale operations and keeps policy unchanged across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ya-peer-refresh-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const id = randomUUID();
  let now = Date.now();
  const store = new PeerAccessStore(id, directory, () => now);
  await store.initialize();
  cleanup.push(() => store.close());
  const invitation = await store.issue({
    sourceServerId: randomUUID(),
    projects: [],
    allProjects: true,
    operations: ["projects"],
    authentication: PEER_AUTHENTICATION,
    expiresAt: now + PEER_IDLE_MS,
  });
  const proof = {
    credentialId: invitation.credentialId,
    generation: invitation.generation,
    tokenHash: hashPeerToken(invitation.secret),
  };
  const token = randomBytes(32).toString("base64url");
  const request = {
    requestId: randomUUID(),
    sequence: 1,
    tokenHash: hashPeerToken(token),
  };
  const revision = store.currentRevision();
  const first = await store.refreshAuthentication(request, proof, () => {});
  expect(first.expiresAt).toBe(now + PEER_ACCESS_MS);
  expect(store.currentRevision()).toBe(revision);
  expect(await readFile(store.path, "utf8")).not.toContain(token);
  await store.close();
  now += 2 * PEER_ACCESS_MS;
  const restarted = new PeerAccessStore(id, directory, () => now);
  await restarted.initialize();
  cleanup.push(() => restarted.close());
  expect(
    await restarted.refreshAuthentication(request, proof, () => {}),
  ).toEqual(first);
  await expect(
    restarted.refreshAuthentication(
      { ...request, tokenHash: hashPeerToken("other") },
      proof,
      () => {},
    ),
  ).rejects.toMatchObject({ status: 409 });
  for (const sequence of [2, 3])
    await restarted.refreshAuthentication(
      {
        requestId: randomUUID(),
        sequence,
        tokenHash: hashPeerToken(String(sequence)),
      },
      proof,
      () => {},
    );
  await expect(
    restarted.refreshAuthentication(request, proof, () => {}),
  ).rejects.toMatchObject({ status: 409 });
  now += PEER_IDLE_MS;
  await expect(
    restarted.refreshAuthentication(
      { requestId: randomUUID(), sequence: 4, tokenHash: hashPeerToken("4") },
      proof,
      () => {},
    ),
  ).rejects.toMatchObject({ status: 401 });
});
it("does not turn a deliberately expiring manual grant into an automatic connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ya-peer-refresh-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new PeerAccessStore(randomUUID(), directory);
  await store.initialize();
  cleanup.push(() => store.close());
  const invitation = await store.issue({
    sourceServerId: randomUUID(),
    projects: ["p"],
    operations: ["projects"],
    expiresAt: Date.now() + 60_000,
  });
  await expect(
    store.refreshAuthentication(
      {
        requestId: randomUUID(),
        sequence: 1,
        tokenHash: hashPeerToken("candidate"),
      },
      {
        credentialId: invitation.credentialId,
        generation: 1,
        tokenHash: hashPeerToken(invitation.secret),
      },
      () => {},
    ),
  ).rejects.toMatchObject({ status: 403 });
});

import { protectedProfile } from "./peer-fixture.js";
import { SrpPeerTransport } from "../../src/peer-api/srp-client.js";
import { PeerAuthentication } from "../../src/peer-api/authentication.js";
import { PeerChannelBudget } from "../../src/peer-api/srp-protocol.js";
import { PeerDirectory } from "../../src/peer-api/directory.js";
import { createRelayServer } from "../../../relay/src/server.js";

it.each(["direct", "relay"] as const)(
  "refreshes over real %s SRP and uses access credentials for session creation, messaging and reads",
  async (kind) => {
    const a = await protectedProfile(cleanup),
      b = await protectedProfile(cleanup);
    let route = b.route as import("../../src/peer-api/state.js").PeerRoute;
    if (kind === "relay") {
      const relay = await createRelayServer({
        inMemoryDb: true,
        disableTelemetry: true,
        logLevel: "silent",
        disablePrettyPrint: true,
        webSocketMaxMessageBytes: 384 * 1024,
      });
      cleanup.push(() => relay.close());
      const url = `ws://127.0.0.1:${relay.port}/ws`;
      await b.manager.store.configureRelay({
        url,
        username: "peer-refresh-test",
      });
      await b.manager.waitForRelay(AbortSignal.timeout(5000));
      route = { kind: "relay", url, username: "peer-refresh-test" };
    }
    const operations = [
      "projects",
      "session",
      "createSession",
      "sendMessage",
      "receipt",
      "followReceipt",
    ] as const;
    const invitation = await b.manager.issue({
      sourceServerId: a.id,
      projects: ["p"],
      operations: [...operations],
      authentication: PEER_AUTHENTICATION,
      expiresAt: Date.now() + PEER_IDLE_MS,
      acknowledgeExecutionAuthority: "server-account",
    });
    await a.manager.importOutgoing({
      invitation,
      route,
      operations: [...operations],
      allowAgentSessions: true,
      replace: false,
    });
    const revision = a.manager.store.currentRevision(),
      targetRevision = b.manager.store.currentRevision();
    expect(await a.read("projects", { serverId: b.id })).toMatchObject({
      items: [{ id: "p" }],
    });
    const peer = a.manager.store.read().outgoing[0]!;
    expect(peer.authentication?.current?.token).toBeTruthy();
    expect(
      b.manager.store.read().incoming[0]?.authentication?.access,
    ).toHaveLength(1);
    expect(a.manager.store.currentRevision()).toBe(revision);
    expect(b.manager.store.currentRevision()).toBe(targetRevision);
    const created = (await a.read("createSession", {
      serverId: b.id,
      body: {
        requestId: "refresh-create-001",
        projectId: "p",
        provider: "codex",
        message: "Review",
        permissionMode: "default",
      },
    })) as { sessionId: string };
    const followed = (await a.read("followReceipt", {
      serverId: b.id,
      receiptId: (created as unknown as { id: string }).id,
      query: { waitMs: "0" },
    })) as { receipt: { sessionId: string } };
    expect(followed.receipt.sessionId).toBe("created-1");
    await a.read("sendMessage", {
      serverId: b.id,
      sessionId: "created-1",
      body: { requestId: "refresh-message-001", message: "Continue" },
    });
    expect(b.starts()).toBe(1);
    expect(b.sends()).toBe(1);
    const budget = new PeerChannelBudget();
    cleanup.push(() => budget.close());
    const raw = new SrpPeerTransport(peer.invitation, route, budget);
    await expect(
      raw.request(
        "projects",
        { serverId: b.id },
        { sessionId: null, launchId: null },
      ),
    ).rejects.toMatchObject({ status: 401 });
    await b.manager.store.revokeIncoming(invitation.credentialId);
    await expect(a.read("projects", { serverId: b.id })).rejects.toMatchObject({
      status: 401,
    });
  },
);

it("recovers a target-accepted lost refresh reply from the durable source candidate", async () => {
  const a = await protectedProfile(cleanup),
    b = await protectedProfile(cleanup);
  const invitation = await b.manager.issue({
    sourceServerId: a.id,
    projects: ["p"],
    operations: ["projects"],
    authentication: PEER_AUTHENTICATION,
    expiresAt: Date.now() + PEER_IDLE_MS,
  });
  // Pause only the source scheduler to inject a lost acknowledgement deterministically.
  await a.manager.authentication.close();
  await a.manager.importOutgoing({
    invitation,
    route: b.route,
    operations: ["projects"],
    allowAgentSessions: false,
    replace: false,
  });
  const budget = new PeerChannelBudget();
  cleanup.push(() => budget.close());
  let lose = true;
  const authentication = new PeerAuthentication(
    a.manager.store,
    () => true,
    (peer) => {
      const transport = new SrpPeerTransport(
          peer.invitation,
          peer.route,
          budget,
        ),
        refresh = transport.refresh.bind(transport);
      transport.refresh = async (body, signal) => {
        const receipt = await refresh(body, signal);
        if (lose) {
          lose = false;
          throw new Error("Lost reply");
        }
        return receipt;
      };
      return transport;
    },
  );
  cleanup.push(() => authentication.close().then(() => {}));
  const peer = a.manager.store.read().outgoing[0]!;
  await expect(authentication.refresh(peer)).rejects.toThrow("Lost reply");
  const pending = a.manager.store.read().outgoing[0]!.authentication!.pending!;
  const receipt =
    b.manager.store.read().incoming[0]!.authentication!.access[0]!;
  expect(receipt.requestId).toBe(pending.requestId);
  await authentication.close();
  await a.manager.store.mutate((next) => {
    next.outgoing[0]!.invitation.expiresAt = Date.now() - 1;
  });
  await a.manager.store.close();
  const now = Date.now() + 90_000;
  const recovered = new PeerAccessStore(a.id, a.directory, () => now);
  await recovered.initialize();
  cleanup.push(() => recovered.close());
  const restarted = new PeerAuthentication(
    recovered,
    () => true,
    (p) => new SrpPeerTransport(p.invitation, p.route, budget),
    () => now,
  );
  cleanup.push(() => restarted.close().then(() => {}));
  expect(await restarted.refresh(recovered.read().outgoing[0]!)).toBe(
    pending.token,
  );
  expect(b.manager.store.read().incoming[0]!.authentication!.access).toEqual([
    receipt,
  ]);
  expect(recovered.read().outgoing[0]!.authentication!.pending).toBeUndefined();
});

it("does not abort admitted observations when updating access slots, but revocation does", () => {
  const token = randomBytes(32).toString("base64url"),
    id = randomUUID();
  const directory = new PeerDirectory([
    {
      id,
      serverId: randomUUID(),
      tokenHash: hashPeerToken("pairing"),
      projects: ["p"],
      operations: ["projects"],
      expiresAt: Date.now() + PEER_IDLE_MS,
      access: [
        { tokenHash: hashPeerToken(token), expiresAt: Date.now() + 60_000 },
      ],
    },
  ]);
  const admitted = directory.authenticate(token, {
    sessionId: null,
    launchId: null,
  });
  directory.updateAuthentication(id, Date.now() + PEER_IDLE_MS, []);
  expect(() => admitted.principal.assertActive()).not.toThrow();
  expect(admitted.principal.signal.aborted).toBe(false);
  expect(() =>
    directory.authenticate(token, { sessionId: null, launchId: null }),
  ).toThrow();
  directory.revoke(id);
  expect(admitted.principal.signal.aborted).toBe(true);
  admitted.release();
  directory.close();
});

import { vi } from "vitest";
it("renews a quiet profile after the old 30-day boundary and fences a late accepted refresh after removal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ya-peer-refresh-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let now = Date.now();
  const sourceId = randomUUID(),
    targetId = randomUUID();
  const source = new PeerAccessStore(
      sourceId,
      join(directory, "source"),
      () => now,
    ),
    target = new PeerAccessStore(
      targetId,
      join(directory, "target"),
      () => now,
    );
  await source.initialize();
  await target.initialize();
  cleanup.push(() => source.close());
  cleanup.push(() => target.close());
  const invitation = await target.issue({
    sourceServerId: sourceId,
    projects: ["p"],
    operations: ["projects"],
    authentication: PEER_AUTHENTICATION,
    expiresAt: now + PEER_IDLE_MS,
  });
  const route = { kind: "direct" as const, url: "ws://127.0.0.1:1/peer/ws" };
  await source.importOutgoing(
    {
      invitation,
      route,
      operations: ["projects"],
      allowAgentSessions: false,
      replace: false,
    },
    source.currentRevision(),
  );
  let hold: Promise<void> | undefined,
    entered: () => void = () => {};
  const budget = new PeerChannelBudget();
  cleanup.push(() => budget.close());
  const authentication = new PeerAuthentication(
    source,
    () => true,
    (peer) => {
      const transport = new SrpPeerTransport(
        peer.invitation,
        peer.route,
        budget,
      );
      transport.refresh = async (body, signal) => {
        const result = await target.refreshAuthentication(
          body,
          {
            credentialId: invitation.credentialId,
            generation: 1,
            tokenHash: hashPeerToken(invitation.secret),
          },
          () => signal.throwIfAborted(),
        );
        entered();
        if (hold) await hold;
        return result;
      };
      return transport;
    },
    () => now,
  );
  cleanup.push(() => authentication.close().then(() => {}));
  const peer = source.read().outgoing[0]!;
  await authentication.refresh(peer);
  const first = source.read().outgoing[0]!.authentication!.current!;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    now += 31 * 24 * 60 * 60_000;
    authentication.changed();
    await vi.advanceTimersByTimeAsync(30);
    await vi.waitFor(() =>
      expect(source.read().outgoing[0]!.authentication!.current!.sequence).toBe(
        2,
      ),
    );
    expect(source.read().outgoing[0]!.invitation.expiresAt).toBe(
      now + PEER_IDLE_MS,
    );
    expect(
      source.read().outgoing[0]!.authentication!.current!.requestId,
    ).not.toBe(first.requestId);
  } finally {
    vi.useRealTimers();
  }
  let release!: () => void;
  hold = new Promise((resolve) => {
    release = resolve;
  });
  const accepted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const refreshing = authentication.refresh(source.read().outgoing[0]!);
  await accepted;
  await source.revokeOutgoing(targetId);
  release();
  await expect(refreshing).rejects.toMatchObject({ status: 401 });
  expect(source.read().outgoing).toHaveLength(0);
});

it("persists cooldown after an attempt timeout, coalesces callers, and stops an expired disconnected pair", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ya-peer-refresh-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let now = Date.now();
  const source = new PeerAccessStore(randomUUID(), directory, () => now);
  await source.initialize();
  cleanup.push(() => source.close());
  const credentialId = randomUUID(),
    secret = randomBytes(32).toString("base64url");
  await source.importOutgoing(
    {
      invitation: {
        version: 1,
        authentication: PEER_AUTHENTICATION,
        sourceServerId: source.serverId,
        targetServerId: randomUUID(),
        credentialId,
        generation: 1,
        username: `peer-${credentialId}`,
        secret,
        expiresAt: now + PEER_IDLE_MS,
      },
      route: { kind: "direct", url: "ws://127.0.0.1:1/peer/ws" },
      operations: ["projects"],
      allowAgentSessions: false,
      replace: false,
    },
    source.currentRevision(),
  );
  const budget = new PeerChannelBudget();
  cleanup.push(() => budget.close());
  let dispatches = 0;
  const deadline = new AbortController();
  const authentication = new PeerAuthentication(
    source,
    () => true,
    (peer) => {
      const transport = new SrpPeerTransport(
        peer.invitation,
        peer.route,
        budget,
      );
      transport.refresh = async (_body, signal) => {
        dispatches++;
        return await import("../../src/peer-api/srp-protocol.js").then(
          ({ awaitPeerWork }) =>
            awaitPeerWork(new Promise<never>(() => {}), signal),
        );
      };
      return transport;
    },
    () => now,
    () => deadline.signal,
  );
  cleanup.push(() => authentication.close().then(() => {}));
  const peer = source.read().outgoing[0]!;
  const first = authentication.refresh(peer),
    second = authentication.refresh(peer);
  expect(second).toBe(first);
  await vi.waitFor(() => expect(dispatches).toBe(1));
  deadline.abort();
  await expect(first).rejects.toMatchObject({ status: 503 });
  expect(source.read().outgoing[0]!.authentication).toMatchObject({
    status: "unavailable",
    failures: 1,
  });
  expect(
    source.read().outgoing[0]!.authentication!.retryAt,
  ).toBeGreaterThanOrEqual(now + 60_000);
  await expect(authentication.refresh(peer)).rejects.toMatchObject({
    status: 503,
  });
  expect(dispatches).toBe(1);
  await authentication.close();
  now += PEER_IDLE_MS + 1;
  await source.publishPeerAuthentication((next) => {
    next.outgoing[0]!.authentication = undefined;
  });
  const expired = new PeerAuthentication(
    source,
    () => true,
    () => {
      throw new Error("Expired pair must not dispatch");
    },
    () => now,
  );
  cleanup.push(() => expired.close().then(() => {}));
  await expect(
    expired.refresh(source.read().outgoing[0]!),
  ).rejects.toMatchObject({ status: 401 });
  expect(source.read().outgoing[0]!.authentication).toMatchObject({
    status: "sign-in-required",
  });
  expect(source.read().outgoing[0]!.authentication?.pending).toBeUndefined();
});

import { operations as coreOperations } from "../../src/core-api/contracts.js";
import { localPeerHost } from "../../src/peer-api/connection-contracts.js";
it("keeps an older target usable and rechecks automatic migration after that target upgrades", async () => {
  const a = await protectedProfile(cleanup),
    b = await protectedProfile(cleanup);
  b.sources.peerAuthentication = () => false;
  const operations = coreOperations
      .filter((op) => op.path.includes(":serverId"))
      .map((op) => op.id),
    operationId = randomUUID();
  const invitation = await b.manager.issue(
    {
      sourceServerId: a.id,
      allProjects: true,
      projects: [],
      operations,
      expiresAt: Date.now() + 30 * 24 * 60 * 60_000,
      acknowledgeExecutionAuthority: "server-account",
    },
    undefined,
    undefined,
    undefined,
    localPeerHost(a.id),
    operationId,
  );
  const publication = vi
    .spyOn(a.manager.store, "publishPeerAuthentication")
    .mockRejectedValueOnce(
      new CoreApiError("command_capacity", "Busy writer", 503),
    );
  await a.manager.importOutgoing(
    {
      invitation,
      route: b.route,
      operations,
      allowAgentSessions: true,
      replace: false,
    },
    undefined,
    undefined,
    localPeerHost(b.id),
    undefined,
    operationId,
  );
  const budget = new PeerChannelBudget();
  cleanup.push(() => budget.close());
  const authentication = a.manager.authentication;
  const peer = a.manager.store.read().outgoing[0]!;
  await expect(authentication.refresh(peer)).rejects.toMatchObject({
    status: 501,
  });
  expect(
    a.manager.store.read().outgoing[0]!.authentication?.pending,
  ).toBeUndefined();
  expect(
    await new SrpPeerTransport(invitation, b.route, budget).request(
      "projects",
      { serverId: b.id },
      { sessionId: null, launchId: null },
    ),
  ).toMatchObject({ items: [{ id: "p" }] });
  b.sources.peerAuthentication = () => true;
  publication.mockRestore();
  await new PeerConnections(a.manager).test(
    b.id,
    () => {},
    AbortSignal.timeout(5000),
  );
  const token =
    a.manager.store.read().outgoing[0]!.authentication!.current!.token;
  expect(token).not.toBe(invitation.secret);
  expect(a.manager.store.read().outgoing[0]!.invitation.authentication).toBe(
    PEER_AUTHENTICATION,
  );
  expect(
    b.manager.store.read().incoming[0]!.authentication?.access,
  ).toHaveLength(1);
});
