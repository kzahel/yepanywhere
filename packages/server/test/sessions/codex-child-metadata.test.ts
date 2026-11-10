import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeSessionRef, parseNativeSessionId } from "@yep-anywhere/shared";
import { afterEach, expect, it, vi } from "vitest";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { openCodexSpawnIndex } from "../../src/sessions/codex-spawn-index.js";
import { ProviderChildRelationshipService } from "../../src/sessions/ProviderChildRelationshipService.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { loadSqliteDriver } from "../../src/storage/sqlite.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function fixture(alias = false) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ya-codex-native-index-")),
  );
  const scope = join(root, "sessions"),
    project = join(root, "project"),
    path = join(root, "state_5.sqlite");
  await mkdir(scope);
  await mkdir(project);
  const db = loadSqliteDriver()!.open(path);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT NOT NULL, child_thread_id TEXT PRIMARY KEY, status TEXT NOT NULL); CREATE INDEX idx_thread_spawn_edges_parent_status ON thread_spawn_edges(parent_thread_id,status)",
  );
  const thread = db.prepare("INSERT OR REPLACE INTO threads VALUES(?,?)"),
    edge = db.prepare(
      "INSERT OR REPLACE INTO thread_spawn_edges VALUES(?,?,?)",
    );
  const file = (id: string) => join(scope, `rollout-${id}.jsonl`);
  const header = (id: string, parent?: string, cwd = project) =>
    JSON.stringify({
      type: "session_meta",
      payload: {
        id,
        cwd,
        timestamp: "2026-11-05T00:00:00Z",
        ...(parent
          ? {
              source: {
                subagent: { thread_spawn: { parent_thread_id: parent } },
              },
            }
          : {}),
      },
    });
  const child = async (
    id: string,
    parent = "parent",
    cwd = project,
    terminated = true,
  ) => {
    await writeFile(
      file(id),
      header(id, parent, cwd) + (terminated ? "\n" : ""),
    );
    thread.run(id, file(id));
    edge.run(parent, id, "running");
  };
  await writeFile(
    file("parent"),
    header("parent") + "\n" + "x".repeat(8 * 1024 * 1024) + "\n",
  );
  thread.run("parent", file("parent"));
  const lexical = alias ? join(root, "linked-home", "sessions") : scope;
  if (alias) await symlink(root, join(root, "linked-home"));
  const reader = new CodexSessionReader({
    sessionsDir: lexical,
    projectPath: project,
  });
  const parent = nativeSessionRef(
    "codex",
    scope,
    parseNativeSessionId("parent"),
  );
  const source = reader.getProviderChildSource(parent)!;
  const profile = new DiscoverySqliteService({
    dataDir: join(root, "profile"),
    probeNetworkFilesystem: () => undefined,
  });
  cleanup.push(async () => {
    await reader.close();
    thread.finalize();
    edge.finalize();
    db.close();
    profile.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    scope,
    path,
    project,
    db,
    thread,
    edge,
    file,
    header,
    child,
    reader,
    parent,
    source,
    profile,
  };
}

it("does not publish point metadata into a root replaced during child validation", async () => {
  const f = await fixture();
  await f.child("child");
  const signal = new AbortController().signal;
  const observation = (await f.source.refreshMetadata!(signal))!;
  expect(await f.source.isCurrent(observation.version)).toBe(true);
  const internals = f.reader as unknown as {
    readSessionMeta(path: string, ...args: unknown[]): Promise<unknown>;
  };
  const original = internals.readSessionMeta.bind(f.reader);
  let release!: () => void,
    entered!: () => void,
    held = false;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(internals, "readSessionMeta").mockImplementation(async (path) => {
    const result = await original(path, undefined, undefined, true);
    if (path === f.file("child") && !held) {
      held = true;
      entered();
      await waiting;
    }
    return result;
  });
  const pending = f.source.isCurrent(observation.version);
  const sibling = new CodexSessionReader({
    sessionsDir: f.scope,
    projectPath: f.project,
  });
  try {
    await ready;
    sibling.invalidateCache();
    await rm(f.file("parent"));
    release();
    expect(await pending).toBe(false);
    expect(await sibling.getSessionFilePath("parent")).toBeNull();
  } finally {
    release();
    await pending;
    await sibling.close();
  }
});
it("refreshes exact indexed locators without a corpus scan, fences WAL and own-header changes, and retains SQL history", async () => {
  const f = await fixture();
  await f.child("child");
  // Initial ordinary discovery establishes the owner; subsequent refreshes may
  // only use targeted native metadata even with a large parent transcript.
  const initial = await f.source.observe(new AbortController().signal);
  expect(initial.children.map((c) => c.native.id)).toEqual(["child"]);
  expect(await f.source.isCurrent(initial.version)).toBe(true);
  f.source.releaseObservation?.();
  const scan = vi
    .spyOn(
      f.reader as unknown as { scanSessions(): Promise<unknown> },
      "scanSessions",
    )
    .mockRejectedValue(new Error("CORPUS SCAN FORBIDDEN"));
  const refresh = () => f.source.refreshMetadata!(new AbortController().signal);
  const main = await stat(f.path);
  let observation = (await refresh())!;
  expect(observation.state).toBe("partial");
  expect(observation.children.map((c) => c.native.id)).toEqual(["child"]);
  await appendFile(f.file("child"), "ordinary child activity\n");
  expect(await f.source.isCurrent(observation.version)).toBe(true);
  await f.child("late");
  expect((await stat(f.path)).mtimeMs).toBe(main.mtimeMs);
  expect(await f.source.isCurrent(observation.version)).toBe(false);
  f.source.releaseObservation?.();
  // Index ownership alone does not prove creation parentage or project scope.
  await f.child("attached", "original");
  f.edge.run("parent", "attached", "running");
  await f.child("foreign", "parent", join(f.root, "other-project"));
  await f.child("unfinished", "parent", f.project, false);
  const outside = join(f.root, "outside.jsonl");
  await writeFile(outside, f.header("escape", "parent") + "\n");
  await symlink(outside, f.file("escape"));
  f.thread.run("escape", f.file("escape"));
  f.edge.run("parent", "escape", "running");
  observation = (await refresh())!;
  expect(observation.children.map((c) => c.native.id)).toEqual([
    "child",
    "late",
  ]);
  expect(await f.source.isCurrent(observation.version)).toBe(true);
  await rename(f.file("child"), f.file("old-child"));
  await writeFile(f.file("child"), f.header("child", "other-parent") + "\n");
  expect(await f.source.isCurrent(observation.version)).toBe(false);
  f.source.releaseObservation?.();
  await appendFile(f.file("unfinished"), "\n");
  let now = 0;
  const errors: unknown[] = [];
  const service = new ProviderChildRelationshipService(
    f.profile.getDatabase(),
    "test",
    () => {},
    (e) => errors.push(e),
    undefined,
    () => now,
  );
  cleanup.push(() => service.close());
  // Metadata requests for a registered owner remain independent of full scans.
  const full = f.source.observe;
  f.source.observe = async (signal) =>
    (await f.source.refreshMetadata!(signal))!;
  service.demand(f.parent, { sessionId: "public" }, f.source);
  await vi.waitFor(
    () =>
      expect(
        service
          .accepted(f.parent, "public")
          ?.map((c) => c.id)
          .sort(),
      ).toEqual(["late", "unfinished"]),
    { interval: 5 },
  );
  f.source.observe = full;
  now = 30_001;
  await f.child("new-child");
  expect(
    service.requestMetadataRefresh(f.parent, { sessionId: "public" }, f.source),
  ).toBe(true);
  expect(service.accepted(f.parent, "public")?.map((c) => c.id)).not.toContain(
    "new-child",
  );
  await vi.waitFor(
    () =>
      expect(service.accepted(f.parent, "public")?.map((c) => c.id)).toContain(
        "new-child",
      ),
    { interval: 5 },
  );
  expect(scan).not.toHaveBeenCalled();
  expect(errors).toEqual([]);
  await service.close();
  await f.reader.close();
  // The provider content can disappear; accepted relationships remain durable.
  await rm(f.scope, { recursive: true });
  const reopened = new ProviderChildRelationshipService(
    f.profile.getDatabase(),
    "test",
    () => {},
  );
  cleanup.push(() => reopened.close());
  expect(
    reopened
      .accepted(f.parent, "public")
      ?.map((c) => c.id)
      .sort(),
  ).toEqual(["late", "new-child", "unfinished"]);
});
it("treats missing/old indexes as unavailable, fences physical database replacement, and releases a retained lease on reader retirement", async () => {
  const f = await fixture();
  await f.child("child");
  let observation = (await f.source.refreshMetadata!(
    new AbortController().signal,
  ))!;
  expect(await f.source.isCurrent(observation.version)).toBe(true);
  f.source.releaseObservation?.();
  expect(f.reader.getLastScanMetrics()).toBeNull();
  expect(await f.reader.listProviderChildSessions("parent")).toMatchObject([
    { id: "child" },
  ]);
  observation = (await f.source.refreshMetadata!(
    new AbortController().signal,
  ))!;
  await rename(f.path, `${f.path}.old`);
  await writeFile(f.path, "unsupported database");
  expect(await f.source.isCurrent(observation.version)).toBe(false);
  f.source.releaseObservation?.();
  await rm(f.path);
  expect(
    await f.source.refreshMetadata!(new AbortController().signal),
  ).toBeUndefined();
  await rename(`${f.path}.old`, f.path);
  const next = (await f.source.refreshMetadata!(new AbortController().signal))!;
  expect(next.children).toHaveLength(1);
  await f.reader.close();
  expect(await f.source.isCurrent(next.version)).toBe(false);
  f.source.releaseObservation?.();
  f.db.exec("DROP INDEX idx_thread_spawn_edges_parent_status");
  expect(await openCodexSpawnIndex(f.scope)).toBeUndefined();
});

it("publishes already-read anchors through an aliased home and falls back when the parent SQL locator is unavailable", async () => {
  const f = await fixture(true);
  await f.child("child");
  const errors: unknown[] = [];
  const service = new ProviderChildRelationshipService(
    f.profile.getDatabase(),
    "test",
    () => {},
    (e) => errors.push(e),
  );
  cleanup.push(() => service.close());
  const full = vi.spyOn(f.source, "observe"),
    cheap = vi.spyOn(f.source, "refreshMetadata");
  service.demand(f.parent, { sessionId: "public" }, f.source);
  await vi.waitFor(
    () => expect(service.accepted(f.parent, "public")).toHaveLength(1),
    { interval: 5 },
  );
  const launch = (id: string, call: string) =>
    [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: call,
          arguments: JSON.stringify({
            task_name: id,
            message: "owned fixture",
          }),
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "SubAgentActivity",
            id: call,
            kind: "started",
            agent_thread_id: id,
            agent_path: "/owned",
          },
        },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n";
  await appendFile(f.file("parent"), launch("child", "call-first"));
  await f.reader.getAgentMappings("parent");
  await vi.waitFor(
    () =>
      expect(
        service.accepted(f.parent, "public")?.find((c) => c.id === "child")
          ?.toolUseId,
      ).toBe("call-first"),
    { interval: 5 },
  );
  expect(cheap).toHaveBeenCalledTimes(1);
  expect(full).toHaveBeenCalledTimes(1);
  await f.child("child2");
  const outside = join(f.root, "outside-parent.jsonl");
  await writeFile(outside, f.header("parent") + "\n");
  f.thread.run("parent", outside);
  await appendFile(f.file("parent"), launch("child2", "call-second"));
  f.reader.invalidateCache();
  await f.reader.getAgentMappings("parent");
  await vi.waitFor(
    () =>
      expect(
        service.accepted(f.parent, "public")?.find((c) => c.id === "child2")
          ?.toolUseId,
      ).toBe("call-second"),
    { interval: 5 },
  );
  expect(cheap).toHaveBeenCalledTimes(2);
  expect(full).toHaveBeenCalledTimes(2);
  // A present but partial native index can omit a newly observed child. A
  // meaningful mapping handoff still gets full discovery; aged reads do not.
  f.thread.run("parent", f.file("parent"));
  await f.child("child3");
  f.db.exec("DELETE FROM thread_spawn_edges WHERE child_thread_id = 'child3'");
  await appendFile(f.file("parent"), launch("child3", "call-third"));
  f.reader.invalidateCache();
  await f.reader.getAgentMappings("parent");
  await vi.waitFor(
    () =>
      expect(
        service.accepted(f.parent, "public")?.find((c) => c.id === "child3")
          ?.toolUseId,
      ).toBe("call-third"),
    { interval: 5 },
  );
  expect(cheap).toHaveBeenCalledTimes(3);
  expect(full).toHaveBeenCalledTimes(3);
  expect(errors).toEqual([]);
});
