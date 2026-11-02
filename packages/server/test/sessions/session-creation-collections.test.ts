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
import { projectCatalogIdentities } from "../../src/sessions/catalog-identity.js";
import type { SessionCatalogRow } from "../../src/sessions/catalog-types.js";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
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
  const notifications = new NotificationService({ dataDir });
  await notifications.initialize();
  const sdk = new MockClaudeSDK(),
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
      sdk,
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
  try {
    const metadata = new SessionMetadataService({
      dataDir: root,
      database: storage.getDatabase(),
    });
    await metadata.initialize();
    const projectId = toUrlProjectId(root);
    const saved = metadata.creations.admit({
      requestId: "count_bound_01",
      context: {
        owner: { kind: "superuser" },
        source: { kind: "request", provenance: { surface: "web" } },
      },
      request: {
        provider: "claude",
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
    const cards = async (rows: SessionCatalogRow[]) => {
      const projected = await projectCatalogIdentities(rows, metadata);
      return mergeCreationProjectCards([card], metadata, {
        nativeInventory: projected.map((row) => ({
          id: row.sessionId,
          projectId: row.projectId,
          provider: row.provider ?? row.catalogFamily,
        })),
        runtimeCounts: () => ({
          activeOwnedCount: 0,
          activeExternalCount: 0,
          projectQueueBlockingCount: 0,
        }),
      });
    };
    expect((await cards([unrelated]))[0]).toMatchObject({
      sessionCount: 2,
      sessionCountsByProvider: { claude: 2 },
    });
    const attempt = metadata.creations.beginDispatch(saved.attempt, native);
    metadata.creations.bindNative(attempt, native);
    expect((await cards([unrelated]))[0]).toMatchObject({
      sessionCount: 2,
      sessionCountsByProvider: { claude: 2 },
    });
    expect((await cards([unrelated, row(native.id)]))[0]).toMatchObject({
      sessionCount: 2,
      sessionCountsByProvider: { claude: 2 },
    });
    metadata.creations.delete(attempt);
    expect((await cards([unrelated, row(native.id)]))[0]?.sessionCount).toBe(1);
  } finally {
    storage.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
