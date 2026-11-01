import { afterEach, expect, it } from "vitest";
import { Hono } from "hono";
import { EMPTY_LIMITED_USER_GRANTS } from "@yep-anywhere/shared";
import { SUPERUSER } from "../../src/auth/principal.js";
import type { ApiPrincipal } from "../../src/core-api/peer-policy.js";
import { CoreApi, type CoreApiSources } from "../../src/core-api/service.js";
import {
  apiSchema,
  type ApiServerMetadata,
} from "../../src/core-api/contracts.js";
import { PeerApiRouter } from "../../src/peer-api/router.js";
import { PeerOutboundStore } from "../../src/peer-api/outbound-store.js";
import { openSqliteOrThrow } from "../../src/storage/sqlite.js";
import { migrateDiscoveryDatabase } from "../../src/storage/discovery-sqlite.js";
import { createV0Routes } from "../../src/routes/v0/index.js";
import { validatePeerReply } from "../../src/peer-api/transport.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const localMetadata = {
    hostname: "studio-mac",
    os: "darwin",
    architecture: "arm64",
    icon: "💻",
    id: "spoofed",
    local: false,
    secret: "local-secret",
    setupRoute: { url: "private-route" },
  };
  const sources: CoreApiSources = {
    serverMetadata: () => localMetadata,
    projects: async () => ({ items: [] }),
    sessions: async () => ({ items: [] }),
    providers: async () => [],
  };
  const core = new CoreApi("A", sources),
    database = openSqliteOrThrow(":memory:");
  migrateDiscoveryDatabase(database);
  cleanup.push(() => database.close());
  const outbound = new PeerOutboundStore(database);
  cleanup.push(() => outbound.close());
  let remote: unknown = {
    id: "B",
    local: true,
    hostname: "fresh-builder",
    os: "win32",
    architecture: "x64",
    icon: "🖥️",
    label: "target-label",
    secret: "remote-secret",
    setupUsername: "owner-login",
  };
  let calls = 0;
  const saved = new Map<string, ApiServerMetadata>([
    [
      "B",
      {
        label: "Windows builder",
        hostname: "recorded-builder",
        os: "win32",
        architecture: "x64",
        icon: "🛠️",
      },
    ],
  ]);
  const metadataReads: string[] = [];
  let enabled = true;
  const router = new PeerApiRouter(
    core,
    outbound,
    [],
    (id) => id,
    () => ({ enabled, grantId: "generation" }),
    (id) => {
      metadataReads.push(id);
      return saved.get(id) ?? {};
    },
  );
  cleanup.push(() => router.close());
  const put = (
    id = "B",
    options: { expiresAt?: number; allowAgentSessions?: boolean } = {},
  ) =>
    router.put({
      serverId: id,
      operations: ["server", "access", "capabilities"],
      allowAgentSessions: true,
      ...options,
      transport: {
        serverId: id,
        async request() {
          calls++;
          return remote;
        },
      },
    });
  put();
  let owner = true;
  let principal: ApiPrincipal = SUPERUSER;
  const app = new Hono<{
    Variables: { yaPrincipal: ApiPrincipal; yaApiOwnerAuthenticated: true };
  }>();
  app.use("*", async (c, next) => {
    c.set("yaPrincipal", principal);
    if (owner) c.set("yaApiOwnerAuthenticated", true);
    await next();
  });
  app.route("/v0", createV0Routes(router));
  return {
    app,
    core,
    router,
    localMetadata,
    saved,
    metadataReads,
    put,
    calls: () => calls,
    remote: (value: unknown) => {
      remote = value;
    },
    owner: (value: boolean) => {
      owner = value;
    },
    principal: (value: ApiPrincipal) => {
      principal = value;
    },
    enabled: (value: boolean) => {
      enabled = value;
    },
  };
}
it("describes self and addressable peers through socket-free HTTP without probing or disclosing private state", async () => {
  const f = fixture();
  const response = await f.app.request("/v0/servers");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    items: [
      {
        id: "A",
        local: true,
        hostname: "studio-mac",
        os: "darwin",
        architecture: "arm64",
        icon: "💻",
      },
      {
        id: "B",
        local: false,
        label: "Windows builder",
        hostname: "recorded-builder",
        os: "win32",
        architecture: "x64",
        icon: "🛠️",
      },
    ],
    nextCursor: null,
  });
  expect(f.calls()).toBe(0);
  const me = await (await f.app.request("/v0/me")).json();
  expect(me.server).toEqual(
    (await (await f.app.request("/v0/servers")).json()).items[0],
  );
  expect(await (await f.app.request("/v0/servers/A")).json()).toEqual(
    me.server,
  );
  const descriptor = await (await f.app.request("/v0/servers/B")).json();
  expect(descriptor).toEqual({
    id: "B",
    local: false,
    label: "Windows builder",
    hostname: "fresh-builder",
    os: "win32",
    architecture: "x64",
    icon: "🖥️",
  });
  expect(f.calls()).toBe(1);
  expect(JSON.stringify(descriptor)).not.toMatch(
    /secret|setupUsername|setupRoute/,
  );
  f.saved.set("B", {
    label: "Renamed builder",
    hostname: "recorded-builder",
    os: "win32",
  });
  expect((await (await f.app.request("/v0/servers/B")).json()).label).toBe(
    "Renamed builder",
  );
  expect(
    (await (await f.app.request("/v0/servers")).json()).items[1].hostname,
  ).toBe("recorded-builder");
});
it("keeps metadata behind existing caller, launch, expiry and pagination filters", async () => {
  const f = fixture();
  f.put("C", { expiresAt: Date.now() - 1 });
  f.saved.set("C", { hostname: "expired-private" });
  f.put("D", { allowAgentSessions: false });
  f.saved.set("D", { hostname: "owner-only" });
  f.owner(false);
  expect(
    (await (await f.app.request("/v0/servers")).json()).items,
  ).toHaveLength(1);
  expect(f.metadataReads).toEqual([]);
  f.owner(true);
  f.principal({
    kind: "limited",
    username: "alice",
    grants: EMPTY_LIMITED_USER_GRANTS,
    switched: false,
    locked: true,
    via: "direct",
  });
  expect(
    (await (await f.app.request("/v0/servers")).json()).items,
  ).toHaveLength(1);
  expect(f.metadataReads).toEqual([]);
  const launch = {
    id: "parent",
    launchId: "launch",
    management: true as const,
    peerAccess: true as const,
    peerGrantId: "generation",
  };
  const listed = await f.router.read("servers", SUPERUSER, {
    launch,
    query: { limit: "1", cursor: "1" },
  });
  expect(listed).toEqual({
    items: [
      {
        id: "B",
        local: false,
        label: "Windows builder",
        hostname: "recorded-builder",
        os: "win32",
        architecture: "x64",
        icon: "🛠️",
      },
    ],
    nextCursor: null,
  });
  expect(f.metadataReads).toEqual(["B"]);
  expect(f.calls()).toBe(0);
  f.enabled(false);
  expect(await f.router.read("servers", SUPERUSER, { launch })).toMatchObject({
    items: [{ id: "A" }],
  });
});
it("keeps old peers addressable with optional metadata and rejects a different reported identity", async () => {
  const f = fixture();
  f.remote({ id: "B", local: true });
  expect(await (await f.app.request("/v0/servers/B")).json()).toMatchObject({
    id: "B",
    label: "Windows builder",
    hostname: "recorded-builder",
  });
  f.saved.delete("B");
  expect(await (await f.app.request("/v0/servers/B")).json()).toEqual({
    id: "B",
    local: false,
  });
  f.remote({ id: "wrong-profile", local: true, hostname: "spoofed" });
  const mismatch = await f.app.request("/v0/servers/B");
  expect(mismatch.status).toBe(502);
  expect(await mismatch.json()).toMatchObject({
    error: { code: "peer_identity_mismatch" },
  });
  const schema = apiSchema(false, "servers");
  expect(JSON.stringify(schema)).toContain("Reported hostname");
  expect(
    validatePeerReply(
      "capabilities",
      "B",
      200,
      new Headers({ "X-YA-Server-ID": "B" }),
      {
        revision: "2026-10-31.1",
        stability: "unstable",
        operations: ["server"],
        peerRouting: false,
      },
    ),
  ).toMatchObject({ revision: "2026-10-31.1" });
});
