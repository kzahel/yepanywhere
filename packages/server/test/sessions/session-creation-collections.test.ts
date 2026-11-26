import { openTestDiscoveryDatabase } from "../utils/session-metadata-database.js";
import { mkdtemp, mkdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  toUrlProjectId,
  nativeSessionRef,
  parseNativeSessionId,
} from "@yep-anywhere/shared";
import { ProjectMetadataService } from "../../src/metadata/ProjectMetadataService.js";
import { NotificationService } from "../../src/notifications/NotificationService.js";
import { mergeCreationProjectCards } from "../../src/routes/creation-session-collections.js";
import { RetainedSessionCollections } from "../../src/services/RetainedSessionCollections.js";
import {
  RetainedSessionQuery,
  retainedSessionQuery,
} from "../../src/services/retained-session-query.js";
import { catalogAdaptersForRows } from "../../src/sessions/catalog-adapters/row.js";
import { SessionCatalogSqliteStore } from "../../src/services/session-catalog-sqlite.js";
import type { SessionCatalogRow } from "../../src/sessions/catalog-types.js";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { createApp } from "../setup/create-app.js";

it("projects retained global/inbox and project lists from creation state without touching native history", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = await mkdtemp(join(tmpdir(), "ya-creation-collections-"));
  const dataDir = join(root, "data"),
    project = join(root, "project"),
    native = join(root, "native");
  await mkdir(project, { recursive: true });
  const projectId = toUrlProjectId(project),
    storage = new DiscoverySqliteService({
      dataDir,
      probeNetworkFilesystem: () => undefined,
    });
  const metadata = new SessionMetadataService({
    dataDir,
    database: storage.getDatabase(),
  });
  await metadata.initialize();
  const projectMetadata = new ProjectMetadataService({ dataDir });
  await projectMetadata.initialize();
  const notifications = new NotificationService({
    dataDir,
    database: openTestDiscoveryDatabase(dataDir),
  });
  await notifications.initialize();
  const sdk = new ScriptedClaudeProvider(),
    start = vi.spyOn(sdk, "startSession");
  let instance: ReturnType<typeof createApp> | undefined;
  try {
    instance = createApp({
      dataDir,
      projectsDir: native,
      discoverySqlite: storage,
      sessionMetadataService: metadata,
      projectMetadataService: projectMetadata,
      notificationService: notifications,
      provider: sdk,
    });
    const read = async (path: string) => {
      const response = await instance!.app.request(path, {
        headers: { "X-Yep-Anywhere": "true" },
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    const admit = (requestId: string, surface: "desktop" | "api") =>
      metadata.creations.admit({
        requestId,
        context: {
          owner: { kind: "superuser" },
          source: { kind: "request", provenance: { surface } },
        },
        request: {
          provider: "claude",
          projectId,
          projectPath: project,
          message: `original ${surface} prompt`,
          settings: {
            permissionMode: "default",
            requestedModel: "default",
            thinking: null,
            effort: null,
            serviceTier: null,
          },
        },
      });
    const cardReads = vi.spyOn(RetainedSessionQuery.prototype, "projectCards");
    await read("/api/projects?summaryMode=retained");
    expect(cardReads).not.toHaveBeenCalled();
    cardReads.mockRestore();
    const before = await read("/api/sessions");
    const generation = metadata.creations.generation;
    const saved = admit("collection_saved_01", "desktop");
    expect(metadata.creations.generation).toBe(generation + 1);
    const first = await read("/api/sessions?summaryMode=retained");
    expect(first.sessions).toEqual([
      expect.objectContaining({
        id: saved.sessionId,
        projectId,
        creation: expect.objectContaining({ state: "saved" }),
        creationProvenance: { surface: "desktop" },
        initialPrompt: "original desktop prompt",
        messageCount: 0,
        ownership: { owner: "none" },
        hasUnread: false,
      }),
    ]);
    expect(first.stats).toMatchObject({
      totalCount: 1,
      unreadCount: 0,
      providerCounts: { claude: 1 },
    });
    expect(first.projects).toContainEqual(
      expect.objectContaining({ id: projectId }),
    );
    const conditional = await read(
      `/api/sessions?knownGeneration=${before.generation}`,
    );
    expect(conditional.unchanged).not.toBe(true);
    metadata.creations.failBeforeEffects(saved.attempt, "startup-unavailable");
    const api = admit("collection_saved_02", "api");
    const deleted = admit("collection_deleted", "desktop");
    metadata.creations.delete(deleted.attempt);
    const second = await read("/api/sessions?summaryMode=retained");
    expect(
      second.sessions.map((item: { id: string }) => item.id).sort(),
    ).toEqual([saved.sessionId, api.sessionId].sort());
    expect(
      second.sessions.find(
        (item: { id: string }) => item.id === saved.sessionId,
      )?.creation,
    ).toMatchObject({ state: "failed", failure: "startup-unavailable" });
    expect(second.stats).toMatchObject({ totalCount: 2, unreadCount: 0 });
    const listed = await read(`/api/projects/${projectId}/sessions`);
    expect(
      listed.sessions.map((item: { id: string }) => item.id).sort(),
    ).toEqual([saved.sessionId, api.sessionId].sort());
    expect(
      listed.sessions.every(
        (row: { hasUnread: boolean }) => row.hasUnread === false,
      ),
    ).toBe(true);
    const inbox = await read("/api/inbox?summaryMode=retained");
    expect(inbox.recentActivity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: saved.sessionId,
          creation: expect.objectContaining({ state: "failed" }),
          creationProvenance: { surface: "desktop" },
        }),
        expect.objectContaining({
          sessionId: api.sessionId,
          creationProvenance: { surface: "api" },
        }),
      ]),
    );
    expect(inbox.active).toEqual([]);
    expect(inbox.needsAttention).toEqual([]);
    const full = await read("/api/sessions?includeStats=true");
    expect(full.sessions.map((item: { id: string }) => item.id).sort()).toEqual(
      [saved.sessionId, api.sessionId].sort(),
    );
    expect(full.stats).toMatchObject({ totalCount: 2, unreadCount: 0 });
    expect((await read("/api/sessions/stats")).stats.totalCount).toBe(2);
    const legacyInbox = await read("/api/inbox");
    expect(
      legacyInbox.recentActivity
        .map((item: { sessionId: string }) => item.sessionId)
        .sort(),
    ).toEqual([saved.sessionId, api.sessionId].sort());
    for (const mode of ["", "?summaryMode=retained"]) {
      const cards = await read("/api/projects" + mode);
      expect(
        cards.projects.filter((card: { id: string }) => card.id === projectId),
      ).toEqual([
        expect.objectContaining({
          id: projectId,
          sessionCount: 2,
          sessionCountsByProvider: { claude: 2 },
          activeOwnedCount: 0,
        }),
      ]);
    }
    expect(
      (await read(`/api/projects/${projectId}`)).project.sessionCount,
    ).toBe(2);
    const fullRead = vi.spyOn(
      SessionCatalogSqliteStore.prototype,
      "readRowsWithHashes",
    );
    const controlList = vi.spyOn(metadata.creations, "listProjections");
    await read("/api/projects?summaryMode=retained");
    await read(`/api/projects/${projectId}`);
    expect(fullRead).not.toHaveBeenCalled();
    expect(controlList).not.toHaveBeenCalled();
    vi.spyOn(
      RetainedSessionQuery.prototype,
      "projectCards",
    ).mockRejectedValueOnce(new Error("catalog temporarily unavailable"));
    expect(
      (await read(`/api/projects/${projectId}`)).project.sessionCount,
    ).toBe(2);
    fullRead.mockRestore();
    controlList.mockRestore();
    await projectMetadata.hideProject(projectId, project);
    for (const mode of ["", "?summaryMode=retained"]) {
      expect(
        (await read("/api/projects" + mode)).projects.map(
          (card: { id: string }) => card.id,
        ),
      ).not.toContain(projectId);
    }
    await projectMetadata.addProject(projectId, project);
    for (const mode of ["", "?summaryMode=retained"]) {
      expect(
        (await read("/api/projects" + mode)).projects.map(
          (card: { id: string }) => card.id,
        ),
      ).toContain(projectId);
    }
    const replayGeneration = metadata.creations.generation;
    expect(admit("collection_saved_02", "api").sessionId).toBe(api.sessionId);
    expect(metadata.creations.generation).toBe(replayGeneration);
    expect(start).not.toHaveBeenCalled();
    await expect(access(native)).rejects.toThrow();
  } finally {
    await instance?.disposeSessionReaders();
    storage.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});

it("counts a bound creation before native publication and deduplicates its later inventory row", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = await mkdtemp(join(tmpdir(), "ya-creation-counts-"));
  const storage = new DiscoverySqliteService({
    dataDir: root,
    probeNetworkFilesystem: () => undefined,
  });
  let collections: RetainedSessionCollections | undefined;
  try {
    const metadata = new SessionMetadataService({
      dataDir: root,
      database: storage.getDatabase(),
    });
    await metadata.initialize();
    const projectId = toUrlProjectId(root);
    const admit = (requestId: string, provider: "claude" | "codex") =>
      metadata.creations.admit({
        requestId,
        context: {
          owner: { kind: "superuser" },
          source: { kind: "request", provenance: { surface: "web" } },
        },
        request: {
          provider,
          projectId,
          projectPath: root,
          message: "bound without transcript",
          settings: {
            permissionMode: "default",
            requestedModel: null,
            thinking: null,
            effort: null,
            serviceTier: null,
          },
        },
      });
    const saved = admit("count_bound_01", "claude");
    const native = nativeSessionRef(
      "claude",
      root,
      parseNativeSessionId("native_bound"),
    );
    const row = (id: string): SessionCatalogRow => ({
      catalogFamily: "claude",
      storeKey: root,
      nativeStorageScope: root,
      sessionId: id,
      projectId,
      projectPath: root,
      projectIdentityKey: root,
      updatedAt: new Date().toISOString(),
      fidelity: "identity",
      sourceVersion: "1",
      location: { kind: "provider", recordId: id },
    });
    const unrelated = row("native_other");
    const card = {
      id: projectId,
      path: root,
      name: "Project",
      provider: "claude" as const,
      sessionCount: 7,
      sessionCountsByProvider: { claude: 7 },
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
    };
    let published: SessionCatalogRow[] = [unrelated];
    const openCollections = () =>
      new RetainedSessionCollections({
        dataDir: root,
        database: storage.getDatabase(),
        adapters: async () => catalogAdaptersForRows(published),
      });
    collections = openCollections();
    let query = retainedSessionQuery(collections, {
      sessionMetadataService: metadata,
    });
    const cards = async () => {
      const groups = await query.projectCards(projectId);
      return mergeCreationProjectCards([card], groups, {
        runtimeCounts: () => ({
          activeOwnedCount: 0,
          activeExternalCount: 0,
          projectQueueBlockingCount: 0,
        }),
      });
    };
    await collections.refresh();
    expect((await cards())[0]).toMatchObject({
      sessionCount: 2,
      sessionCountsByProvider: { claude: 2 },
    });
    const attempt = metadata.creations.beginDispatch(saved.attempt, native);
    metadata.creations.bindNative(attempt, native);
    expect((await cards())[0]).toMatchObject({
      sessionCount: 2,
      sessionCountsByProvider: { claude: 2 },
    });
    published.push(row(native.id));
    await collections.refresh();
    expect((await cards())[0]).toMatchObject({
      sessionCount: 2,
      sessionCountsByProvider: { claude: 2 },
    });
    const otherProject = toUrlProjectId(join(root, "other"));
    await metadata.setWorkingProject(saved.sessionId, otherProject, projectId);
    expect(
      (await query.projectCards(otherProject)).get(otherProject)?.sessionCount,
    ).toBe(1);
    await metadata.setWorkingProject(saved.sessionId, undefined, undefined);
    const unrelatedProject = toUrlProjectId(join(root, "history"));
    for (const population of [32, 512]) {
      published = [
        unrelated,
        row(native.id),
        ...Array.from({ length: population }, (_, i) => ({
          ...row("history_" + i),
          projectPath: join(root, "history"),
          projectIdentityKey: join(root, "history"),
          projectId: unrelatedProject,
        })),
      ];
      await collections.refresh();
      await cards();
      const scans = vi.spyOn(
        SessionCatalogSqliteStore.prototype,
        "readRowsWithHashes",
      );
      const coldMetadata = vi.spyOn(metadata, "getMetadataBatch");
      expect((await cards())[0]?.sessionCount).toBe(2);
      expect((await query.projectCards()).get(projectId)?.sessionCount).toBe(2);
      expect(scans).not.toHaveBeenCalled();
      expect(coldMetadata.mock.calls.flatMap(([ids]) => ids)).toEqual([]);
      scans.mockRestore();
      coldMetadata.mockRestore();
    }
    const changed = published[published.length - 1]!;
    published[published.length - 1] = {
      ...changed,
      sourceVersion: "2",
      title: "updated",
    };
    await collections.refresh();
    const batch = vi.spyOn(metadata, "getMetadataBatch");
    expect((await cards())[0]?.sessionCount).toBe(2);
    expect(batch.mock.calls.flatMap(([ids]) => ids).length).toBeLessThanOrEqual(
      2,
    );
    batch.mockRestore();
    await collections.dispose();
    collections = openCollections();
    const restoreRead = vi.spyOn(
      SessionCatalogSqliteStore.prototype,
      "readRowsWithHashes",
    );
    query = retainedSessionQuery(collections, {
      sessionMetadataService: metadata,
    });
    expect((await cards())[0]?.sessionCount).toBe(2);
    expect(restoreRead).not.toHaveBeenCalled();
    restoreRead.mockRestore();
    metadata.creations.delete(attempt);
    expect((await cards())[0]?.sessionCount).toBe(1);
    const early = admit("publication_before_bind", "codex");
    const earlyRef = nativeSessionRef(
      "codex",
      root,
      parseNativeSessionId("early_native"),
    );
    const earlyAttempt = metadata.creations.beginDispatch(
      early.attempt,
      earlyRef,
    );
    published.push({ ...row(earlyRef.id), catalogFamily: "codex" });
    await collections.refresh();
    const mixed = {
      sessionCount: 2,
      sessionCountsByProvider: { claude: 1, codex: 1 },
    };
    expect((await cards())[0]).toMatchObject(mixed);
    metadata.creations.bindNative(earlyAttempt, earlyRef);
    expect((await cards())[0]).toMatchObject(mixed);
  } finally {
    await collections?.dispose();
    storage.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
