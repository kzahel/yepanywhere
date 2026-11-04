import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

// Past both caches' 5 s untrusted lifetime.
const PAST_UNTRUSTED_TTL_MS = 60_000;

describe("watcher-trusted Codex rollout enumeration", () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
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
