import { Hono } from "hono";
import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_LIMITED_USER_GRANTS,
  nativeSessionRef,
  parseNativeSessionId,
  parseYaSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import type { SessionCatalogRow } from "../../src/sessions/catalog-types.js";
import {
  type Principal,
  PRINCIPAL_VARIABLE,
  SUPERUSER,
} from "../../src/auth/principal.js";
import {
  closeTestDiscoveryDatabases,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { productionApiSources } from "../../src/core-api/production-sources.js";
import { CoreApi } from "../../src/core-api/service.js";
import { createV0Routes } from "../../src/routes/v0/index.js";

it("rejects native cross-project collisions before session-wide metadata can hide them", async () => {
  const visible = toUrlProjectId("/work/visible"),
    privateId = toUrlProjectId("/work/private");
  const rows: SessionCatalogRow[] = [visible, privateId].map(
    (projectId, index) => ({
      sessionId: "same-id",
      projectId,
      projectPath: index ? "/work/private" : "/work/visible",
      projectIdentityKey: projectId,
      title: index ? "private title" : "visible title",
      updatedAt: "2026-10-30T00:00:00Z",
      catalogFamily: "claude",
      storeKey: "fixture",
      sourceVersion: "fixture",
      fidelity: "head",
      location: { kind: "file", path: `/unused/${index}` },
    }),
  );
  const sources = productionApiSources({
    scanner: {
      readRetainedProjects: async () => ({
        projects: [],
        complete: true,
        refreshing: false,
      }),
    },
    sessions: {
      read: async () => ({
        rows,
        catalog: {
          catalogEpoch: "fixture",
          catalogGeneration: 1,
          complete: true,
          refreshing: false,
        },
      }),
    },
    metadata: { getMetadata: () => ({ workingProjectId: visible }) },
    sessionState: () => "not-running",
    ownedSessions: () => [
      {
        id: "same-id",
        projectId: visible,
        provider: "claude",
        title: "must stay hidden",
        updatedAt: "",
        state: "in-turn",
      },
      {
        id: "new-visible",
        projectId: visible,
        provider: "codex",
        title: "New owner",
        updatedAt: "",
        state: "in-turn",
      },
      {
        id: "new-private",
        projectId: privateId,
        provider: "codex",
        title: "Private owner",
        updatedAt: "",
        state: "in-turn",
      },
    ],
    providers: () => [],
    hiddenProjects: async () => new Set(),
  });
  const app = new Hono<{ Variables: { yaPrincipal: Principal } }>();
  app.use("*", async (c, next) => {
    c.set(PRINCIPAL_VARIABLE, {
      kind: "limited",
      username: "reader",
      grants: { ...EMPTY_LIMITED_USER_GRANTS, viewProjects: [visible] },
      switched: false,
      locked: true,
      via: "direct",
    });
    await next();
  });
  app.route("/v0", createV0Routes(new CoreApi("A", sources)));
  const response = await app.request("/v0/servers/A/sessions");
  expect(response.status).toBe(200);
  expect(
    (await response.json()).items.map((item: { id: string }) => item.id),
  ).toEqual(["new-visible"]);
  expect((await app.request("/v0/servers/A/sessions/same-id")).status).toBe(
    404,
  );
});

it("keeps a session under the YA id its creator holds once only its native transcript remains", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ya-v0-identity-"));
  try {
    const database = openTestDiscoveryDatabase(dir);
    const metadata = new SessionMetadataService({ dataDir: dir, database });
    await metadata.initialize();
    const projectId = toUrlProjectId("/work/visible");
    const publicId = parseYaSessionId("11111111-1111-4111-8111-111111111111");
    // Codex names its own thread; YA binds that thread to the id it issued.
    const thread = "019a1d69-0bed-73b0-9c88-2720d31c25c8";
    database.transaction(() => {
      metadata.identities.allocateWithinTransaction({
        sessionId: publicId,
        provider: "codex",
        projectId,
        createdAt: "2026-11-13T00:00:00.000Z",
      });
      metadata.identities.bindWithinTransaction(
        publicId,
        nativeSessionRef("codex", "/store", parseNativeSessionId(thread)),
      );
    });
    const row: SessionCatalogRow = {
      sessionId: thread,
      projectId,
      projectPath: "/work/visible",
      projectIdentityKey: projectId,
      title: "Finished work",
      updatedAt: "2026-11-13T00:00:00Z",
      catalogFamily: "codex",
      storeKey: "/store",
      nativeStorageScope: "/store",
      sourceVersion: "fixture",
      fidelity: "head",
      location: { kind: "file", path: `/store/rollout-${thread}.jsonl` },
    };
    let running = true;
    const sources = productionApiSources({
      scanner: {
        readRetainedProjects: async () => ({
          projects: [],
          complete: true,
          refreshing: false,
        }),
      },
      sessions: {
        read: async () => ({
          rows: [row],
          catalog: {
            catalogEpoch: "fixture",
            catalogGeneration: 1,
            complete: true,
            refreshing: false,
          },
        }),
      },
      metadata,
      sessionState: () => (running ? "idle" : "not-running"),
      // While its process lives, the owner lists the session by its YA id.
      ownedSessions: () =>
        running
          ? [
              {
                id: publicId,
                projectId,
                provider: "codex",
                title: "Finished work",
                updatedAt: "",
                state: "idle",
              },
            ]
          : [],
      providers: () => [],
      hiddenProjects: async () => new Set(),
    });
    const app = new Hono<{ Variables: { yaPrincipal: Principal } }>();
    app.use("*", async (c, next) => {
      c.set(PRINCIPAL_VARIABLE, SUPERUSER);
      await next();
    });
    app.route("/v0", createV0Routes(new CoreApi("A", sources)));
    for (const state of ["idle", "not-running"]) {
      running = state === "idle";
      const listed = await (await app.request("/v0/servers/A/sessions")).json();
      // One session, one id: never a second row under the native thread id.
      expect(
        listed.items.map((item: { id: string; state: string }) => [
          item.id,
          item.state,
        ]),
      ).toEqual([[publicId, state]]);
      expect(
        (await app.request(`/v0/servers/A/sessions/${publicId}`)).status,
      ).toBe(200);
      expect(
        (await app.request(`/v0/servers/A/sessions/${thread}`)).status,
      ).toBe(404);
    }
  } finally {
    closeTestDiscoveryDatabases();
    await rm(dir, { recursive: true });
  }
});
