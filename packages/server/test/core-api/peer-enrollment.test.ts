import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import { EMPTY_LIMITED_USER_GRANTS } from "@yep-anywhere/shared";
import { AuthService } from "../../src/auth/AuthService.js";
import { AgentServerTokens } from "../../src/auth/AgentServerTokens.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/routes.js";
import { SUPERUSER, type Principal } from "../../src/auth/principal.js";
import { createAuthMiddleware } from "../../src/middleware/auth.js";
import type { Operation } from "../../src/core-api/contracts.js";
import {
  AUTHENTICATED_SRP_TRANSPORT,
  type AuthenticatedSrpTransportContext,
} from "../../src/middleware/authenticated-transport.js";
import { createPeerOwnerProof } from "../../src/peer-api/owner-proof.js";
import { PeerAccessStore } from "../../src/peer-api/state.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function profile(id = randomUUID()) {
  const directory = await mkdtemp(join(tmpdir(), "ya-peer-enrollment-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new PeerAccessStore(id, directory);
  await store.initialize();
  cleanup.push(() => store.close());
  return { directory, store, id };
}
const permissions: Operation[] = [
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
const grant = () => ({
  projects: ["p"],
  operations: permissions,
  expiresAt: Date.now() + 60_000,
  acknowledgeExecutionAuthority: "server-account",
});

it("persists separate target/source credentials, rotates without changing the peer identity, and retains private relay registration across disablement", async () => {
  const a = await profile(),
    b = await profile();
  const invitation = await b.store.issue({ ...grant(), sourceServerId: a.id });
  const targetSaved = await readFile(b.store.path, "utf8");
  expect(targetSaved).not.toContain(invitation.secret);
  expect(JSON.parse(targetSaved).incoming[0]).toMatchObject({
    sourceServerId: a.id,
    id: invitation.credentialId,
    generation: 1,
  });
  const request = {
    invitation,
    operations: permissions,
    route: { kind: "direct" as const, url: "ws://127.0.0.1:3400/peer/ws" },
    allowAgentSessions: true,
    replace: false,
  };
  await a.store.importOutgoing(request, a.store.currentRevision());
  expect(await readFile(a.store.path, "utf8")).toContain(invitation.secret);
  await b.store.close();
  const restarted = new PeerAccessStore(b.id, b.directory);
  await restarted.initialize();
  cleanup.push(() => restarted.close());
  const rotated = await restarted.issue(grant(), invitation.credentialId);
  expect(rotated).toMatchObject({
    sourceServerId: a.id,
    credentialId: invitation.credentialId,
    generation: 2,
  });
  expect(rotated.secret).not.toBe(invitation.secret);
  expect(restarted.read().incoming).toHaveLength(1);
  await a.store.configureRelay({
    url: "wss://relay.example/ws",
    username: "peer-fixture",
  });
  const registration = a.store.read().relay!.registrationId;
  await a.store.removeRelay();
  expect(a.store.read().relay?.enabled).toBe(false);
  await a.store.configureRelay({
    url: "wss://relay.example/ws",
    username: "peer-fixture",
  });
  expect(a.store.read().relay).toMatchObject({
    enabled: true,
    registrationId: registration,
  });
  if (process.platform !== "win32") {
    expect((await stat(a.store.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(a.store.path)).mode & 0o777).toBe(0o600);
  }
});

it("fences stale preflight and pending rotation, and never restores an old native peer grant generation", async () => {
  const a = await profile(),
    b = await profile();
  const invitation = await b.store.issue({ ...grant(), sourceServerId: a.id });
  const beforePreflight = a.store.currentRevision();
  await a.store.revokeOutgoing(b.id);
  await expect(
    a.store.importOutgoing(
      {
        invitation,
        operations: permissions,
        route: { kind: "direct", url: "ws://127.0.0.1:3400/peer/ws" },
        allowAgentSessions: false,
        replace: false,
      },
      beforePreflight,
    ),
  ).rejects.toMatchObject({ code: "peer_record_conflict" });
  expect(a.store.read().outgoing).toEqual([]);
  const pending = b.store
    .issue(grant(), invitation.credentialId)
    .catch((error: unknown) => error);
  await b.store.revokeIncoming(invitation.credentialId);
  expect(await pending).toMatchObject({ code: "peer_record_conflict" });
  expect(b.store.read().incoming).toEqual([]);
  await a.store.setAgentAccess(true);
  const first = a.store.read().agentAccess.grantId;
  await a.store.setAgentAccess(false);
  await a.store.setAgentAccess(true);
  expect(a.store.read().agentAccess.grantId).not.toBe(first);
  await expect(
    a.store.issue({
      ...grant(),
      sourceServerId: b.id,
      acknowledgeExecutionAuthority: undefined,
    }),
  ).rejects.toMatchObject({ code: "invalid_request" });
});

it("fails closed on malformed profile state and on failed durable policy publication", async () => {
  const { directory, store, id } = await profile();
  let faults = 0;
  store.observe(
    () => {},
    () => {
      faults++;
    },
  );
  await rm(store.directory, { recursive: true, force: true });
  await writeFile(store.directory, "cannot use a file as a state directory", {
    mode: 0o600,
  });
  await expect(store.setAgentAccess(true)).rejects.toMatchObject({
    code: "peer_state_unavailable",
  });
  expect(() => store.read()).toThrow("Peer state is unavailable");
  expect(faults).toBe(1);
  await rm(store.directory);
  await store.close();
  const restored = new PeerAccessStore(id, directory);
  await restored.initialize();
  await restored.setAgentAccess(true);
  await restored.close();
  await writeFile(restored.path, '{"version":999}', { mode: 0o600 });
  const corrupt = new PeerAccessStore(id, directory);
  cleanup.push(() => corrupt.close());
  await expect(corrupt.initialize()).rejects.toMatchObject({
    code: "peer_state_unavailable",
  });
});

it("validates actual owner proof under auth-off, rejecting unknown cookies, limited sessions and legacy agent superusers", async () => {
  const { directory } = await profile();
  const auth = new AuthService({ dataDir: directory });
  await auth.initialize();
  const owner = await auth.createSession("owner"),
    limited = await auth.createSession("limited", "alice");
  const agents = new AgentServerTokens(() => true),
    legacy = agents.mint()!;
  const proof = createPeerOwnerProof({
    authService: auth,
    agentServerTokens: agents,
    remoteAccessService: { isEnabled: () => true, getUsername: () => "owner" },
  });
  let actor: Principal = SUPERUSER;
  const app = new Hono<{ Variables: { yaPrincipal: Principal } }>();
  app.use(
    "*",
    createAuthMiddleware({
      authService: auth,
      authDisabled: true,
      agentServerTokens: agents,
    }),
  );
  app.use("*", async (c, next) => {
    c.set("yaPrincipal", actor);
    await next();
  });
  app.get("/proof", async (c) => c.json({ owner: await proof(c) }));
  const check = async (cookie?: string, authorization?: string) =>
    (
      await (
        await app.request("/proof", {
          headers: {
            ...(cookie ? { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` } : {}),
            ...(authorization ? { Authorization: authorization } : {}),
          },
        })
      ).json()
    ).owner;
  expect(await check()).toBe(false);
  expect(await check("unknown-session")).toBe(false);
  expect(await check(limited)).toBe(false);
  expect(await check(owner)).toBe(true);
  expect(await check(owner, `Bearer ${legacy.token}`)).toBe(false);
  actor = {
    kind: "limited",
    username: "alice",
    grants: EMPTY_LIMITED_USER_GRANTS,
    switched: true,
    locked: false,
    via: "direct",
  };
  expect(await check(owner)).toBe(false);
  actor = SUPERUSER;
  let active = true;
  const srp: AuthenticatedSrpTransportContext = {
    kind: "srp",
    username: "owner",
    sessionId: "owned-live-srp-session",
    transportNonce: "owned-transport-nonce",
    authenticationMethod: "srp-full",
    transport: "direct",
    connectionId: "owned-connection",
    isActive: () => active,
    closeConnection: () => {},
    closeAfterResponse: () => {},
    deferAfterResponse: () => {},
  };
  const checkSrp = async () =>
    (
      await (
        await app.request("/proof", {}, { [AUTHENTICATED_SRP_TRANSPORT]: srp })
      ).json()
    ).owner;
  expect(await checkSrp()).toBe(true);
  active = false;
  expect(await checkSrp()).toBe(false);
  delete srp.isActive;
  expect(await checkSrp()).toBe(false);
  await auth.invalidateSession(owner);
  expect(await check(owner)).toBe(false);
  await auth.waitForPendingWrites();
});
