import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as identityServiceCrypto from "../../src/identity-service/crypto.js";
import * as atomicFiles from "../../src/utils/writeFileAtomically.js";
import * as jose from "jose";
import { IdentityServiceClient } from "../../src/identity-service/client.js";
import {
  generateIdentityServiceProfileKeys,
  publicIdentityServiceKey,
  verifyIdentityServicePeerJwt,
} from "../../src/identity-service/crypto.js";
import { createIdentityService } from "../../src/identity-service/service.js";
import { IdentityServiceStore } from "../../src/identity-service/store.js";
import type { IdentityServiceCredentials } from "../../src/identity-service/auth.js";
import type { AccessRelationship } from "../../src/identity-service/contracts.js";
import { passwordFromStdin } from "../../src/identity-service/main.js";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of clean.splice(0).reverse()) await stop();
});
async function fixture(secondAccount = false) {
  const directory = await mkdtemp(join(tmpdir(), "ya-fleet-"));
  clean.push(() => rm(directory, { recursive: true, force: true }));
  const issuer = "http://127.0.0.1:45678";
  const store = new IdentityServiceStore(directory, issuer, true);
  await store.initialize();
  clean.push(() => store.close());
  const accountId = await store.provisionLocal("alice", "a long test password");
  if (secondAccount)
    await store.provisionLocal("bob", "a separate long password");
  let now = Date.now();
  const service = createIdentityService(store, { now: () => now });
  const requests: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return service.app.fetch(request);
  };
  const client = async () => {
    const keys = await generateIdentityServiceProfileKeys();
    let saved!: IdentityServiceCredentials;
    const http = new IdentityServiceClient(issuer, randomUUID(), keys, {
      allowInsecureLoopback: true,
      fetch: fetcher,
      now: () => now,
      publish: async (c) => {
        saved = c;
      },
      remove: async () => {},
    });
    await http.basicLogin("Alice", "a long test password", "test host");
    return { http, keys, credentials: () => saved };
  };
  return {
    directory,
    issuer,
    store,
    accountId,
    service,
    requests,
    client,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it("enrolls two key-bound clients, delivers opaque directional proposals and bounds issuer tokens", async () => {
  const f = await fixture(),
    source = await f.client(),
    target = await f.client();
  expect(f.store.read().clients).toHaveLength(2);
  const policy = {
    projects: ["p"],
    operations: [
      "server",
      "access",
      "capabilities",
      "session",
      "createSession",
      "prompt",
      "followConversation",
    ],
    expiresAt: Date.now() + 600_000,
  };
  const relationship = (await source.http.request("/relationships", "POST", {
    targetClientId: target.credentials().client.id,
    policy,
  })) as AccessRelationship;
  await expect(
    source.http.request(`/relationships/${relationship.id}/token`, "POST"),
  ).rejects.toMatchObject({ code: "not_accepted" });
  const envelopeId = randomUUID(),
    credentialId = randomUUID();
  const envelope = {
    envelopeId,
    credentialId,
    credentialGeneration: 1,
    policy,
    ciphertext: "one.two.three.four.five",
  };
  await expect(
    source.http.request(
      `/relationships/${relationship.id}/envelope`,
      "PUT",
      envelope,
    ),
  ).rejects.toMatchObject({ status: 404 });
  await target.http.request(
    `/relationships/${relationship.id}/envelope`,
    "PUT",
    envelope,
  );
  await target.http.request(
    `/relationships/${relationship.id}/envelope`,
    "PUT",
    envelope,
  );
  const mailbox = (await source.http.request("/mailbox")) as {
    items: unknown[];
  };
  expect(mailbox.items).toHaveLength(1);
  expect(JSON.stringify(mailbox)).not.toContain("one.two");
  await expect(
    target.http.request(`/mailbox/${envelopeId}`),
  ).rejects.toMatchObject({ status: 404 });
  expect(await source.http.request(`/mailbox/${envelopeId}`)).toMatchObject({
    ciphertext: envelope.ciphertext,
  });
  const issued = (await source.http.request(
    `/relationships/${relationship.id}/token`,
    "POST",
  )) as { token: string };
  const peer = await verifyIdentityServicePeerJwt(
    issued.token,
    publicIdentityServiceKey(f.store.read().signingKey),
    f.issuer,
    target.http.profileId,
    Date.now(),
  );
  expect(peer.ya).toMatchObject({
    accountId: f.accountId,
    sourceProfileId: source.http.profileId,
    credentialId,
  });
  expect(peer.exp - peer.iat).toBeLessThanOrEqual(290);
  await source.http.request(`/mailbox/${envelopeId}/ack`, "POST");
  await target.http.request(
    `/relationships/${relationship.id}/envelope`,
    "PUT",
    envelope,
  );
  expect(
    ((await source.http.request("/mailbox")) as { items: unknown[] }).items,
  ).toEqual([]);
  await target.http.request(`/relationships/${relationship.id}`, "DELETE");
  await expect(
    source.http.request(`/relationships/${relationship.id}/token`, "POST"),
  ).rejects.toMatchObject({ status: 404 });
  // A token already issued is bounded offline authority, not immediately remotely revoked.
  expect(jose.decodeJwt(issued.token).exp).toBe(peer.exp);
});

it("consumes nonces and refresh once, fences old families and refuses key replacement", async () => {
  const f = await fixture(),
    source = await f.client();
  const old = source.credentials();
  await source.http.request("/me");
  const accepted = f.requests
    .filter((r) => new URL(r.url).pathname === "/fleet/v0/me")
    .at(-1)!;
  const replay = await f.service.app.fetch(accepted.clone());
  expect(replay.status).toBe(401);
  expect(replay.headers.get("www-authenticate")).toContain("use_dpop_nonce");
  const before = old.refreshToken;
  f.advance(286_000);
  await source.http.request("/me");
  expect(source.credentials().refreshToken).not.toBe(before);
  const obsolete = new IdentityServiceClient(
    f.issuer,
    source.http.profileId,
    source.keys,
    {
      allowInsecureLoopback: true,
      fetch: async (input, init) =>
        f.service.app.fetch(new Request(input, init)),
      now: () => Date.now() + 286_000,
    },
  );
  obsolete.restore(old);
  await expect(obsolete.request("/me")).rejects.toMatchObject({ status: 401 });
  // Reauthentication reuses the client but retires its old session family.
  const oldFamily = source.credentials();
  await source.http.basicLogin("alice", "a long test password", "renamed");
  expect(source.credentials().client.id).toBe(oldFamily.client.id);
  expect(f.store.read().sessions).toHaveLength(1);
  const impostor = new IdentityServiceClient(
    f.issuer,
    source.http.profileId,
    await generateIdentityServiceProfileKeys(),
    {
      allowInsecureLoopback: true,
      fetch: async (input, init) =>
        f.service.app.fetch(new Request(input, init)),
      now: () => Date.now() + 286_000,
    },
  );
  await expect(
    impostor.basicLogin("alice", "a long test password", "changed key"),
  ).rejects.toMatchObject({ status: 409 });
  await f.store.provisionLocal("alice", "a different long password");
  await expect(source.http.request("/me")).rejects.toMatchObject({
    status: 401,
  });
});

it("exclusively owns a durable identity, survives restart and never regenerates missing or corrupt state", async () => {
  const f = await fixture(),
    source = await f.client(),
    serviceId = f.store.read().serviceId;
  const competing = new IdentityServiceStore(f.directory, f.issuer, true);
  await expect(competing.initialize()).rejects.toMatchObject({
    code: "fleet_state_unavailable",
  });
  await f.store.close();
  const resumed = new IdentityServiceStore(f.directory, f.issuer, true);
  await resumed.initialize();
  expect(resumed.read().serviceId).toBe(serviceId);
  expect(resumed.read().clients[0]?.id).toBe(source.credentials().client.id);
  await resumed.close();
  const saved = await readFile(resumed.path, "utf8");
  await writeFile(resumed.path, "{corrupt", { mode: 0o600 });
  await expect(
    new IdentityServiceStore(f.directory, f.issuer, true).initialize(),
  ).rejects.toMatchObject({ code: "fleet_state_unavailable" });
  expect(await readFile(resumed.path, "utf8")).toBe("{corrupt");
  await writeFile(resumed.path, saved, { mode: 0o600 });
  await rm(resumed.path);
  await expect(
    new IdentityServiceStore(f.directory, f.issuer, true).initialize(),
  ).rejects.toMatchObject({ code: "fleet_state_unavailable" });
});

it("requires reauthentication after a lost refresh response and never extends the absolute family", async () => {
  const f = await fixture(),
    keys = await generateIdentityServiceProfileKeys(),
    profileId = randomUUID();
  let saved!: IdentityServiceCredentials,
    drop = false;
  const http = new IdentityServiceClient(f.issuer, profileId, keys, {
    allowInsecureLoopback: true,
    now: () => clock,
    publish: async (credentials) => {
      saved = credentials;
    },
    remove: async () => {},
    fetch: async (input, init) => {
      const request = new Request(input, init),
        response = await f.service.app.fetch(request);
      if (
        drop &&
        new URL(request.url).pathname === "/fleet/v0/refresh" &&
        response.ok
      ) {
        drop = false;
        throw new Error("owned lost response");
      }
      return response;
    },
  });
  let clock = Date.now();
  await http.basicLogin("alice", "a long test password", "lost refresh host");
  const inaccessible = saved;
  f.advance(286_000);
  clock += 286_000;
  drop = true;
  await expect(http.request("/me")).rejects.toThrow("owned lost response");
  await expect(http.request("/me")).rejects.toMatchObject({
    code: "login_required",
  });
  http.restore(inaccessible);
  await expect(http.request("/me")).rejects.toMatchObject({ status: 401 });
  await http.basicLogin("alice", "a long test password", "recovered host");
  expect(saved.client.id).toBe(inaccessible.client.id);
  const absolute = saved.familyExpiresAt;
  const jump = 30 * 86_400_000 - 5000;
  f.advance(jump);
  clock += jump;
  await http.request("/me");
  expect(saved.familyExpiresAt).toBe(absolute);
  expect(jose.decodeJwt(saved.accessToken).exp! * 1000).toBeLessThanOrEqual(
    absolute,
  );
  expect(jose.decodeJwt(saved.refreshToken).exp! * 1000).toBeLessThanOrEqual(
    absolute,
  );
  f.advance(6000);
  clock += 6000;
  await expect(http.request("/me")).rejects.toMatchObject({
    code: "login_required",
  });
});

it("replaces expired proposals and permits a fresh pinned identity only after explicit revocation", async () => {
  const f = await fixture(),
    source = await f.client(),
    target = await f.client();
  const proposal = {
    targetClientId: target.credentials().client.id,
    policy: {
      projects: ["p"],
      operations: ["server"],
      expiresAt: Date.now() + 20_000,
    },
  };
  const first = (await source.http.request(
    "/relationships",
    "POST",
    proposal,
  )) as AccessRelationship;
  f.advance(21_000);
  proposal.policy.expiresAt += 60_000;
  const second = (await source.http.request(
    "/relationships",
    "POST",
    proposal,
  )) as AccessRelationship;
  expect(second.id).not.toBe(first.id);
  expect(f.store.read().relationships).toHaveLength(1);
  await source.http.request(
    `/clients/${target.credentials().client.id}`,
    "DELETE",
  );
  const recovered = new IdentityServiceClient(
    f.issuer,
    target.http.profileId,
    await generateIdentityServiceProfileKeys(),
    {
      allowInsecureLoopback: true,
      now: () => Date.now() + 21_000,
      fetch: async (input, init) =>
        f.service.app.fetch(new Request(input, init)),
    },
  );
  const client = await recovered.basicLogin(
    "alice",
    "a long test password",
    "explicitly recovered",
  );
  expect(client.id).not.toBe(target.credentials().client.id);
  await expect(target.http.request("/me")).rejects.toMatchObject({
    status: 401,
  });
  const oldKid = (await f.service.auth.jwks()).keys[0]!.kid;
  await f.store.rotateSigningKey();
  expect((await f.service.auth.jwks()).keys.map((k) => k.kid)).toContain(
    oldKid,
  );
  await source.http.request("/me"); // old access tokens remain valid while explicitly retained.
});

it("refuses oversized policies before publication and fences a revoked introduction across signing", async () => {
  const f = await fixture(),
    source = await f.client(),
    target = await f.client();
  const policy = {
    projects: Array.from({ length: 4 }, (_, i) => String(i).repeat(4000)),
    operations: ["server"],
    expiresAt: Date.now() + 60_000,
  };
  await expect(
    source.http.request("/relationships", "POST", {
      targetClientId: target.credentials().client.id,
      policy,
    }),
  ).rejects.toMatchObject({ code: "invalid_request" });
  expect(f.store.read().relationships).toEqual([]);
  policy.projects = policy.projects.slice(0, 2);
  expect(
    await source.http.request("/relationships", "POST", {
      targetClientId: target.credentials().client.id,
      policy,
    }),
  ).toMatchObject({ policy });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
  const original = identityServiceCrypto.signIdentityServiceJwt;
  const spy = vi
    .spyOn(identityServiceCrypto, "signIdentityServiceJwt")
    .mockImplementation(async (...args) => {
      if (args[2] === "ya-client-introduction+jwt") {
        entered();
        await hold;
      }
      return original(...args);
    });
  const introduced = source.http.request(
    `/clients/${target.credentials().client.id}`,
  );
  const checked = expect(introduced).rejects.toMatchObject({ status: 404 });
  try {
    await started;
    await target.http.request(
      `/clients/${target.credentials().client.id}`,
      "DELETE",
    );
  } finally {
    release();
    await checked;
    spy.mockRestore();
  }
});

it("fences pre-revocation bootstrap authority, reclaims retired capacity, and preserves overload status", async () => {
  const f = await fixture(),
    source = await f.client(),
    target = await f.client();
  const pending = await f.service.auth.pending(
    f.store.read().accounts[0]!,
    {
      profileId: target.http.profileId,
      displayName: "pending",
      signingKey: publicIdentityServiceKey(target.keys.signing),
      encryptionKey: publicIdentityServiceKey(target.keys.encryption),
    },
    30 * 86_400_000,
  );
  await f.store.mutate((state) => {
    for (let i = state.clients.length; i < 256; i++)
      state.clients.push({
        ...target.credentials().client,
        id: randomUUID(),
        profileId: randomUUID(),
      });
  });
  await source.http.request(
    `/clients/${target.credentials().client.id}`,
    "DELETE",
  );
  await expect(
    target.http.completeEnrollment(pending.token),
  ).rejects.toMatchObject({ status: 401 });
  await f.client();
  expect(f.store.read().clients).toHaveLength(256);
  expect(
    f.store.read().clients.some((c) => c.id === target.credentials().client.id),
  ).toBe(false);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const jobs = Array.from({ length: 8 }, () =>
    f.service.auth.crypto.run(() => hold),
  );
  try {
    const before = f.store.read().sessions;
    await expect(source.http.request("/me")).rejects.toMatchObject({
      status: 503,
      code: "capacity",
    });
    expect(f.store.read().sessions).toEqual(before);
  } finally {
    release();
    await Promise.all(jobs);
  }
  const unicode = "long password with é and 🐈";
  const bytes = Buffer.from(unicode + "\n");
  async function* input() {
    for (const byte of bytes) yield Uint8Array.of(byte);
  }
  const decoded = await passwordFromStdin(input());
  expect(decoded).toBe(unicode);
  await source.http.request(
    `/clients/${source.credentials().client.id}`,
    "DELETE",
  );
  await f.store.provisionLocal("unicode", decoded);
  const http = new IdentityServiceClient(
    f.issuer + "/",
    randomUUID(),
    await generateIdentityServiceProfileKeys(),
    {
      allowInsecureLoopback: true,
      fetch: async (input, init) =>
        f.service.app.fetch(new Request(input, init)),
    },
  );
  await http.basicLogin("unicode", unicode, "UTF-8 host");
});

it("clears durable credentials after an already-running publication crosses disconnect", async () => {
  const f = await fixture(),
    keys = await generateIdentityServiceProfileKeys();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
  const path = join(f.directory, "owned-client.json");
  const http = new IdentityServiceClient(f.issuer, randomUUID(), keys, {
    allowInsecureLoopback: true,
    fetch: async (input, init) => f.service.app.fetch(new Request(input, init)),
    publish: async (credentials) => {
      entered();
      await hold;
      await writeFile(path, JSON.stringify(credentials), { mode: 0o600 });
    },
    remove: () => rm(path, { force: true }),
  });
  const login = http.basicLogin(
    "alice",
    "a long test password",
    "pending save",
  );
  const outcome = login.then(
    () => null,
    (error) => error,
  );
  await started;
  const disconnected = http.disconnect();
  release();
  await disconnected;
  expect(await outcome).toMatchObject({ code: "cancelled" });
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(http.request("/me")).rejects.toMatchObject({
    code: "login_required",
  });
});

it("isolates accounts and rejects otherwise signed wrong issuer, audience, purpose and key claims", async () => {
  const f = await fixture(true),
    source = await f.client();
  const bob = new IdentityServiceClient(
    f.issuer,
    randomUUID(),
    await generateIdentityServiceProfileKeys(),
    {
      allowInsecureLoopback: true,
      fetch: async (input, init) =>
        f.service.app.fetch(new Request(input, init)),
    },
  );
  const bobClient = await bob.basicLogin(
    "bob",
    "a separate long password",
    "separate account",
  );
  expect(await bob.request("/clients")).toMatchObject({ items: [bobClient] });
  await expect(
    source.http.request(`/clients/${bobClient.id}`),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    bob.request(`/clients/${source.credentials().client.id}`),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    source.http.request("/relationships", "POST", {
      targetClientId: bobClient.id,
      policy: {
        projects: ["p"],
        operations: ["server"],
        expiresAt: Date.now() + 60_000,
      },
    }),
  ).rejects.toMatchObject({ status: 400 });
  const claims = jose.decodeJwt(source.credentials().accessToken);
  for (const changed of [
    { iss: "https://wrong.invalid" },
    { aud: "wrong-audience" },
    { purpose: "refresh" },
    { cnf: { jkt: bobClient.signingJkt } },
  ]) {
    const invalid = await identityServiceCrypto.signIdentityServiceJwt(
      f.store.read().signingKey,
      { ...claims, ...changed },
      "at+jwt",
    );
    const http = new IdentityServiceClient(
      f.issuer,
      source.http.profileId,
      source.keys,
      {
        allowInsecureLoopback: true,
        fetch: async (input, init) =>
          f.service.app.fetch(new Request(input, init)),
      },
    );
    http.restore({ ...source.credentials(), accessToken: invalid });
    await expect(http.request("/me")).rejects.toMatchObject({ status: 401 });
  }
});

it("rejects concurrent reuse of one DPoP nonce before dispatch", async () => {
  const f = await fixture(),
    keys = await generateIdentityServiceProfileKeys();
  const seen = new Map<string, number[]>();
  let saved!: IdentityServiceCredentials,
    clock = Date.now();
  let activeService = f.service;
  const http = new IdentityServiceClient(f.issuer, randomUUID(), keys, {
    allowInsecureLoopback: true,
    now: () => clock,
    publish: async (c) => {
      saved = c;
    },
    remove: async () => {},
    fetch: async (input, init) => {
      const request = new Request(input, init),
        path = new URL(request.url).pathname;
      if (
        ["/fleet/v0/enroll", "/fleet/v0/refresh", "/fleet/v0/me"].includes(path)
      ) {
        const responses = await Promise.all([
          activeService.app.fetch(request.clone()),
          activeService.app.fetch(request.clone()),
        ]);
        if (responses.some((r) => r.ok)) {
          seen.set(path, responses.map((r) => r.status).sort());
          return responses.find((r) => r.ok)!;
        }
        return responses[0]!;
      }
      return activeService.app.fetch(request);
    },
  });
  await http.basicLogin("alice", "a long test password", "concurrent requests");
  expect(seen.get("/fleet/v0/enroll")).toEqual([200, 401]);
  expect(f.store.read().sessions).toHaveLength(1);
  await http.request("/me");
  expect(seen.get("/fleet/v0/me")).toEqual([200, 401]);
  const old = saved.refreshToken;
  f.advance(286_000);
  clock += 286_000;
  // A fresh service invalidates its nonce ledger; persisted sessions still work.
  activeService = createIdentityService(f.store, { now: () => clock });
  await http.request("/me");
  expect(seen.get("/fleet/v0/refresh")).toEqual([200, 401]);
  expect(saved.refreshToken).not.toBe(old);
  expect(f.store.read().sessions).toHaveLength(1);
});

it("fences bootstrap and refresh commits even when both callers have distinct valid nonces", async () => {
  const f = await fixture(),
    keys = await generateIdentityServiceProfileKeys(),
    profileId = randomUUID();
  let clock = Date.now(),
    saved!: IdentityServiceCredentials;
  const options = {
    allowInsecureLoopback: true,
    now: () => clock,
    fetch: async (input: string | URL | Request, init?: RequestInit) =>
      f.service.app.fetch(new Request(input, init)),
    publish: async (c: IdentityServiceCredentials) => {
      saved = c;
    },
    remove: async () => {},
  };
  const a = new IdentityServiceClient(f.issuer, profileId, keys, options),
    b = new IdentityServiceClient(f.issuer, profileId, keys, options);
  const pending = await f.service.auth.login("alice", "a long test password", {
    profileId,
    displayName: "independent proofs",
    signingKey: publicIdentityServiceKey(keys.signing),
    encryptionKey: publicIdentityServiceKey(keys.encryption),
  });
  let entered = 0,
    both!: () => void,
    release!: () => void;
  let reached = new Promise<void>((resolve) => {
      both = resolve;
    }),
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
  const original = identityServiceCrypto.signIdentityServiceJwt;
  const spy = vi
    .spyOn(identityServiceCrypto, "signIdentityServiceJwt")
    .mockImplementation(async (...args) => {
      if (args[1].purpose === "control") {
        entered++;
        if (entered === 2) both();
        await hold;
      }
      return original(...args);
    });
  try {
    const enrollments = Promise.allSettled([
      a.completeEnrollment(pending.token),
      b.completeEnrollment(pending.token),
    ]);
    await reached;
    release();
    const results = await enrollments;
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      results.filter((r) => r.status === "rejected").map((r) => r.reason),
    ).toMatchObject([{ status: 401 }]);
    expect(f.store.read().clients).toHaveLength(1);
    expect(f.store.read().sessions).toHaveLength(1);
    a.restore(saved);
    b.restore(saved);
    f.advance(286_000);
    clock += 286_000;
    entered = 0;
    reached = new Promise<void>((resolve) => {
      both = resolve;
    });
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshes = Promise.allSettled([a.request("/me"), b.request("/me")]);
    await reached;
    release();
    const refreshed = await refreshes;
    expect(refreshed.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      refreshed.filter((r) => r.status === "rejected").map((r) => r.reason),
    ).toMatchObject([{ status: 401 }]);
    expect(f.store.read().sessions).toHaveLength(1);
  } finally {
    release();
    spy.mockRestore();
  }
});

it("closes admission after uncertain publication and recovers only from the durable directory", async () => {
  const f = await fixture(),
    source = await f.client(),
    target = await f.client();
  const original = atomicFiles.writeFileAtomically;
  const spy = vi
    .spyOn(atomicFiles, "writeFileAtomically")
    .mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("owned failure after rename");
    });
  try {
    await expect(
      source.http.request("/relationships", "POST", {
        targetClientId: target.credentials().client.id,
        policy: {
          projects: ["p"],
          operations: ["server"],
          expiresAt: Date.now() + 60_000,
        },
      }),
    ).rejects.toMatchObject({ status: 503, code: "fleet_state_unavailable" });
    await expect(source.http.request("/clients")).rejects.toMatchObject({
      status: 503,
    });
  } finally {
    spy.mockRestore();
  }
  await f.store.close();
  const recovered = new IdentityServiceStore(f.directory, f.issuer, true);
  await recovered.initialize();
  try {
    expect(recovered.read().relationships).toHaveLength(1);
  } finally {
    await recovered.close();
  }
});

it("does not publish a session when its existing client is revoked during enrollment signing", async () => {
  const f = await fixture(),
    source = await f.client(),
    target = await f.client();
  const pending = await f.service.auth.pending(
    f.store.read().accounts[0]!,
    {
      profileId: target.http.profileId,
      displayName: "reenroll",
      signingKey: publicIdentityServiceKey(target.keys.signing),
      encryptionKey: publicIdentityServiceKey(target.keys.encryption),
    },
    30 * 86_400_000,
  );
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
  const original = identityServiceCrypto.signIdentityServiceJwt;
  const spy = vi
    .spyOn(identityServiceCrypto, "signIdentityServiceJwt")
    .mockImplementation(async (...args) => {
      if (
        args[1].purpose === "control" &&
        args[1].client_id === target.credentials().client.id
      ) {
        entered();
        await hold;
      }
      return original(...args);
    });
  const outcome = target.http.completeEnrollment(pending.token).then(
    () => null,
    (error) => error,
  );
  try {
    await started;
    await source.http.request(
      `/clients/${target.credentials().client.id}`,
      "DELETE",
    );
  } finally {
    release();
    expect(await outcome).toMatchObject({ status: 401 });
    spy.mockRestore();
  }
  expect(
    f.store
      .read()
      .sessions.some((s) => s.clientId === target.credentials().client.id),
  ).toBe(false);
});
