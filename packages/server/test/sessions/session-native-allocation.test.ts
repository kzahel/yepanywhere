import {
  appendFile,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  nativeSessionRef,
  parseNativeSessionId,
  parseYaSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { NativeSessionAllocationPending } from "../../src/sessions/SessionIdentityStore.js";
import {
  SessionCreationConflict,
  SessionCreationCapacityError,
  StaleCreationAttempt,
} from "../../src/sessions/SessionCreationStore.js";
import { projectCatalogIdentities } from "../../src/sessions/catalog-identity.js";
import type { SessionCatalogRow } from "../../src/sessions/catalog-types.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { createApp } from "../setup/create-app.js";

const requestFor = (path: string) => ({
  provider: "claude" as const,
  projectId: toUrlProjectId(path),
  projectPath: path,
  message: "retained exact prompt",
  settings: {
    permissionMode: "default" as const,
    requestedModel: null,
    thinking: null,
    effort: null,
    serviceTier: null,
  },
});
const context = {
  owner: { kind: "superuser" as const },
  source: {
    kind: "request" as const,
    provenance: { surface: "desktop" as const },
  },
};

it("commits namespace quarantine with dispatch, retaining unknown effects through deletion and profile reopen", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = await mkdtemp(join(tmpdir(), "ya-native-allocation-"));
  let storage: DiscoverySqliteService | undefined;
  try {
    const open = async () => {
      storage = new DiscoverySqliteService({
        dataDir: root,
        probeNetworkFilesystem: () => undefined,
      });
      const metadata = new SessionMetadataService({
        dataDir: root,
        database: storage.getDatabase(),
      });
      await metadata.initialize();
      return metadata;
    };
    let metadata = await open();
    const request = requestFor(root),
      ids = metadata.identities,
      store = metadata.creations;
    const a = store.admit({ requestId: "allocation_a_01", context, request });
    const b = store.admit({ requestId: "allocation_b_01", context, request });
    const native = nativeSessionRef(
      "claude",
      root,
      parseNativeSessionId("native-a"),
    );
    const input = {
      native,
      provider: "claude" as const,
      projectId: request.projectId,
      createdAt: new Date().toISOString(),
    };
    const db = storage!.getDatabase();
    db.exec(
      "CREATE TRIGGER refuse_dispatch BEFORE UPDATE ON session_creation_attempts WHEN NEW.state = 'dispatching' BEGIN SELECT RAISE(ABORT, 'refuse dispatch'); END",
    );
    const generation = store.generation;
    expect(() => store.beginDispatch(a.attempt, native)).toThrow(
      "refuse dispatch",
    );
    expect(ids.isNativeNamespacePending(native)).toBe(false);
    expect(store.generation).toBe(generation);
    expect(store.getForSession(a.sessionId)?.attempt.state).toBe("saved");
    db.exec("DROP TRIGGER refuse_dispatch");
    expect(() =>
      store.beginDispatch(a.attempt, { ...native, family: "codex" }),
    ).toThrow(SessionCreationConflict);
    expect(() =>
      store.beginDispatch(a.attempt, {
        ...native,
        storageScope: "/" + "界".repeat(3000),
      }),
    ).toThrow(SessionCreationCapacityError);
    expect(ids.isNativeNamespacePending(native)).toBe(false);
    expect(store.getForSession(a.sessionId)?.attempt.state).toBe("saved");
    const activeA = store.beginDispatch(a.attempt, native),
      activeB = store.beginDispatch(b.attempt, native);
    expect(ids.canDiscoverNative(native)).toBe(false);
    expect(ids.adoptDiscoveredBatch([input])).toEqual([undefined]);
    expect(() => ids.adoptDiscovered(input)).toThrow(
      NativeSessionAllocationPending,
    );
    expect(ids.resolveYa(parseYaSessionId(native.id))).toBeUndefined();
    expect(() =>
      store.bindNative(activeA, {
        ...native,
        storageScope: join(root, "wrong"),
      }),
    ).toThrow(SessionCreationConflict);
    store.bindNative(activeA, native);
    expect(ids.canDiscoverNative(native)).toBe(true);
    expect(ids.isNativeNamespacePending(native)).toBe(true); // B still owns a claim.
    expect(ids.adoptDiscovered(input).sessionId).toBe(a.sessionId);
    const elsewhere = {
      ...input,
      native: {
        ...native,
        id: parseNativeSessionId("native-elsewhere"),
        storageScope: join(root, "other"),
      },
    };
    expect(ids.adoptDiscovered(elsewhere).sessionId).toBe(elsewhere.native.id);
    const copy = {
      ...input,
      native: { ...native, id: parseNativeSessionId("known-owned-copy") },
    };
    expect(ids.adoptCopiedNative(copy).sessionId).toBe(copy.native.id);
    store.markUncertain(activeB);
    store.delete(activeB);
    expect(ids.isNativeNamespacePending(native)).toBe(true);
    expect(() =>
      store.bindNative(activeB, {
        ...native,
        id: parseNativeSessionId("native-b"),
      }),
    ).toThrow(StaleCreationAttempt);
    storage!.close();
    storage = undefined;
    metadata = await open();
    expect(metadata.identities.isNativeNamespacePending(native)).toBe(true);
    expect(metadata.identities.lookupNative(native)?.sessionId).toBe(
      a.sessionId,
    );
    expect(
      metadata.identities.canDiscoverNative({
        ...native,
        id: parseNativeSessionId("native-b"),
      }),
    ).toBe(false);
    const row: SessionCatalogRow = {
      catalogFamily: "claude",
      storeKey: root,
      sessionId: "scope-less-legacy",
      projectId: request.projectId,
      projectPath: root,
      projectIdentityKey: root,
      updatedAt: new Date().toISOString(),
      fidelity: "identity",
      sourceVersion: "old",
      location: { kind: "provider", recordId: "old" },
    };
    expect(await projectCatalogIdentities([row], metadata)).toEqual([]);
  } finally {
    storage?.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});

it("keeps a native transcript written before binding out of public lists and legacy reads, then publishes only its YA id", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = await mkdtemp(join(tmpdir(), "ya-native-publication-"));
  const project = join(root, "project"),
    projectsDir = join(root, "native"),
    nativeDir = join(projectsDir, "-owned-project");
  const dataDir = join(root, "data"),
    storage = new DiscoverySqliteService({
      dataDir,
      probeNetworkFilesystem: () => undefined,
    });
  let app: ReturnType<typeof createApp> | undefined;
  let releaseLookup = () => {};
  const subscriptions: Array<() => void> = [];
  try {
    await Promise.all([mkdir(project), mkdir(nativeDir, { recursive: true })]);
    const scope = await realpath(nativeDir),
      request = requestFor(project),
      projectId = request.projectId;
    const knownId = parseNativeSessionId(
        "11111111-1111-4111-8111-111111111111",
      ),
      pendingId = parseNativeSessionId("22222222-2222-4222-8222-222222222222");
    const write = async (id: string) =>
      writeFile(
        join(nativeDir, id + ".jsonl"),
        [
          {
            type: "user",
            uuid: "user-" + id,
            sessionId: id,
            cwd: project,
            timestamp: new Date().toISOString(),
            message: { role: "user", content: "native history " + id },
          },
          {
            type: "assistant",
            uuid: "assistant-" + id,
            parentUuid: "user-" + id,
            sessionId: id,
            cwd: project,
            timestamp: new Date().toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "text", text: "native answer " + id }],
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n",
      );
    await write(knownId);
    const metadata = new SessionMetadataService({
      dataDir,
      database: storage.getDatabase(),
    });
    await metadata.initialize();
    metadata.identities.adoptDiscovered({
      native: nativeSessionRef("claude", scope, knownId),
      provider: "claude",
      projectId,
      createdAt: new Date().toISOString(),
    });
    const saved = metadata.creations.admit({
      requestId: "public_allocation_01",
      context,
      request,
    });
    const native = nativeSessionRef("claude", scope, pendingId);
    const sdk = new ScriptedClaudeProvider(),
      starts = vi.spyOn(sdk, "startSession");
    app = createApp({
      dataDir,
      projectsDir,
      discoverySqlite: storage,
      sessionMetadataService: metadata,
      provider: sdk,
      // This fixture models an already-used Claude store without launching it.
      getCatalogFamilies: () => ["claude"],
    });
    let lookupEntered = () => {};
    const entered = new Promise<void>((resolve) => {
      lookupEntered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let armed = true;
    const pause = async () => {
      if (!armed) return;
      armed = false;
      lookupEntered();
      await held;
    };
    const get = app.scanner.getProject.bind(app.scanner),
      getOrCreate = app.scanner.getOrCreateProject.bind(app.scanner);
    const getSpy = vi
      .spyOn(app.scanner, "getProject")
      .mockImplementation(async (id) => {
        await pause();
        return get(id);
      });
    const createSpy = vi
      .spyOn(app.scanner, "getOrCreateProject")
      .mockImplementation(async (id) => {
        await pause();
        return getOrCreate(id);
      });
    const nativeEvents: unknown[] = [];
    subscriptions.push(
      app.focusedSessionWatchManager.subscribe(
        { sessionId: pendingId, projectId, providerHint: "claude" },
        (event) => nativeEvents.push(event),
      ),
    );
    await entered;
    const attempt = metadata.creations.beginDispatch(saved.attempt, native);
    await write(pendingId);
    releaseLookup();
    const watchState = app.focusedSessionWatchManager as unknown as {
      targets: Map<
        string,
        { resolving: boolean; filePath: string | null; watchDir: string | null }
      >;
    };
    // Resolution takes about a second on a loaded host, the default budget.
    await vi.waitFor(
      () =>
        expect(
          watchState.targets.get(`${projectId}:${pendingId}`)?.resolving,
        ).toBe(false),
      { timeout: 5000 },
    );
    expect(
      watchState.targets.get(`${projectId}:${pendingId}`)?.filePath,
    ).toBeNull();
    expect(
      watchState.targets.get(`${projectId}:${pendingId}`)?.watchDir,
    ).toBeNull();
    getSpy.mockRestore();
    createSpy.mockRestore();
    // A known binding in the claimed namespace still receives real appends.
    let knownChanged = () => {};
    const knownEvent = new Promise<void>((resolve) => {
      knownChanged = resolve;
    });
    subscriptions.push(
      app.focusedSessionWatchManager.subscribe(
        { sessionId: knownId, projectId, providerHint: "claude" },
        () => knownChanged(),
      ),
    );
    await vi.waitFor(() =>
      expect(
        watchState.targets.get(`${projectId}:${knownId}`)?.watchDir,
      ).toBeTruthy(),
    );
    await appendFile(join(nativeDir, knownId + ".jsonl"), "\n");
    await knownEvent;
    expect(nativeEvents).toEqual([]);
    // A proven, still-unadopted native file in another scope remains watchable.
    const otherProject = join(root, "other-project"),
      otherDir = join(projectsDir, "-other-project");
    await Promise.all([mkdir(otherProject), mkdir(otherDir)]);
    const otherId = parseNativeSessionId(
        "33333333-3333-4333-8333-333333333333",
      ),
      otherProjectId = toUrlProjectId(otherProject),
      otherFile = join(otherDir, otherId + ".jsonl");
    await writeFile(
      otherFile,
      JSON.stringify({
        type: "user",
        uuid: "other-user",
        cwd: otherProject,
        sessionId: otherId,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "unrelated native scope" },
      }) + "\n",
    );
    app.scanner.invalidateCache();
    await app.scanner.refreshRetainedProjects();
    expect(
      metadata.identities.resolveYa(parseYaSessionId(otherId)),
    ).toBeUndefined();
    let otherChanged = () => {};
    const otherEvent = new Promise<void>((resolve) => {
      otherChanged = resolve;
    });
    subscriptions.push(
      app.focusedSessionWatchManager.subscribe(
        {
          sessionId: otherId,
          projectId: otherProjectId,
          providerHint: "claude",
        },
        () => otherChanged(),
      ),
    );
    await vi.waitFor(() =>
      expect(
        watchState.targets.get(`${otherProjectId}:${otherId}`)?.watchDir,
      ).toBeTruthy(),
    );
    await appendFile(otherFile, "\n");
    await otherEvent;
    expect(nativeEvents).toEqual([]);
    const read = async (url: string) => {
      const response = await app!.app.request(url);
      expect(response.status).toBe(200);
      return response.json();
    };
    for (const suffix of ["", "/metadata"]) {
      expect(
        (
          await app.app.request(
            `/api/projects/${projectId}/sessions/${pendingId}${suffix}`,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await app.app.request(
            `/api/projects/${projectId}/sessions/${knownId}${suffix}`,
          )
        ).status,
      ).toBe(200);
    }
    const refresh = async (id: string) =>
      app!.app.request(
        `/api/projects/${projectId}/sessions/${id}/refresh-preview`,
        { method: "POST", headers: { "X-Yep-Anywhere": "true" } },
      );
    const hiddenPreview = await refresh(pendingId);
    expect([200, 404]).toContain(hiddenPreview.status);
    if (hiddenPreview.status === 200)
      expect((await hiddenPreview.json()).lastAgentText).toBeNull();
    const knownPreview = await refresh(knownId);
    expect(knownPreview.status).toBe(200);
    expect((await knownPreview.json()).lastAgentText).toContain(
      "native answer " + knownId,
    );
    const listed = await read(`/api/projects/${projectId}/sessions`);
    expect(listed.sessions.map((row: { id: string }) => row.id).sort()).toEqual(
      [knownId, saved.sessionId].sort(),
    );
    await vi.waitFor(async () => {
      const body = await read(
        `/api/sessions?summaryMode=retained&project=${projectId}`,
      );
      expect(body.sessions.map((row: { id: string }) => row.id).sort()).toEqual(
        [knownId, saved.sessionId].sort(),
      );
    });
    expect(
      metadata.identities.resolveYa(parseYaSessionId(pendingId)),
    ).toBeUndefined();
    metadata.creations.bindNative(attempt, native);
    expect(metadata.identities.isNativeNamespacePending(native)).toBe(false);
    for (const mode of [
      `?project=${projectId}`,
      `?summaryMode=retained&project=${projectId}`,
    ]) {
      const body = await read("/api/sessions" + mode);
      expect(body.sessions.map((row: { id: string }) => row.id).sort()).toEqual(
        [knownId, saved.sessionId].sort(),
      );
      expect(
        body.sessions.filter(
          (row: { id: string }) => row.id === saved.sessionId,
        ),
      ).toHaveLength(1);
    }
    const bound = await read(
      `/api/projects/${projectId}/sessions/${saved.sessionId}`,
    );
    expect(JSON.stringify(bound.messages)).toContain(
      "native history " + pendingId,
    );
    expect(bound.session.id).toBe(saved.sessionId);
    expect(starts).not.toHaveBeenCalled();
  } finally {
    releaseLookup();
    for (const unsubscribe of subscriptions) unsubscribe();
    app?.stopNotifications();
    await app?.disposeSessionReaders();
    storage.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
  // Several provider-scan waits, each near a second on a loaded host.
}, 20_000);
