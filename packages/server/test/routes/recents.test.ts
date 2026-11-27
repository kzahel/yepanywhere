import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  nativeSessionRef,
  parseNativeSessionId,
  parseYaSessionId,
  toUrlProjectId,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { SessionAccessResolver } from "../../src/auth/sessionAccess.js";
import { createLimitedUsersMiddleware } from "../../src/middleware/limited-users.js";
import type { SessionCatalogRow } from "../../src/sessions/catalog-types.js";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { seedRetainedCollection } from "../utils/retained-query-fixture.js";
import {
  closeTestDiscoveryDatabases,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRINCIPAL_VARIABLE,
  type Principal,
  SUPERUSER,
} from "../../src/auth/principal.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { RecentsService } from "../../src/recents/index.js";
import { RetainedSessionCollections } from "../../src/services/RetainedSessionCollections.js";
import { createRecentsRoutes } from "../../src/routes/recents.js";
import type { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";

function createProject(): Project {
  return {
    id: "proj-1" as UrlProjectId,
    path: "/tmp/project",
    name: "project",
    sessionCount: 1,
    sessionDir: "/tmp/project/.claude-sessions",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

function createSummary(): SessionSummary {
  return {
    id: "sess-1",
    projectId: "proj-1" as UrlProjectId,
    title: "Codex recent session",
    fullTitle: "Codex recent session",
    createdAt: new Date("2026-03-10T09:45:00.000Z").toISOString(),
    updatedAt: new Date("2026-03-10T09:46:00.000Z").toISOString(),
    messageCount: 1,
    ownership: { owner: "none" },
    provider: "codex",
  };
}

describe("Recents Routes", () => {
  let directory: string;
  let retained: RetainedSessionCollections | undefined;
  afterEach(async () => {
    await retained?.dispose();
    retained = undefined;
    closeTestDiscoveryDatabases();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("keeps missing visits before and after discovery of an empty profile", async () => {
    directory = await mkdtemp(join(tmpdir(), "ya-empty-recents-"));
    retained = new RetainedSessionCollections({
      dataDir: directory,
      database: openTestDiscoveryDatabase(directory),
      adapters: async () => [],
    });
    const recentsService = new RecentsService({ dataDir: directory });
    await recentsService.recordVisit("unseen", "proj-1");
    const routes = createRecentsRoutes({
      recentsService,
      scanner: {} as ProjectScanner,
      readerFactory: vi.fn(),
      retainedCollections: retained,
    });
    for (const complete of [false, true]) {
      if (complete) await retained.refresh();
      const response = await routes.request("/?summaryMode=retained");
      expect(await response.json()).toEqual({
        recents: [],
        catalog: expect.objectContaining({ complete }),
        visits: recentsService.getRecents(),
      });
    }
  });

  it("resolves visits against all matching public sources and filters the effective project", async () => {
    directory = await mkdtemp(join(tmpdir(), "ya-visit-sources-"));
    const database = openTestDiscoveryDatabase(directory);
    const metadata = new SessionMetadataService({
      dataDir: directory,
      database,
    });
    await metadata.initialize();
    const original = toUrlProjectId("/original"),
      moved = toUrlProjectId("/moved");
    const makeRow = (
      sessionId: string,
      storeKey: string,
      extra: Partial<SessionCatalogRow> = {},
    ): SessionCatalogRow => ({
      catalogFamily: "claude",
      storeKey,
      sessionId,
      projectPath: "/original",
      projectId: original,
      projectIdentityKey: "/original",
      updatedAt: "2026-03-10T09:46:00.000Z",
      fidelity: "head",
      sourceVersion: "one",
      location: { kind: "provider", recordId: sessionId },
      ...extra,
    });
    const remapped = makeRow("native", join(directory, "store-a"), {
      nativeStorageScope: join(directory, "store-a"),
      title: null,
    });
    const conflict = makeRow("other-native", join(directory, "store-c"), {
      catalogFamily: "codex",
      nativeStorageScope: join(directory, "store-c"),
    });
    database.transaction(() => {
      for (const [row, id, projectId] of [
        [remapped, "public", original],
        [conflict, "other-public", moved],
      ] as const) {
        metadata.identities.allocateWithinTransaction({
          sessionId: parseYaSessionId(id),
          provider: row.catalogFamily,
          projectId,
          createdAt: row.updatedAt,
        });
        metadata.identities.bindWithinTransaction(
          parseYaSessionId(id),
          nativeSessionRef(
            row.catalogFamily,
            row.nativeStorageScope!,
            parseNativeSessionId(row.sessionId),
          ),
        );
      }
    });
    const adopted = makeRow("discovered", join(directory, "store-d"), {
      nativeStorageScope: join(directory, "store-d"),
    });
    retained = await seedRetainedCollection(directory, [
      remapped,
      conflict,
      adopted,
      makeRow("duplicate", join(directory, "store-a")),
      makeRow("duplicate", "store-b"),
    ]);
    const recentsService = new RecentsService({ dataDir: directory });
    const routes = createRecentsRoutes({
      recentsService,
      retainedCollections: retained,
      sessionMetadataService: metadata,
      scanner: {} as ProjectScanner,
      readerFactory: vi.fn(),
      projectDisplayName: (path) => "Renamed " + path,
    });
    const path = "/?summaryMode=retained";
    // The first request has no visits or earlier Inbox read. It must still
    // adopt native identities and report a conflict outside the visit set.
    expect(await (await routes.request(path)).json()).toMatchObject({
      visits: [],
      recents: [],
      catalog: { complete: false, refreshError: expect.any(String) },
    });
    expect(
      metadata.identities.lookupNative(
        nativeSessionRef(
          "claude",
          join(directory, "store-d"),
          parseNativeSessionId("discovered"),
        ),
      ),
    ).toBeDefined();
    await metadata.setArchived("public", true);
    for (const id of ["discovered", "duplicate", "public", "native", "missing"])
      await recentsService.recordVisit(id, original);
    await metadata.setWorkingProject("public", moved, original);
    const body = await (await routes.request(path)).json();
    expect(body.visits).toEqual(
      recentsService
        .getRecents()
        .map((v) =>
          v.sessionId === "public" ? { ...v, projectId: moved } : v,
        ),
    );
    expect(body.recents).toEqual([
      {
        ...body.visits[2],
        title: null,
        provider: "claude",
        projectName: "Renamed /moved",
      },
      {
        ...body.visits[4],
        provider: "claude",
        projectName: "Renamed /original",
      },
    ]);
    await recentsService.recordVisit("public", moved);
    const limited = new Hono();
    limited.use(
      "*",
      createLimitedUsersMiddleware({
        getActiveGrants: () => ({
          viewProjects: [moved],
          joinProjects: [],
          newSessionProjects: [],
          joinStaleOffsetMinutes: 0,
          lock: {},
        }),
        getSuperuserIdentity: () => null,
        getCookieSessionUsername: async () => "alice",
        getCookieSecret: () => "secret",
        sessionAccess: new SessionAccessResolver({
          getLiveSession: () => undefined,
          getSessionMetadata: () => undefined,
          readCatalogRows: async () => {
            throw Error("unexpected session lookup");
          },
        }),
      }),
    );
    limited.route("/api/recents", routes);
    const filtered = await (
      await limited.request("/api/recents" + path.slice(1))
    ).json();
    expect(filtered.catalog.complete).toBe(false);
    expect(filtered.catalog).not.toHaveProperty("refreshError");
    expect(filtered.visits).toEqual([recentsService.getRecents()[0]]);
    expect(filtered.recents).toEqual([
      {
        ...filtered.visits[0],
        title: null,
        provider: "claude",
        projectName: "Renamed /moved",
      },
    ]);
  });

  it("resolves recent sessions across providers for mixed-provider projects", async () => {
    const project = createProject();
    const summary = createSummary();
    const claudeReader = {
      getSessionSummary: vi.fn(async () => null),
    } as unknown as ISessionReader;
    const codexReader = {
      getSessionSummary: vi.fn(async () => summary),
    } as unknown as ISessionReader;

    const routes = createRecentsRoutes({
      recentsService: {
        getRecentsWithLimit: vi.fn(() => [
          {
            sessionId: "sess-1",
            projectId: "proj-1",
            visitedAt: new Date("2026-03-10T09:47:00.000Z").toISOString(),
          },
        ]),
      } as unknown as RecentsService,
      scanner: {
        listProjects: vi.fn(async () => [project]),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(() => claudeReader),
      codexSessionsDir: "/tmp/codex-sessions",
      codexReaderFactory: vi.fn(
        () => codexReader as unknown as CodexSessionReader,
      ),
    });

    const response = await routes.request("/");
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.recents).toHaveLength(1);
    expect(json.recents[0]).toMatchObject({
      sessionId: "sess-1",
      title: "Codex recent session",
      provider: "codex",
    });
    expect(vi.mocked(claudeReader.getSessionSummary)).toHaveBeenCalledWith(
      "sess-1",
      "proj-1",
    );
    expect(vi.mocked(codexReader.getSessionSummary)).toHaveBeenCalledWith(
      "sess-1",
      "proj-1",
    );
  });

  it("prunes entries that resolve to no session", async () => {
    const pruneUnresolved = vi.fn(async () => {});
    const reader = {
      getSessionSummary: vi.fn(async () => null),
    } as unknown as ISessionReader;
    const routes = createRecentsRoutes({
      recentsService: {
        getRecentsWithLimit: vi.fn(() => [
          {
            sessionId: "provisional-1",
            projectId: "proj-1",
            visitedAt: new Date("2026-03-10T09:47:00.000Z").toISOString(),
          },
        ]),
        pruneUnresolved,
      } as unknown as RecentsService,
      scanner: {
        listProjects: vi.fn(async () => [createProject()]),
      } as unknown as ProjectScanner,
      readerFactory: vi.fn(() => reader),
    });

    const response = await routes.request("/");
    expect((await response.json()).recents).toEqual([]);
    expect(pruneUnresolved).toHaveBeenCalledWith(
      ["provisional-1"],
      expect.any(Number),
    );
  });

  it("records the superuser's visit but not a limited user's", async () => {
    const recordVisit = vi.fn(async () => {});
    const visitAs = async (principal: Principal) => {
      const app = new Hono<{
        Variables: Record<typeof PRINCIPAL_VARIABLE, Principal>;
      }>();
      app.use("*", async (c, next) => {
        c.set(PRINCIPAL_VARIABLE, principal);
        await next();
      });
      app.route(
        "/",
        createRecentsRoutes({
          recentsService: { recordVisit } as unknown as RecentsService,
          scanner: {} as ProjectScanner,
          readerFactory: vi.fn(),
        }),
      );
      const response = await app.request("/visit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "sess-1", projectId: "proj-1" }),
      });
      expect(response.status).toBe(200);
      return response.json();
    };

    await expect(
      visitAs({
        kind: "limited",
        username: "alice",
        grants: {
          newSessionProjects: [],
          joinProjects: [],
          viewProjects: ["proj-1"],
          joinStaleOffsetMinutes: 0,
          lock: {},
        },
        switched: false,
        locked: true,
        via: "direct",
      }),
    ).resolves.toEqual({ recorded: false });
    expect(recordVisit).not.toHaveBeenCalled();

    await expect(visitAs(SUPERUSER)).resolves.toEqual({ recorded: true });
    expect(recordVisit).toHaveBeenCalledWith("sess-1", "proj-1");
  });
});
