import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { EventEmitter } from "node:events";
import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSessionMap } from "../../src/sessions/codex-shared-scan-cache.js";
import { createCodexThreadChangeHints } from "../../src/sessions/codex-thread-index.js";
import { loadSqliteDriver } from "../../src/storage/sqlite.js";
import { EventBus, type FileChangeEvent } from "../../src/watcher/EventBus.js";
import { FileWatcher } from "../../src/watcher/FileWatcher.js";
import * as sharedDirectoryWatcher from "../../src/watcher/SharedDirectoryWatcher.js";

// The subset of Codex rust-v0.167.0's threads schema the hints read.
const SCHEMA = `PRAGMA journal_mode=WAL;
CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL,
  updated_at INTEGER NOT NULL, updated_at_ms INTEGER);
CREATE INDEX idx_threads_updated_at ON threads(updated_at DESC, id DESC);`;

const driver = loadSqliteDriver();

function createCodexHome(root: string, schema = SCHEMA) {
  const sessionsDir = join(root, "sessions");
  const databasePath = join(root, "state_5.sqlite");
  mkdirSync(root, { recursive: true });
  const database = driver!.open(databasePath);
  database.exec(schema);
  const upsert = database.prepare(
    `INSERT INTO threads (id, rollout_path, updated_at, updated_at_ms)
     VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
     rollout_path = excluded.rollout_path, updated_at = excluded.updated_at,
     updated_at_ms = excluded.updated_at_ms`,
  );
  return {
    sessionsDir,
    databasePath,
    write(id: string, rolloutPath: string, updatedAtMs = Date.now()) {
      upsert.run(id, rolloutPath, Math.floor(updatedAtMs / 1000), updatedAtMs);
    },
    close() {
      upsert.finalize();
      database.close();
    },
  };
}

async function rollout(sessionsDir: string, name: string): Promise<string> {
  const dir = join(sessionsDir, "2026", "11", "08");
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, "{}\n");
  return path;
}

describe.skipIf(!driver)("Codex thread change hints", () => {
  const roots: string[] = [];
  const homes: { close(): void }[] = [];
  const home = (schema?: string) => {
    const root = join(tmpdir(), `codex-thread-index-${randomUUID()}`);
    roots.push(root);
    const created = createCodexHome(root, schema);
    homes.push(created);
    return created;
  };

  afterEach(async () => {
    for (const created of homes.splice(0)) created.close();
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("names rollouts whose rows changed since the previous read", async () => {
    const codex = home();
    const a = await rollout(codex.sessionsDir, "rollout-a.jsonl");
    const b = await rollout(codex.sessionsDir, "rollout-b.jsonl");
    const compressed = await rollout(codex.sessionsDir, "rollout-c.jsonl");
    await rename(compressed, `${compressed}.zst`);
    codex.write("a", a);
    const hints = createCodexThreadChangeHints(codex.sessionsDir);

    // The first read only finds where to resume; the watcher rescans once.
    expect(await hints.changedPaths()).toBeNull();
    expect(await hints.changedPaths()).toEqual([]);

    codex.write("b", b);
    codex.write("c", compressed);
    codex.write(
      "archived",
      join(codex.sessionsDir, "..", "archived_sessions", "rollout-a.jsonl"),
    );
    expect(new Set(await hints.changedPaths())).toEqual(
      new Set([b, `${compressed}.zst`]),
    );
    expect(await hints.changedPaths()).toEqual([]);

    // A row from a clock running ahead must not hide later ordinary rows.
    codex.write("a", a, Date.now() + 10 * 60_000);
    expect(await hints.changedPaths()).toEqual([a]);
    codex.write("b", b, Date.now() + 1_000);
    expect(await hints.changedPaths()).toEqual([b]);
  });

  it("maps canonical rollout paths back under an aliased root", async () => {
    const codex = home();
    await rollout(codex.sessionsDir, "rollout-real.jsonl");
    // Codex records canonical paths; the watcher was given an alias.
    const canonical = realpathSync(join(codex.sessionsDir, ".."));
    const alias = join(tmpdir(), `codex-thread-alias-${randomUUID()}`);
    roots.push(alias);
    await symlink(join(codex.sessionsDir, ".."), alias);
    const hints = createCodexThreadChangeHints(
      join(alias, "sessions"),
      codex.databasePath,
    );
    expect(await hints.changedPaths()).toBeNull();

    codex.write(
      "real",
      join(canonical, "sessions", "2026", "11", "08", "rollout-real.jsonl"),
    );
    codex.write("archived", join(canonical, "archived_sessions", "r.jsonl"));
    expect(await hints.changedPaths()).toEqual([
      join(alias, "sessions", "2026", "11", "08", "rollout-real.jsonl"),
    ]);

    // An index describing some other tree cannot vouch for this one.
    codex.write("foreign", join(tmpdir(), "elsewhere", "rollout-x.jsonl"));
    expect(await hints.changedPaths()).toBeNull();
  });

  it("cannot vouch for a missing, replaced or unexpected database", async () => {
    const codex = home();
    const hints = createCodexThreadChangeHints(codex.sessionsDir);
    expect(await hints.changedPaths()).toBeNull();
    expect(await hints.changedPaths()).toEqual([]);

    codex.close();
    homes.splice(homes.indexOf(codex), 1);
    await rm(codex.databasePath);
    await rm(`${codex.databasePath}-wal`, { force: true });
    await rm(`${codex.databasePath}-shm`, { force: true });
    expect(await hints.changedPaths()).toBeNull();

    // A replacement database is a new history: baseline it, rescan once.
    const replacement = driver!.open(codex.databasePath);
    replacement.exec(SCHEMA);
    replacement.close();
    expect(await hints.changedPaths()).toBeNull();
    expect(await hints.changedPaths()).toEqual([]);

    const unindexed = home(
      `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, updated_at INTEGER,
        updated_at_ms INTEGER);`,
    );
    const schemaDrift = createCodexThreadChangeHints(unindexed.sessionsDir);
    expect(await schemaDrift.changedPaths()).toBeNull();
    expect(await schemaDrift.changedPaths()).toBeNull();
  });
});

describe("CodexSessionMap change log", () => {
  const session = (id: string) => ({
    id,
    filePath: `/s/rollout-${id}.jsonl`,
    cwd: "/p",
    timestamp: "",
    mtime: 0,
    size: 0,
    isSubagent: false,
  });

  it("replays only sessions written since a version, within its bound", () => {
    const map = new CodexSessionMap();
    map.set("a", session("a"));
    const seen = map.version;
    map.set("b", session("b"));
    map.set("b", session("b"));
    map.delete("a");
    expect(map.changesSince(seen)?.map((s) => s.id)).toEqual(["b"]);
    expect(map.changesSince(map.version)).toEqual([]);

    for (let i = 0; i < 1100; i++) map.set(`x${i}`, session(`x${i}`));
    expect(map.changesSince(seen)).toBeUndefined();
    map.clear();
    expect(map.changesSince(map.version - 1)).toBeUndefined();
  });
});

interface PeriodicCheckAccess {
  lastFullRescanAt: number;
  runPeriodicCheck(): Promise<void>;
  rescanAndEmit(reason: "fallback" | "periodic"): Promise<void>;
}

describe("FileWatcher periodic hints", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("re-checks hinted paths instead of walking the tree", async () => {
    const watchDir = join(tmpdir(), `file-watcher-hints-${randomUUID()}`);
    roots.push(watchDir);
    const quiet = await rollout(watchDir, "rollout-quiet.jsonl");
    const hinted = await rollout(watchDir, "rollout-hinted.jsonl");
    let next: readonly string[] | null = [];
    const events: FileChangeEvent[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.type === "file-change") events.push(event);
    });
    const watcher = new FileWatcher({
      watchDir,
      provider: "codex",
      eventBus,
      debounceMs: 1,
      // The test drives ticks itself.
      periodicRescanMs: 3_600_000,
      periodicRescanHints: () => ({ changedPaths: async () => next }),
    });
    const access = watcher as unknown as PeriodicCheckAccess;
    const rescan = vi.spyOn(access, "rescanAndEmit");
    // Own native delivery so only the hint can report the hinted append.
    class NativeWatch extends EventEmitter {
      close() {}
    }
    vi.spyOn(sharedDirectoryWatcher, "watchSharedDirectory").mockReturnValue(
      new NativeWatch() as unknown as ReturnType<
        typeof sharedDirectoryWatcher.watchSharedDirectory
      >,
    );
    try {
      watcher.start();
      await watcher.waitForInitialBaseline();
      await writeFile(quiet, "{}\n{}\n");
      await writeFile(hinted, "{}\n{}\n");
      events.length = 0;

      next = [hinted, join(watchDir, "..", "elsewhere.jsonl")];
      await access.runPeriodicCheck();
      await vi.waitFor(() =>
        expect(events).toEqual([
          expect.objectContaining({ path: hinted, changeType: "modify" }),
        ]),
      );
      expect(rescan).not.toHaveBeenCalled();

      next = null;
      await access.runPeriodicCheck();
      expect(rescan).toHaveBeenCalledWith("periodic");

      // Hints cannot report removals, so a quiet hint still yields to a full
      // walk once the floor has passed.
      rescan.mockClear();
      next = [];
      await access.runPeriodicCheck();
      expect(rescan).not.toHaveBeenCalled();
      access.lastFullRescanAt = Date.now() - 10 * 60 * 1000;
      await access.runPeriodicCheck();
      expect(rescan).toHaveBeenCalledWith("periodic");
    } finally {
      watcher.stop();
      vi.restoreAllMocks();
    }
  });
});
