import { afterEach, expect, it, vi } from "vitest";
import { fleetFixture } from "./fleet-fixture.js";
import { oidcFixture } from "./oidc-fixture.js";
import { PeerAccessStore } from "../../src/peer-api/state.js";
import { FleetHttpClient } from "../../src/fleet/client.js";
import { createAgentApiRuntime } from "../../src/agent-api/runtime.js";
import { SUPERUSER } from "../../src/auth/principal.js";
import { nativeRequest } from "./peer-fixture.js";
import type { Operation } from "../../src/core-api/contracts.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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
async function fixture(options?: Parameters<typeof oidcFixture>[0]) {
  const upstream = await oidcFixture(options);
  const fleet = await fleetFixture(cleanup, {
    external: { issuer: upstream.issuer, subject: upstream.subject },
    oidcProviders: [upstream.provider],
    oidcFetch: upstream.fetcher,
  });
  return { ...fleet, upstream };
}

async function confirmation(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("Content-Security-Policy")).toContain(
    "default-src 'none'",
  );
  const html = await response.text();
  expect(html).not.toMatch(/access_token|refresh_token|at\+jwt/);
  const code = /id="enrollment-confirmation">([A-Za-z0-9_-]{32})<\/code>/.exec(
    html,
  )?.[1];
  expect(code).toHaveLength(32);
  return code!;
}
async function browser(f: Awaited<ReturnType<typeof fixture>>, url: string) {
  const callback = await f.upstream.authorize(url);
  const code = await confirmation(
    await f.service.app.fetch(new Request(callback)),
  );
  return { callback, code };
}

it("uses actual OIDC code/PKCE/JWKS then the shared key-bound enrollment and protected native workflow", async () => {
  const f = await fixture(),
    source = await f.make(),
    target = await f.make();

  const enroll = async (profile: typeof source) => {
    const started = await profile.json("/fleet/oidc/start", "POST", {
      providerId: "owned",
      displayName: "OIDC YA host",
    });
    expect(Object.keys(started).sort()).toEqual([
      "authorizationUrl",
      "expiresAt",
      "flowId",
      "profileId",
      "signingFingerprint",
    ]);
    expect(f.store.read().clients).toEqual([]);
    const { callback, code } = await browser(f, started.authorizationUrl);
    expect((await f.service.app.fetch(new Request(callback))).status).toBe(401);
    expect(await profile.json(`/fleet/oidc/${started.flowId}`)).toMatchObject({
      status: "ready",
    });
    const other = await profile.otherOwner();
    expect(
      (
        await other(`/fleet/oidc/${started.flowId}/complete`, "POST", {
          confirmationCode: code,
        })
      ).status,
    ).toBe(401);
    return profile.json(`/fleet/oidc/${started.flowId}/complete`, "POST", {
      confirmationCode: code,
    });
  };
  const sourceClient = await enroll(source);
  // Completion, rather than the browser callback, creates membership.
  expect(f.store.read().clients).toHaveLength(1);
  // The second host uses the same account but its own local owner session/key.
  const started = await target.json("/fleet/oidc/start", "POST", {
    providerId: "owned",
    displayName: "OIDC target",
  });
  const { code } = await browser(f, started.authorizationUrl);
  expect(f.store.read().clients).toHaveLength(1);
  const targetClient = await target.json(
    `/fleet/oidc/${started.flowId}/complete`,
    "POST",
    { confirmationCode: code },
  );
  expect(f.upstream.exchanges()).toBe(2);
  expect(f.upstream.jwksReads()).toBeGreaterThan(0);
  for (const family of f.store.read().sessions)
    expect(family.expiresAt - family.createdAt).toBeLessThanOrEqual(3_600_000);
  const policy = {
    projects: ["p"],
    operations,
    expiresAt: Date.now() + 600_000,
  };
  const r = await source.json("/fleet/relationships", "POST", {
    targetClientId: targetClient.id,
    policy,
  });
  const delivered = await target.json("/fleet/accept", "POST", {
    relationshipId: r.id,
    policy,
    route: target.route,
    acknowledgeExecutionAuthority: "server-account",
  });
  const imported = await source.json("/fleet/adopt", "POST", {
    envelopeId: delivered.envelopeId,
    allowAgentSessions: true,
  });
  await source.json(`/outgoing/${target.id}/select`, "POST", {
    credentialId: imported.credentialId,
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
    token = lease.environment.AGENT_YA_V0_AUTHORIZATION!,
    base = `/v0/servers/${target.id}`;
  const created = await nativeRequest(runtime, token, base + "/sessions", {
    requestId: "oidc-peer-create",
    projectId: "p",
    provider: "codex",
    message: "OIDC reviewer",
  });
  expect(created.status).toBe(202);
  expect(created.body.creator).toMatchObject({
    serverId: source.id,
    sessionId: "parent",
  });
  const receipt = await nativeRequest(
      runtime,
      token,
      `${base}/receipts/${created.body.id}/follow?waitMs=0`,
    ),
    sid = receipt.body.receipt.sessionId;
  expect(
    (
      await nativeRequest(runtime, token, `${base}/sessions/${sid}/messages`, {
        requestId: "oidc-peer-message",
        message: "Continue",
      })
    ).status,
  ).toBe(202);
  const followed = await nativeRequest(
    runtime,
    token,
    `${base}/sessions/${sid}/conversation/follow?waitMs=0`,
  );
  expect(followed.status).toBe(200);
  expect(JSON.stringify(followed.body)).toContain(
    "Protected fleet workflow completed.",
  );
  expect(
    source.manager.store.read().fleet.enrollment!.credentials!.client.id,
  ).toBe(sourceClient.id);
  await target.json(`/fleet/relationships/${r.id}`, "DELETE");
  expect((await nativeRequest(runtime, token, base + "/projects")).status).toBe(
    401,
  );
  expect(target.starts()).toBe(1);
  expect(target.sends()).toBe(1);
});

it("rejects wrong upstream nonce, signature, issuer and subject without implicit account linking", async () => {
  const f = await fixture(),
    source = await f.make();
  for (const fault of ["nonce", "signature", "issuer", "subject"] as const) {
    const started = await source.json("/fleet/oidc/start", "POST", {
      providerId: "owned",
      displayName: "invalid external identity",
    });
    f.upstream.failNext(fault);
    const callback = await f.upstream.authorize(started.authorizationUrl);
    expect((await f.service.app.fetch(new Request(callback))).status).toBe(401);
    expect(await source.json(`/fleet/oidc/${started.flowId}`)).toMatchObject({
      status: "failed",
    });
    expect(
      (await source.call(`/fleet/oidc/${started.flowId}/complete`, "POST", {}))
        .status,
    ).toBe(401);
    expect(f.store.read().clients).toEqual([]);
    expect(f.store.read().sessions).toEqual([]);
  }
});

it("fences detached owners, disconnect and expired upstream flows without browser-created membership", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = await fixture(),
    source = await f.make();
  const started = await source.json("/fleet/oidc/start", "POST", {
    providerId: "owned",
    displayName: "will disconnect",
  });
  await source.json("/fleet", "DELETE");
  const callback = await f.upstream.authorize(started.authorizationUrl);
  expect((await f.service.app.fetch(new Request(callback))).status).toBe(200);
  expect(
    (await source.call(`/fleet/oidc/${started.flowId}/complete`, "POST", {}))
      .status,
  ).toBe(401);
  expect(f.store.read().clients).toEqual([]);
  expect(source.manager.store.read().fleet.enrollment).toBeNull();
  await source.json("/fleet", "PUT", {
    issuer: f.issuer,
    accountId: f.accountId,
  });
  const expired = await source.json("/fleet/oidc/start", "POST", {
    providerId: "owned",
    displayName: "will expire",
  });
  vi.setSystemTime(Date.now() + 300_001);
  const late = await f.upstream.authorize(expired.authorizationUrl);
  expect((await f.service.app.fetch(new Request(late))).status).toBe(401);
  expect(
    (await source.call(`/fleet/oidc/${expired.flowId}/complete`, "POST", {}))
      .status,
  ).toBe(401);
  await source.invalidateOwner();
  expect(
    (
      await source.call("/fleet/oidc/start", "POST", {
        providerId: "owned",
        displayName: "detached",
      })
    ).status,
  ).toBe(403);
  expect(f.store.read().clients).toEqual([]);
});

it("invalidates an outstanding OIDC flow when its enrolled client is revoked", async () => {
  const f = await fixture(),
    source = await f.make(),
    target = await f.make();
  const enroll = async (profile: typeof source) => {
    const flow = await profile.json("/fleet/oidc/start", "POST", {
      providerId: "owned",
      displayName: "revocation host",
    });
    const { code } = await browser(f, flow.authorizationUrl);
    return profile.json(`/fleet/oidc/${flow.flowId}/complete`, "POST", {
      confirmationCode: code,
    });
  };
  const sourceClient = await enroll(source);
  await enroll(target);
  const pending = await source.json("/fleet/oidc/start", "POST", {
    providerId: "owned",
    displayName: "pending reauthentication",
  });
  await target.manager.fleetAccess.request(
    `/clients/${sourceClient.id}`,
    "DELETE",
  );
  const callback = await f.upstream.authorize(pending.authorizationUrl);
  expect((await f.service.app.fetch(new Request(callback))).status).toBe(401);
  expect(
    (await source.call(`/fleet/oidc/${pending.flowId}/complete`, "POST", {}))
      .status,
  ).toBe(401);
  expect(f.store.read().clients.filter((c) => !c.revoked)).toHaveLength(1);
  expect(
    f.store.read().sessions.some((s) => s.clientId === sourceClient.id),
  ).toBe(false);
});

it("caps delayed OIDC redemption at the verified callback's absolute family deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = await fixture(),
    source = await f.make();
  const pending = await source.json("/fleet/oidc/start", "POST", {
    providerId: "owned",
    displayName: "delayed completion",
  });
  const { code } = await browser(f, pending.authorizationUrl);
  const completedAt = Date.now();
  vi.setSystemTime(Date.now() + 120_000);
  await source.json(`/fleet/oidc/${pending.flowId}/complete`, "POST", {
    confirmationCode: code,
  });
  const session = f.store.read().sessions[0]!;
  expect(session.expiresAt).toBe(completedAt + 3_600_000);
  expect(session.expiresAt - session.createdAt).toBe(3_480_000);
});

it("requires a browser-only code after login, rejects cross-flow codes and retires five failed attempts", async () => {
  const f = await fixture(),
    source = await f.make();
  const start = () =>
    source.json("/fleet/oidc/start", "POST", {
      providerId: "owned",
      displayName: "<untrusted> & claimed host",
    });
  const first = await start(),
    second = await start();
  // Readiness is not confirmation, and trying early does not consume the flow.
  expect(
    (await source.call(`/fleet/oidc/${first.flowId}/complete`, "POST", {}))
      .status,
  ).toBe(409);
  const a = await browser(f, first.authorizationUrl),
    b = await browser(f, second.authorizationUrl);
  const status = await source.json(`/fleet/oidc/${first.flowId}`);
  expect(status).toEqual({ flowId: first.flowId, status: "ready" });
  expect(JSON.stringify(status)).not.toContain(a.code);
  // An attacker who created the login URL has keys and readiness, but not this code.
  for (const code of [undefined, b.code, "wrong", "wrong", "wrong"]) {
    const response = await source.call(
      `/fleet/oidc/${first.flowId}/complete`,
      "POST",
      { confirmationCode: code },
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("invalid_confirmation");
    expect(f.store.read().clients).toHaveLength(0);
  }
  expect(
    (
      await source.call(`/fleet/oidc/${first.flowId}/complete`, "POST", {
        confirmationCode: a.code,
      })
    ).status,
  ).toBe(401);
  await source.json(`/fleet/oidc/${second.flowId}/complete`, "POST", {
    confirmationCode: b.code,
  });
  expect(f.store.read().clients).toHaveLength(1);
  expect(
    (
      await source.call(`/fleet/oidc/${second.flowId}/complete`, "POST", {
        confirmationCode: b.code,
      })
    ).status,
  ).toBe(401);
});

it("consumes a flow once across independent valid key-bound DPoP lanes", async () => {
  const f = await fixture(),
    source = await f.make();
  const keys = source.manager.store.read().fleet.enrollment!.keys;
  const make = () =>
    new FleetHttpClient(f.issuer, source.id, keys, {
      allowInsecureLoopback: true,
      fetch: async (input, init) =>
        f.service.app.fetch(new Request(input, init)),
    });
  const a = make(),
    b = make();
  cleanup.push(
    () => a.close(),
    () => b.close(),
  );
  const ownerBinding = "a".repeat(64),
    epoch = 1;
  const flow = await a.startOidc({
    providerId: "owned",
    accountId: f.accountId,
    ownerBinding,
    enrollmentEpoch: epoch,
    displayName: "concurrent ceremony",
  });
  const { code } = await browser(f, flow.authorizationUrl);
  const results = await Promise.allSettled(
    [a, b].map((client) =>
      client.completeOidc(flow, ownerBinding, epoch, code, () => {}),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(f.store.read().clients).toHaveLength(1);
  expect(f.store.read().sessions).toHaveLength(1);
});

it("rechecks the live initiating owner before enrollment, queued publication and adoption", async () => {
  for (const boundary of [
    "redeem",
    "enroll",
    "queued-write",
    "published-write",
  ] as const) {
    const f = await fixture(),
      source = await f.make();
    const flow = await source.json("/fleet/oidc/start", "POST", {
      providerId: "owned",
      displayName: "logout race",
    });
    const { code } = await browser(f, flow.authorizationUrl);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    let enrollSends = 0,
      deletes = 0;
    f.intercept(async (request, proceed) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/enroll")) enrollSends++;
      if (request.method === "DELETE") deletes++;
      const response = await proceed();
      if (
        response.ok &&
        ((boundary === "redeem" && path.endsWith("/redeem")) ||
          (boundary === "enroll" && path.endsWith("/enroll")))
      ) {
        enter();
        await gate;
      }
      return response;
    });
    if (boundary === "queued-write" || boundary === "published-write") {
      const store = source.manager.store,
        publish = store.publishFleetCredentials.bind(store);
      vi.spyOn(store, "publishFleetCredentials").mockImplementation(
        async (update) => {
          if (boundary === "published-write") {
            const result = await publish(update);
            enter();
            await gate;
            return result;
          }
          enter();
          await gate;
          return publish(update);
        },
      );
    }
    const completing = source.call(
      `/fleet/oidc/${flow.flowId}/complete`,
      "POST",
      { confirmationCode: code },
    );
    await entered;
    await source.invalidateOwner();
    release();
    const response = await completing,
      result = await response.json();
    expect(response.status, boundary).toBe(403);
    expect(result.error.code, boundary).toBe(
      boundary === "redeem"
        ? "owner_session_changed"
        : "owner_session_changed_remote_unconfirmed",
    );
    expect(
      source.manager.store.read().fleet.enrollment!.credentials,
      boundary,
    ).toBeNull();
    expect(f.store.read().clients.length, boundary).toBe(
      boundary === "redeem" ? 0 : 1,
    );
    if (boundary === "redeem") expect(enrollSends).toBe(0);
    expect(deletes, boundary).toBe(0);
    vi.restoreAllMocks();
  }
});

it("supports configured ES256 ID tokens and client_secret_post without changing fleet authority", async () => {
  const f = await fixture({
      algorithm: "ES256",
      authMethod: "client_secret_post",
    }),
    source = await f.make();
  const providers = await source.json("/fleet/oidc/providers");
  expect(providers).toEqual({
    items: [
      {
        id: "owned",
        displayName: "Owned OIDC issuer",
        issuer: f.upstream.issuer,
      },
    ],
  });
  const started = await source.json("/fleet/oidc/start", "POST", {
    providerId: "owned",
    displayName: "ES256 / POST",
  });
  const { code } = await browser(f, started.authorizationUrl);
  await source.json(`/fleet/oidc/${started.flowId}/complete`, "POST", {
    confirmationCode: code,
  });
  expect(f.store.read().clients).toHaveLength(1);
  expect(f.upstream.jwksReads()).toBe(1);
  expect(source.manager.store.read().incoming).toHaveLength(0);
});

it("bounds upstream discovery replies and recovers a failed configuration fetch", async () => {
  const upstream = await oidcFixture();
  let oversized = true;
  const f = await fleetFixture(cleanup, {
    external: { issuer: upstream.issuer, subject: upstream.subject },
    oidcProviders: [upstream.provider],
    oidcFetch: async (input, init) =>
      oversized
        ? new Response("x".repeat(64 * 1024 + 1))
        : upstream.fetcher(input, init),
  });
  const source = await f.make(),
    start = () =>
      source.call("/fleet/oidc/start", "POST", {
        providerId: "owned",
        displayName: "bounded upstream",
      });
  expect((await start()).status).toBe(503);
  expect(f.store.read().clients).toHaveLength(0);
  oversized = false;
  const retried = await start();
  expect(retried.status).toBe(200);
  expect((await retried.json()).authorizationUrl).toContain("/authorize?");
});

it.each([0, 1])(
  "checks the live owner after async DPoP signing before enrollment attempt %s",
  async (alreadySent) => {
    const f = await fixture(),
      source = await f.make();
    const flow = await source.json("/fleet/oidc/start", "POST", {
      providerId: "owned",
      displayName: "DPoP signing race",
    });
    const { code } = await browser(f, flow.authorizationUrl);
    let enter!: () => void,
      release!: () => void,
      sends = 0,
      held = false;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    f.intercept(async (request, proceed) => {
      if (new URL(request.url).pathname.endsWith("/enroll")) sends++;
      return proceed();
    });
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "sign").mockImplementation(
      async (algorithm, key, data) => {
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        let enrollmentProof = false;
        try {
          enrollmentProof =
            JSON.parse(
              Buffer.from(
                Buffer.from(bytes).toString("utf8").split(".")[1] ?? "",
                "base64url",
              ).toString("utf8"),
            ).htu?.endsWith("/enroll") === true;
        } catch {}
        if (enrollmentProof && !held && sends === alreadySent) {
          held = true;
          enter();
          await gate;
        }
        return sign(algorithm, key, data);
      },
    );
    const completion = source.call(
      `/fleet/oidc/${flow.flowId}/complete`,
      "POST",
      { confirmationCode: code },
    );
    await entered;
    await source.invalidateOwner();
    release();
    const result = await completion;
    expect(result.status).toBe(403);
    expect((await result.json()).error.code).toBe(
      alreadySent === 0
        ? "owner_session_changed"
        : "owner_session_changed_remote_unconfirmed",
    );
    // The optional first send obtained only a pre-admission nonce challenge.
    expect(sends).toBe(alreadySent);
    expect(f.store.read().clients).toHaveLength(0);
    expect(
      source.manager.store.read().fleet.enrollment!.credentials,
    ).toBeNull();
  },
);

it("conditionally discards a published family even when the normal persistence queue is full", async () => {
  const f = await fixture(),
    source = await f.make();
  const flow = await source.json("/fleet/oidc/start", "POST", {
    providerId: "owned",
    displayName: "full cleanup queue",
  });
  const { code } = await browser(f, flow.authorizationUrl),
    store = source.manager.store;
  const publish = store.publishFleetCredentials.bind(store),
    discard = store.discardFleetCredentials.bind(store);
  let writes: Promise<unknown>[] = [],
    logout: Promise<void> | undefined,
    full: Promise<unknown> | undefined;
  vi.spyOn(store, "publishFleetCredentials").mockImplementation(
    async (update) => {
      const result = await publish(update);
      writes = Array.from({ length: 16 }, () => store.mutate(() => {}));
      logout = source.invalidateOwner();
      return result;
    },
  );
  vi.spyOn(store, "discardFleetCredentials").mockImplementation(
    (epoch, token) => {
      // This rejected admission establishes that the normal queue is actually full.
      full = expect(store.mutate(() => {})).rejects.toMatchObject({
        code: "command_capacity",
      });
      return discard(epoch, token);
    },
  );
  const response = await source.call(
    `/fleet/oidc/${flow.flowId}/complete`,
    "POST",
    { confirmationCode: code },
  );
  await Promise.all([...writes, logout, full]);
  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe(
    "owner_session_changed_remote_unconfirmed",
  );
  expect(full).toBeDefined();
  expect(store.read().fleet.enrollment!.credentials).toBeNull();
  const restored = new PeerAccessStore(source.id, source.directory);
  try {
    await restored.initialize();
    expect(restored.read().fleet.enrollment!.credentials).toBeNull();
  } finally {
    await restored.close();
  }
  expect(f.store.read().clients).toHaveLength(1);
});
