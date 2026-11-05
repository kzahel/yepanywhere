import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeSessionRef, parseNativeSessionId } from "@yep-anywhere/shared";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderChildRelationshipService } from "../../src/sessions/ProviderChildRelationshipService.js";
import { SessionRelationshipStore } from "../../src/sessions/SessionRelationshipStore.js";
import { ClaudeSessionReader } from "../../src/sessions/reader.js";
import { MergedSessionReader } from "../../src/sessions/merged-reader.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import type { FileChangeEvent } from "../../src/watcher/EventBus.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import { FileWatcher } from "../../src/watcher/FileWatcher.js";
import { ProviderSessionWatcherRegistry } from "../../src/watcher/ProviderSessionWatcherRegistry.js";
import { resolveProviderChildSessions } from "../../src/sessions/provider-child-sessions.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ya-claude-child-sql-")),
  );
  const nativeRoot = join(root, "native");
  await mkdir(nativeRoot);
  await writeFile(
    join(nativeRoot, "parent.jsonl"),
    "PARENT BODY IS NOT A TRANSCRIPT\n".repeat(32768),
  );
  const parent = nativeSessionRef(
    "claude",
    nativeRoot,
    parseNativeSessionId("parent"),
  );
  const dir = join(nativeRoot, "parent", "subagents");
  const reader = new ClaudeSessionReader({ sessionDir: nativeRoot });
  const db = new DiscoverySqliteService({
    dataDir: join(root, "profile"),
    probeNetworkFilesystem: () => undefined,
  });
  let commit = deferred();
  const errors: unknown[] = [];
  const service = new ProviderChildRelationshipService(
    db.getDatabase(),
    "server",
    () => commit.resolve(),
    (error) => errors.push(error),
  );
  const source = reader.getProviderChildSource(parent)!;
  cleanups.push(async () => {
    await service.close();
    await reader.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const child = async (id: string, title = id) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `agent-${id}.jsonl`), "native child body\n");
    await writeFile(
      join(dir, `agent-${id}.meta.json`),
      JSON.stringify({
        description: title,
        toolUseId: `call-${id}`,
        agentType: "Explore",
        spawnDepth: 1,
      }),
    );
  };
  const demand = async (nextSource = source) => {
    commit = deferred();
    service.demand(parent, { sessionId: "canonical-parent" }, nextSource);
    await commit.promise;
    await nextTurn();
  };
  const changed = async (event: FileChangeEvent) => {
    commit = deferred();
    service.notifyNativeFileChange(event);
    await commit.promise;
    await nextTurn();
  };
  const event = (
    id: string,
    changeType: FileChangeEvent["changeType"],
    meta = false,
    mtimeMs = Date.now(),
  ): FileChangeEvent => ({
    type: "file-change",
    provider: "claude",
    path: join(dir, `agent-${id}.${meta ? "meta.json" : "jsonl"}`),
    relativePath: "",
    changeType,
    fileType: "agent-session",
    timestamp: new Date().toISOString(),
    mtimeMs,
  });
  return {
    root,
    nativeRoot,
    parent,
    dir,
    reader,
    db,
    service,
    source,
    errors,
    child,
    demand,
    changed,
    event,
    accepted: () => service.accepted(parent, "canonical-parent"),
  };
}

it("records exact physical child scope without reading the parent body and serves it after database reopen and source removal", async () => {
  const f = await fixture();
  await f.child("child", "Qualified child");
  await f.demand();
  expect(f.accepted()).toMatchObject([
    {
      id: "child",
      parentSessionId: "canonical-parent",
      title: "Qualified child",
      toolUseId: "call-child",
    },
  ]);
  const store = new SessionRelationshipStore(f.db.getDatabase());
  const edges = store.list({
    resource: { kind: "native", serverId: "server", native: f.parent },
    direction: "outgoing",
  }).edges;
  expect(edges[0]?.target).toEqual({
    kind: "native",
    serverId: "server",
    native: nativeSessionRef("claude", f.dir, parseNativeSessionId("child")),
  });
  store.dispose();
  await f.service.close();
  f.db.close();
  await rm(f.nativeRoot, { recursive: true });
  const reopened = new DiscoverySqliteService({
    dataDir: join(f.root, "profile"),
    probeNetworkFilesystem: () => undefined,
  });
  const next = new ProviderChildRelationshipService(
    reopened.getDatabase(),
    "server",
    () => {},
  );
  try {
    expect(next.accepted(f.parent, "canonical-parent")).toMatchObject([
      { id: "child", title: "Qualified child" },
    ]);
  } finally {
    await next.close();
    reopened.close();
  }
  expect(f.errors).toEqual([]);
});

it("keeps activity append events out of structural acquisition and SQL while allowing late sidecar enrichment and repair", async () => {
  const f = await fixture();
  await f.child("child", "Original child");
  const observe = vi.spyOn(f.source, "observe");
  await f.demand();
  const before = f.accepted()![0]!.updatedAt;
  // Whole seconds avoid utimes' fractional-second conversion rounding below
  // the requested millisecond on Linux. Activity still advances independently.
  const later = Math.ceil(Date.parse(before) / 1000) * 1000 + 10000;
  await utimes(
    join(f.dir, "agent-child.jsonl"),
    new Date(later),
    new Date(later),
  );
  f.service.notifyNativeFileChange(f.event("child", "modify", false, later));
  await vi.waitFor(() =>
    expect(f.accepted()![0]!.updatedAt).toBe(new Date(later).toISOString()),
  );
  expect(observe).toHaveBeenCalledTimes(1);
  const metaPath = join(f.dir, "agent-child.meta.json");
  const original = await readFile(metaPath, "utf8");
  await writeFile(metaPath, "{");
  await f.changed(f.event("child", "modify", true));
  expect(f.accepted()).toMatchObject([
    { title: "Original child", toolUseId: "call-child" },
  ]);
  await writeFile(
    metaPath,
    original.replace("Original child", "Repaired child"),
  );
  await f.changed(f.event("child", "modify", true));
  expect(f.accepted()).toMatchObject([{ title: "Repaired child" }]);
  expect(f.errors).toEqual([]);
});

it("fences stale sidecars and root aliases, distinguishes missing metadata from accepted empty and rejects a foreign root", async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const empty = await f.source.observe(signal);
  expect(empty).toMatchObject({ state: "complete", children: [] });
  expect(await f.source.isCurrent(empty.version)).toBe(true);
  await f.child("child");
  expect(await f.source.isCurrent(empty.version)).toBe(false);
  const first = await f.source.observe(signal);
  await writeFile(
    join(f.dir, "agent-child.meta.json"),
    '{"description":"changed"}',
  );
  expect(await f.source.isCurrent(first.version)).toBe(false);
  await rm(join(f.dir, "agent-child.meta.json"));
  const partial = await f.source.observe(signal);
  expect(partial).toMatchObject({
    state: "partial",
    children: [{ metadataAvailable: false }],
  });
  const foreign = join(f.root, "foreign");
  await mkdir(foreign);
  const foreignReader = new ClaudeSessionReader({ sessionDir: foreign });
  try {
    await expect(
      foreignReader.getProviderChildSource(f.parent)!.observe(signal),
    ).rejects.toThrow("does not own");
  } finally {
    await foreignReader.close();
  }
  const alias = join(f.root, "alias");
  await symlink(
    f.nativeRoot,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const aliased = new ClaudeSessionReader({ sessionDir: alias });
  try {
    const source = aliased.getProviderChildSource(f.parent)!;
    const observed = await source.observe(signal);
    expect(await source.isCurrent(observed.version)).toBe(true);
    expect(
      await source.handleFileChange!({
        ...f.event("child", "create"),
        path: join(alias, "parent", "subagents", "agent-child.jsonl"),
      }),
    ).toBe(true);
    expect(await source.isCurrent(observed.version)).toBe(false);
    const beforeRebind = await source.observe(signal);
    await rm(alias, { recursive: true });
    await symlink(
      foreign,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const lastActivity = source.overlayActivity!([
      beforeRebind.children[0]!.summary,
    ])[0]!.updatedAt;
    await source.handleFileChange!({
      ...f.event("child", "modify", false, Date.now() + 60000),
      path: join(alias, "parent", "subagents", "agent-child.jsonl"),
    });
    expect(
      source.overlayActivity!([beforeRebind.children[0]!.summary])[0]!
        .updatedAt,
    ).toBe(lastActivity);
    expect(await source.isCurrent(beforeRebind.version)).toBe(false);
  } finally {
    await aliased.close();
  }
});

it("selects an exact bound namespace through merged and multi-root readers without a same-id authority fallback", async () => {
  const f = await fixture();
  await f.child("same", "Root A");
  const other = join(f.root, "other");
  const childDir = join(other, "parent", "subagents");
  await mkdir(childDir, { recursive: true });
  await writeFile(join(other, "parent.jsonl"), "unparsed parent B\n");
  await writeFile(join(childDir, "agent-same.jsonl"), "child B\n");
  await writeFile(
    join(childDir, "agent-same.meta.json"),
    '{"description":"Root B"}',
  );
  const merged = new MergedSessionReader([
    new MergedSessionReader([
      new ClaudeSessionReader({
        sessionDir: f.nativeRoot,
        additionalDirs: [other],
      }),
    ]),
  ]);
  try {
    const parent = nativeSessionRef("claude", other, f.parent.id);
    const source = merged.getProviderChildSource!(parent)!;
    const observation = await source.observe(new AbortController().signal);
    expect(observation.children).toMatchObject([
      { native: { storageScope: childDir }, summary: { title: "Root B" } },
    ]);
    expect(
      (await merged.getNativeSessionRefs(["parent"])).get("parent")
        ?.storageScope,
    ).toBe(f.nativeRoot);
    await rm(join(other, "parent.jsonl"));
    await expect(
      source.observe(new AbortController().signal),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await merged.close();
  }
});

it("fences a retiring reader between SQL batches and resumes the remaining native children on a new reader", async () => {
  const f = await fixture();
  for (let i = 0; i < 205; i++) await f.child(String(i).padStart(3, "0"));
  const database = f.db.getDatabase();
  const transaction = database.transaction.bind(database);
  let batches = 0;
  const stop = vi.spyOn(database, "transaction").mockImplementation((write) => {
    const result = transaction(write);
    if (++batches === 1) void f.reader.close();
    return result;
  });
  await f.demand();
  stop.mockRestore();
  expect(batches).toBe(1);
  expect(f.accepted()).toHaveLength(100);
  expect(f.service.hasSource(f.parent)).toBe(false);
  const next = new ClaudeSessionReader({ sessionDir: f.nativeRoot });
  const count = vi
    .spyOn(database, "transaction")
    .mockImplementation((write) => {
      batches++;
      return transaction(write);
    });
  try {
    await f.demand(next.getProviderChildSource(f.parent)!);
    expect(f.accepted()).toHaveLength(205);
    expect(batches).toBe(3);
    expect(f.errors).toEqual([]);
  } finally {
    count.mockRestore();
    await next.close();
  }
});

it("publishes late children from a real aliased native watcher into a canonical scoped SQL source", async () => {
  const f = await fixture();
  await f.demand();
  expect(f.accepted()).toEqual([]);
  const alias = join(f.root, "watch-alias");
  await symlink(
    f.nativeRoot,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const events = new EventBus();
  const seen: FileChangeEvent[] = [];
  const release = events.subscribe((event) => {
    if (event.type === "file-change") {
      seen.push(event);
      f.service.notifyNativeFileChange(event);
    }
  });
  const watcher = new FileWatcher({
    watchDir: alias,
    provider: "claude",
    eventBus: events,
    debounceMs: 10,
  });
  try {
    watcher.start();
    await watcher.waitForInitialBaseline();
    await f.child("late", "Discovered through the real watcher");
    await vi.waitFor(() =>
      expect(f.accepted()).toMatchObject([
        {
          id: "late",
          toolUseId: "call-late",
          title: "Discovered through the real watcher",
        },
      ]),
    );
    expect(
      seen.some(
        (event) =>
          event.nativeStorageScope === alias && event.path.startsWith(alias),
      ),
    ).toBe(true);
    expect(f.errors).toEqual([]);
  } finally {
    watcher.stop();
    release();
  }
});

it("retains activity and shares a live acquisition across repeated fresh source factories", async () => {
  const f = await fixture();
  await f.child("active");
  await f.demand();
  const time = new Date(Math.ceil(Date.now() / 1000) * 1000 + 60000);
  await utimes(join(f.dir, "agent-active.jsonl"), time, time);
  f.service.notifyNativeFileChange(f.event("active", "modify"));
  await vi.waitFor(() =>
    expect(f.accepted()?.[0]?.updatedAt).toBe(time.toISOString()),
  );
  const hold = deferred(),
    started = deferred();
  const observe = f.source.observe;
  let reads = 0;
  f.source.observe = async (signal) => {
    reads++;
    started.resolve();
    await hold.promise;
    return observe(signal);
  };
  const fresh = () =>
    resolveProviderChildSessions(f.reader, "parent", "fresh", {
      service: f.service,
      native: f.parent,
      publicSessionId: "canonical-parent",
    });
  try {
    await fresh();
    await started.promise;
    for (let i = 0; i < 20; i++) {
      expect((await fresh())?.[0]?.updatedAt).toBe(time.toISOString());
      expect(f.accepted()?.[0]?.updatedAt).toBe(time.toISOString());
    }
  } finally {
    hold.resolve();
  }
  await nextTurn();
  await nextTurn();
  expect(reads).toBe(1);
});

it("reconciles children created before a delayed watcher starts through its initial baseline handover", async () => {
  const f = await fixture();
  await f.demand();
  expect(f.accepted()).toEqual([]);
  await f.child("gap", "Created before watcher activation");
  const events = new EventBus();
  const registry = new ProviderSessionWatcherRegistry({
    eventBus: events,
    specs: [{ family: "claude", provider: "claude", watchDir: f.nativeRoot }],
  });
  const release = registry.subscribeReady((family) =>
    f.service.observationReady(family),
  );
  try {
    registry.activate(["claude"]);
    await vi.waitFor(() =>
      expect(f.accepted()?.[0]?.title).toBe(
        "Created before watcher activation",
      ),
    );
    // Bun/macOS may collapse a new descendant tree to its parent directory.
    await f.child("directory-only", "Directory notification");
    f.service.notifyNativeFileChange({
      ...f.event("directory-only", "create"),
      path: join(f.nativeRoot, "parent"),
      nativeStorageScope: f.nativeRoot,
      fileType: "other",
    });
    await vi.waitFor(() => expect(f.accepted()).toHaveLength(2));
  } finally {
    release();
    registry.stop();
  }
});
