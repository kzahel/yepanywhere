import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { toUrlProjectId } from "@yep-anywhere/shared";
import type { SidebarSessionSnapshot } from "@yep-anywhere/shared/sidebar-snapshot";
import { createLimitedUsersMiddleware } from "../../src/middleware/limited-users.js";
import { SessionAccessResolver } from "../../src/auth/sessionAccess.js";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { ProjectScanner } from "../../src/projects/scanner.js";
import {
  createGlobalSessionsRoutes,
  type GlobalSessionItem,
} from "../../src/routes/global-sessions.js";
import type { RetainedSessionCollections } from "../../src/services/RetainedSessionCollections.js";
import { seedRetainedCollection } from "../utils/retained-query-fixture.js";
import {
  closeTestDiscoveryDatabases,
  openTestDiscoveryDatabase,
} from "../utils/session-metadata-database.js";

let dataDir: string;
let collections: RetainedSessionCollections | undefined;
let scanner: ProjectScanner | undefined;
afterEach(async () => {
  await collections?.dispose();
  scanner?.dispose();
  closeTestDiscoveryDatabases();
  if (dataDir) await rm(dataDir, { recursive: true });
  vi.restoreAllMocks();
});

it("replaces independent granted windows using bounded SQL reads after edits", async () => {
  dataDir = await mkdtemp(join(tmpdir(), "sidebar-snapshot-"));
  const allowed = toUrlProjectId("/allowed");
  const denied = toUrlProjectId("/denied");
  const database = openTestDiscoveryDatabase(dataDir);
  let reads = 0;
  let tracking = false;
  const track = (database: ReturnType<typeof openTestDiscoveryDatabase>) => {
    const prepare = database.prepare.bind(database);
    vi.spyOn(database, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      for (const method of ["get", "all"] as const) {
        const original = statement[method].bind(statement);
        vi.spyOn(statement, method).mockImplementation((...values) => {
          if (tracking) reads++;
          return original(...values);
        });
      }
      return statement;
    });
  };
  track(database);
  const metadata = new SessionMetadataService({ dataDir, database });
  await metadata.initialize();
  for (let i = 100; i < 180; i++) {
    await metadata.updateMetadata(`session-${i}`, {
      starred: true,
      sidebarCategory: "Work",
    });
  }
  await metadata.flushPendingWrites();
  collections = await seedRetainedCollection(
    dataDir,
    Array.from({ length: 300 }, (_, i) => ({
      catalogFamily: "claude" as const,
      storeKey: "/fixture",
      nativeStorageScope: "/fixture",
      sessionId: `session-${i}`,
      projectId: i < 100 ? denied : allowed,
      projectPath: i < 100 ? "/denied" : "/allowed",
      projectIdentityKey: i < 100 ? "/denied" : "/allowed",
      updatedAt:
        i < 223 ? "2026-11-11T12:00:00.000Z" : "2026-11-10T12:00:00.000Z",
      title: `Session ${i}`,
      fidelity: "head" as const,
      sourceVersion: "fixture",
      location: { kind: "provider" as const, recordId: `session-${i}` },
    })),
  );
  await collections.refresh();
  track(collections.queryDatabase);
  scanner = new ProjectScanner({
    projectsDir: join(dataDir, "empty"),
    enableCodex: false,
    enableGemini: false,
  });
  const discover = vi
    .spyOn(scanner, "listProjects")
    .mockRejectedValue(new Error("unexpected discovery"));
  const read = vi.fn(() => {
    throw Error("unexpected transcript read");
  });
  const app = new Hono();
  app.use(
    "*",
    createLimitedUsersMiddleware({
      getActiveGrants: () => ({
        newSessionProjects: [],
        joinProjects: [],
        viewProjects: [allowed],
        joinStaleOffsetMinutes: 0,
        lock: {},
      }),
      sessionAccess: new SessionAccessResolver({
        getLiveSession: () => undefined,
        getSessionMetadata: () => undefined,
        readCatalogRows: async () => {
          throw Error("unexpected session lookup");
        },
      }),
      getSuperuserIdentity: () => "owner",
      getCookieSessionUsername: async () => "alice",
      getCookieSecret: () => "secret",
    }),
  );
  app.route(
    "/api/sessions",
    createGlobalSessionsRoutes({
      scanner,
      readerFactory: read,
      retainedCollections: collections,
      sessionMetadataService: metadata,
    }),
  );
  async function snapshot(recent = 4) {
    const response = await app.request(
      `/api/sessions/sidebar?recentLimit=${recent}&starredLimit=3&categorizedLimit=5`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Server-Timing")).toContain("ya-sidebar-sync");
    return response.json() as Promise<
      SidebarSessionSnapshot<GlobalSessionItem>
    >;
  }
  const initial = await snapshot();
  expect(initial.rows).toHaveLength(5);
  expect(initial.rows.every((row) => row.projectId === allowed)).toBe(true);
  expect(initial.windows.recent.ids).toEqual(
    [100, 101, 102, 103].map((i) => `session-${i}`),
  );
  expect(initial.windows.starred.ids).toEqual(
    [100, 101, 102].map((i) => `session-${i}`),
  );
  expect(initial.windows.categorized.ids).toEqual(
    [100, 101, 102, 103, 104].map((i) => `session-${i}`),
  );
  expect(Object.values(initial.windows).every((window) => window.hasMore)).toBe(
    true,
  );
  expect(initial).not.toHaveProperty("filterOptions");
  expect(initial).not.toHaveProperty("stats");
  tracking = true;
  await snapshot(50);
  tracking = false;
  expect(reads).toBeLessThan(32);
  // Identity-bearing cursors neither skip timestamp ties nor repeat the anchor.
  const ids: string[] = [];
  let after: string | undefined;
  do {
    const url = `/api/sessions?summaryMode=retained&limit=50${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const response = await app.request(url);
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      sessions: GlobalSessionItem[];
      hasMore: boolean;
    };
    ids.push(...page.sessions.map((row) => row.id));
    const last = page.sessions.at(-1);
    after =
      page.hasMore && last
        ? JSON.stringify([last.updatedAt, last.id])
        : undefined;
  } while (after);
  expect(ids).toEqual(
    Array.from({ length: 200 }, (_, i) => `session-${i + 100}`).sort((a, b) =>
      a.localeCompare(b),
    ),
  );
  expect(new Set(ids).size).toBe(200);
  await metadata.updateMetadata("session-100", {
    starred: false,
    sidebarCategory: null,
  });
  await metadata.setArchived("session-101", true);
  const edited = await snapshot(8);
  expect(edited.windows.recent.ids).toHaveLength(8);
  expect(edited.windows.starred.ids).toEqual(
    [102, 103, 104].map((i) => `session-${i}`),
  );
  expect(edited.windows.categorized.ids).toEqual(
    [102, 103, 104, 105, 106].map((i) => `session-${i}`),
  );
  expect(edited.rows.some((row) => row.id === "session-101")).toBe(false);
  expect(discover).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  for (const limit of ["501", "0", "NaN", "1.5"]) {
    expect(
      (await app.request(`/api/sessions/sidebar?recentLimit=${limit}`)).status,
    ).toBe(400);
  }
});
