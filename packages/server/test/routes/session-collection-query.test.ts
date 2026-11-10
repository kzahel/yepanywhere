import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  toUrlProjectId,
  nativeSessionRef,
  parseNativeSessionId,
} from "@yep-anywhere/shared";
import { afterEach, expect, it, vi } from "vitest";
import {
  createGlobalSessionsRoutes,
  type GlobalSessionsDeps,
} from "../../src/routes/global-sessions.js";
import { createInboxRoutes } from "../../src/routes/inbox.js";
import { NotificationService } from "../../src/notifications/NotificationService.js";
import { RetainedSessionCollections } from "../../src/services/RetainedSessionCollections.js";
import { openTestCatalog } from "../utils/session-catalog.js";
import {
  createTestSessionMetadataService,
  openTestDiscoveryDatabase,
  closeTestDiscoveryDatabases,
} from "../utils/session-metadata-database.js";
import type { SessionCatalogRow } from "../../src/sessions/catalog-types.js";
import type { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";

const owned: Array<{
  directory: string;
  collections: RetainedSessionCollections;
  metadata: SessionMetadataService;
  notifications: NotificationService;
}> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of owned) {
    await f.collections.dispose();
    await f.metadata.flushPendingWrites();
    await f.notifications.flush();
  }
  closeTestDiscoveryDatabases();
  for (const f of owned.splice(0))
    await rm(f.directory, { recursive: true, force: true });
});
async function fixture(count = 256, days = 0) {
  let clock = Date.parse("2026-11-10T12:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const directory = await mkdtemp(join(tmpdir(), "ya-sql-collections-"));
  const scope = join(directory, "native");
  let rows: SessionCatalogRow[] = Array.from({ length: count }, (_, i) => {
    const path = join(directory, `p${i % 4}`);
    return {
      catalogFamily: "claude",
      storeKey: scope,
      nativeStorageScope: scope,
      sessionId: `native-${i}`,
      projectId: toUrlProjectId(path),
      projectPath: path,
      projectIdentityKey: path,
      provider: "claude",
      updatedAt: new Date(clock - i * 3600_000).toISOString(),
      title: `Title ${i}`,
      fidelity: "head",
      sourceVersion: "v1",
      location: { kind: "provider", recordId: `native-${i}` },
    };
  });
  const metadata = createTestSessionMetadataService(directory);
  await metadata.initialize();
  metadata.identities.adoptDiscoveredBatch(
    rows.map((row) => ({
      native: nativeSessionRef(
        "claude",
        scope,
        parseNativeSessionId(row.sessionId),
      ),
      provider: "claude",
      projectId: row.projectId,
      createdAt: row.updatedAt,
    })),
  );
  const adapters = () =>
    [...new Set(rows.map((row) => row.storeKey))].map((storeKey) => ({
      catalogFamily: "claude" as const,
      storeKey,
      scan: async () => ({
        sourceVersion: "fixture",
        rows: rows.filter((row) => row.storeKey === storeKey),
      }),
    }));
  const seed = openTestCatalog(directory);
  await seed.initialize();
  await seed.reconcile(adapters());
  seed.stop();
  const collections = new RetainedSessionCollections({
    dataDir: directory,
    database: openTestDiscoveryDatabase(directory),
    adapters: async () => adapters(),
  });
  const notifications = new NotificationService({ dataDir: directory });
  await notifications.initialize();
  const processes = new Map<string, unknown>();
  const deps: GlobalSessionsDeps = {
    retainedCollections: collections,
    sessionMetadataService: metadata,
    notificationService: notifications,
    sessionAutoArchiveDays: days,
    scanner: {
      listProjects: () => {
        throw new Error("retained query entered discovery");
      },
    } as unknown as ProjectScanner,
    readerFactory: () => {
      throw new Error("retained query entered provider history");
    },
    supervisor: {
      getProcessForSession: (id: string) => processes.get(id),
      getAllProcesses: () =>
        [...processes].map(([sessionId, p]) => ({
          ...(p as object),
          sessionId,
        })),
    } as unknown as Supervisor,
  };
  const global = createGlobalSessionsRoutes(deps);
  const inbox = createInboxRoutes({ ...deps });
  const get = async (path = "?summaryMode=retained&limit=10") => {
    const response = await global.request("/" + path);
    expect(response.status).toBe(200);
    return response.json();
  };
  const getInbox = async () => {
    const response = await inbox.request("/?summaryMode=retained");
    expect(response.status).toBe(200);
    return response.json();
  };
  const id = (i: number) =>
    metadata.identities.lookupNative(
      nativeSessionRef("claude", scope, parseNativeSessionId(`native-${i}`)),
    )!.sessionId;
  owned.push({ directory, collections, metadata, notifications });
  return {
    directory,
    collections,
    metadata,
    notifications,
    deps,
    processes,
    id,
    get,
    getInbox,
    advance: (ms: number) => {
      clock += ms;
    },
    change: async (
      update: (rows: SessionCatalogRow[]) => SessionCatalogRow[],
    ) => {
      rows = update(rows);
      collections.invalidate();
      await collections.refresh();
    },
  };
}

it("uses one SQL owner for list and Inbox polls and touches only changed metadata after publication", async () => {
  const f = await fixture();
  await f.getInbox();
  const tables = () =>
    f.collections.queryDatabase
      .prepare(
        "SELECT name FROM sqlite_temp_master WHERE type='table' AND name LIKE 'collection_query_%_rows'",
      )
      .all();
  const before = f.collections.queryDatabase ? tables() : [];
  const reads = vi.spyOn(f.metadata, "getMetadata");
  const page = await f.get();
  await f.getInbox();
  expect(page.sessions).toHaveLength(10);
  expect(page.stats.totalCount).toBe(256);
  expect(reads.mock.calls.length).toBeLessThan(8);
  expect(tables()).toEqual(before);
  reads.mockClear();
  await f.metadata.setStarred(f.id(12), true);
  const starred = await f.get("?summaryMode=retained&starred=true&limit=5");
  expect(starred.sessions.map((s: { id: string }) => s.id)).toEqual([f.id(12)]);
  expect(starred.stats.starredCount).toBe(1);
  expect(reads.mock.calls.length).toBeLessThan(12);
  reads.mockClear();
  await f.change((rows) =>
    rows
      .filter((row) => row.sessionId !== "native-1")
      .map((row) =>
        row.sessionId === "native-12"
          ? { ...row, title: "Changed title", sourceVersion: "v2" }
          : row,
      ),
  );
  const changed = await f.get("?summaryMode=retained&starred=true");
  expect(changed.sessions[0].title).toBe("Changed title");
  expect(changed.stats.totalCount).toBe(255);
  expect(reads.mock.calls.length).toBeLessThan(20);
});

it("retains pending, reverted and failed metadata without requiring a committed row", async () => {
  const f = await fixture(8);
  await f.get();
  const id = f.id(0);
  await f.metadata.setTitle(id, "Original");
  await f.get();
  const internals = f.metadata as unknown as { save: () => Promise<void> };
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = vi.spyOn(internals, "save").mockReturnValue(held);
  const first = f.metadata.setTitle(id, "Pending");
  try {
    expect((await f.get()).sessions[0].customTitle).toBe("Pending");
    const second = f.metadata.setTitle(id, "Original");
    save.mockRestore();
    release();
    await Promise.all([first, second]);
    await f.metadata.flushPendingWrites();
    expect((await f.get()).sessions[0].customTitle).toBe("Original");
  } finally {
    save.mockRestore();
    release();
    await first;
  }
  const sql = openTestDiscoveryDatabase(f.directory);
  sql.exec(
    "CREATE TRIGGER refuse_metadata BEFORE UPDATE ON session_metadata BEGIN SELECT RAISE(ABORT,'held writer'); END;",
  );
  await expect(f.metadata.setTitle(id, "Failed but visible")).rejects.toThrow(
    "held writer",
  );
  expect((await f.get()).sessions[0].customTitle).toBe("Failed but visible");
  sql.exec("DROP TRIGGER refuse_metadata");
  await f.metadata.flushPendingWrites();
  expect((await f.get()).sessions[0].customTitle).toBe("Failed but visible");
});

it("updates unread counts on seen and clear while recaps change order without creating unread content", async () => {
  const f = await fixture(32);
  await f.get();
  await f.notifications.markSeen(f.id(2));
  expect((await f.get()).stats.unreadCount).toBe(31);
  await f.metadata.addRecapMessage(f.id(2), {
    type: "system",
    subtype: "away_summary",
    content: "Recap",
    timestamp: "2026-11-11T00:00:00Z",
    uuid: "recap",
    id: "recap",
    yaRecapSource: "idle",
  } as never);
  const recap = await f.get();
  expect(recap.sessions[0].id).toBe(f.id(2));
  expect(recap.sessions[0].hasUnread).toBe(false);
  await f.notifications.clearSession(f.id(2));
  expect((await f.get()).stats.unreadCount).toBe(32);
  const inbox = await f.getInbox();
  expect(inbox.recentActivity[0].sessionId).toBe(f.id(2));
});

it("evaluates expiry in both clock directions and preserves explicit archived rows", async () => {
  const f = await fixture(16, 2);
  await f.get();
  await f.metadata.setArchived(f.id(0), true);
  expect((await f.get()).stats.archivedCount).toBe(1);
  f.advance(3 * 86400_000);
  const parses = vi.spyOn(JSON, "parse");
  const old = await f.get();
  // Crossing archive boundaries must not hydrate each cold response payload.
  expect(
    parses.mock.calls.some(
      ([text]) =>
        typeof text === "string" && text.includes('"title":"Title 7"'),
    ),
  ).toBe(false);
  parses.mockRestore();
  expect(old.sessions).toEqual([]);
  expect(old.stats.archivedCount).toBe(16);
  expect(old.stats.totalCount).toBe(0);
  f.advance(-3 * 86400_000);
  const back = await f.get();
  expect(back.stats.archivedCount).toBe(1);
  expect(back.stats.totalCount).toBe(15);
});

it("matches Unicode and escaped prompt text before limiting and retains locale ordering for timestamp ties", async () => {
  const f = await fixture(32);
  await f.get();
  await f.metadata.setInitialPrompt(f.id(31), "Äpfel\0quasar");
  const matched = await f.get(
    "?summaryMode=retained&q=" +
      encodeURIComponent("äpfel\0quasar") +
      "&limit=1",
  );
  expect(matched.sessions.map((s: { id: string }) => s.id)).toEqual([f.id(31)]);
  await f.change((rows) =>
    rows.map((row) => ({ ...row, updatedAt: "2026-11-10T12:00:00Z" })),
  );
  const tied = await f.get("?summaryMode=retained&limit=5");
  const expected = Array.from({ length: 32 }, (_, i) => f.id(i)).sort((a, b) =>
    a.localeCompare(b),
  );
  expect(tied.sessions.map((s: { id: string }) => s.id)).toEqual(
    expected.slice(0, 5),
  );
  expect(tied.hasMore).toBe(true);
});

it("uses publication order when a new native alias precedes an existing public row", async () => {
  const f = await fixture(8);
  await f.get();
  const id = f.id(0);
  let aliasKey = "";
  await f.change((rows) => {
    aliasKey = ["!", "0", "/0"].find(
      (key) => `claude:${key}`.localeCompare(`claude:${rows[0]!.storeKey}`) < 0,
    )!;
    expect(aliasKey).toBeTruthy();
    return [
      ...rows,
      { ...rows[0]!, storeKey: aliasKey, title: "Earlier alias" },
    ];
  });
  expect(
    (await f.get()).sessions.find((s: { id: string }) => s.id === id).title,
  ).toBe("Earlier alias");
  await f.change((rows) => rows.filter((row) => row.storeKey !== aliasKey));
  expect(
    (await f.get()).sessions.find((s: { id: string }) => s.id === id).title,
  ).toBe("Title 0");
});
