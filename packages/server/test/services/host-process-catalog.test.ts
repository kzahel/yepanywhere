import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNativeSessionId, toUrlProjectId } from "@yep-anywhere/shared";
import { expect, it, vi } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { HostAgentProcessService } from "../../src/services/HostAgentProcessService.js";
import { describeNativeProcessSessions } from "../../src/services/host-process-catalog.js";
import { SessionCatalogService } from "../../src/services/SessionCatalogService.js";
import type { NativeProcessSession } from "../../src/services/providerProcessClassifier.js";
import { catalogAdaptersForRows } from "../../src/sessions/catalog-adapters/row.js";
import type { SessionCatalogRow } from "../../src/sessions/catalog-types.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";

it("correlates native PID namespaces once per sample and never emits a wrong legacy backlink", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const root = await realpath(await mkdtemp(join(tmpdir(), "ya-pid-catalog-")));
  const dataDir = join(root, "data");
  const project = join(root, "original");
  const projectId = toUrlProjectId(project);
  const workingId = toUrlProjectId(join(root, "working"));
  const namespaceA = join(root, "claude-a", "projects");
  const namespaceB = join(root, "claude-b", "projects");
  const nativeId = parseNativeSessionId("same-native-address");
  const legacyId = parseNativeSessionId("retained-legacy-address");
  let storage: DiscoverySqliteService | undefined;
  let service: HostAgentProcessService | undefined;
  const catalog = new SessionCatalogService({ dataDir });
  const row = (
    namespace: string,
    id: string,
    dir = "original",
  ): SessionCatalogRow => ({
    catalogFamily: "claude",
    storeKey: join(namespace, dir),
    nativeStorageScope: join(namespace, dir),
    sessionId: id,
    projectId,
    projectPath: project,
    projectIdentityKey: project,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    title: "native title",
    fidelity: "head",
    sourceVersion: "v1",
    location: { kind: "file", path: join(namespace, dir, id + ".jsonl") },
  });
  const baseRows = [
    row(namespaceA, nativeId),
    row(namespaceA, legacyId),
    row(namespaceB, nativeId),
  ];
  const publish = (rows: SessionCatalogRow[]) =>
    catalog.reconcile(catalogAdaptersForRows(rows));
  let now = Date.parse("2026-11-01T00:00:00.000Z");
  const startedAtMs = now - 1000;
  const nativeRecords: NativeProcessSession[] = [
    {
      nativeSessionId: nativeId,
      projectsRoot: namespaceA,
      projectPath: "/current/cwd/is/not/the/transcript/project",
    },
    {
      nativeSessionId: legacyId,
      projectsRoot: namespaceA,
      projectPath: project,
    },
    {
      nativeSessionId: nativeId,
      projectsRoot: namespaceB,
      projectPath: project,
    },
    { nativeSessionId: nativeId, projectPath: project },
  ];
  try {
    await mkdir(dataDir, { recursive: true });
    storage = new DiscoverySqliteService({
      dataDir,
      probeNetworkFilesystem: () => undefined,
    });
    const metadata = new SessionMetadataService({
      dataDir,
      database: storage.getDatabase(),
    });
    await metadata.initialize();
    const insert = storage
      .getDatabase()
      .prepare(
        "INSERT INTO session_identities VALUES (?, 'claude', ?, ?, 'claude', ?, ?)",
      );
    try {
      insert.run(
        "permanent-a",
        projectId,
        new Date(0).toISOString(),
        join(namespaceA, "original"),
        nativeId,
      );
      insert.run(
        "permanent-b",
        projectId,
        new Date(0).toISOString(),
        join(namespaceB, "original"),
        nativeId,
      );
    } finally {
      insert.finalize();
    }
    await metadata.setTitle("permanent-a", "Public A title");
    await metadata.setTitle("permanent-b", "Public B title");
    await metadata.setTitle(nativeId, "Wrong native-string title");
    await metadata.setTitle(legacyId, "Legacy title");
    await metadata.setWorkingProject("permanent-a", workingId, projectId);
    await catalog.initialize();
    await publish(baseRows);
    const readRows = vi.fn(() => catalog.readRows());
    const nativeReader = vi.fn(
      async (_provider: unknown, pid: number) => nativeRecords[pid - 100],
    );
    service = new HostAgentProcessService(
      async () =>
        nativeRecords.map((_, i) => ({
          pid: 100 + i,
          parentPid: 1,
          startedAtMs,
          cpuTimeMs: 0,
          rssBytes: 1,
          provider: "claude",
        })),
      "darwin",
      () => now,
      async () => new Map(),
      nativeReader,
      describeNativeProcessSessions({ metadata, readRows }),
    );
    const [first, shared] = await Promise.all([
      service.sample([]),
      service.sample([]),
    ]);
    expect(first).toEqual(shared);
    expect(first.observations[0]).toMatchObject({
      sessionId: nativeId,
      sessionTitle: "Public A title",
    });
    expect(first.observations[0]?.projectId).toBeUndefined();
    expect(first.observations[1]).toMatchObject({
      sessionId: legacyId,
      sessionTitle: "Legacy title",
      projectId,
    });
    expect(first.observations[2]).toMatchObject({
      sessionId: nativeId,
      sessionTitle: "Public B title",
    });
    expect(first.observations[2]?.projectId).toBeUndefined();
    expect(first.observations[3]).toMatchObject({ sessionId: nativeId });
    expect(first.observations[3]?.sessionTitle).toBeUndefined();
    expect(JSON.stringify(first)).not.toMatch(
      /Wrong native-string|current\/cwd|claude-a/,
    );
    expect(readRows).toHaveBeenCalledTimes(1);
    expect(nativeReader).toHaveBeenCalledTimes(4);
    now += 5000;
    await service.sample([]);
    expect(readRows).toHaveBeenCalledTimes(1);
    // Another project copy within the same native namespace makes A ambiguous.
    await publish([...baseRows, row(namespaceA, nativeId, "other-original")]);
    now += 61000;
    const ambiguous = await service.sample([]);
    expect(ambiguous.observations[0]?.sessionTitle).toBeUndefined();
    expect(ambiguous.observations[0]?.projectId).toBeUndefined();
    expect(ambiguous.observations[2]?.sessionTitle).toBe("Public B title");
    expect(readRows).toHaveBeenCalledTimes(2);
    // A stale catalogue completion cannot query/adopt after the owner closes.
    let release = () => {};
    let entered = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    readRows.mockImplementationOnce(async () => {
      entered();
      await held;
      return { rows: baseRows, snapshot: catalog.getSnapshot() };
    });
    const lookup = vi.spyOn(metadata.identities, "lookupNative");
    now += 61000;
    const pending = service.sample([]);
    await started;
    service.close();
    storage.close();
    storage = undefined;
    release();
    const closed = await pending;
    expect(
      closed.observations.every(
        (observation) => observation.sessionId === undefined,
      ),
    ).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
    expect(await service.sample([])).toMatchObject({
      enabled: false,
      observations: [],
    });
  } finally {
    service?.close();
    catalog.stop();
    storage?.close();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
