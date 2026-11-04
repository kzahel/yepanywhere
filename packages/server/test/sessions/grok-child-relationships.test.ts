import {
  mkdir,
  link,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeSessionRef, parseNativeSessionId } from "@yep-anywhere/shared";
import { afterEach, expect, it, vi } from "vitest";
import { GrokSessionReader } from "../../src/sessions/grok-reader.js";
import { ProviderChildRelationshipService } from "../../src/sessions/ProviderChildRelationshipService.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { EventBus, type FileChangeEvent } from "../../src/watcher/EventBus.js";
import { ProviderSessionWatcherRegistry } from "../../src/watcher/ProviderSessionWatcherRegistry.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ya-grok-child-sql-")),
  );
  const nativeRoot = join(root, "native"),
    project = join(root, "project");
  const parentDir = join(nativeRoot, encodeURIComponent(project), "parent");
  await mkdir(parentDir, { recursive: true });
  await mkdir(project);
  const summary = {
    info: { id: "parent", cwd: project },
    updated_at: "2026-11-04T00:00:00Z",
  };
  await writeFile(join(parentDir, "summary.json"), JSON.stringify(summary));
  await writeFile(
    join(parentDir, "updates.jsonl"),
    "NOT A TRANSCRIPT\n".repeat(65536),
  );
  const parent = nativeSessionRef(
    "grok",
    nativeRoot,
    parseNativeSessionId("parent"),
  );
  const reader = new GrokSessionReader({
    sessionsDir: nativeRoot,
    projectPath: project,
  });
  const source = reader.getProviderChildSource(parent)!;
  const db = new DiscoverySqliteService({
    dataDir: join(root, "profile"),
    probeNetworkFilesystem: () => undefined,
  });
  let commit = deferred();
  const errors: unknown[] = [];
  let commits = 0;
  const service = new ProviderChildRelationshipService(
    db.getDatabase(),
    "server",
    () => {
      commits++;
      commit.resolve();
    },
    (error) => errors.push(error),
  );
  cleanup.push(async () => {
    await service.close();
    reader.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const child = async (id: string, title = id) => {
    const dir = join(parentDir, "subagents", id),
      nativeDir = join(nativeRoot, encodeURIComponent(project), id);
    await mkdir(dir, { recursive: true });
    await mkdir(nativeDir, { recursive: true });
    await writeFile(
      join(nativeDir, "summary.json"),
      JSON.stringify({ info: { id, cwd: project } }),
    );
    await writeFile(
      join(nativeDir, "updates.jsonl"),
      "NOT A CHILD TRANSCRIPT\n".repeat(8192),
    );
    await writeFile(
      join(dir, "meta.json"),
      JSON.stringify({
        subagent_id: id,
        child_session_id: id,
        parent_session_id: "parent",
        description: title,
        subagent_type: "general-purpose",
        child_cwd: project,
        started_at: "2026-11-04T00:00:00Z",
        prompt: "DO_NOT_SAVE_DELEGATED_PROMPT",
        attempt_id: "DO_NOT_SAVE_ATTEMPT",
      }),
    );
    return { dir, nativeDir, meta: join(dir, "meta.json") };
  };
  const demand = async () => {
    commit = deferred();
    service.demand(parent, { sessionId: "public-parent" }, source);
    await commit.promise;
    await turn();
  };
  const event = (
    path: string,
    changeType: FileChangeEvent["changeType"] = "modify",
  ): FileChangeEvent => ({
    type: "file-change",
    provider: "grok",
    path,
    relativePath: "unused",
    nativeStorageScope: nativeRoot,
    changeType,
    fileType: "agent-session",
    timestamp: new Date().toISOString(),
  });
  return {
    root,
    nativeRoot,
    project,
    parentDir,
    parent,
    reader,
    source,
    db,
    service,
    errors,
    child,
    demand,
    event,
    get commits() {
      return commits;
    },
    accepted: () => service.accepted(parent, "public-parent"),
  };
}

it("publishes scoped Grok child proof without parsing bodies or retaining delegated prompts, and reopens after source loss", async () => {
  const f = await fixture();
  await f.child("child", "Delegated child");
  await f.demand();
  expect(f.accepted()).toMatchObject([
    { id: "child", parentSessionId: "public-parent", title: "Delegated child" },
  ]);
  const statement = f.db
    .getDatabase()
    .prepare("SELECT source, target FROM session_relationship_edges");
  try {
    const rows = statement.all() as Array<{ source: string; target: string }>;
    expect(JSON.parse(rows[0]!.target)).toEqual([
      "native",
      "server",
      "grok",
      f.nativeRoot,
      "child",
    ]);
  } finally {
    statement.finalize();
  }
  const evidence = f.db
    .getDatabase()
    .prepare("SELECT metadata FROM session_relationship_evidence");
  try {
    const saved = JSON.stringify(evidence.all());
    expect(saved).not.toContain("DO_NOT_SAVE");
    expect(saved).not.toContain(f.project);
  } finally {
    evidence.finalize();
  }
  await f.service.close();
  f.db.close();
  await rm(f.nativeRoot, { recursive: true });
  const reopened = new DiscoverySqliteService({
    dataDir: join(f.root, "profile"),
    probeNetworkFilesystem: () => undefined,
  });
  const service = new ProviderChildRelationshipService(
    reopened.getDatabase(),
    "server",
    () => {},
  );
  try {
    expect(service.accepted(f.parent, "public-parent")).toMatchObject([
      { id: "child", title: "Delegated child" },
    ]);
  } finally {
    await service.close();
    reopened.close();
  }
  expect(f.errors).toEqual([]);
});

it("keeps unavailable, partial, copied fork history and accepted empty distinct", async () => {
  const f = await fixture(),
    signal = new AbortController().signal;
  expect(await f.source.observe(signal)).toMatchObject({
    state: "complete",
    children: [],
  });
  await mkdir(join(f.parentDir, "subagents"));
  await writeFile(
    join(f.parentDir, "subagents", ".DS_Store"),
    "finder metadata",
  );
  expect(await f.source.observe(signal)).toMatchObject({
    state: "complete",
    children: [],
  });
  await f.demand();
  expect(f.accepted()).toEqual([]);
  const child = await f.child("child");
  const self = join(f.parentDir, "subagents", "parent");
  await mkdir(self);
  await writeFile(
    join(self, "meta.json"),
    JSON.stringify({
      subagent_id: "parent",
      child_session_id: "parent",
      parent_session_id: "parent",
    }),
  );
  const original = await readFile(child.meta, "utf8");
  await writeFile(child.meta, "{");
  expect(await f.source.observe(signal)).toMatchObject({
    state: "partial",
    children: [],
  });
  await writeFile(
    child.meta,
    JSON.stringify({
      ...JSON.parse(original),
      parent_session_id: "copied-source-parent",
    }),
  );
  expect(await f.source.observe(signal)).toMatchObject({
    state: "partial",
    children: [],
  });
  await writeFile(child.meta, original);
  await f.demand();
  expect(f.accepted()).toHaveLength(1);
  expect(f.errors).toEqual([]);
  const knownActivity = f.accepted()![0]!.updatedAt;
  const outside = join(f.root, "child");
  await mkdir(outside);
  await writeFile(join(outside, "updates.jsonl"), "outside namespace");
  const future = new Date("2030-01-01T00:00:00Z");
  await utimes(join(outside, "updates.jsonl"), future, future);
  await writeFile(
    child.meta,
    JSON.stringify({ ...JSON.parse(original), child_cwd: ".." }),
  );
  const invalidCwd = await f.source.observe(signal);
  expect(invalidCwd.state).toBe("partial");
  expect(invalidCwd.children[0]?.summary.updatedAt).toBe(knownActivity);
  await writeFile(
    child.meta,
    JSON.stringify({
      ...JSON.parse(original),
      child_cwd: `${f.project}\ud800`,
    }),
  );
  const invalidUnicode = await f.source.observe(signal);
  expect(invalidUnicode).toMatchObject({
    state: "partial",
    children: [{ summary: { id: "child", updatedAt: knownActivity } }],
  });
  await writeFile(
    child.meta,
    JSON.stringify({
      ...JSON.parse(original),
      prompt: "x".repeat(1024 * 1024),
    }),
  );
  await f.demand();
  expect(f.accepted()).toHaveLength(1);
  await rm(join(f.parentDir, "summary.json"));
  await expect(f.source.observe(signal)).rejects.toThrow("unavailable");
  expect(f.accepted()).toHaveLength(1);
});

it("finds legacy directory spellings by canonical header identity and rejects root or sidecar escapes", async () => {
  const f = await fixture(),
    signal = new AbortController().signal;
  await f.child("child");
  const legacy = join(
    f.nativeRoot,
    encodeURIComponent(f.project),
    "legacy-directory",
  );
  await rename(f.parentDir, legacy);
  const observation = await f.source.observe(signal);
  expect(observation.children[0]?.native.id).toBe("child");
  expect(await f.source.isCurrent(observation.version)).toBe(true);
  const foreign = join(f.root, "foreign");
  await mkdir(foreign);
  const foreignReader = new GrokSessionReader({
    sessionsDir: foreign,
    projectPath: f.project,
  });
  try {
    await expect(
      foreignReader.getProviderChildSource(f.parent)!.observe(signal),
    ).rejects.toThrow("does not own");
  } finally {
    foreignReader.close();
  }
  const childDir = join(legacy, "subagents", "child");
  await rm(childDir, { recursive: true });
  await symlink(
    foreign,
    childDir,
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(await f.source.observe(signal)).toMatchObject({
    state: "partial",
    children: [],
  });
  expect(await f.source.isCurrent(observation.version)).toBe(false);
  await writeFile(
    join(legacy, "summary.json"),
    JSON.stringify({ info: { id: "different-native-id", cwd: f.project } }),
  );
  await expect(f.source.observe(signal)).rejects.toThrow("unavailable");
});

it("uses an internal aliased watcher for baseline handover, later children and activity without extending the public bus", async () => {
  const f = await fixture();
  await f.demand();
  await f.child("first");
  const alias = join(f.root, "watch-alias");
  await symlink(
    f.nativeRoot,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const publicBus = new EventBus(),
    published: unknown[] = [];
  const releasePublic = publicBus.subscribe((event) => published.push(event));
  const registry = new ProviderSessionWatcherRegistry({
    eventBus: publicBus,
    specs: [
      {
        family: "grok",
        provider: "grok",
        watchDir: alias,
        internalOnly: true,
        debounceMs: 10,
      },
    ],
  });
  const releaseChanges = registry.subscribeNativeChanges((event) =>
    f.service.notifyNativeFileChange(event),
  );
  const releaseReady = registry.subscribeReady((family) =>
    f.service.observationReady(family),
  );
  try {
    registry.activate(["grok"]);
    await vi.waitFor(() => expect(f.accepted()).toHaveLength(1));
    const second = await f.child("second");
    await vi.waitFor(() => expect(f.accepted()).toHaveLength(2));
    const before = f.commits,
      updated = f.accepted()!.find((c) => c.id === "second")!.updatedAt;
    const time = new Date(Date.now() + 60000);
    await utimes(join(second.nativeDir, "updates.jsonl"), time, time);
    await vi.waitFor(() =>
      expect(f.accepted()!.find((c) => c.id === "second")!.updatedAt).not.toBe(
        updated,
      ),
    );
    expect(f.commits).toBe(before);
    expect(published).toEqual([]);
    expect(f.errors).toEqual([]);
    const lateParent = nativeSessionRef(
      "grok",
      f.nativeRoot,
      parseNativeSessionId("late-parent"),
    );
    const lateSource = f.reader.getProviderChildSource(lateParent)!;
    f.service.demand(lateParent, { sessionId: "late-public" }, lateSource);
    await vi.waitFor(() => expect(f.errors.length).toBeGreaterThan(0));
    expect(String(f.errors[0])).toContain("unavailable");
    const lateDir = join(
      f.nativeRoot,
      encodeURIComponent(f.project),
      "late-parent",
    );
    await mkdir(join(lateDir, "subagents", "late-child"), { recursive: true });
    await writeFile(
      join(lateDir, "summary.json"),
      JSON.stringify({ info: { id: "late-parent", cwd: f.project } }),
    );
    await writeFile(
      join(lateDir, "subagents", "late-child", "meta.json"),
      JSON.stringify({
        subagent_id: "late-child",
        child_session_id: "late-child",
        parent_session_id: "late-parent",
        started_at: "2026-11-04T00:00:00Z",
      }),
    );
    await vi.waitFor(() =>
      expect(f.service.accepted(lateParent, "late-public")).toMatchObject([
        { id: "late-child" },
      ]),
    );
    expect(published).toEqual([]);
  } finally {
    releaseReady();
    releaseChanges();
    releasePublic();
    registry.stop();
  }
});

it("fences retirement and aliased-root rebinding before publication or activity overlay", async () => {
  const f = await fixture(),
    signal = new AbortController().signal;
  const child = await f.child("child");
  const alias = join(f.root, "alias");
  await symlink(
    f.nativeRoot,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const reader = new GrokSessionReader({
      sessionsDir: alias,
      projectPath: f.project,
    }),
    source = reader.getProviderChildSource(f.parent)!;
  try {
    const observed = await source.observe(signal);
    expect(await source.isCurrent(observed.version)).toBe(true);
    const foreign = join(f.root, "foreign");
    await mkdir(foreign);
    await rm(alias, { recursive: true });
    await symlink(
      foreign,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const before = source.overlayActivity!([observed.children[0]!.summary]);
    const time = new Date(Date.now() + 60000);
    await utimes(join(child.nativeDir, "updates.jsonl"), time, time);
    await source.handleFileChange!({
      ...f.event(
        join(alias, encodeURIComponent(f.project), "child", "updates.jsonl"),
      ),
      nativeStorageScope: alias,
    });
    expect(source.overlayActivity!([observed.children[0]!.summary])).toEqual(
      before,
    );
    expect(await source.isCurrent(observed.version)).toBe(false);
    reader.close();
    await expect(source.observe(signal)).rejects.toThrow("retired");
  } finally {
    reader.close();
  }
});

it("follows a corrected child location even when its file has an older mtime", async () => {
  const f = await fixture(),
    signal = new AbortController().signal;
  const child = await f.child("child");
  await f.demand();
  const otherProject = join(f.root, "other-project"),
    nativeDir = join(f.nativeRoot, encodeURIComponent(otherProject), "child");
  await mkdir(otherProject);
  await mkdir(nativeDir, { recursive: true });
  const body = join(nativeDir, "updates.jsonl");
  await writeFile(body, "native body");
  const old = new Date("2020-01-01T00:00:00Z");
  await utimes(body, old, old);
  const meta = JSON.parse(await readFile(child.meta, "utf8"));
  await writeFile(
    child.meta,
    JSON.stringify({ ...meta, child_cwd: otherProject }),
  );
  await rm(child.nativeDir, { recursive: true });
  const moved = await f.source.observe(signal);
  expect(moved.children[0]?.native).toEqual(
    nativeSessionRef("grok", f.nativeRoot, parseNativeSessionId("child")),
  );
  const current = new Date(Date.now() + 60000);
  await utimes(body, current, current);
  expect(await f.source.handleFileChange!(f.event(body, "create"))).toBe(false);
  expect(
    f.source.overlayActivity!([moved.children[0]!.summary])[0]?.updatedAt,
  ).toBe(current.toISOString());
});

it("fences an empty parent directory rebound to an outside directory sharing its summary inode", async () => {
  const f = await fixture(),
    signal = new AbortController().signal;
  const foreign = join(f.root, "foreign-parent");
  await mkdir(foreign);
  await link(join(f.parentDir, "summary.json"), join(foreign, "summary.json"));
  const observed = await f.source.observe(signal);
  expect(observed.children).toEqual([]);
  await rename(f.parentDir, `${f.parentDir}-old`);
  await symlink(
    foreign,
    f.parentDir,
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(await f.source.isCurrent(observed.version)).toBe(false);
});
