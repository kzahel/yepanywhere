import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { nativeSessionRef, parseNativeSessionId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravitySessionReader } from "../../src/sessions/antigravity-reader.js";
import {
  AntigravitySummariesReader,
  antigravitySessionWatcherSpec,
} from "../../src/sessions/antigravity-summaries.js";
import { ProviderChildRelationshipService } from "../../src/sessions/ProviderChildRelationshipService.js";
import { resolveProviderChildSessions } from "../../src/sessions/provider-child-sessions.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import { loadSqliteDriver } from "../../src/storage/sqlite.js";
import { EventBus, type FileChangeEvent } from "../../src/watcher/EventBus.js";
import { FileWatcher } from "../../src/watcher/FileWatcher.js";
import { wireProviderObservations } from "../../src/watcher/provider-observation-wiring.js";
import { ProviderSessionWatcherRegistry } from "../../src/watcher/ProviderSessionWatcherRegistry.js";

const uuid = (n: number) =>
  `${String(n).padStart(8, "0")}-1111-4111-8111-${String(n).padStart(12, "0")}`;

const PARENT_ID = uuid(1);
const CHILD_ID = uuid(2);
const GRANDCHILD_ID = uuid(3);
const LATE_ID = uuid(4);
const OTHER_ID = uuid(5);
const CYCLE_A = uuid(6);
const CYCLE_B = uuid(7);
const CYCLE_VALID = uuid(8);
const FOREIGN_ID = uuid(9);
const OVERLONG_CHILD_ID = uuid(10);

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.unstubAllEnvs();
});

async function createFixture(
  options: { oldSchema?: boolean; noSummariesDb?: boolean } = {},
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ya-agy-child-sql-")),
  );
  const project = join(root, "project");
  const cliDir = join(root, "antigravity-cli");
  const conversationsDir = join(cliDir, "conversations");
  const dbPath = join(cliDir, "conversation_summaries.db");
  await mkdir(project, { recursive: true });
  await mkdir(conversationsDir, { recursive: true });

  const projectUri = JSON.stringify([pathToFileURL(project).href]);
  let db:
    | ReturnType<NonNullable<ReturnType<typeof loadSqliteDriver>>["open"]>
    | undefined;
  let insertStmt: ReturnType<NonNullable<typeof db>["prepare"]> | undefined;

  if (!options.noSummariesDb) {
    db = loadSqliteDriver()!.open(dbPath);
    if (options.oldSchema) {
      db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA wal_autocheckpoint=0;
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          workspace_uris TEXT NOT NULL
        );
      `);
      const ins = db.prepare(
        "INSERT INTO conversation_summaries VALUES (?, ?, ?)",
      );
      ins.run(PARENT_ID, "Parent", projectUri);
      ins.finalize();
    } else {
      db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA wal_autocheckpoint=0;
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          workspace_uris TEXT NOT NULL,
          agent_name TEXT NOT NULL DEFAULT '',
          parent_conversation_id TEXT NOT NULL DEFAULT '',
          nesting_depth INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT '',
          not_fully_idle NUMERIC NOT NULL DEFAULT 0,
          killed NUMERIC NOT NULL DEFAULT 0,
          last_modified_time DATETIME NOT NULL DEFAULT '0001-01-01 00:00:00+00:00'
        );
      `);
      insertStmt = db.prepare(
        "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      insertStmt.run(
        PARENT_ID,
        "Parent Session",
        projectUri,
        "",
        "",
        0,
        "CASCADE_RUN_STATUS_IDLE",
        0,
        0,
        "2026-11-21 17:00:00+00:00",
      );
    }
  }

  const insertRow = (
    id: string,
    opts: {
      title?: string;
      cwd?: string;
      agentName?: string;
      parentId?: string;
      depth?: number;
      status?: string;
      notFullyIdle?: number;
      lastModifiedTime?: string;
    } = {},
  ) => {
    insertStmt!.run(
      id,
      opts.title ?? "",
      JSON.stringify([pathToFileURL(opts.cwd ?? project).href]),
      opts.agentName ?? "research",
      opts.parentId ?? PARENT_ID,
      opts.depth ?? 1,
      opts.status ?? "CASCADE_RUN_STATUS_IDLE",
      opts.notFullyIdle ?? 0,
      0,
      opts.lastModifiedTime ?? "2026-11-21 17:01:00+00:00",
    );
  };

  const reader = new AntigravitySessionReader({
    projectPath: project,
    sessionsDir: conversationsDir,
  });
  const parent = nativeSessionRef(
    "antigravity",
    conversationsDir,
    parseNativeSessionId(PARENT_ID),
  );
  const source = reader.getProviderChildSource(parent)!;
  const profile = new DiscoverySqliteService({
    dataDir: join(root, "profile"),
    probeNetworkFilesystem: () => undefined,
  });
  let commits = 0;
  const onCommit = vi.fn<(sessionId: string) => void>();
  const onError = vi.fn<(error: unknown) => void>();
  const errors: unknown[] = [];
  const service = new ProviderChildRelationshipService(
    profile.getDatabase(),
    "server",
    (owner) => {
      commits++;
      onCommit(owner.sessionId);
    },
    (e) => {
      errors.push(e);
      onError(e);
    },
  );
  const demand = () =>
    service.demand(
      parent,
      { sessionId: "public-parent" },
      reader.getProviderChildSource(parent)!,
    );
  const wait = async (check: () => boolean) =>
    vi.waitFor(() => expect(check()).toBe(true), {
      interval: 5,
      timeout: 2500,
    });

  cleanup.push(async () => {
    await service.close();
    await reader.close();
    insertStmt?.finalize();
    db?.close();
    profile.close();
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    project,
    cliDir,
    conversationsDir,
    dbPath,
    db,
    insertRow,
    reader,
    parent,
    source,
    profile,
    service,
    errors,
    onCommit,
    onError,
    demand,
    wait,
    commits: () => commits,
  };
}

describe("Antigravity durable child relationships", () => {
  it("publishes descendants with immediate parents, handles 0001-01-01 running mtimes, sees WAL commits, and reopens without native store", async () => {
    const f = await createFixture();
    // Running child has sentinel 0001-01-01 timestamp -> falls back to .db/.db-wal mtime.
    const childDbPath = join(f.conversationsDir, `${CHILD_ID}.db`);
    const childWalPath = join(f.conversationsDir, `${CHILD_ID}.db-wal`);
    await writeFile(childDbPath, "child-db");
    const runningMtime = new Date("2026-11-21T17:04:00.000Z");
    await utimes(childDbPath, runningMtime, runningMtime);

    f.insertRow(CHILD_ID, {
      title: "",
      agentName: "research",
      parentId: PARENT_ID,
      depth: 1,
      status: "CASCADE_RUN_STATUS_RUNNING",
      notFullyIdle: 1,
      lastModifiedTime: "0001-01-01 00:00:00+00:00",
    });
    f.insertRow(GRANDCHILD_ID, {
      title: "Nested lookup",
      agentName: "self",
      parentId: CHILD_ID,
      depth: 2,
      lastModifiedTime: "2026-11-21 17:02:00+00:00",
    });

    const beforeMainStat = await stat(f.dbPath);
    f.demand();
    expect(f.service.accepted(f.parent, "public-parent")).toBeUndefined();
    await f.wait(
      () => f.service.accepted(f.parent, "public-parent")?.length === 1,
    );

    const directChildren = f.service.accepted(f.parent, "public-parent")!;
    expect(directChildren).toEqual([
      {
        id: CHILD_ID,
        parentSessionId: "public-parent",
        agentType: "research",
        spawnDepth: 1,
        updatedAt: runningMtime.toISOString(),
      },
    ]);

    const childRef = nativeSessionRef(
      "antigravity",
      f.conversationsDir,
      parseNativeSessionId(CHILD_ID),
    );
    expect(f.service.accepted(childRef, "public-child")).toEqual([
      {
        id: GRANDCHILD_ID,
        parentSessionId: "public-child",
        title: "Nested lookup",
        agentType: "self",
        spawnDepth: 2,
        updatedAt: "2026-11-21T17:02:00.000Z",
      },
    ]);

    // WAL-only insertion of a second direct child is seen even though main DB mtime is unchanged.
    f.insertRow(LATE_ID, {
      title: "Second child",
      agentName: "self",
      parentId: PARENT_ID,
      depth: 1,
      lastModifiedTime: "2026-11-21 17:06:00+00:00",
    });
    expect((await stat(f.dbPath)).mtimeMs).toBe(beforeMainStat.mtimeMs);
    f.demand();
    await f.wait(
      () => f.service.accepted(f.parent, "public-parent")?.length === 2,
    );
    expect(
      f.service.accepted(f.parent, "public-parent")?.map((c) => c.id),
    ).toEqual([LATE_ID, CHILD_ID]);

    // Child .db-wal activity updates ChildActivityOverlay WITHOUT a SQL commit!
    const commitsBeforeActivity = f.commits();
    const walMtime = new Date("2026-11-21T17:10:00.000Z");
    await writeFile(childWalPath, "wal-append");
    await utimes(childWalPath, walMtime, walMtime);
    f.service.notifyNativeFileChange({
      type: "file-change",
      provider: "antigravity",
      path: childWalPath,
      relativePath: `${CHILD_ID}.db-wal`,
      nativeStorageScope: f.conversationsDir,
      fileType: "session",
      changeType: "modify",
      timestamp: walMtime.toISOString(),
    });
    await f.wait(
      () =>
        f.service
          .accepted(f.parent, "public-parent")
          ?.find((c) => c.id === CHILD_ID)?.updatedAt ===
        walMtime.toISOString(),
    );
    expect(f.commits()).toBe(commitsBeforeActivity);
    expect(
      f.service.accepted(f.parent, "public-parent")?.map((c) => c.id),
    ).toEqual([CHILD_ID, LATE_ID]);
    expect(f.errors).toEqual([]);

    // Reopen SQLite after native directory disappears: durable children survive.
    await f.service.close();
    await f.reader.close();
    await rename(f.cliDir, join(f.root, "gone"));
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
      ).toEqual([CHILD_ID, LATE_ID].sort());
      expect(reopened.accepted(childRef, "public-child")?.[0]?.id).toBe(
        GRANDCHILD_ID,
      );
    } finally {
      await reopened.close();
    }
  });

  it("keeps bound SQL children when a colliding reader rejects their scope or is unavailable", async () => {
    const a = await createFixture();
    const b = await createFixture();
    a.insertRow(CHILD_ID, { title: "Child A" });
    b.insertRow(LATE_ID, { title: "Child B" });
    b.insertRow(OTHER_ID, { title: "Empty Root", parentId: "", depth: 0 });
    const emptyRef = nativeSessionRef(
      "antigravity",
      b.conversationsDir,
      parseNativeSessionId(OTHER_ID),
    );
    a.demand();
    a.service.demand(b.parent, { sessionId: "public-b" }, b.source);
    a.service.demand(
      emptyRef,
      { sessionId: "public-empty" },
      b.reader.getProviderChildSource(emptyRef)!,
    );
    await a.wait(
      () =>
        a.service.accepted(a.parent, "public-parent")?.length === 1 &&
        a.service.accepted(b.parent, "public-b")?.length === 1 &&
        a.service.accepted(emptyRef, "public-empty")?.length === 0,
    );

    const boundReaderA = new AntigravitySessionReader({
      projectPath: a.project,
      sessionsDir: a.conversationsDir,
      nativeStorageScope: a.conversationsDir,
    });
    cleanup.push(() => boundReaderA.close());
    expect(boundReaderA.getProviderChildSource(b.parent)).toBeUndefined();
    expect(
      (await boundReaderA.listProviderChildSessions(PARENT_ID)).map(
        (c) => c.id,
      ),
    ).toEqual([CHILD_ID]);

    const freshSpy = vi.spyOn(boundReaderA, "listProviderChildSessions");
    const indexed = {
      service: a.service,
      native: b.parent,
      publicSessionId: "public-b",
    };
    for (const mode of ["fresh", "accepted-or-cheap"] as const) {
      expect(
        (
          await resolveProviderChildSessions(
            boundReaderA,
            PARENT_ID,
            mode,
            indexed,
          )
        )?.map((c) => c.id),
      ).toEqual([LATE_ID]);
    }
    expect(freshSpy).not.toHaveBeenCalled();

    // Unknown scope stays undefined; accepted empty stays [].
    expect(
      await resolveProviderChildSessions(boundReaderA, PARENT_ID, "fresh", {
        service: a.service,
        native: nativeSessionRef(
          "antigravity",
          join(b.root, "unknown"),
          parseNativeSessionId(PARENT_ID),
        ),
        publicSessionId: "public-unknown",
      }),
    ).toBeUndefined();
    expect(
      await resolveProviderChildSessions(boundReaderA, OTHER_ID, "fresh", {
        service: a.service,
        native: emptyRef,
        publicSessionId: "public-empty",
      }),
    ).toEqual([]);
  });

  it("isolates cycles, foreign projects, malformed parent IDs, and missing ancestors as partial while accepting valid siblings", async () => {
    const f = await createFixture();
    f.insertRow(CHILD_ID, { title: "Valid Child" });
    f.insertRow(FOREIGN_ID, {
      title: "Foreign Child",
      cwd: join(f.root, "other-project"),
    });
    f.insertRow(OVERLONG_CHILD_ID, {
      title: "Malformed Parent",
      parentId: "not-a-uuid",
    });
    f.insertRow(CYCLE_A, { title: "Cycle A", parentId: CYCLE_B });
    f.insertRow(CYCLE_B, { title: "Cycle B", parentId: CYCLE_A });
    f.insertRow(CYCLE_VALID, { title: "Cycle Valid", parentId: CYCLE_A });

    const first = await f.source.observe(new AbortController().signal);
    expect(first.state).toBe("partial");
    expect(first.children.map((c) => c.native.id)).toEqual([CHILD_ID]);

    // Inserting another child invalidates isCurrent(first.version).
    f.insertRow(LATE_ID, { title: "Late Child" });
    expect(await f.source.isCurrent(first.version)).toBe(false);

    // Observing a cyclic parent isolates the cycle and still accepts valid direct children.
    const cycleParent = nativeSessionRef(
      "antigravity",
      f.conversationsDir,
      parseNativeSessionId(CYCLE_A),
    );
    const cyclicObs = await f.reader
      .getProviderChildSource(cycleParent)!
      .observe(new AbortController().signal);
    expect(cyclicObs.state).toBe("partial");
    expect(cyclicObs.children.map((c) => c.native.id)).toEqual([CYCLE_VALID]);

    // Wrong-project reader cannot observe this parent.
    const wrongReader = new AntigravitySessionReader({
      projectPath: join(f.root, "different-project"),
      sessionsDir: f.conversationsDir,
    });
    try {
      await expect(
        wrongReader
          .getProviderChildSource(f.parent)!
          .observe(new AbortController().signal),
      ).rejects.toThrow("project");
    } finally {
      await wrongReader.close();
    }
  });

  it("distinguishes missing/standalone 1.4.x stores and pre-lineage schemas from accepted empty", async () => {
    const standalone = await createFixture({ noSummariesDb: true });
    await expect(
      standalone.source.observe(new AbortController().signal),
    ).rejects.toThrow();
    expect(
      await standalone.reader.listProviderChildSessions(PARENT_ID),
    ).toEqual([]);

    const oldSchema = await createFixture({ oldSchema: true });
    const obs = await oldSchema.source.observe(new AbortController().signal);
    expect(obs.state).toBe("partial");
    expect(obs.children).toEqual([]);
    // Because partial-empty is NOT accepted-empty, service.accepted stays undefined.
    oldSchema.demand();
    await vi.waitFor(
      () => expect(oldSchema.commits()).toBeGreaterThanOrEqual(0),
      { timeout: 200 },
    );
    expect(
      oldSchema.service.accepted(oldSchema.parent, "public-parent"),
    ).toBeUndefined();

    // Retired reader rejects observation.
    await oldSchema.reader.close();
    await expect(
      oldSchema.source.observe(new AbortController().signal),
    ).rejects.toThrow("retired");
  });

  it("fences project-alias rebinding between observation and commit", async () => {
    const f = await createFixture();
    f.insertRow(CHILD_ID, { title: "Child" });
    const alias = join(f.root, "project-alias");
    const elsewhere = join(f.root, "elsewhere");
    await mkdir(elsewhere);
    await symlink(
      f.project,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const update = f.db!.prepare(
      "UPDATE conversation_summaries SET workspace_uris = ?",
    );
    try {
      update.run(JSON.stringify([pathToFileURL(alias).href]));
    } finally {
      update.finalize();
    }
    const aliasReader = new AntigravitySessionReader({
      projectPath: alias,
      sessionsDir: f.conversationsDir,
    });
    try {
      const source = aliasReader.getProviderChildSource(f.parent)!;
      const obs = await source.observe(new AbortController().signal);
      expect(obs.children).toHaveLength(1);
      await rm(alias);
      await symlink(
        elsewhere,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(await source.isCurrent(obs.version)).toBe(false);
    } finally {
      await aliasReader.close();
    }
  });

  it("rejects isCurrent() when a native title changes while alias checks are in flight", async () => {
    const f = await createFixture();
    f.insertRow(CHILD_ID, { title: "Before Race" });
    const obs = await f.source.observe(new AbortController().signal);
    const fs = await import("node:fs");
    const realRealpath = fs.promises.realpath.bind(fs.promises);
    let mutated = false;
    const realpathSpy = vi
      .spyOn(fs.promises, "realpath")
      .mockImplementation(async (...args) => {
        const result = await realRealpath(...args);
        if (!mutated && String(args[0]) === f.project) {
          mutated = true;
          const upd = f.db!.prepare(
            "UPDATE conversation_summaries SET title = 'After Race' WHERE conversation_id = ?",
          );
          try {
            upd.run(CHILD_ID);
          } finally {
            upd.finalize();
          }
        }
        return result;
      });
    try {
      expect(await f.source.isCurrent(obs.version)).toBe(false);
      expect(mutated).toBe(true);
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it("supersedes stale durable edges when a child is reparented to an unregistered destination parent", async () => {
    const f = await createFixture();
    f.insertRow(OTHER_ID, {
      title: "Unregistered Destination Parent",
      agentName: "",
      parentId: "",
      depth: 0,
    });
    f.insertRow(CHILD_ID, { title: "Moving Child", parentId: PARENT_ID });

    // Register ONLY PARENT_ID (using f.source directly so we can intercept
    // isCurrent below); OTHER_ID is never opened or registered.
    f.service.demand(f.parent, { sessionId: "public-parent" }, f.source);
    await f.wait(
      () => f.service.accepted(f.parent, "public-parent")?.[0]?.id === CHILD_ID,
    );

    const move = f.db!.prepare(
      "UPDATE conversation_summaries SET parent_conversation_id = ? WHERE conversation_id = ?",
    );
    try {
      move.run(OTHER_ID, CHILD_ID);
    } finally {
      move.finalize();
    }
    f.service.notifyNativeFileChange({
      type: "file-change",
      provider: "antigravity",
      path: `${f.dbPath}-wal`,
      relativePath: "../conversation_summaries.db-wal",
      nativeStorageScope: f.conversationsDir,
      fileType: "other",
      changeType: "modify",
      timestamp: "2026-11-21T17:15:00.000Z",
    });

    await f.wait(
      () => f.service.accepted(f.parent, "public-parent")?.length === 0,
    );
    const otherRef = nativeSessionRef(
      "antigravity",
      f.conversationsDir,
      parseNativeSessionId(OTHER_ID),
    );
    expect(f.service.hasSource(otherRef)).toBe(false);
    expect(
      f.service.accepted(otherRef, "public-other")?.map((c) => c.id),
    ).toEqual([CHILD_ID]);

    // Also verify reparenting survives BOTH a failed isCurrent() retry AND a
    // full service/reader restart (fresh source seeded from durable SQL edges).
    f.insertRow(LATE_ID, { title: "Retry Child", parentId: PARENT_ID });
    f.service.demand(f.parent, { sessionId: "public-parent" }, f.source);
    await f.wait(
      () => f.service.accepted(f.parent, "public-parent")?.[0]?.id === LATE_ID,
    );
    const moveLate = f.db!.prepare(
      "UPDATE conversation_summaries SET parent_conversation_id = ? WHERE conversation_id = ?",
    );
    try {
      moveLate.run(OTHER_ID, LATE_ID);
    } finally {
      moveLate.finalize();
    }
    const origIsCurrent = f.source.isCurrent;
    let failedOnce = false;
    f.source.isCurrent = async (version) => {
      if (!failedOnce) {
        failedOnce = true;
        return false;
      }
      return origIsCurrent(version);
    };
    try {
      f.service.demand(f.parent, { sessionId: "public-parent" }, f.source);
      await f.wait(
        () => f.service.accepted(f.parent, "public-parent")?.length === 0,
      );
      expect(failedOnce).toBe(true);
      expect(
        f.service
          .accepted(otherRef, "public-other")
          ?.map((c) => c.id)
          .sort(),
      ).toEqual([CHILD_ID, LATE_ID].sort());
    } finally {
      f.source.isCurrent = origIsCurrent;
    }

    // Restart with a brand-new reader and service after moving a child offline.
    f.insertRow(GRANDCHILD_ID, {
      title: "Offline Move Child",
      parentId: PARENT_ID,
    });
    f.demand();
    await f.wait(
      () =>
        f.service.accepted(f.parent, "public-parent")?.[0]?.id ===
        GRANDCHILD_ID,
    );
    await f.service.close();
    await f.reader.close();
    const moveOffline = f.db!.prepare(
      "UPDATE conversation_summaries SET parent_conversation_id = ? WHERE conversation_id = ?",
    );
    try {
      moveOffline.run(OTHER_ID, GRANDCHILD_ID);
    } finally {
      moveOffline.finalize();
    }
    const freshReader = new AntigravitySessionReader({
      projectPath: f.project,
      sessionsDir: f.conversationsDir,
    });
    const freshService = new ProviderChildRelationshipService(
      f.profile.getDatabase(),
      "server",
      () => {},
    );
    cleanup.push(async () => {
      await freshService.close();
      await freshReader.close();
    });
    freshService.demand(
      f.parent,
      { sessionId: "public-parent" },
      freshReader.getProviderChildSource(f.parent)!,
    );
    await vi.waitFor(
      () =>
        expect(freshService.accepted(f.parent, "public-parent")).toEqual([]),
      { interval: 5, timeout: 2500 },
    );
    expect(
      freshService
        .accepted(otherRef, "public-other")
        ?.map((c) => c.id)
        .sort(),
    ).toEqual([CHILD_ID, GRANDCHILD_ID, LATE_ID].sort());

    // B (OTHER_ID) has accepted outgoing edges in SQLite but has NEVER had its
    // own snapshot checkpoint. Move CHILD_ID from B -> C offline, then open B
    // for the very first time: B must still reconcile and clear CHILD_ID!
    const thirdParentId = uuid(33);
    const thirdRef = nativeSessionRef(
      "antigravity",
      f.conversationsDir,
      parseNativeSessionId(thirdParentId),
    );
    f.insertRow(thirdParentId, {
      title: "Third Parent C",
      agentName: "",
      parentId: "",
      depth: 0,
    });
    const moveBtoC = f.db!.prepare(
      "UPDATE conversation_summaries SET parent_conversation_id = ? WHERE conversation_id = ?",
    );
    try {
      moveBtoC.run(thirdParentId, CHILD_ID);
    } finally {
      moveBtoC.finalize();
    }
    freshService.demand(
      otherRef,
      { sessionId: "public-other" },
      freshReader.getProviderChildSource(otherRef)!,
    );
    await vi.waitFor(
      () =>
        expect(
          freshService
            .accepted(otherRef, "public-other")
            ?.map((c) => c.id)
            .sort(),
        ).toEqual([GRANDCHILD_ID, LATE_ID].sort()),
      { interval: 5, timeout: 2500 },
    );
    expect(
      freshService.accepted(thirdRef, "public-third")?.map((c) => c.id),
    ).toEqual([CHILD_ID]);
    expect(f.errors).toEqual([]);
  });

  it("loads the bounded related-ID subset and ancestry when missing relatedIds overflow maxSeeds", async () => {
    const f = await createFixture();
    f.insertRow(OTHER_ID, {
      title: "Destination Parent",
      agentName: "",
      parentId: "",
      depth: 0,
    });
    f.insertRow(CHILD_ID, { title: "Moved Child", parentId: OTHER_ID });
    const missing = [
      CHILD_ID,
      ...Array.from({ length: 300 }, (_, i) => uuid(9000 + i)),
    ];
    const reader = new AntigravitySummariesReader(f.dbPath);
    try {
      const snap = reader.readRelationshipSnapshot([PARENT_ID], missing, {
        maxSeeds: 256,
      });
      expect(snap.truncated).toBe(true);
      const ids = snap.rows.map((r) => r.conversation_id);
      expect(ids).toContain(PARENT_ID);
      expect(ids).toContain(CHILD_ID);
      expect(ids).toContain(OTHER_ID);
    } finally {
      reader.close();
    }
  });

  it("keeps a single parent with 257 unchanged children complete across repeated observations", async () => {
    const f = await createFixture();
    f.db!.exec("BEGIN");
    for (let i = 0; i < 257; i++) {
      f.insertRow(uuid(5000 + i), {
        title: `Bulk Child ${i}`,
        parentId: PARENT_ID,
        depth: 1,
      });
    }
    f.db!.exec("COMMIT");

    // Register via onRetire so active.previousChildIds tracks all 257 children.
    const release = f.source.onRetire?.(() => {});
    try {
      for (let round = 0; round < 3; round++) {
        const obs = await f.source.observe(new AbortController().signal);
        expect(obs.state).toBe("complete");
        expect(obs.children).toHaveLength(257);
        expect(await f.source.isCurrent(obs.version)).toBe(true);
      }
    } finally {
      release?.();
    }
  });

  it("shares one companion probe across separate project readers pointing at the same physical store", async () => {
    const f = await createFixture();
    const projectB = join(f.root, "project-b");
    await mkdir(projectB, { recursive: true });
    f.insertRow(CHILD_ID, {
      title: "Project A child",
      parentId: PARENT_ID,
      lastModifiedTime: "2026-11-21 17:01:00+00:00",
    });
    f.insertRow(OTHER_ID, {
      title: "Project B root",
      cwd: projectB,
      agentName: "",
      parentId: "",
      depth: 0,
    });
    f.insertRow(LATE_ID, {
      title: "Project B child",
      cwd: projectB,
      parentId: OTHER_ID,
      lastModifiedTime: "2026-11-21 17:01:00+00:00",
    });

    const readerB = new AntigravitySessionReader({
      projectPath: projectB,
      sessionsDir: f.conversationsDir,
    });
    cleanup.push(() => readerB.close());
    const parentB = nativeSessionRef(
      "antigravity",
      f.conversationsDir,
      parseNativeSessionId(OTHER_ID),
    );
    const sourceB = readerB.getProviderChildSource(parentB)!;

    let handled = 0;
    let done!: () => void;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    for (const s of [f.source, sourceB]) {
      const orig = s.handleFileChange!;
      s.handleFileChange = async (event) => {
        try {
          return await orig(event);
        } finally {
          if (++handled === 2) done();
        }
      };
    }

    f.service.demand(f.parent, { sessionId: "public-a" }, f.source);
    f.service.demand(parentB, { sessionId: "public-b" }, sourceB);
    await f.wait(
      () =>
        f.service.accepted(f.parent, "public-a")?.[0]?.id === CHILD_ID &&
        f.service.accepted(parentB, "public-b")?.[0]?.id === LATE_ID,
    );
    const commitsBefore = f.commits();
    const snapshotSpy = vi.spyOn(
      AntigravitySummariesReader.prototype,
      "readRelationshipSnapshot",
    );
    const fs = await import("node:fs");
    const realpathCalls: string[] = [];
    const realRealpath = fs.promises.realpath.bind(fs.promises);
    const realpathSpy = vi
      .spyOn(fs.promises, "realpath")
      .mockImplementation(async (...args) => {
        realpathCalls.push(String(args[0]));
        return realRealpath(...args);
      });
    try {
      const upd = f.db!.prepare(
        "UPDATE conversation_summaries SET last_modified_time = '2026-11-21 17:30:00+00:00' WHERE conversation_id IN (?, ?)",
      );
      try {
        upd.run(CHILD_ID, LATE_ID);
      } finally {
        upd.finalize();
      }
      f.service.notifyNativeFileChange({
        type: "file-change",
        provider: "antigravity",
        path: `${f.dbPath}-wal`,
        relativePath: "../conversation_summaries.db-wal",
        nativeStorageScope: f.conversationsDir,
        fileType: "other",
        changeType: "modify",
        timestamp: "2026-11-21T17:30:01.000Z",
      });
      await finished;
      expect(snapshotSpy).toHaveBeenCalledTimes(1);
      // Each project reader checks only its own project path and never stats
      // the other project's workspace URI (2 realpaths per project: initial + recheck).
      expect(
        realpathCalls.filter((p) => p === f.project).length,
      ).toBeLessThanOrEqual(2);
      expect(
        realpathCalls.filter((p) => p === projectB).length,
      ).toBeLessThanOrEqual(2);
      expect(f.commits()).toBe(commitsBefore);
      expect(f.service.accepted(f.parent, "public-a")?.[0]?.updatedAt).toBe(
        "2026-11-21T17:30:00.000Z",
      );
      expect(f.service.accepted(parentB, "public-b")?.[0]?.updatedAt).toBe(
        "2026-11-21T17:30:00.000Z",
      );
    } finally {
      realpathSpy.mockRestore();
      snapshotSpy.mockRestore();
    }
  });

  it("uses the shared Antigravity companion watcher to discover late WAL children automatically", async () => {
    const f = await createFixture();
    const bus = new EventBus();
    const watchers = new ProviderSessionWatcherRegistry({
      eventBus: bus,
      createWatcher: (options) => new FileWatcher(options),
      specs: [
        {
          ...antigravitySessionWatcherSpec(f.conversationsDir),
          debounceMs: 10,
        },
      ],
    });
    const wiring = wireProviderObservations(
      {
        eventBus: bus,
        subscribeProviderObservationReady: (cb) => watchers.subscribeReady(cb),
        subscribeNativeProviderFileChanges: (cb) =>
          watchers.subscribeNativeChanges(cb),
      },
      f.service,
      { notifyFileChange: () => {}, observationReady: () => {} },
    );
    cleanup.push(async () => {
      wiring.dispose();
      watchers.stop();
    });

    watchers.activate(["antigravity"]);
    f.demand();
    await f.wait(
      () => f.service.accepted(f.parent, "public-parent")?.length === 0,
    );

    // Late WAL-only insert triggers companion watcher -> publishes child automatically.
    f.insertRow(CHILD_ID, {
      title: "Spawned via WAL",
      agentName: "research",
      parentId: PARENT_ID,
      depth: 1,
    });
    await f.wait(
      () => f.service.accepted(f.parent, "public-parent")?.[0]?.id === CHILD_ID,
    );
    expect(f.errors).toEqual([]);
  });

  it("coalesces DB/WAL events across 128 sources with 2 children each, avoids commits on activity-only changes, and detects reparenting", async () => {
    const f = await createFixture();
    f.insertRow(CHILD_ID, {
      title: "Initial child 1",
      lastModifiedTime: "2026-11-21 17:01:00+00:00",
    });
    f.insertRow(LATE_ID, {
      title: "Initial child 2",
      lastModifiedTime: "2026-11-21 17:01:00+00:00",
    });
    const observed = [{ native: f.parent, source: f.source }];
    f.db!.exec("BEGIN");
    for (let i = 0; i < 127; i++) {
      const id = uuid(100 + i);
      f.insertRow(id, {
        title: `Root ${i}`,
        agentName: "",
        parentId: "",
        depth: 0,
      });
      // Give every active parent 2 children (256 children across 128 parents =
      // 384 rows total, exceeding the 256-seed limit if children were re-seeded).
      f.insertRow(uuid(1000 + i * 2), {
        title: `Child ${i}-a`,
        parentId: id,
        depth: 1,
        lastModifiedTime: "2026-11-21 17:01:00+00:00",
      });
      f.insertRow(uuid(1001 + i * 2), {
        title: `Child ${i}-b`,
        parentId: id,
        depth: 1,
        lastModifiedTime: "2026-11-21 17:01:00+00:00",
      });
      const native = nativeSessionRef(
        "antigravity",
        f.conversationsDir,
        parseNativeSessionId(id),
      );
      observed.push({
        native,
        source: f.reader.getProviderChildSource(native)!,
      });
    }
    f.db!.exec("COMMIT");

    let handled = 0;
    let done!: () => void;
    let finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    const remaining = new Set(
      observed.map(({ native }) => `public-${native.id}`),
    );
    const acquired = new Promise<void>((resolve, reject) => {
      f.onCommit.mockImplementation((sessionId) => {
        remaining.delete(sessionId);
        if (remaining.size === 0) resolve();
      });
      f.onError.mockImplementation(reject);
    });

    for (const { native, source } of observed) {
      const original = source.handleFileChange!;
      source.handleFileChange = async (event) => {
        try {
          return await original(event);
        } finally {
          if (++handled === observed.length) done();
        }
      };
      f.service.demand(native, { sessionId: `public-${native.id}` }, source);
    }
    await acquired;
    const commitsAfterAcquire = f.commits();

    const snapshotSpy = vi.spyOn(
      AntigravitySummariesReader.prototype,
      "readRelationshipSnapshot",
    );
    try {
      // Activity-only change: 1 shared probe, 0 SQL commits, live overlay updated.
      const actStmt = f.db!.prepare(
        "UPDATE conversation_summaries SET last_modified_time = '2026-11-21 17:20:00+00:00', status = 'CASCADE_RUN_STATUS_IDLE', not_fully_idle = 0 WHERE conversation_id = ?",
      );
      try {
        actStmt.run(CHILD_ID);
      } finally {
        actStmt.finalize();
      }
      const walEvent: FileChangeEvent = {
        type: "file-change",
        provider: "antigravity",
        path: `${f.dbPath}-wal`,
        relativePath: "../conversation_summaries.db-wal",
        nativeStorageScope: f.conversationsDir,
        fileType: "other",
        changeType: "modify",
        timestamp: "2026-11-21T17:20:01.000Z",
      };
      f.service.notifyNativeFileChange({
        ...walEvent,
        path: f.dbPath,
        relativePath: "../conversation_summaries.db",
      });
      f.service.notifyNativeFileChange(walEvent);
      await finished;
      expect(snapshotSpy).toHaveBeenCalledTimes(1);
      expect(f.commits()).toBe(commitsAfterAcquire);
      expect(
        f.service.accepted(f.parent, "public-parent")?.[0]?.updatedAt,
      ).toBe("2026-11-21T17:20:00.000Z");

      // Reparenting CHILD_ID from PARENT_ID to uuid(100): 1 shared probe +
      // observe/isCurrent for only the 2 affected parents (5 snapshots total),
      // and zero commits on any of the other 126 unrelated parents.
      handled = 0;
      finished = new Promise<void>((resolve) => {
        done = resolve;
      });
      snapshotSpy.mockClear();
      const reparentCommits = new Set<string>();
      f.onCommit.mockImplementation((sessionId) => {
        reparentCommits.add(sessionId);
      });
      const targetParentId = uuid(100);
      const targetNative = observed[1]!.native;
      const moveStmt = f.db!.prepare(
        "UPDATE conversation_summaries SET parent_conversation_id = ? WHERE conversation_id = ?",
      );
      try {
        moveStmt.run(targetParentId, CHILD_ID);
      } finally {
        moveStmt.finalize();
      }
      f.service.notifyNativeFileChange({
        ...walEvent,
        timestamp: "2026-11-21T17:21:00.000Z",
      });
      await finished;
      await f.wait(
        () =>
          f.service.accepted(f.parent, "public-parent")?.length === 1 &&
          f.service
            .accepted(targetNative, `public-${targetParentId}`)
            ?.some((c) => c.id === CHILD_ID) === true,
      );
      expect(snapshotSpy).toHaveBeenCalledTimes(5);
      expect([...reparentCommits].sort()).toEqual(
        [`public-${PARENT_ID}`, `public-${targetParentId}`].sort(),
      );
      expect(f.errors).toEqual([]);
    } finally {
      snapshotSpy.mockRestore();
    }
  });
});
