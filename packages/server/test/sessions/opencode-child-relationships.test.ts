import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
  rename,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeSessionRef, parseNativeSessionId } from "@yep-anywhere/shared";
import { afterEach, expect, it, vi } from "vitest";
import { openCodeRelationshipWatcherSpec } from "../../src/sessions/opencode-child-source.js";
import { OpenCodeDbReader } from "../../src/sessions/opencode-db-reader.js";
import { OpenCodeSessionReader } from "../../src/sessions/opencode-reader.js";
import { ProviderChildRelationshipService } from "../../src/sessions/ProviderChildRelationshipService.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { loadSqliteDriver } from "../../src/storage/sqlite.js";
import { FileWatcher } from "../../src/watcher/FileWatcher.js";
import { EventBus, type FileChangeEvent } from "../../src/watcher/EventBus.js";
import { ProviderSessionWatcherRegistry } from "../../src/watcher/ProviderSessionWatcherRegistry.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
async function fixture(
  options: { legacy?: boolean; oldSchema?: boolean } = {},
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ya-opencode-child-sql-")),
  );
  const nativeRoot = join(root, "native"),
    project = join(root, "project"),
    storage = join(nativeRoot, "storage"),
    path = join(nativeRoot, "opencode.db");
  await mkdir(nativeRoot);
  await mkdir(project);
  await mkdir(join(storage, "project"), { recursive: true });
  await mkdir(join(storage, "session", "p"), { recursive: true });
  const db = loadSqliteDriver()!.open(path);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE project(id TEXT PRIMARY KEY, worktree TEXT); CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, agent TEXT, time_updated INTEGER); CREATE INDEX session_parent_idx ON session(parent_id)",
  );
  const insert = db.prepare("INSERT INTO session VALUES(?,?,?,?,?,?,?)");
  const child = (
    id: string,
    parent: string | null = "parent",
    directory = project,
  ) => insert.run(id, "p", parent, directory, id, "general", 1000);
  const p = db.prepare("INSERT INTO project VALUES(?,?)");
  p.run("p", project);
  p.finalize();
  if (!options.legacy) child("parent", null);
  const header = async (
    id: string,
    parent?: string,
    extra: Record<string, unknown> = {},
  ) =>
    writeFile(
      join(storage, "session", "p", `${id}.json`),
      JSON.stringify({
        id,
        projectID: "p",
        directory: project,
        parentID: parent,
        title: id,
        time: { updated: 1000 },
        ...extra,
      }),
    );
  if (options.legacy) {
    await writeFile(
      join(storage, "project", "p.json"),
      JSON.stringify({ id: "p", worktree: project }),
    );
    await header("parent");
  }
  if (options.oldSchema)
    db.exec(
      "DROP INDEX session_parent_idx; ALTER TABLE session DROP COLUMN parent_id",
    );
  const reader = new OpenCodeSessionReader({
    databasePath: path,
    storageDir: storage,
    projectPath: project,
  });
  const parent = nativeSessionRef(
    "opencode",
    nativeRoot,
    parseNativeSessionId("parent"),
  );
  const source = reader.getProviderChildSource(parent)!;
  const profile = new DiscoverySqliteService({
    dataDir: join(root, "profile"),
    probeNetworkFilesystem: () => undefined,
  });
  let commits = 0;
  const errors: unknown[] = [];
  const service = new ProviderChildRelationshipService(
    profile.getDatabase(),
    "server",
    () => {
      commits++;
    },
    (e) => errors.push(e),
  );
  const demand = () =>
    service.demand(
      parent,
      { sessionId: "public-parent" },
      reader.getProviderChildSource(parent)!,
    );
  const wait = async (test: () => boolean) =>
    vi.waitFor(() => expect(test()).toBe(true), { interval: 5, timeout: 2000 });
  cleanup.push(async () => {
    await service.close();
    reader.close();
    insert.finalize();
    db.close();
    profile.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    nativeRoot,
    project,
    storage,
    path,
    db,
    child,
    header,
    reader,
    parent,
    source,
    profile,
    service,
    errors,
    demand,
    wait,
    commits: () => commits,
  };
}
it("publishes native descendants with immediate parents, sees WAL-only commits, and reopens SQL without native content", async () => {
  const f = await fixture();
  f.child("child");
  f.child("grandchild", "child");
  f.child("fork", null);
  const before = await stat(f.path);
  f.demand();
  expect(f.service.accepted(f.parent, "public-parent")).toBeUndefined();
  await f.wait(
    () => f.service.accepted(f.parent, "public-parent")?.length === 1,
  );
  expect(
    f.service.accepted(f.parent, "public-parent")?.map((c) => c.id),
  ).toEqual(["child"]);
  const childRef = nativeSessionRef(
    "opencode",
    f.nativeRoot,
    parseNativeSessionId("child"),
  );
  expect(
    f.service.accepted(childRef, "public-child")?.map((c) => c.id),
  ).toEqual(["grandchild"]);
  f.child("late");
  expect((await stat(f.path)).mtimeMs).toBe(before.mtimeMs);
  f.demand();
  await f.wait(
    () => f.service.accepted(f.parent, "public-parent")?.length === 2,
  );
  const later = f.db.prepare(
    "UPDATE session SET time_updated=2000 WHERE id='late'",
  );
  later.run();
  later.finalize();
  f.demand();
  await f.wait(
    () => f.service.accepted(f.parent, "public-parent")?.[0]?.id === "late",
  );
  const commits = f.commits();
  const u = f.db.prepare(
    "UPDATE session SET time_updated=5000 WHERE id='child'",
  );
  u.run();
  u.finalize();
  const observation = await f.source.observe(new AbortController().signal);
  expect(await f.source.isCurrent(observation.version)).toBe(true);
  f.demand();
  await f.wait(
    () =>
      f.service
        .accepted(f.parent, "public-parent")
        ?.find((c) => c.id === "child")?.updatedAt ===
      new Date(5000).toISOString(),
  );
  expect(f.commits()).toBe(commits);
  expect(f.service.accepted(f.parent, "public-parent")?.[0]?.id).toBe("child");
  expect(f.errors).toEqual([]);
  await f.service.close();
  f.reader.close();
  await rename(f.nativeRoot, join(f.root, "gone"));
  const reopened = new ProviderChildRelationshipService(
    f.profile.getDatabase(),
    "server",
    () => {},
  );
  try {
    expect(
      reopened
        .accepted(f.parent, "public-parent")
        ?.map((c) => c.id)
        .sort(),
    ).toEqual(["child", "late"]);
    expect(reopened.accepted(childRef, "public-child")?.[0]?.id).toBe(
      "grandchild",
    );
  } finally {
    await reopened.close();
  }
});
it("revalidates the logical WAL snapshot before publication and isolates cycles and foreign ancestry", async () => {
  const f = await fixture();
  f.child("valid");
  f.child("cycle-a", "cycle-b");
  f.child("cycle-b", "cycle-a");
  f.child("foreign", "parent", join(f.root, "foreign"));
  // Global project's worktree cannot supply an umbrella grant.
  f.db.exec("UPDATE project SET worktree='/' WHERE id='p'");
  const first = await f.source.observe(new AbortController().signal);
  f.child("late");
  expect(await f.source.isCurrent(first.version)).toBe(false);
  // Cycles reachable through a selected parent cannot turn into invented edges.
  f.child("self", "self");
  f.child("cycle-valid", "cycle-a");
  const cycleParent = nativeSessionRef(
    "opencode",
    f.nativeRoot,
    parseNativeSessionId("cycle-a"),
  );
  const cyclic = await f.reader
    .getProviderChildSource(cycleParent)!
    .observe(new AbortController().signal);
  expect(cyclic.state).toBe("partial");
  expect(cyclic.children.map((c) => c.native.id)).toEqual(["cycle-valid"]);
  f.demand();
  await f.wait(
    () => f.service.accepted(f.parent, "public-parent")?.length === 2,
  );
  expect(
    f.service
      .accepted(f.parent, "public-parent")
      ?.map((c) => c.id)
      .sort(),
  ).toEqual(["late", "valid"]);
  expect(f.errors).toEqual([]);
  const wrong = new OpenCodeSessionReader({
    databasePath: f.path,
    storageDir: f.storage,
    projectPath: join(f.root, "different"),
  });
  try {
    await expect(
      wrong
        .getProviderChildSource(f.parent)!
        .observe(new AbortController().signal),
    ).rejects.toThrow("project");
  } finally {
    wrong.close();
  }
});
it("imports bounded legacy headers, gives current SQL parent proof precedence, and retains history after bad metadata", async () => {
  const f = await fixture({ legacy: true });
  await f.header("old", "parent");
  await f.header("grandchild", "old");
  await f.header("moved", "parent");
  f.child("other", null);
  f.child("moved", "other");
  f.demand();
  await f.wait(
    () => f.service.accepted(f.parent, "public-parent")?.length === 1,
  );
  expect(f.service.accepted(f.parent, "public-parent")?.[0]?.id).toBe("old");
  const other = nativeSessionRef(
    "opencode",
    f.nativeRoot,
    parseNativeSessionId("other"),
  );
  expect(f.service.accepted(other, "other-public")?.[0]?.id).toBe("moved");
  await writeFile(
    join(f.storage, "session", "p", "old.json"),
    "{".repeat(70000),
  );
  f.demand();
  await f.wait(() => f.commits() >= 2);
  expect(f.service.accepted(f.parent, "public-parent")?.[0]?.id).toBe("old");
  expect(f.errors).toEqual([]);
});
it("distinguishes unavailable native stores and schemas without parent proof from known empty", async () => {
  const f = await fixture({ oldSchema: true });
  const observation = await f.source.observe(new AbortController().signal);
  expect(observation.state).toBe("partial");
  expect(observation.children).toEqual([]);
  const other = join(f.root, "other");
  await mkdir(other);
  const wrong = f.reader.getProviderChildSource(
    nativeSessionRef("opencode", other, parseNativeSessionId("parent")),
  )!;
  await expect(wrong.observe(new AbortController().signal)).rejects.toThrow(
    "namespace",
  );
  f.reader.close();
  await expect(f.source.observe(new AbortController().signal)).rejects.toThrow(
    "retired",
  );
});
it("honors native SQLite opt-out while preserving qualified legacy proof", async () => {
  const f = await fixture({ legacy: true });
  await f.header("old", "parent");
  vi.stubEnv("OPENCODE_DB_READER", "0");
  expect(openCodeRelationshipWatcherSpec(f.path)).toBeUndefined();
  // A deliberately corrupt native store must not be opened in this mode.
  await writeFile(f.path, "not sqlite");
  f.demand();
  await f.wait(
    () => f.service.accepted(f.parent, "public-parent")?.length === 1,
  );
  expect(f.errors).toEqual([]);
});
it("uses one private metadata watcher, prunes transcript/media trees, and discovers late native children", async () => {
  const f = await fixture();
  await mkdir(join(f.nativeRoot, "media", "deep"), { recursive: true });
  await writeFile(join(f.nativeRoot, "media", "deep", "large"), "ignored");
  const publicEvents: unknown[] = [];
  const bus = new EventBus();
  const unsubscribe = bus.subscribe((e) => publicEvents.push(e));
  let nativeWatcher: FileWatcher | undefined;
  const watchers = new ProviderSessionWatcherRegistry({
    eventBus: bus,
    createWatcher: (options) => (nativeWatcher = new FileWatcher(options)),
    specs: [{ ...openCodeRelationshipWatcherSpec(f.path)!, debounceMs: 5 }],
  });
  const seen: unknown[] = [];
  const remove = watchers.subscribeNativeChanges((e) => {
    seen.push(e);
    f.service.notifyNativeFileChange(e);
  });
  const ready = watchers.subscribeReady((family) =>
    f.service.observationReady(family),
  );
  cleanup.push(async () => {
    remove();
    ready();
    unsubscribe();
    watchers.stop();
  });
  watchers.activate(["opencode"]);
  f.demand();
  await vi.waitFor(
    () => {
      expect(f.errors).toEqual([]);
      expect(
        f.service.accepted(f.parent, "public-parent"),
        "initial accepted empty",
      ).toEqual([]);
    },
    { interval: 5, timeout: 2000 },
  );
  f.child("late");
  await vi.waitFor(
    () => {
      expect(f.errors).toEqual([]);
      expect(
        f.service.accepted(f.parent, "public-parent"),
        JSON.stringify({ seen, diag: watchers.getDiagnostics() }),
      ).toHaveLength(1);
    },
    { interval: 5, timeout: 2000 },
  );
  expect(nativeWatcher!.getInitialBaselineMetrics()!.directoriesVisited).toBe(
    1,
  );
  expect(publicEvents).toEqual([]);
  expect(watchers.getMetrics().activeWatchers).toBe(1);
  expect(watchers.getDiagnostics().families[0]?.baselineState).toBe("complete");
  expect(f.errors).toEqual([]);
});

it("fences project-alias rebinding between acquisition and commit", async () => {
  const f = await fixture();
  f.child("child");
  const alias = join(f.root, "project-alias"),
    elsewhere = join(f.root, "elsewhere");
  await mkdir(elsewhere);
  await symlink(
    f.project,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const update = f.db.prepare("UPDATE session SET directory=?");
  try {
    update.run(alias);
  } finally {
    update.finalize();
  }
  const reader = new OpenCodeSessionReader({
    databasePath: f.path,
    storageDir: f.storage,
    projectPath: alias,
  });
  try {
    const source = reader.getProviderChildSource(f.parent)!;
    const snapshot = await source.observe(new AbortController().signal);
    expect(snapshot.children).toHaveLength(1);
    await rm(alias);
    await symlink(
      elsewhere,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(await source.isCurrent(snapshot.version)).toBe(false);
  } finally {
    reader.close();
  }
});

it("coalesces DB/WAL for all 128 sources and reacquires only the changed lineage", async () => {
  const f = await fixture();
  f.child("child");
  const observed = [{ native: f.parent, source: f.source }];
  for (let i = 0; i < 127; i++) {
    const id = "unrelated-" + i;
    f.child(id, null);
    const native = nativeSessionRef(
      "opencode",
      f.nativeRoot,
      parseNativeSessionId(id),
    );
    observed.push({ native, source: f.reader.getProviderChildSource(native)! });
  }
  let handled = 0,
    done!: () => void;
  let finished = new Promise<void>((resolve) => (done = resolve));
  for (const { native, source } of observed) {
    const original = source.handleFileChange!;
    source.handleFileChange = async (event) => {
      try {
        return await original(event);
      } finally {
        if (++handled === observed.length) done();
      }
    };
    f.service.demand(native, { sessionId: "public-" + native.id }, source);
  }
  await f.wait(() =>
    observed.every(
      ({ native }) =>
        f.service.accepted(native, "public-" + native.id) !== undefined,
    ),
  );
  const commits = f.commits();
  const snapshot = vi.spyOn(
    OpenCodeDbReader.prototype,
    "readRelationshipSnapshot",
  );
  try {
    const update = f.db.prepare(
      "UPDATE session SET time_updated=5000 WHERE id='child'",
    );
    update.run();
    update.finalize();
    const event: FileChangeEvent = {
      type: "file-change",
      provider: "opencode",
      path: f.path + "-wal",
      relativePath: "opencode.db-wal",
      nativeStorageScope: f.nativeRoot,
      fileType: "agent-session",
      changeType: "modify",
      timestamp: "2026-11-05T00:00:01Z",
    };
    f.service.notifyNativeFileChange({
      ...event,
      path: f.path,
      relativePath: "opencode.db",
    });
    f.service.notifyNativeFileChange(event);
    await finished;
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(f.commits()).toBe(commits);
    expect(f.service.accepted(f.parent, "public-parent")?.[0]?.updatedAt).toBe(
      new Date(5000).toISOString(),
    );
    handled = 0;
    finished = new Promise<void>((resolve) => (done = resolve));
    snapshot.mockClear();
    f.child("late");
    f.service.notifyNativeFileChange({
      ...event,
      timestamp: "2026-11-05T00:00:02Z",
    });
    await finished;
    await f.wait(
      () => f.service.accepted(f.parent, "public-parent")?.length === 2,
    );
    expect(snapshot).toHaveBeenCalledTimes(3);
    expect(f.commits()).toBe(commits + 1);
    expect(f.errors).toEqual([]);
  } finally {
    snapshot.mockRestore();
  }
});
it("keeps current database proof available when legacy storage fails and an ancestor above the selected parent is missing", async () => {
  const f = await fixture();
  f.child("child");
  const foreign = join(f.root, "foreign-legacy");
  await mkdir(join(foreign, "project"), { recursive: true });
  await rename(f.storage, join(f.root, "old-storage"));
  await symlink(
    foreign,
    f.storage,
    process.platform === "win32" ? "junction" : "dir",
  );
  const update = f.db.prepare(
    "UPDATE session SET parent_id='missing-ancestor' WHERE id='parent'",
  );
  update.run();
  update.finalize();
  const observation = await f.source.observe(new AbortController().signal);
  expect(observation.state).toBe("partial");
  expect(observation.children.map((c) => c.native.id)).toEqual(["child"]);
  expect(await f.source.isCurrent(observation.version)).toBe(true);
});
it("preserves legacy-owned parent proof when an older native schema has no parent column", async () => {
  const f = await fixture({ legacy: true, oldSchema: true });
  await f.header("old-child", "parent");
  const insert = f.db.prepare(
    "INSERT INTO session(id,project_id,directory,title,agent,time_updated) VALUES(?,'p',?,'from DB','general',1000)",
  );
  try {
    insert.run("parent", f.project);
    insert.run("old-child", f.project);
  } finally {
    insert.finalize();
  }
  const observation = await f.source.observe(new AbortController().signal);
  expect(observation.state).toBe("partial");
  expect(observation.children).toMatchObject([
    { native: { id: "old-child" }, parent: { id: "parent" } },
  ]);
});

it("publishes an initial parent while unrelated lineage changes interleave with validation", async () => {
  const f = await fixture();
  f.child("other", null);
  f.child("child");
  const other = nativeSessionRef(
    "opencode",
    f.nativeRoot,
    parseNativeSessionId("other"),
  );
  f.service.demand(
    other,
    { sessionId: "public-other" },
    f.reader.getProviderChildSource(other)!,
  );
  await f.wait(() => f.service.accepted(other, "public-other") !== undefined);
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((yes) => (resolve = yes));
    return { promise, resolve };
  };
  const gates = [gate(), gate()];
  let validations = 0;
  const original = f.source.isCurrent;
  f.source.isCurrent = async (version) => {
    const n = validations++;
    if (gates[n]) await gates[n]!.promise;
    return original(version);
  };
  try {
    f.service.demand(f.parent, { sessionId: "public-parent" }, f.source);
    await f.wait(() => validations === 1);
    const event: FileChangeEvent = {
      type: "file-change",
      provider: "opencode",
      path: f.path + "-wal",
      relativePath: "opencode.db-wal",
      nativeStorageScope: f.nativeRoot,
      fileType: "agent-session",
      changeType: "modify",
      timestamp: "2026-11-05T00:01:01Z",
    };
    f.child("other-child-1", "other");
    f.service.notifyNativeFileChange(event);
    await f.wait(() => f.service.accepted(other, "public-other")?.length === 1);
    gates[0]!.resolve();
    await f.wait(
      () =>
        f.service.accepted(f.parent, "public-parent") !== undefined ||
        validations === 2,
    );
    f.child("other-child-2", "other");
    f.service.notifyNativeFileChange({
      ...event,
      timestamp: "2026-11-05T00:01:02Z",
    });
    await f.wait(() => f.service.accepted(other, "public-other")?.length === 2);
    gates[1]!.resolve();
    const update = f.db.prepare(
      "UPDATE session SET time_updated=6000 WHERE id='other'",
    );
    update.run();
    update.finalize();
    f.service.notifyNativeFileChange({
      ...event,
      timestamp: "2026-11-05T00:01:03Z",
    });
    await f.wait(
      () => f.service.accepted(f.parent, "public-parent")?.[0]?.id === "child",
    );
    expect(f.errors).toEqual([]);
  } finally {
    for (const g of gates) g.resolve();
  }
});

it("refreshes current SQLite metadata without enumerating a retained legacy catalog", async () => {
  const f = await fixture();
  f.child("child");
  const full = await f.source.observe(new AbortController().signal);
  expect(await f.source.isCurrent(full.version)).toBe(true);
  f.source.releaseObservation?.();
  const owner = (
    f.reader as unknown as {
      childSourceOwner: { legacyRows(): Promise<unknown> };
    }
  ).childSourceOwner;
  const legacy = vi
    .spyOn(owner, "legacyRows")
    .mockRejectedValue(new Error("LEGACY CORPUS FORBIDDEN"));
  f.child("late");
  const next = (await f.source.refreshMetadata!(new AbortController().signal))!;
  expect(next.state).toBe("partial");
  expect(next.children.map((c) => c.native.id)).toEqual(["child", "late"]);
  expect(await f.source.isCurrent(next.version)).toBe(true);
  expect(legacy).not.toHaveBeenCalled();
  f.source.releaseObservation?.();
  legacy.mockRestore();
});
