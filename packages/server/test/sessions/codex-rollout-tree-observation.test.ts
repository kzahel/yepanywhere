import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSessionScanner } from "../../src/projects/codex-scanner.js";
import {
  CodexSessionReader,
  observeCodexRolloutTree,
} from "../../src/sessions/codex-reader.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import { FileWatcher } from "../../src/watcher/FileWatcher.js";
import {
  nativeSessionRef,
  parseNativeSessionId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { ProviderChildRelationshipService } from "../../src/sessions/ProviderChildRelationshipService.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import {
  getCodexRolloutTreeEpoch,
  canonicalCodexChange,
} from "../../src/sessions/codex-rollout-tree-observation.js";

// Past both caches' 5 s untrusted lifetime.
const PAST_UNTRUSTED_TTL_MS = 60_000;

describe("watcher-trusted Codex rollout enumeration", () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("publishes a child through an aliased real watcher into a canonical native scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-alias-observed-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const physical = join(await realpath(root), "store"),
      alias = join(root, "alias");
    await mkdir(physical);
    await symlink(physical, alias, "junction");
    const parentId = randomUUID(),
      childId = randomUUID(),
      timestamp = new Date().toISOString();
    const meta = (id: string, parent?: string) =>
      JSON.stringify({
        type: "session_meta",
        timestamp,
        payload: {
          id,
          timestamp,
          cwd: root,
          ...(parent
            ? {
                parent_thread_id: parent,
                source: {
                  subagent: { thread_spawn: { parent_thread_id: parent } },
                },
              }
            : {}),
        },
      }) + "\n";
    await writeFile(
      join(physical, `rollout-${parentId}.jsonl`),
      meta(parentId),
    );
    const events = new EventBus();
    const watcher = new FileWatcher({
      watchDir: alias,
      provider: "codex",
      eventBus: events,
      debounceMs: 10,
    });
    watcher.start();
    cleanups.push(() => watcher.stop());
    await watcher.waitForInitialBaseline();
    cleanups.push(
      observeCodexRolloutTree({
        sessionsDir: alias,
        eventBus: events,
        epoch: () => watcher.getObservationEpoch(),
      }),
    );
    const db = new DiscoverySqliteService({
      dataDir: join(root, "ya"),
      probeNetworkFilesystem: () => undefined,
    });
    cleanups.push(() => db.close());
    const reader = new CodexSessionReader({
      sessionsDir: physical,
      projectPath: root,
    });
    cleanups.push(() => reader.close());
    const rawReader = new CodexSessionReader({
      sessionsDir: alias,
      projectPath: root,
    });
    cleanups.push(() => rawReader.close());
    await rawReader.listSessions(toUrlProjectId(root));
    let first!: () => void,
      second!: () => void,
      commits = 0;
    const initial = new Promise<void>((resolve) => {
      first = resolve;
    });
    const updated = new Promise<void>((resolve) => {
      second = resolve;
    });
    const service = new ProviderChildRelationshipService(
      db.getDatabase(),
      "local",
      () => {
        if (++commits === 1) first();
        else second();
      },
    );
    cleanups.push(() => service.close());
    cleanups.push(
      events.subscribe((event) => {
        if (event.type === "file-change") service.notifyNativeFileChange(event);
      }),
    );
    const parent = nativeSessionRef(
      "codex",
      physical,
      parseNativeSessionId(parentId),
    );
    service.demand(
      parent,
      { sessionId: "public-parent" },
      reader.getProviderChildSource(parent)!,
    );
    await initial;
    expect(service.accepted(parent, "public-parent")).toEqual([]);
    expect(getCodexRolloutTreeEpoch(physical)).toBe(
      watcher.getObservationEpoch(),
    );
    await writeFile(
      join(alias, `rollout-${childId}.jsonl`),
      meta(childId, parentId),
    );
    await updated;
    expect(service.accepted(parent, "public-parent")).toMatchObject([
      { id: childId, parentSessionId: "public-parent" },
    ]);
    expect(
      (
        await rawReader
          .getProviderChildSource(parent)!
          .observe(new AbortController().signal)
      ).children.map((child) => child.native.id),
    ).toEqual([childId]);
    expect(getCodexRolloutTreeEpoch(physical)).toBe(
      watcher.getObservationEpoch(),
    );
    const physicalPath = join(physical, `rollout-${childId}.jsonl`);
    expect(
      await canonicalCodexChange(
        {
          type: "file-change",
          provider: "codex",
          nativeStorageScope: alias,
          path: physicalPath,
          relativePath: "unused",
          changeType: "create",
          fileType: "session",
          timestamp,
        },
        alias,
      ),
    ).toEqual({ scope: physical, path: physicalPath });
    watcher.stop();
    expect(getCodexRolloutTreeEpoch(physical)).toBeNull();
    watcher.start();
    await watcher.waitForInitialBaseline();
    // The physical alias cannot certify a new observation epoch until the
    // configured root is revalidated, including after a possible retarget.
    await canonicalCodexChange({
      type: "file-change",
      provider: "codex",
      nativeStorageScope: physical,
      path: physicalPath,
      relativePath: "unused",
      changeType: "modify",
      fileType: "session",
      timestamp,
    });
    expect(getCodexRolloutTreeEpoch(physical)).toBeNull();
    await canonicalCodexChange(
      {
        type: "file-change",
        provider: "codex",
        nativeStorageScope: alias,
        path: join(alias, `rollout-${childId}.jsonl`),
        relativePath: "unused",
        changeType: "modify",
        fileType: "session",
        timestamp,
      },
      alias,
    );
    expect(getCodexRolloutTreeEpoch(physical)).toBe(
      watcher.getObservationEpoch(),
    );
  });

  async function watchedTree() {
    const sessionsDir = await mkdtemp(join(tmpdir(), "codex-observed-"));
    cleanups.push(() => rm(sessionsDir, { recursive: true, force: true }));
    const eventBus = new EventBus();
    const watcher = new FileWatcher({
      watchDir: sessionsDir,
      provider: "codex",
      eventBus,
      debounceMs: 20,
    });
    watcher.start();
    cleanups.push(() => watcher.stop());
    await watcher.waitForInitialBaseline();
    cleanups.push(
      observeCodexRolloutTree({
        sessionsDir,
        eventBus,
        epoch: () => watcher.getObservationEpoch(),
      }),
    );
    const reported = (filePath: string) =>
      new Promise<void>((resolve) => {
        const unsubscribe = eventBus.subscribe((event) => {
          if (event.type === "file-change" && event.path === filePath) {
            unsubscribe();
            resolve();
          }
        });
      });
    return { sessionsDir, watcher, reported };
  }

  it("synchronously folds a physical path paired with a configured alias without duplicate reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-mixed-observed-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const physical = join(await realpath(root), "store"),
      alias = join(root, "alias");
    await mkdir(physical);
    await symlink(physical, alias, "junction");
    const events = new EventBus();
    cleanups.push(
      observeCodexRolloutTree({
        sessionsDir: alias,
        eventBus: events,
        epoch: () => 1,
      }),
    );
    const first = await writeRollout(physical, "01");
    const timestamp = new Date().toISOString();
    await canonicalCodexChange(
      {
        type: "file-change",
        provider: "codex",
        nativeStorageScope: alias,
        path: first.filePath,
        relativePath: "unused",
        changeType: "create",
        fileType: "session",
        timestamp,
      },
      alias,
    );
    const reader = new CodexSessionReader({ sessionsDir: physical });
    cleanups.push(() => reader.close());
    await reader.listSessionFiles(physical);
    const second = await writeRollout(physical, "02");
    events.emit({
      type: "file-change",
      provider: "codex",
      nativeStorageScope: alias,
      path: second.filePath,
      relativePath: "unused",
      changeType: "create",
      fileType: "session",
      timestamp,
    });
    expect(
      (await reader.listSessionFiles(physical))
        .map((row) => row.sessionId)
        .sort(),
    ).toEqual([first.id, second.id].sort());
    expect(reader.getLastScanMetrics()).toMatchObject({
      sharedCacheStatus: "hit",
      directoriesVisited: 0,
      rolloutFilesFound: 1,
    });
  });

  function rolloutPath(sessionsDir: string, day: string) {
    const id = randomUUID();
    const filePath = join(
      sessionsDir,
      "2026",
      "11",
      day,
      `rollout-2026-11-${day}T00-00-00-${id}.jsonl`,
    );
    return { id, filePath };
  }

  async function writeRollout(sessionsDir: string, day: string) {
    const rollout = rolloutPath(sessionsDir, day);
    await writeRolloutAt(rollout);
    return rollout;
  }

  async function writeRolloutAt({
    id,
    filePath,
  }: {
    id: string;
    filePath: string;
  }) {
    await mkdir(dirname(filePath), { recursive: true });
    const meta = {
      type: "session_meta",
      timestamp: new Date().toISOString(),
      payload: {
        id,
        cwd: "/test/project",
        timestamp: new Date().toISOString(),
      },
    };
    await writeFile(filePath, `${JSON.stringify(meta)}\n`);
  }

  function advanceClock(ms: number) {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + ms);
  }

  it("serves unchanged history without re-walking and folds in reported files", async () => {
    const { sessionsDir, watcher, reported } = await watchedTree();
    const first = await writeRollout(sessionsDir, "01");
    const reader = new CodexSessionReader({
      sessionsDir,
      slowLogThresholdMs: 60_000,
    });
    const ids = async () =>
      (await reader.listSessionFiles(sessionsDir)).map((row) => row.sessionId);

    expect(await ids()).toEqual([first.id]);
    expect(reader.getLastScanMetrics()?.sharedCacheStatus).toBe("miss");

    advanceClock(PAST_UNTRUSTED_TTL_MS);
    expect(await ids()).toEqual([first.id]);
    expect(reader.getLastScanMetrics()).toMatchObject({
      sharedCacheStatus: "hit",
      directoriesVisited: 0,
      rolloutFilesFound: 0,
    });

    // A new day directory and its rollout arrive together, as Codex writes them.
    const second = rolloutPath(sessionsDir, "02");
    const added = reported(second.filePath);
    await writeRolloutAt(second);
    await added;
    expect((await ids()).sort()).toEqual([first.id, second.id].sort());
    // Create and write may arrive as separate reports; each re-reads only
    // the reported file.
    const folded = reader.getLastScanMetrics();
    expect(folded).toMatchObject({
      sharedCacheStatus: "hit",
      directoriesVisited: 0,
    });
    expect(folded?.rolloutFilesFound).toBeGreaterThanOrEqual(1);
    expect(folded?.rolloutFilesFound).toBeLessThanOrEqual(2);

    const deleted = reported(second.filePath);
    await rm(second.filePath);
    await deleted;
    expect(await ids()).toEqual([first.id]);
    expect(reader.getLastScanMetrics()?.sharedCacheStatus).toBe("miss");

    // Without a watcher, the enumeration falls back to its short lifetime.
    watcher.stop();
    advanceClock(2 * PAST_UNTRUSTED_TTL_MS);
    expect(await ids()).toEqual([first.id]);
    expect(reader.getLastScanMetrics()?.sharedCacheStatus).toBe("miss");
  });

  it("keeps the project scanner's enumeration while the watcher observes", async () => {
    const { sessionsDir, watcher } = await watchedTree();
    await writeRollout(sessionsDir, "01");
    const scanner = new CodexSessionScanner({
      sessionsDir,
      slowLogThresholdMs: 60_000,
    });

    const sessionCount = async () =>
      (await scanner.listProjects())[0]?.sessionCount ?? 0;

    expect(await sessionCount()).toBe(1);
    // In the server, ProjectScanner forwards watcher reports to this scanner.
    // Withholding one shows whether a later read re-walked the tree.
    await writeRollout(sessionsDir, "02");

    advanceClock(PAST_UNTRUSTED_TTL_MS);
    expect(await sessionCount()).toBe(1);

    watcher.stop();
    advanceClock(2 * PAST_UNTRUSTED_TTL_MS);
    expect(await sessionCount()).toBe(2);
  });
});
