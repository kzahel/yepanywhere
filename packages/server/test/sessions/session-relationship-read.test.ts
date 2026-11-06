import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import {
  EMPTY_LIMITED_USER_GRANTS,
  nativeSessionRef,
  parseNativeSessionId,
  parseYaSessionId,
} from "@yep-anywhere/shared";
import { SUPERUSER, type Principal } from "../../src/auth/principal.js";
import { CoreApi } from "../../src/core-api/service.js";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import { createSessionRelationshipRoutes } from "../../src/routes/session-relationships.js";
import { createV0Routes } from "../../src/routes/v0/index.js";
import { AuthorizedRelationshipSource } from "../../src/sessions/authorized-relationship-source.js";
import { createSessionRelationshipRead } from "../../src/sessions/session-relationship-read.js";
import { profileSessionRelationships } from "../../src/sessions/SessionRelationshipWriter.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { createApp } from "../setup/create-app.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const reader: Principal = {
  kind: "limited",
  username: "reader",
  grants: EMPTY_LIMITED_USER_GRANTS,
  switched: false,
  locked: true,
  via: "direct",
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ya-related-http-"));
  const profile = new DiscoverySqliteService({
    dataDir: root,
    probeNetworkFilesystem: () => undefined,
  });
  const db = profile.getDatabase();
  const metadata = new SessionMetadataService({ dataDir: root, database: db });
  await metadata.initialize();
  const writer = profileSessionRelationships(db);
  const source = new AuthorizedRelationshipSource(db, () => writer.index);
  const projectId = encodeProjectId(join(root, "project"));
  const native = nativeSessionRef(
    "claude",
    join(root, "DO_NOT_EXPOSE_native"),
    parseNativeSessionId("native-parent"),
  );
  const resource = (id: string) => writer.session(id);
  db.transaction(() => {
    for (const id of ["parent", "child", "other"])
      metadata.identities.allocateWithinTransaction({
        sessionId: parseYaSessionId(id),
        projectId,
        provider: "claude",
        createdAt: "2026-11-06T00:00:00Z",
      });
    metadata.identities.bindWithinTransaction(
      parseYaSessionId("parent"),
      native,
    );
  });
  writer.index.record(
    {
      producer: "DO_NOT_EXPOSE_producer",
      sourceKey: "DO_NOT_EXPOSE_source",
      sourceVersion: "DO_NOT_EXPOSE_version",
      extractorVersion: 1,
      observedAt: "2026-11-06T00:00:00Z",
    },
    [
      {
        type: "launched_harness",
        source: resource("parent"),
        target: resource("child"),
        recordKey: "private-command",
        trust: "command-observed",
        metadata: {
          title: "Worker",
          receiptId: "DO_NOT_EXPOSE_receipt",
          launchId: "DO_NOT_EXPOSE_launch",
        },
      },
      {
        type: "forked_from",
        source: resource("other"),
        target: resource("parent"),
        recordKey: "private-copy",
        trust: "local-authenticated",
        metadata: { boundaryId: "DO_NOT_EXPOSE_boundary" },
      },
      {
        type: "provider_child",
        source: { kind: "native", serverId: writer.serverId, native },
        target: {
          kind: "native",
          serverId: writer.serverId,
          native: nativeSessionRef(
            "claude",
            join(native.storageScope, "subagents"),
            parseNativeSessionId("native-child"),
          ),
        },
        recordKey: "private-spawn",
        trust: "provider-observed",
        metadata: { agentType: "Explore", toolUseId: "call-1", spawnDepth: 1 },
      },
    ],
  );
  const makeRead = () =>
    createSessionRelationshipRead({
      serverId: writer.serverId,
      source: (scope) => source.scoped(() => scope),
      identities: metadata.identities,
      metadata,
      isDeleted: (id) =>
        metadata.creations.statusForSession(parseYaSessionId(id))?.state ===
        "deleted",
    });
  const read = makeRead();
  const routes = (principal = SUPERUSER as Principal) => {
    const app = new Hono<{ Variables: { yaPrincipal: Principal } }>();
    app.use("*", async (c, next) => {
      c.set("yaPrincipal", principal);
      await next();
    });
    app.route("/api", createSessionRelationshipRoutes(read));
    return app;
  };
  cleanups.push(async () => {
    source.dispose();
    writer.dispose();
    metadata.identities.close();
    profile.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    db,
    profile,
    writer,
    metadata,
    source,
    projectId,
    read,
    makeRead,
    routes,
    path: `/api/projects/${projectId}/sessions/parent/relationships`,
  };
}

it("serves both canonical/native anchors with safe endpoints and independently paged incoming/outgoing evidence", async () => {
  const f = await fixture();
  const app = f.routes();
  let cursor: string | null = null;
  const rows = [];
  do {
    const response = await app.request(
      `${f.path}?limit=1${cursor ? `&cursor=${cursor}` : ""}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const page = await response.json();
    expect(JSON.stringify(page)).not.toContain("DO_NOT_EXPOSE");
    rows.push(...page.relationships);
    cursor = page.nextCursor;
  } while (cursor);
  expect(rows.map((row) => row.type).sort()).toEqual([
    "forked_from",
    "launched_harness",
    "provider_child",
  ]);
  const child = rows.find((row) => row.type === "provider_child")!;
  expect(child.source.sessionId).toBe("parent");
  expect(child.target).toEqual({
    kind: "provider-child",
    serverId: f.writer.serverId,
    parentSessionId: "parent",
    childId: "native-child",
    projectId: f.projectId,
    provider: "claude",
  });
  const incoming = await f.read({
    sessionId: "parent",
    query: { direction: "incoming" },
  });
  expect(incoming.relationships.map((row) => row.type)).toEqual([
    "forked_from",
  ]);
  const filtered = await f.read({
    sessionId: "parent",
    query: { type: "launched_harness" },
  });
  expect(filtered.relationships).toHaveLength(1);
});

it("rejects wrong projects, unknown sessions, invalid queries and another API generation's cursor; restricted callers never reach SQL", async () => {
  const f = await fixture();
  const app = f.routes();
  const absent = await app.request(f.path.replace("/parent/", "/missing/"));
  const moved = await app.request(
    f.path.replace(f.projectId, encodeProjectId("/other")),
  );
  expect(absent.status).toBe(404);
  expect(moved.status).toBe(404);
  expect(await absent.json()).toEqual(await moved.json());
  expect((await app.request(`${f.path}?limit=0`)).status).toBe(400);
  const page = await f.read({ sessionId: "parent", query: { limit: 1 } });
  await expect(
    f.makeRead()({ sessionId: "parent", query: { cursor: page.nextCursor } }),
  ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  const sql = vi.spyOn(f.source, "scoped");
  expect((await f.routes(reader).request(f.path)).status).toBe(403);
  expect(sql).not.toHaveBeenCalled();
});

it("adds opt-in v0 related pages without changing legacy receipt pagination or peer/limited provenance", async () => {
  const f = await fixture();
  const related = vi.fn(f.read);
  const api = new CoreApi(f.writer.serverId, {
    projects: async () => ({ items: [] }),
    providers: async () => [],
    sessions: async () => ({
      items: [
        {
          id: "parent",
          projectId: f.projectId,
          provider: "claude",
          title: "Parent",
          updatedAt: "2026-11-06T00:00:00Z",
          state: "not-running",
        },
      ],
    }),
    relationships: related,
  });
  const app = new Hono<{ Variables: { yaPrincipal: Principal } }>();
  app.use("*", async (c, next) => {
    c.set("yaPrincipal", SUPERUSER);
    await next();
  });
  app.route("/v0", createV0Routes(api));
  const path = `/v0/servers/${f.writer.serverId}/sessions/parent/relationships`;
  const legacy = await (await app.request(`${path}?cursor=0&limit=1`)).json();
  expect(legacy).toEqual({
    sessionId: "parent",
    creation: null,
    initiated: [],
    nextCursor: null,
  });
  expect(related).not.toHaveBeenCalled();
  const first = await (
    await app.request(
      `${path}?cursor=0&limit=1&includeRelated=true&relatedLimit=1`,
    )
  ).json();
  expect(first.nextCursor).toBeNull();
  expect(first.related.relationships).toHaveLength(1);
  expect(first.related.nextCursor).toBeTypeOf("string");
  const next = await app.request(
    `${path}?includeRelated=true&relatedCursor=${first.related.nextCursor}`,
  );
  expect(next.status).toBe(200);
  expect((await next.json()).related.relationships).toHaveLength(2);
  const count = related.mock.calls.length;
  const peer = await api.read(
    "relationships",
    {
      kind: "peer",
      serverId: "peer",
      credentialId: "fixture",
      projects: [f.projectId],
      operations: ["relationships", "session"],
      sourceSessionId: null,
      sourceLaunchId: null,
      signal: new AbortController().signal,
      assertActive() {},
    },
    { sessionId: "parent", query: { includeRelated: "true" } },
  );
  expect(peer).toEqual(legacy);
  expect(related).toHaveBeenCalledTimes(count);
  await expect(
    api.read("relationships", reader, { sessionId: "parent" }),
  ).rejects.toMatchObject({ code: "forbidden" });
});

it("mounts the production route on the required profile database without a provider or transcript", async () => {
  const f = await fixture();
  const instance = createApp({
    dataDir: f.root,
    discoverySqlite: f.profile,
    sessionMetadataService: f.metadata,
    projectsDir: join(f.root, "no-native-transcripts"),
    externalSessionsEnabled: false,
    provider: null,
  });
  try {
    const response = await instance.app.request(f.path);
    expect(response.status).toBe(200);
    expect((await response.json()).relationships).toHaveLength(3);
  } finally {
    instance.stopNotifications();
    await instance.disposeSessionReaders();
  }
});

it("excludes deleted creations before pagination and refuses their own anchor", async () => {
  const f = await fixture();
  const admitted = f.metadata.creations.admit({
    requestId: "related-deleted-creation",
    context: {
      owner: { kind: "superuser" },
      source: { kind: "request", provenance: { surface: "api" } },
    },
    request: {
      projectId: f.projectId,
      projectPath: join(f.root, "project"),
      provider: "claude",
      message: "DO_NOT_EXPOSE_prompt",
      settings: {
        requestedModel: null,
        permissionMode: "default",
        serviceTier: null,
        thinking: null,
        effort: null,
      },
    },
  });
  f.writer.index.record(
    {
      producer: "owned-delete",
      sourceKey: "owned-delete",
      sourceVersion: "1",
      extractorVersion: 1,
      observedAt: "2026-11-06T00:00:00Z",
    },
    [
      {
        type: "continued_from",
        source: f.writer.session("parent"),
        target: f.writer.session(admitted.sessionId),
        recordKey: "continuation",
        trust: "local-authenticated",
      },
    ],
  );
  expect(
    (
      await f.read({
        sessionId: "parent",
        query: { type: "continued_from", limit: 1 },
      })
    ).relationships,
  ).toHaveLength(1);
  f.metadata.creations.delete(admitted.attempt);
  expect(
    f.source
      .scoped(() => ({
        serverId: f.writer.serverId,
        projects: "all",
        creators: true,
      }))
      .list({ resource: f.writer.session("parent"), type: "continued_from" })
      .edges,
  ).toEqual([]);
  expect(
    await f.read({
      sessionId: "parent",
      query: { type: "continued_from", limit: 1 },
    }),
  ).toEqual({ relationships: [], nextCursor: null });
  await expect(f.read({ sessionId: admitted.sessionId })).rejects.toMatchObject(
    { code: "session_not_found", status: 404 },
  );
});
