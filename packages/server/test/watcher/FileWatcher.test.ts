import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  appendFile,
  mkdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus, type FileChangeEvent } from "../../src/watcher/EventBus.js";
import { FileWatcher } from "../../src/watcher/FileWatcher.js";
import * as sharedDirectoryWatcher from "../../src/watcher/SharedDirectoryWatcher.js";

interface FileWatcherTestAccess {
  rescanInProgress: boolean;
  rescanAndEmit(reason: "fallback" | "periodic"): Promise<void>;
  scanDirAsync(
    root: string,
    index: Map<string, { mtimeMs: number; size: number }>,
    metrics: unknown,
    lifecycleGeneration: number | null,
  ): Promise<boolean>;
  emitEvent(filePath: string, eventType: string): void;
  handleFileEvent(eventType: string, filename: string): void;
}

async function forceRescan(
  watcher: FileWatcher,
  reason: "fallback" | "periodic" = "fallback",
): Promise<void> {
  await (watcher as unknown as FileWatcherTestAccess).rescanAndEmit(reason);
}

describe("FileWatcher", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("attaches before building its initial tree baseline", async () => {
    const watchDir = join(tmpdir(), `file-watcher-${randomUUID()}`);
    tempDirs.push(watchDir);
    const dateDir = join(watchDir, "2026", "06", "25");
    await mkdir(dateDir, { recursive: true });
    const filePath = join(dateDir, "rollout-existing.jsonl");
    await writeFile(filePath, "{}\n");

    const events: FileChangeEvent[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.type === "file-change") events.push(event);
    });
    const watcher = new FileWatcher({
      watchDir,
      provider: "codex",
      eventBus,
      // Keep a delayed platform watcher event from racing this baseline-only
      // assertion; direct emissions below exercise the post-baseline path.
      debounceMs: 60_000,
      rescanSlowLogThresholdMs: 60_000,
    });

    try {
      watcher.start();
      expect(watcher.getInitialBaselineState()).toBe("scheduled");
      const metrics = await watcher.waitForInitialBaseline();

      expect(metrics).toMatchObject({
        provider: "codex",
        watchDir,
        filesScanned: 1,
        directoryReadErrors: 0,
        statFailures: 0,
      });
      expect(
        (metrics?.filesIndexed ?? 0) + (metrics?.touchedPathsPreserved ?? 0),
      ).toBe(1);
      expect(metrics?.directoriesVisited).toBeGreaterThanOrEqual(4);
      expect(watcher.getInitialBaselineState()).toBe("complete");

      // macOS may deliver the fixture write after the watcher attaches. In
      // that valid case the baseline deliberately leaves the touched file for
      // the event path to reconcile instead of installing a stale mtime.
      if (metrics?.touchedPathsPreserved) {
        (watcher as unknown as FileWatcherTestAccess).emitEvent(
          filePath,
          "change",
        );
        events.length = 0;
      }
      expect(events).toEqual([]);

      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeFile(filePath, '{"changed":true}\n');
      (watcher as unknown as FileWatcherTestAccess).emitEvent(
        filePath,
        "change",
      );
      expect(events.at(-1)).toMatchObject({
        path: filePath,
        nativeStorageScope: watchDir,
        changeType: "modify",
        mtimeMs: expect.any(Number),
        size: Buffer.byteLength('{"changed":true}\n'),
      });
    } finally {
      watcher.stop();
    }
  });

  it.each(["before", "after"])(
    "preserves a pending-baseline event delivered %s baseline completion",
    async (delivery) => {
      const watchDir = join(tmpdir(), `file-watcher-${randomUUID()}`);
      tempDirs.push(watchDir);
      await mkdir(watchDir, { recursive: true });
      const filePath = join(watchDir, "session.jsonl");
      await writeFile(filePath, "{}\n");

      const events: FileChangeEvent[] = [];
      const eventBus = new EventBus();
      eventBus.subscribe((event) => {
        if (event.type === "file-change") events.push(event);
      });
      const watcher = new FileWatcher({
        watchDir,
        provider: "claude",
        eventBus,
        debounceMs: 0,
        rescanSlowLogThresholdMs: 60_000,
      });

      // Native notifications for the fixture write can arrive after start() on
      // macOS and replace the injected event's debounce timer. Own delivery here;
      // the other watcher tests retain real filesystem observation coverage.
      class NativeWatch extends EventEmitter {
        close() {}
        ref() {
          return this;
        }
        unref() {
          return this;
        }
      }
      const nativeWatch = vi
        .spyOn(sharedDirectoryWatcher, "watchSharedDirectory")
        .mockReturnValue(new NativeWatch());
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        watcher.start();
        (watcher as unknown as FileWatcherTestAccess).handleFileEvent(
          "change",
          "session.jsonl",
        );
        if (delivery === "before") vi.runOnlyPendingTimers();
        const metrics = await watcher.waitForInitialBaseline();
        expect(watcher.getInitialBaselineState()).toBe("complete");
        if (delivery === "after") vi.runOnlyPendingTimers();

        expect(metrics?.touchedPathsPreserved).toBe(1);
        expect(events).toEqual([
          expect.objectContaining({
            path: filePath,
            changeType: "modify",
          }),
        ]);
      } finally {
        watcher.stop();
        vi.useRealTimers();
        nativeWatch.mockRestore();
      }
    },
  );

  it("reports a file first seen after the baseline as a create", async () => {
    const watchDir = join(tmpdir(), `file-watcher-${randomUUID()}`);
    tempDirs.push(watchDir);
    await mkdir(watchDir, { recursive: true });

    const events: FileChangeEvent[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.type === "file-change") events.push(event);
    });
    const watcher = new FileWatcher({
      watchDir,
      provider: "claude",
      eventBus,
      // Keep the platform event from racing the explicit event under test.
      // stop() clears the delayed timer before it can emit a duplicate.
      debounceMs: 60_000,
      rescanSlowLogThresholdMs: 60_000,
    });

    try {
      watcher.start();
      await watcher.waitForInitialBaseline();
      expect(watcher.getInitialBaselineState()).toBe("complete");

      // A file created and appended within one debounce window collapses to
      // the later "change" event, which must not hide the create from
      // SessionIndexService's directory reconciliation.
      const filePath = join(watchDir, "session.jsonl");
      await writeFile(filePath, "{}\n");
      (watcher as unknown as FileWatcherTestAccess).emitEvent(
        filePath,
        "change",
      );

      expect(events).toEqual([
        expect.objectContaining({ path: filePath, changeType: "create" }),
      ]);
    } finally {
      watcher.stop();
    }
  });

  it("reports an append whose mtime remains unchanged", async () => {
    const watchDir = join(tmpdir(), `file-watcher-${randomUUID()}`);
    tempDirs.push(watchDir);
    await mkdir(watchDir, { recursive: true });
    const filePath = join(watchDir, "session.jsonl");
    const fixedTime = new Date("2026-01-01T00:00:00.000Z");
    await writeFile(filePath, "{}\n");
    await utimes(filePath, fixedTime, fixedTime);

    const events: FileChangeEvent[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.type === "file-change") events.push(event);
    });
    const watcher = new FileWatcher({
      watchDir,
      provider: "codex",
      eventBus,
      rescanSlowLogThresholdMs: 60_000,
    });
    const internals = watcher as unknown as FileWatcherTestAccess;

    await forceRescan(watcher);
    events.length = 0;
    const before = await stat(filePath);
    await appendFile(filePath, '{"appended":true}\n');
    await utimes(filePath, fixedTime, fixedTime);

    internals.emitEvent(filePath, "change");

    expect(events).toEqual([
      expect.objectContaining({
        path: filePath,
        changeType: "modify",
        mtimeMs: before.mtimeMs,
        size: before.size + Buffer.byteLength('{"appended":true}\n'),
      }),
    ]);

    internals.emitEvent(filePath, "change");
    expect(events).toHaveLength(1);
  });

  it("finds a fixed-mtime append during a fallback rescan", async () => {
    const watchDir = join(tmpdir(), `file-watcher-${randomUUID()}`);
    tempDirs.push(watchDir);
    await mkdir(watchDir, { recursive: true });
    const filePath = join(watchDir, "session.jsonl");
    const fixedTime = new Date("2026-01-01T00:00:00.000Z");
    await writeFile(filePath, "{}\n");
    await utimes(filePath, fixedTime, fixedTime);

    const events: FileChangeEvent[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.type === "file-change") events.push(event);
    });
    const watcher = new FileWatcher({
      watchDir,
      provider: "codex",
      eventBus,
      rescanSlowLogThresholdMs: 60_000,
    });

    await forceRescan(watcher);
    events.length = 0;
    const before = await stat(filePath);
    await appendFile(filePath, '{"appended":true}\n');
    await utimes(filePath, fixedTime, fixedTime);

    await forceRescan(watcher);

    expect(events).toEqual([
      expect.objectContaining({
        path: filePath,
        changeType: "modify",
        mtimeMs: before.mtimeMs,
        size: before.size + Buffer.byteLength('{"appended":true}\n'),
      }),
    ]);
    expect(watcher.getLastRescanMetrics()).toMatchObject({
      modifyEvents: 1,
      emittedEvents: 1,
    });
  });

  it("records fallback rescan metrics and emitted change counts", async () => {
    const watchDir = join(tmpdir(), `file-watcher-${randomUUID()}`);
    tempDirs.push(watchDir);
    const dateDir = join(watchDir, "2026", "06", "25");
    await mkdir(dateDir, { recursive: true });

    const keepPath = join(dateDir, "rollout-keep.jsonl");
    const deletePath = join(dateDir, "rollout-delete.jsonl");
    const createPath = join(dateDir, "rollout-create.jsonl");
    await writeFile(keepPath, "{}\n");
    await writeFile(deletePath, "{}\n");

    const events: FileChangeEvent[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.type === "file-change") events.push(event);
    });

    const watcher = new FileWatcher({
      watchDir,
      provider: "codex",
      eventBus,
      rescanSlowLogThresholdMs: 60_000,
    });

    await forceRescan(watcher);
    expect(events.map((event) => event.changeType).sort()).toEqual([
      "create",
      "create",
    ]);

    events.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(keepPath, '{"changed":true}\n');
    await writeFile(createPath, "{}\n");
    await rm(deletePath);

    await forceRescan(watcher);

    expect(events.map((event) => event.changeType).sort()).toEqual([
      "create",
      "delete",
      "modify",
    ]);
    expect(events.every((event) => event.fileType === "session")).toBe(true);

    const metrics = watcher.getLastRescanMetrics();
    expect(metrics).toMatchObject({
      provider: "codex",
      watchDir,
      reason: "fallback",
      knownFilesBefore: 2,
      currentFiles: 2,
      knownFilesAfter: 2,
      createEvents: 1,
      modifyEvents: 1,
      deleteEvents: 1,
      emittedEvents: 3,
      sessionEvents: 3,
      agentSessionEvents: 0,
      otherEvents: 0,
      directoryReadErrors: 0,
      statFailures: 0,
    });
    expect(metrics?.directoriesVisited).toBeGreaterThanOrEqual(4);
    expect(metrics?.filesScanned).toBe(2);
    expect(metrics?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("classifies current Claude child transcripts and metadata together", async () => {
    const watchDir = join(tmpdir(), `file-watcher-${randomUUID()}`);
    tempDirs.push(watchDir);
    const subagentsDir = join(
      watchDir,
      "project-hash",
      "parent-session",
      "subagents",
    );
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(join(subagentsDir, "agent-child.jsonl"), "{}\n");
    await writeFile(join(subagentsDir, "agent-child.meta.json"), "{}\n");

    const events: FileChangeEvent[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.type === "file-change") events.push(event);
    });
    const watcher = new FileWatcher({
      watchDir,
      provider: "claude",
      eventBus,
      rescanSlowLogThresholdMs: 60_000,
    });

    await forceRescan(watcher);

    expect(events).toHaveLength(2);
    expect(events.every((event) => event.fileType === "agent-session")).toBe(
      true,
    );
  });

  it("records overlap skips on the next completed rescan", async () => {
    const watchDir = join(tmpdir(), `file-watcher-${randomUUID()}`);
    tempDirs.push(watchDir);
    await mkdir(watchDir, { recursive: true });

    const watcher = new FileWatcher({
      watchDir,
      provider: "codex",
      eventBus: new EventBus(),
      periodicRescanMs: 100,
      periodicRescanMaxBackoffMs: 1000,
      rescanSlowLogThresholdMs: 60_000,
    });
    const internals = watcher as unknown as FileWatcherTestAccess;

    internals.rescanInProgress = true;
    await forceRescan(watcher, "periodic");
    internals.rescanInProgress = false;

    await forceRescan(watcher, "periodic");

    expect(watcher.getLastRescanMetrics()).toMatchObject({
      reason: "periodic",
      periodicRescanCurrentMs: 100,
      periodicRescanNextMs: 200,
      periodicRescanBackoffReason: "overlap",
      overlapSkipsSinceLast: 1,
      overlapSkipsTotal: 1,
    });
    expect(watcher.getPeriodicRescanDelayMs()).toBe(200);
  });

  it("does not publish a rescan that finishes after stop", async () => {
    const watchDir = join(tmpdir(), `file-watcher-${randomUUID()}`);
    tempDirs.push(watchDir);
    await mkdir(watchDir, { recursive: true });

    const events: FileChangeEvent[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe((event) => {
      if (event.type === "file-change") events.push(event);
    });
    const watcher = new FileWatcher({
      watchDir,
      provider: "claude",
      eventBus,
      debounceMs: 60_000,
      rescanSlowLogThresholdMs: 60_000,
    });
    const internals = watcher as unknown as FileWatcherTestAccess;
    let releaseScan: (() => void) | undefined;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });

    try {
      watcher.start();
      await watcher.waitForInitialBaseline();
      const scan = vi
        .spyOn(internals, "scanDirAsync")
        .mockImplementation(async (_root, index) => {
          index.set(join(watchDir, "late.jsonl"), { mtimeMs: 1, size: 1 });
          await scanGate;
          return true;
        });

      const rescan = forceRescan(watcher);
      await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
      watcher.stop();
      releaseScan?.();
      await rescan;

      expect(events).toEqual([]);
      expect(watcher.getLastRescanMetrics()).toBeNull();
    } finally {
      releaseScan?.();
      watcher.stop();
    }
  });

  it("backs off and recovers periodic rescan delay from duration", async () => {
    const watchDir = join(tmpdir(), `file-watcher-${randomUUID()}`);
    tempDirs.push(watchDir);
    await mkdir(watchDir, { recursive: true });

    const watcher = new FileWatcher({
      watchDir,
      provider: "codex",
      eventBus: new EventBus(),
      periodicRescanMs: 100,
      periodicRescanMaxBackoffMs: 1000,
      rescanSlowLogThresholdMs: 60_000,
    });
    const dateNow = vi.spyOn(Date, "now");

    try {
      dateNow.mockReturnValue(1060);
      dateNow.mockReturnValueOnce(1000).mockReturnValueOnce(1060);
      await forceRescan(watcher, "periodic");

      expect(watcher.getLastRescanMetrics()).toMatchObject({
        durationMs: 60,
        periodicRescanCurrentMs: 100,
        periodicRescanNextMs: 200,
        periodicRescanBackoffReason: "slow",
      });
      expect(watcher.getPeriodicRescanDelayMs()).toBe(200);

      dateNow.mockReset();
      dateNow.mockReturnValue(2005);
      dateNow.mockReturnValueOnce(2000).mockReturnValueOnce(2005);
      await forceRescan(watcher, "periodic");

      expect(watcher.getLastRescanMetrics()).toMatchObject({
        durationMs: 5,
        periodicRescanCurrentMs: 200,
        periodicRescanNextMs: 100,
        periodicRescanBackoffReason: "recovered",
      });
      expect(watcher.getPeriodicRescanDelayMs()).toBe(100);
    } finally {
      dateNow.mockRestore();
    }
  });
});
