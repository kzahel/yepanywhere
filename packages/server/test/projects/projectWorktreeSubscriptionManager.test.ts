import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import type * as fs from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  GitWorkingTreeFile,
  GitWorkingTreePathKind,
  GitWorktreeCoverage,
  GitWorktreeDeltaEvent,
  GitWorktreeDirectory,
  GitWorktreeSubscriptionEvent,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "../../src/logging/logger.js";
import { ProjectWorktreeSubscriptionManager } from "../../src/projects/projectWorktreeSubscriptionManager.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

class FakeWatcher extends EventEmitter {
  closed = false;

  close(): void {
    this.closed = true;
  }
}

function file(path: string, kind: GitWorkingTreePathKind): GitWorkingTreeFile {
  return { path, kind, tracked: kind === "tracked" };
}

function mapFiles(
  files: GitWorkingTreeFile[],
): Map<string, GitWorkingTreeFile> {
  return new Map(files.map((entry) => [entry.path, entry]));
}

describe("ProjectWorktreeSubscriptionManager", () => {
  let projectPath: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    projectPath = await realpath(
      await mkdtemp(join(tmpdir(), "ya-worktree-watch-")),
    );
    await mkdir(join(projectPath, ".git", "objects"), { recursive: true });
    await mkdir(join(projectPath, "src", "nested"), { recursive: true });
    await writeFile(join(projectPath, "src", "a.ts"), "a\n");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(projectPath, { recursive: true });
  });

  it("rejects subscriptions without scanning while monitoring is disabled", async () => {
    const getProject = vi.fn();
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: { getProject },
      enabled: false,
    });

    const subscription = manager.subscribe(
      "project-a" as UrlProjectId,
      { tracked: true, untracked: true, ignored: false },
      vi.fn(),
    );

    await expect(subscription.ready).rejects.toThrow(
      "Live worktree monitoring is disabled",
    );
    expect(getProject).not.toHaveBeenCalled();
    expect(manager.isEnabled()).toBe(false);
  });

  it("releases every project resource when monitoring is disabled", async () => {
    const projectId = "project-a" as UrlProjectId;
    const watchers: FakeWatcher[] = [];
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-a",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      platform: "linux",
      watchDirectory: () => {
        const watcher = new FakeWatcher();
        watchers.push(watcher);
        return watcher as unknown as fs.FSWatcher;
      },
      scanWorktree: vi.fn(async () => ({
        headSha: "head-a",
        baseSha: "base-a",
        files: mapFiles([file("src/a.ts", "tracked")]),
      })),
    });
    const subscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      vi.fn(),
    );
    await subscription.ready;

    await vi.waitFor(() => expect(watchers.length).toBeGreaterThan(0));
    manager.setEnabled(false);

    expect(watchers.every((watcher) => watcher.closed)).toBe(true);
    expect(manager.diagnostics()).toEqual({
      mode: "off",
      circuitOpen: false,
      circuitReason: null,
      activeProjects: 0,
      watchedProjects: 0,
      retainedProjects: 0,
      subscribers: 0,
      watchedDirectories: 0,
      maxWatchedDirectories: 256,
      maxWatchedProjects: 4,
      cumulativeRegistrations: watchers.length,
    });
  });

  it.each(["darwin", "win32"] as const)(
    "never allocates native watchers on %s",
    async (platform) => {
      const projectId = "project-poll-only" as UrlProjectId;
      const watchDirectory = vi.fn(() => {
        return new FakeWatcher() as unknown as fs.FSWatcher;
      });
      const scanWorktree = vi.fn(async () => ({
        headSha: "head-a",
        baseSha: "base-a",
        files: mapFiles([file("src/a.ts", "tracked")]),
      }));
      const manager = new ProjectWorktreeSubscriptionManager({
        scanner: {
          getProject: vi.fn(async () => ({
            id: projectId,
            path: projectPath,
            name: "project-poll-only",
            sessionCount: 0,
            sessionDir: "",
            activeOwnedCount: 0,
            activeExternalCount: 0,
            lastActivity: null,
            provider: "claude" as const,
          })),
        },
        fallbackPollMs: 1_000,
        platform,
        watchDirectory,
        scanWorktree,
      });
      const subscription = manager.subscribe(
        projectId,
        { tracked: true, untracked: true, ignored: false },
        vi.fn(),
      );
      await subscription.ready;

      expect(watchDirectory).not.toHaveBeenCalled();
      expect(manager.diagnostics()).toMatchObject({
        mode: "polling",
        circuitOpen: false,
        circuitReason: null,
        watchedDirectories: 0,
        cumulativeRegistrations: 0,
      });

      // Bounded full reconciliation remains the truth source on the clock.
      const scanCount = scanWorktree.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() =>
        expect(scanWorktree).toHaveBeenCalledTimes(scanCount + 1),
      );
      expect(watchDirectory).not.toHaveBeenCalled();

      subscription.release();
      const releasedScanCount = scanWorktree.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(scanWorktree).toHaveBeenCalledTimes(releasedScanCount);
      manager.dispose();
    },
  );

  it("opens the circuit on runaway watcher registration churn", async () => {
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    const projectId = "project-churn" as UrlProjectId;
    const churnDir = join(projectPath, "churn");
    await mkdir(churnDir, { recursive: true });
    const watchListeners = new Map<
      string,
      (eventType: string, filename: Buffer | string | null) => void
    >();
    const watchers: FakeWatcher[] = [];
    const scanWorktree = vi.fn(async () => ({
      headSha: "head-a",
      baseSha: "base-a",
      files: mapFiles([file("src/a.ts", "tracked")]),
    }));
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-churn",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      debounceMs: 25,
      maxEventAgeMs: 100,
      fallbackPollMs: 1_000,
      maxNativeWatchers: 6,
      platform: "linux",
      registrationChurnLimit: 6,
      watchDirectory: (path, listener) => {
        watchListeners.set(path, listener);
        const watcher = new FakeWatcher();
        watchers.push(watcher);
        return watcher as unknown as fs.FSWatcher;
      },
      scanWorktree,
    });
    const subscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      vi.fn(),
    );
    await subscription.ready;
    await vi.waitFor(() =>
      expect(manager.diagnostics().watchedDirectories).toBeGreaterThan(2),
    );
    expect(manager.diagnostics().circuitOpen).toBe(false);

    // Repeatedly replace the same directory. The active count never grows,
    // but cumulative registrations do, and the churn window catches them.
    for (let round = 0; round < 8; round += 1) {
      if (manager.diagnostics().circuitOpen) break;
      const watchedBeforeRemoval = manager.diagnostics().watchedDirectories;
      await rm(churnDir, { recursive: true, force: true });
      watchListeners.get(projectPath)?.("rename", "churn");
      await vi.advanceTimersByTimeAsync(150);
      await vi.waitFor(() =>
        expect(manager.diagnostics().watchedDirectories).toBeLessThan(
          watchedBeforeRemoval,
        ),
      );

      const registrationsBeforeCreate =
        manager.diagnostics().cumulativeRegistrations;
      await mkdir(churnDir, { recursive: true });
      watchListeners.get(projectPath)?.("rename", "churn");
      await vi.advanceTimersByTimeAsync(150);
      await vi.waitFor(() => {
        const diagnostics = manager.diagnostics();
        expect(
          diagnostics.circuitOpen ||
            diagnostics.cumulativeRegistrations > registrationsBeforeCreate,
        ).toBe(true);
      });
    }

    await vi.waitFor(() =>
      expect(manager.diagnostics()).toMatchObject({
        mode: "polling",
        circuitOpen: true,
        circuitReason: "registration-churn",
        watchedDirectories: 0,
      }),
    );
    expect(watchers.every((watcher) => watcher.closed)).toBe(true);

    // The circuit does not retry allocation; polling covers the project.
    const allocationCount = watchers.length;
    const scanCount = scanWorktree.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(scanWorktree.mock.calls.length).toBeGreaterThan(scanCount),
    );
    expect(watchers.length).toBe(allocationCount);

    subscription.release();
    warn.mockRestore();
    manager.dispose();
  });

  it("opens the circuit before a directory set can exceed the watcher budget", async () => {
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    const projectId = "project-budget" as UrlProjectId;
    const watchDirectory = vi.fn(() => {
      const watcher = new FakeWatcher();
      return watcher as unknown as fs.FSWatcher;
    });
    const scanWorktree = vi.fn(async () => ({
      headSha: "head-a",
      baseSha: "base-a",
      files: mapFiles([file("src/a.ts", "tracked")]),
    }));
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-budget",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      fallbackPollMs: 1_000,
      maxNativeWatchers: 2,
      platform: "linux",
      watchDirectory,
      scanWorktree,
    });
    const subscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      vi.fn(),
    );
    await subscription.ready;

    await vi.waitFor(() =>
      expect(manager.diagnostics().circuitOpen).toBe(true),
    );
    expect(watchDirectory).not.toHaveBeenCalled();
    expect(manager.diagnostics()).toMatchObject({
      mode: "polling",
      circuitOpen: true,
      circuitReason: "watcher-limit",
      activeProjects: 1,
      watchedProjects: 0,
      watchedDirectories: 0,
      maxWatchedDirectories: 2,
    });
    expect(warn).toHaveBeenCalledTimes(1);

    const scanCount = scanWorktree.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(scanWorktree).toHaveBeenCalledTimes(scanCount + 1),
    );
    expect(watchDirectory).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    subscription.release();
    warn.mockRestore();
  });

  it("closes every watcher and stops allocations after EMFILE", async () => {
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    const projectId = "project-emfile" as UrlProjectId;
    const watchers: FakeWatcher[] = [];
    const watchDirectory = vi.fn(() => {
      const watcher = new FakeWatcher();
      watchers.push(watcher);
      return watcher as unknown as fs.FSWatcher;
    });
    const scanWorktree = vi.fn(async () => ({
      headSha: "head-a",
      baseSha: "base-a",
      files: mapFiles([file("src/a.ts", "tracked")]),
    }));
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-emfile",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      fallbackPollMs: 1_000,
      maxNativeWatchers: 10,
      platform: "linux",
      watchDirectory,
      scanWorktree,
    });
    const subscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      vi.fn(),
    );
    await subscription.ready;
    await vi.waitFor(() => expect(watchers.length).toBeGreaterThan(1));
    const allocationCount = watchDirectory.mock.calls.length;

    watchers[0]?.emit(
      "error",
      Object.assign(new Error("Too many open files"), { code: "EMFILE" }),
    );

    expect(watchers.every((watcher) => watcher.closed)).toBe(true);
    expect(manager.diagnostics()).toMatchObject({
      mode: "polling",
      circuitOpen: true,
      circuitReason: "EMFILE",
      watchedDirectories: 0,
    });
    expect(warn).toHaveBeenCalledTimes(1);

    watchers[1]?.emit(
      "error",
      Object.assign(new Error("Too many open files"), { code: "EMFILE" }),
    );
    const scanCount = scanWorktree.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(scanWorktree).toHaveBeenCalledTimes(scanCount + 1),
    );
    expect(watchDirectory).toHaveBeenCalledTimes(allocationCount);
    expect(warn).toHaveBeenCalledTimes(1);

    manager.setEnabled(false);
    manager.setEnabled(true);
    expect(manager.diagnostics()).toMatchObject({
      mode: "watching",
      circuitOpen: false,
      circuitReason: null,
    });
    const resetSubscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      vi.fn(),
    );
    await resetSubscription.ready;
    await vi.waitFor(() =>
      expect(watchDirectory.mock.calls.length).toBeGreaterThan(allocationCount),
    );
    resetSubscription.release();
    subscription.release();
    warn.mockRestore();
  });

  it("opens the circuit before watching more than the active-project cap", async () => {
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    const secondPath = await realpath(
      await mkdtemp(join(tmpdir(), "ya-worktree-watch-second-")),
    );
    await mkdir(join(secondPath, "src"), { recursive: true });
    const firstId = "project-first" as UrlProjectId;
    const secondId = "project-second" as UrlProjectId;
    const watchers: FakeWatcher[] = [];
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async (projectId) => ({
          id: projectId,
          path: projectId === firstId ? projectPath : secondPath,
          name: projectId,
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      maxNativeWatchers: 20,
      maxWatchedProjects: 1,
      platform: "linux",
      watchDirectory: () => {
        const watcher = new FakeWatcher();
        watchers.push(watcher);
        return watcher as unknown as fs.FSWatcher;
      },
      scanWorktree: vi.fn(async () => ({
        headSha: "head-a",
        baseSha: "base-a",
        files: mapFiles([file("src/a.ts", "tracked")]),
      })),
    });
    const first = manager.subscribe(
      firstId,
      { tracked: true, untracked: true, ignored: false },
      vi.fn(),
    );
    await first.ready;
    await vi.waitFor(() => expect(watchers.length).toBeGreaterThan(0));
    const firstProjectAllocations = watchers.length;

    const second = manager.subscribe(
      secondId,
      { tracked: true, untracked: true, ignored: false },
      vi.fn(),
    );
    await second.ready;
    await vi.waitFor(() =>
      expect(manager.diagnostics().circuitOpen).toBe(true),
    );

    expect(watchers).toHaveLength(firstProjectAllocations);
    expect(watchers.every((watcher) => watcher.closed)).toBe(true);
    expect(manager.diagnostics()).toMatchObject({
      mode: "polling",
      circuitOpen: true,
      circuitReason: "active-project-limit",
      activeProjects: 2,
      watchedProjects: 0,
      watchedDirectories: 0,
      maxWatchedProjects: 1,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    first.release();
    second.release();
    warn.mockRestore();
    await rm(secondPath, { recursive: true });
  });

  it("shares one dot-git-free watch set and loads ignored paths only on demand", async () => {
    const projectId = "project-a" as UrlProjectId;
    const watchedPaths: string[] = [];
    const watchOptions = new Map<string, { recursive: boolean }>();
    const watchListeners = new Map<
      string,
      (eventType: string, filename: Buffer | string | null) => void
    >();
    const watchers: FakeWatcher[] = [];
    const coverages: GitWorktreeCoverage[] = [];
    let currentFiles = [
      file("src/a.ts", "tracked"),
      file("notes.txt", "untracked"),
    ];
    const manager = new ProjectWorktreeSubscriptionManager({
      platform: "linux",
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-a",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      debounceMs: 25,
      maxEventAgeMs: 100,
      watchDirectory: (path, listener, options) => {
        watchedPaths.push(path);
        watchOptions.set(path, options);
        watchListeners.set(path, listener);
        const watcher = new FakeWatcher();
        watchers.push(watcher);
        return watcher as unknown as fs.FSWatcher;
      },
      scanWorktree: vi.fn(async (_path, coverage) => {
        coverages.push({ ...coverage });
        return {
          headSha: "head-a",
          baseSha: "base-a",
          files: mapFiles(
            currentFiles.filter((entry) => coverage[entry.kind ?? "untracked"]),
          ),
        };
      }),
    });

    const ordinaryEvents: GitWorktreeSubscriptionEvent[] = [];
    const ordinary = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      (event) => ordinaryEvents.push(event),
    );
    await ordinary.ready;

    expect(ordinaryEvents[0]).toMatchObject({
      type: "git-worktree-snapshot",
      files: [file("notes.txt", "untracked"), file("src/a.ts", "tracked")],
    });
    await vi.waitFor(() => {
      expect(watchedPaths).toContain(projectPath);
      expect(watchedPaths).toContain(join(projectPath, "src"));
      expect(watchedPaths).toContain(join(projectPath, "src", "nested"));
    });
    const initialWatchCount = watchedPaths.length;
    expect(watchOptions.get(projectPath)).toEqual({ recursive: false });
    expect(watchOptions.get(join(projectPath, "src"))).toEqual({
      recursive: false,
    });
    expect(
      watchedPaths.some((path) =>
        path.includes(`${join(projectPath, ".git")}`),
      ),
    ).toBe(false);
    expect(coverages.at(-1)?.ignored).toBe(false);

    currentFiles = [...currentFiles, file("build/output.js", "ignored")];
    const ignoredEvents: GitWorktreeSubscriptionEvent[] = [];
    const ignored = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: true },
      (event) => ignoredEvents.push(event),
    );
    await ignored.ready;

    expect(coverages.at(-1)?.ignored).toBe(true);
    expect(ignoredEvents[0]).toMatchObject({
      type: "git-worktree-snapshot",
      files: [
        file("build/output.js", "ignored"),
        file("notes.txt", "untracked"),
        file("src/a.ts", "tracked"),
      ],
    });

    currentFiles = currentFiles.map((entry) => ({ ...entry }));
    watchListeners.get(join(projectPath, "src"))?.("change", "a.ts");
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => {
      expect(ordinaryEvents.at(-1)).toMatchObject({
        type: "git-worktree-delta",
        changes: [{ changeType: "modify", path: "src/a.ts" }],
      });
    });
    expect(watchedPaths).toHaveLength(initialWatchCount);

    watchListeners.get(projectPath)?.("change", null);
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => {
      expect(ordinaryEvents.at(-1)).toMatchObject({
        type: "git-worktree-delta",
        changes: [
          { changeType: "modify", path: "notes.txt" },
          { changeType: "modify", path: "src/a.ts" },
        ],
      });
    });

    ignored.release();
    ordinary.release();
    expect(manager.diagnostics()).toMatchObject({
      activeProjects: 0,
      subscribers: 0,
      watchedDirectories: 0,
    });
    expect(watchers.every((watcher) => watcher.closed)).toBe(true);
    manager.dispose();
  });

  it("shares one scan for identical subscribers and preserves global sequence", async () => {
    const projectId = "project-a" as UrlProjectId;
    const watchListeners = new Map<
      string,
      (eventType: string, filename: Buffer | string | null) => void
    >();
    let currentFiles = [
      file("src/a.ts", "tracked"),
      file("build/output.js", "ignored"),
    ];
    const scanWorktree = vi.fn(
      async (_path, coverage: GitWorktreeCoverage) => ({
        headSha: "head-a",
        baseSha: "base-a",
        files: mapFiles(
          currentFiles.filter((entry) => coverage[entry.kind ?? "untracked"]),
        ),
      }),
    );
    const manager = new ProjectWorktreeSubscriptionManager({
      platform: "linux",
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-a",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      debounceMs: 25,
      maxEventAgeMs: 100,
      watchDirectory: (path, listener) => {
        watchListeners.set(path, listener);
        return new FakeWatcher() as unknown as fs.FSWatcher;
      },
      scanWorktree,
    });
    const coverage = { tracked: true, untracked: true, ignored: false };
    const firstEvents: GitWorktreeSubscriptionEvent[] = [];
    const secondEvents: GitWorktreeSubscriptionEvent[] = [];
    const first = manager.subscribe(projectId, coverage, (event) =>
      firstEvents.push(event),
    );
    await first.ready;
    await vi.waitFor(() => expect(scanWorktree).toHaveBeenCalledTimes(2));
    const initialScanCount = scanWorktree.mock.calls.length;
    const second = manager.subscribe(projectId, coverage, (event) =>
      secondEvents.push(event),
    );
    await second.ready;
    expect(scanWorktree).toHaveBeenCalledTimes(initialScanCount);

    const ignoredEvents: GitWorktreeSubscriptionEvent[] = [];
    const ignored = manager.subscribe(
      projectId,
      { ...coverage, ignored: true },
      (event) => ignoredEvents.push(event),
    );
    await ignored.ready;
    expect(scanWorktree).toHaveBeenCalledTimes(initialScanCount + 1);
    expect(firstEvents.at(-1)).toMatchObject({
      type: "git-worktree-delta",
      generation: expect.any(Object),
      changes: [],
    });
    expect(secondEvents.at(-1)).toMatchObject({
      type: "git-worktree-delta",
      generation: expect.any(Object),
      changes: [],
    });
    const expansionSequence = firstEvents.at(-1)?.generation.sequence;
    expect(secondEvents.at(-1)?.generation.sequence).toBe(expansionSequence);
    expect(ignoredEvents[0]?.generation.sequence).toBe(expansionSequence);

    currentFiles = currentFiles.map((entry) =>
      entry.kind === "ignored" ? { ...entry } : entry,
    );
    watchListeners.get(projectPath)?.("change", "build/output.js");
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() =>
      expect(scanWorktree).toHaveBeenCalledTimes(initialScanCount + 2),
    );
    expect(firstEvents.at(-1)).toMatchObject({
      type: "git-worktree-delta",
      generation: expect.any(Object),
      changes: [],
    });
    expect(ignoredEvents.at(-1)).toMatchObject({
      type: "git-worktree-delta",
      generation: expect.any(Object),
      changes: [{ changeType: "modify", path: "build/output.js" }],
    });
    const changedSequence = firstEvents.at(-1)?.generation.sequence;
    expect(ignoredEvents.at(-1)?.generation.sequence).toBe(changedSequence);
    expect(changedSequence).toBe((expansionSequence ?? -1) + 1);

    ignored.release();
    second.release();
    first.release();
    manager.dispose();
  });

  it("rescans when subscription coverage widens during an active expansion", async () => {
    const projectId = "project-a" as UrlProjectId;
    const currentFiles = [
      file("src/a.ts", "tracked"),
      file("notes.txt", "untracked"),
      file("build/output.js", "ignored"),
    ];
    let releaseExpansion: () => void = () => {};
    const expansionGate = new Promise<void>((resolve) => {
      releaseExpansion = resolve;
    });
    let expansionStarted = false;
    const coverages: GitWorktreeCoverage[] = [];
    const scanWorktree = vi.fn(
      async (_path: string, coverage: GitWorktreeCoverage) => {
        coverages.push({ ...coverage });
        if (coverage.untracked && !coverage.ignored) {
          expansionStarted = true;
          await expansionGate;
        }
        return {
          headSha: "head-a",
          baseSha: "base-a",
          files: mapFiles(
            currentFiles.filter((entry) => coverage[entry.kind ?? "untracked"]),
          ),
        };
      },
    );
    const manager = new ProjectWorktreeSubscriptionManager({
      platform: "linux",
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-a",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      watchDirectory: () => new FakeWatcher() as unknown as fs.FSWatcher,
      scanWorktree,
    });
    const tracked = manager.subscribe(
      projectId,
      { tracked: true, untracked: false, ignored: false },
      vi.fn(),
    );
    await tracked.ready;
    await vi.waitFor(() =>
      expect(scanWorktree.mock.calls.length).toBeGreaterThan(1),
    );

    const untracked = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      vi.fn(),
    );
    await vi.waitFor(() => expect(expansionStarted).toBe(true));
    const ignoredEvents: GitWorktreeSubscriptionEvent[] = [];
    const ignored = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: true },
      (event) => ignoredEvents.push(event),
    );
    releaseExpansion();

    await Promise.all([untracked.ready, ignored.ready]);
    expect(coverages.at(-1)?.ignored).toBe(true);
    expect(ignoredEvents[0]).toMatchObject({
      type: "git-worktree-snapshot",
      files: expect.arrayContaining([
        expect.objectContaining({ path: "build/output.js", kind: "ignored" }),
      ]),
    });

    ignored.release();
    untracked.release();
    tracked.release();
    manager.dispose();
  });

  it("pins the reconciliation deadline to the first unprocessed event", async () => {
    const projectId = "project-a" as UrlProjectId;
    const watchListeners = new Map<
      string,
      (eventType: string, filename: Buffer | string | null) => void
    >();
    const scanWorktree = vi.fn(async () => ({
      headSha: "head-a",
      baseSha: "base-a",
      files: mapFiles([file("src/a.ts", "tracked")]),
    }));
    const manager = new ProjectWorktreeSubscriptionManager({
      platform: "linux",
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-a",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      debounceMs: 25,
      maxEventAgeMs: 100,
      watchDirectory: (path, listener) => {
        watchListeners.set(path, listener);
        return new FakeWatcher() as unknown as fs.FSWatcher;
      },
      scanWorktree,
    });
    const subscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      vi.fn(),
    );
    await subscription.ready;
    await vi.waitFor(() => expect(scanWorktree).toHaveBeenCalledTimes(2));
    const initialScanCount = scanWorktree.mock.calls.length;

    for (let index = 0; index < 5; index += 1) {
      watchListeners.get(projectPath)?.("change", `event-${index}`);
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.waitFor(() =>
      expect(scanWorktree).toHaveBeenCalledTimes(initialScanCount + 1),
    );

    subscription.release();
    manager.dispose();
  });

  it("keeps bounded full reconciliation while a directory watch is unavailable", async () => {
    const projectId = "project-a" as UrlProjectId;
    const watchListeners = new Map<
      string,
      (eventType: string, filename: Buffer | string | null) => void
    >();
    let failSrcWatch = true;
    const scanWorktree = vi.fn(async () => ({
      headSha: "head-a",
      baseSha: "base-a",
      files: mapFiles([file("src/a.ts", "tracked")]),
    }));
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-a",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      debounceMs: 25,
      maxEventAgeMs: 100,
      fallbackPollMs: 1_000,
      platform: "linux",
      watchDirectory: (path, listener) => {
        if (failSrcWatch && path === join(projectPath, "src")) {
          throw new Error("watch unavailable");
        }
        watchListeners.set(path, listener);
        return new FakeWatcher() as unknown as fs.FSWatcher;
      },
      scanWorktree,
    });
    const subscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      vi.fn(),
    );
    await subscription.ready;
    await vi.waitFor(() => expect(scanWorktree).toHaveBeenCalledTimes(2));
    const initialScanCount = scanWorktree.mock.calls.length;

    // The unwatchable directory keeps full clock reconciliation running.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(scanWorktree).toHaveBeenCalledTimes(initialScanCount + 1),
    );

    failSrcWatch = false;
    watchListeners.get(projectPath)?.("rename", "src");
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() =>
      expect(watchListeners.has(join(projectPath, "src"))).toBe(true),
    );
    // Let the post-reattach refresh settle; complete watches with no Git
    // metadata then end clock reconciliation.
    await vi.advanceTimersByTimeAsync(100);
    const recoveredScanCount = scanWorktree.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(scanWorktree).toHaveBeenCalledTimes(recoveredScanCount);

    subscription.release();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(scanWorktree).toHaveBeenCalledTimes(recoveredScanCount);
    manager.dispose();
  });

  it("uses Linux Git metadata events without unchanged full scans", async () => {
    const projectId = "project-linux-metadata" as UrlProjectId;
    const gitDir = join(projectPath, ".git");
    const headRefPath = join(gitDir, "refs", "heads", "main");
    await mkdir(join(gitDir, "refs", "heads"), { recursive: true });
    await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(gitDir, "index"), "index-a\n");
    await writeFile(headRefPath, "head-a\n");

    const watchListeners = new Map<
      string,
      (eventType: string, filename: Buffer | string | null) => void
    >();
    let currentFile = file("pending.txt", "untracked");
    let moveHeadDuringScan = false;
    const scanWorktree = vi.fn(async () => {
      if (moveHeadDuringScan) {
        moveHeadDuringScan = false;
        await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/next\n");
      }
      return {
        headSha: "head-a",
        baseSha: "base-a",
        files: mapFiles([currentFile]),
      };
    });
    const resolveGitMetadata = vi.fn(async () => ({
      gitDir,
      commonDir: gitDir,
      headRefPath,
    }));
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-linux-metadata",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      debounceMs: 25,
      maxEventAgeMs: 100,
      fallbackPollMs: 1_000,
      platform: "linux",
      resolveGitMetadata,
      watchDirectory: (path, listener) => {
        watchListeners.set(path, listener);
        return new FakeWatcher() as unknown as fs.FSWatcher;
      },
      scanWorktree,
    });
    const events: GitWorktreeSubscriptionEvent[] = [];
    const subscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      (event) => events.push(event),
    );
    await subscription.ready;
    await vi.waitFor(() => expect(scanWorktree).toHaveBeenCalledTimes(2));
    const initialScanCount = scanWorktree.mock.calls.length;

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    expect(scanWorktree).toHaveBeenCalledTimes(initialScanCount);

    watchListeners.get(gitDir)?.("rename", "index.lock");
    await vi.advanceTimersByTimeAsync(25);
    expect(scanWorktree).toHaveBeenCalledTimes(initialScanCount);

    currentFile = file("pending.txt", "tracked");
    watchListeners.get(gitDir)?.("rename", "index");
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        type: "git-worktree-delta",
        changes: [
          expect.objectContaining({
            path: "pending.txt",
            file: expect.objectContaining({ kind: "tracked" }),
          }),
        ],
      }),
    );
    expect(scanWorktree).toHaveBeenCalledTimes(initialScanCount + 1);

    const resolvedBeforeHeadMove = resolveGitMetadata.mock.calls.length;
    moveHeadDuringScan = true;
    watchListeners.get(gitDir)?.("rename", "index");
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() =>
      expect(scanWorktree).toHaveBeenCalledTimes(initialScanCount + 3),
    );
    expect(resolveGitMetadata.mock.calls.length).toBeGreaterThan(
      resolvedBeforeHeadMove,
    );

    const scanCountBeforeFingerprintDrift = scanWorktree.mock.calls.length;
    const resolvedBeforeFingerprintDrift = resolveGitMetadata.mock.calls.length;
    await writeFile(join(gitDir, "index"), "index-b\n");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(scanWorktree).toHaveBeenCalledTimes(
        scanCountBeforeFingerprintDrift + 1,
      ),
    );
    expect(resolveGitMetadata.mock.calls.length).toBeGreaterThan(
      resolvedBeforeFingerprintDrift,
    );

    subscription.release();
    manager.dispose();
  });

  it("reconciles on the clock until a failed scan succeeds again", async () => {
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    const projectId = "project-scan-failure" as UrlProjectId;
    const gitDir = join(projectPath, ".git");
    const headRefPath = join(gitDir, "refs", "heads", "main");
    await mkdir(join(gitDir, "refs", "heads"), { recursive: true });
    await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(gitDir, "index"), "index-a\n");
    await writeFile(headRefPath, "head-a\n");

    const watchListeners = new Map<
      string,
      (eventType: string, filename: Buffer | string | null) => void
    >();
    let failScan = false;
    const scanWorktree = vi.fn(async () => {
      if (failScan) throw new Error("scan failed");
      return {
        headSha: "head-a",
        baseSha: "base-a",
        files: mapFiles([file("src/a.ts", "tracked")]),
      };
    });
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-scan-failure",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      debounceMs: 25,
      maxEventAgeMs: 100,
      fallbackPollMs: 1_000,
      platform: "linux",
      resolveGitMetadata: vi.fn(async () => ({
        gitDir,
        commonDir: gitDir,
        headRefPath,
      })),
      watchDirectory: (path, listener) => {
        watchListeners.set(path, listener);
        return new FakeWatcher() as unknown as fs.FSWatcher;
      },
      scanWorktree,
    });
    const subscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      vi.fn(),
    );
    await subscription.ready;
    await vi.waitFor(() => expect(scanWorktree).toHaveBeenCalledTimes(2));

    // Complete watches make the fingerprint the truth source, so an unchanged
    // tick does no work.
    const quietScanCount = scanWorktree.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    expect(scanWorktree).toHaveBeenCalledTimes(quietScanCount);

    failScan = true;
    watchListeners.get(projectPath)?.("change", "src/a.ts");
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() =>
      expect(scanWorktree).toHaveBeenCalledTimes(quietScanCount + 1),
    );

    // The snapshot is now behind the worktree with no pending event of its
    // own, so reconciliation runs on the clock without a metadata change.
    const failedScanCount = scanWorktree.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(scanWorktree).toHaveBeenCalledTimes(failedScanCount + 1),
    );

    failScan = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(scanWorktree.mock.calls.length).toBeGreaterThan(
        failedScanCount + 1,
      ),
    );
    const recoveredScanCount = scanWorktree.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    expect(scanWorktree).toHaveBeenCalledTimes(recoveredScanCount);
    expect(warn).toHaveBeenCalledTimes(2);

    subscription.release();
    manager.dispose();
    warn.mockRestore();
  });

  it("falls back to full polling when a Git metadata directory is not watchable", async () => {
    const projectId = "project-metadata-fallback" as UrlProjectId;
    const gitDir = join(projectPath, ".git");
    const scanWorktree = vi.fn(async () => ({
      headSha: "head-a",
      baseSha: "base-a",
      files: mapFiles([file("src/a.ts", "tracked")]),
    }));
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-metadata-fallback",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      fallbackPollMs: 1_000,
      platform: "linux",
      resolveGitMetadata: vi.fn(async () => ({
        gitDir,
        commonDir: gitDir,
        headRefPath: null,
      })),
      watchDirectory: (path) => {
        if (path === gitDir) throw new Error("Git watch unavailable");
        return new FakeWatcher() as unknown as fs.FSWatcher;
      },
      scanWorktree,
    });
    const subscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      vi.fn(),
    );
    await subscription.ready;
    await vi.waitFor(() => expect(scanWorktree).toHaveBeenCalledTimes(2));
    const initialScanCount = scanWorktree.mock.calls.length;

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(scanWorktree).toHaveBeenCalledTimes(initialScanCount + 1),
    );

    subscription.release();
    manager.dispose();
  });

  it("watches linked-worktree and common Git metadata directories", async () => {
    const projectId = "project-linked-metadata" as UrlProjectId;
    const commonDir = join(projectPath, ".git", "common");
    const gitDir = join(commonDir, "worktrees", "linked");
    const headRefPath = join(commonDir, "refs", "heads", "linked");
    await mkdir(join(commonDir, "refs", "heads"), { recursive: true });
    await mkdir(join(gitDir, "rebase-merge"), { recursive: true });
    await writeFile(headRefPath, "head-a\n");

    const watchOptions = new Map<string, { recursive: boolean }>();
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-linked-metadata",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      platform: "linux",
      resolveGitMetadata: vi.fn(async () => ({
        gitDir,
        commonDir,
        headRefPath,
      })),
      watchDirectory: (path, _listener, options) => {
        watchOptions.set(path, options);
        return new FakeWatcher() as unknown as fs.FSWatcher;
      },
      scanWorktree: vi.fn(async () => ({
        headSha: "head-a",
        baseSha: "base-a",
        files: new Map(),
      })),
    });
    const subscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      vi.fn(),
    );
    await subscription.ready;
    await vi.waitFor(() => {
      expect(watchOptions.get(gitDir)).toEqual({ recursive: false });
      expect(watchOptions.get(commonDir)).toEqual({ recursive: false });
      expect(watchOptions.get(join(commonDir, "refs"))).toEqual({
        recursive: true,
      });
      expect(watchOptions.get(join(gitDir, "rebase-merge"))).toEqual({
        recursive: true,
      });
    });

    subscription.release();
    manager.dispose();
  });

  it("serializes Git metadata reconciliation and queues one follow-up", async () => {
    const projectId = "project-metadata-serialization" as UrlProjectId;
    const gitDir = join(projectPath, ".git");
    const watchListeners = new Map<
      string,
      (eventType: string, filename: Buffer | string | null) => void
    >();
    let blockNextScan = false;
    let releaseScan: () => void = () => {};
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    let activeScans = 0;
    let maxActiveScans = 0;
    const scanWorktree = vi.fn(async () => {
      activeScans += 1;
      maxActiveScans = Math.max(maxActiveScans, activeScans);
      try {
        if (blockNextScan) {
          blockNextScan = false;
          await scanGate;
        }
        return {
          headSha: "head-a",
          baseSha: "base-a",
          files: mapFiles([file("src/a.ts", "tracked")]),
        };
      } finally {
        activeScans -= 1;
      }
    });
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-metadata-serialization",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      debounceMs: 25,
      maxEventAgeMs: 100,
      platform: "linux",
      resolveGitMetadata: vi.fn(async () => ({
        gitDir,
        commonDir: gitDir,
        headRefPath: null,
      })),
      watchDirectory: (path, listener) => {
        watchListeners.set(path, listener);
        return new FakeWatcher() as unknown as fs.FSWatcher;
      },
      scanWorktree,
    });
    const subscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      vi.fn(),
    );
    await subscription.ready;
    await vi.waitFor(() => expect(scanWorktree).toHaveBeenCalledTimes(2));
    const initialScanCount = scanWorktree.mock.calls.length;

    blockNextScan = true;
    watchListeners.get(gitDir)?.("rename", "index");
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => expect(activeScans).toBe(1));
    watchListeners.get(gitDir)?.("rename", "HEAD");
    await vi.advanceTimersByTimeAsync(25);
    releaseScan();

    await vi.waitFor(() =>
      expect(scanWorktree).toHaveBeenCalledTimes(initialScanCount + 2),
    );
    expect(maxActiveScans).toBe(1);

    subscription.release();
    manager.dispose();
  });

  it("unions filesystem prefixes while projecting and watching each subscriber's coverage", async () => {
    const projectId = "project-expanded-prefixes" as UrlProjectId;
    await mkdir(join(projectPath, "notes"));
    await writeFile(join(projectPath, "notes", "todo.txt"), "todo\n");
    const watchers = new Map<string, FakeWatcher[]>();
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-expanded-prefixes",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      platform: "linux",
      watchDirectory: (path) => {
        const watcher = new FakeWatcher();
        watchers.set(path, [...(watchers.get(path) ?? []), watcher]);
        return watcher as unknown as fs.FSWatcher;
      },
    });
    const rootEvents: GitWorktreeSubscriptionEvent[] = [];
    const root = manager.subscribe(
      projectId,
      {
        tracked: true,
        untracked: true,
        ignored: false,
        expandedPrefixes: [],
      },
      (event) => rootEvents.push(event),
    );
    await root.ready;

    expect(rootEvents[0]).toMatchObject({
      type: "git-worktree-snapshot",
      files: [],
      directories: [
        { path: "notes", pending: true, truncated: false },
        { path: "src", pending: true, truncated: false },
      ],
    });
    expect(watchers.has(projectPath)).toBe(true);
    expect(watchers.has(join(projectPath, "src"))).toBe(false);

    const srcEvents: GitWorktreeSubscriptionEvent[] = [];
    const src = manager.subscribe(
      projectId,
      {
        tracked: true,
        untracked: true,
        ignored: false,
        expandedPrefixes: ["src"],
      },
      (event) => srcEvents.push(event),
    );
    await src.ready;

    expect(srcEvents[0]).toMatchObject({
      type: "git-worktree-snapshot",
      files: [expect.objectContaining({ path: "src/a.ts" })],
      directories: [
        { path: "notes", pending: true, truncated: false },
        { path: "src", pending: false, truncated: false },
        { path: "src/nested", pending: true, truncated: false },
      ],
    });
    expect(watchers.has(join(projectPath, "src"))).toBe(true);
    expect(watchers.has(join(projectPath, "src", "nested"))).toBe(false);

    const notesEvents: GitWorktreeSubscriptionEvent[] = [];
    const notes = manager.subscribe(
      projectId,
      {
        tracked: true,
        untracked: true,
        ignored: false,
        expandedPrefixes: ["notes"],
      },
      (event) => notesEvents.push(event),
    );
    await notes.ready;

    expect(notesEvents[0]).toMatchObject({
      type: "git-worktree-snapshot",
      files: [expect.objectContaining({ path: "notes/todo.txt" })],
      directories: [
        { path: "notes", pending: false, truncated: false },
        { path: "src", pending: true, truncated: false },
      ],
    });
    expect(
      notesEvents[0]?.type === "git-worktree-snapshot" &&
        notesEvents[0].files.some((entry) => entry.path === "src/a.ts"),
    ).toBe(false);
    expect(watchers.has(join(projectPath, "notes"))).toBe(true);

    src.release();
    await vi.waitFor(() => {
      expect(
        watchers
          .get(join(projectPath, "src"))
          ?.every((watcher) => watcher.closed),
      ).toBe(true);
    });
    expect(
      watchers
        .get(join(projectPath, "notes"))
        ?.some((watcher) => !watcher.closed),
    ).toBe(true);
    expect(rootEvents.at(-1)).toMatchObject({
      type: "git-worktree-delta",
      changes: [],
      directoryChanges: [],
    });

    notes.release();
    root.release();
    manager.dispose();
  });

  it("reports truncation when a Git projection reaches the manager bound", async () => {
    const projectId = "project-bounded-git-projection" as UrlProjectId;
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-bounded-git-projection",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      fileLimit: 2,
      watchDirectory: () => new FakeWatcher() as unknown as fs.FSWatcher,
      scanWorktree: vi.fn(async () => ({
        headSha: "head-a",
        baseSha: "base-a",
        files: mapFiles([
          file("a.txt", "tracked"),
          file("b.txt", "tracked"),
          file("c.txt", "tracked"),
        ]),
      })),
    });
    const events: GitWorktreeSubscriptionEvent[] = [];
    const subscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: false, ignored: false },
      (event) => events.push(event),
    );

    await subscription.ready;
    expect(events[0]).toMatchObject({
      type: "git-worktree-snapshot",
      files: [file("a.txt", "tracked"), file("b.txt", "tracked")],
      truncated: true,
    });

    subscription.release();
    manager.dispose();
  });

  it("keeps bounded subscribers bounded beside a complete filesystem subscriber", async () => {
    const projectId = "project-complete-filesystem-scan" as UrlProjectId;
    const watchListeners = new Map<
      string,
      (eventType: string, filename: Buffer | string | null) => void
    >();
    let currentFiles = [
      file("a.txt", "untracked"),
      file("b.txt", "untracked"),
      file("c.txt", "untracked"),
    ];
    const scanWorktree = vi.fn(
      async (_path: string, _coverage: GitWorktreeCoverage) => ({
        headSha: null,
        baseSha: null,
        files: mapFiles(currentFiles),
        totalFiles: currentFiles.length,
        directories: new Set([""]),
        directoryRows: new Map<string, GitWorktreeDirectory>([
          [
            "",
            {
              path: "",
              pending: false,
              truncated: false,
              totalFiles: currentFiles.length,
            },
          ],
        ]),
      }),
    );
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-complete-filesystem-scan",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      fileLimit: 2,
      debounceMs: 25,
      platform: "linux",
      watchDirectory: (path, listener) => {
        watchListeners.set(path, listener);
        return new FakeWatcher() as unknown as fs.FSWatcher;
      },
      scanWorktree,
    });
    const boundedEvents: GitWorktreeSubscriptionEvent[] = [];
    const bounded = manager.subscribe(
      projectId,
      {
        tracked: true,
        untracked: true,
        ignored: false,
        expandedPrefixes: [],
      },
      (event) => boundedEvents.push(event),
    );
    await bounded.ready;
    expect(boundedEvents[0]).toMatchObject({
      type: "git-worktree-snapshot",
      files: [file("a.txt", "untracked"), file("b.txt", "untracked")],
      truncated: true,
      totalFiles: 3,
    });

    const hiddenEvents: GitWorktreeSubscriptionEvent[] = [];
    const hidden = manager.subscribe(
      projectId,
      {
        tracked: true,
        untracked: false,
        ignored: false,
        expandedPrefixes: [],
      },
      (event) => hiddenEvents.push(event),
    );
    await hidden.ready;
    expect(hiddenEvents[0]).toMatchObject({
      type: "git-worktree-snapshot",
      files: [],
      truncated: false,
      totalFiles: 0,
    });

    const completeEvents: GitWorktreeSubscriptionEvent[] = [];
    const complete = manager.subscribe(
      projectId,
      {
        tracked: true,
        untracked: true,
        ignored: false,
        expandedPrefixes: [],
        filesystemScan: "complete",
      },
      (event) => completeEvents.push(event),
    );
    await complete.ready;
    expect(completeEvents[0]).toMatchObject({
      type: "git-worktree-snapshot",
      files: currentFiles,
      truncated: false,
      totalFiles: 3,
    });
    expect(boundedEvents[0]).toMatchObject({
      files: [file("a.txt", "untracked"), file("b.txt", "untracked")],
    });

    currentFiles = [file("0.txt", "untracked"), ...currentFiles];
    watchListeners.get(projectPath)?.("rename", "0.txt");
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => {
      expect(boundedEvents.at(-1)).toMatchObject({
        type: "git-worktree-delta",
        changes: [
          { changeType: "create", path: "0.txt" },
          { changeType: "delete", path: "b.txt" },
        ],
        truncated: true,
        totalFiles: 4,
      });
      expect(completeEvents.at(-1)).toMatchObject({
        type: "git-worktree-delta",
        changes: [{ changeType: "create", path: "0.txt" }],
        truncated: false,
        totalFiles: 4,
      });
    });

    complete.release();
    hidden.release();
    bounded.release();
    manager.dispose();
  });

  it("preserves expanded-prefix projections during a compatibility scan", async () => {
    const projectId = "project-mixed-prefix-coverage" as UrlProjectId;
    const rootFile = file("root.txt", "untracked");
    const nestedFile = file("src/a.ts", "untracked");
    const scanWorktree = vi.fn(async (_path, coverage: GitWorktreeCoverage) => {
      if (coverage.expandedPrefixes === undefined) {
        return {
          headSha: null,
          baseSha: null,
          files: mapFiles([rootFile]),
          truncated: true,
          directories: new Set([""]),
        };
      }
      const srcExpanded = coverage.expandedPrefixes.includes("src");
      return {
        headSha: null,
        baseSha: null,
        files: mapFiles(srcExpanded ? [rootFile, nestedFile] : [rootFile]),
        totalFiles: srcExpanded ? 2 : 1,
        directories: new Set(srcExpanded ? ["", "src"] : [""]),
        directoryRows: new Map<string, GitWorktreeDirectory>([
          ["", { path: "", pending: false, truncated: false, totalFiles: 1 }],
          [
            "src",
            {
              path: "src",
              pending: !srcExpanded,
              truncated: false,
              ...(srcExpanded ? { totalFiles: 1 } : {}),
            },
          ],
        ]),
      };
    });
    const watchers = new Map<string, FakeWatcher>();
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-mixed-prefix-coverage",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      platform: "linux",
      watchDirectory: (path) => {
        const watcher = new FakeWatcher();
        watchers.set(path, watcher);
        return watcher as unknown as fs.FSWatcher;
      },
      scanWorktree,
    });
    const rootEvents: GitWorktreeSubscriptionEvent[] = [];
    const root = manager.subscribe(
      projectId,
      {
        tracked: true,
        untracked: true,
        ignored: false,
        expandedPrefixes: [],
      },
      (event) => rootEvents.push(event),
    );
    await root.ready;

    const legacyEvents: GitWorktreeSubscriptionEvent[] = [];
    const legacy = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      (event) => legacyEvents.push(event),
    );
    await legacy.ready;

    expect(legacyEvents[0]).toMatchObject({
      type: "git-worktree-snapshot",
      files: [rootFile],
      truncated: true,
    });
    expect(rootEvents.at(-1)).toMatchObject({
      type: "git-worktree-delta",
      changes: [],
      directoryChanges: [],
    });

    const srcEvents: GitWorktreeSubscriptionEvent[] = [];
    const src = manager.subscribe(
      projectId,
      {
        tracked: true,
        untracked: true,
        ignored: false,
        expandedPrefixes: ["src"],
      },
      (event) => srcEvents.push(event),
    );
    await src.ready;
    expect(srcEvents[0]).toMatchObject({
      type: "git-worktree-snapshot",
      files: [rootFile, nestedFile],
      directories: [
        {
          path: "src",
          pending: false,
          truncated: false,
          totalFiles: 1,
        },
      ],
      totalFiles: 2,
    });
    expect(scanWorktree).toHaveBeenLastCalledWith(
      projectPath,
      expect.objectContaining({ expandedPrefixes: ["src"] }),
    );
    await vi.waitFor(() => {
      expect(watchers.get(join(projectPath, "src"))?.closed).toBe(false);
    });

    root.release();
    src.release();
    await vi.waitFor(() => {
      expect(watchers.get(join(projectPath, "src"))?.closed).toBe(true);
      expect(watchers.get(projectPath)?.closed).toBe(false);
    });
    legacy.release();
    manager.dispose();
  });

  it("streams create, rename, and delete changes for pending directories", async () => {
    const projectId = "project-directory-deltas" as UrlProjectId;
    const watchListeners = new Map<
      string,
      (eventType: string, filename: Buffer | string | null) => void
    >();
    const events: GitWorktreeSubscriptionEvent[] = [];
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-directory-deltas",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      debounceMs: 25,
      platform: "linux",
      watchDirectory: (path, listener) => {
        watchListeners.set(path, listener);
        return new FakeWatcher() as unknown as fs.FSWatcher;
      },
    });
    const subscription = manager.subscribe(
      projectId,
      {
        tracked: true,
        untracked: true,
        ignored: false,
        expandedPrefixes: [],
      },
      (event) => events.push(event),
    );
    await subscription.ready;

    await mkdir(join(projectPath, "docs"));
    watchListeners.get(projectPath)?.("rename", "docs");
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        type: "git-worktree-delta",
        directoryChanges: [
          {
            changeType: "create",
            path: "docs",
            directory: { path: "docs", pending: true, truncated: false },
          },
        ],
      }),
    );

    await rename(join(projectPath, "docs"), join(projectPath, "guides"));
    watchListeners.get(projectPath)?.("rename", "docs");
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        type: "git-worktree-delta",
        directoryChanges: [
          { changeType: "delete", path: "docs" },
          {
            changeType: "create",
            path: "guides",
            directory: { path: "guides", pending: true, truncated: false },
          },
        ],
      }),
    );

    await rm(join(projectPath, "guides"), { recursive: true });
    watchListeners.get(projectPath)?.("rename", "guides");
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        type: "git-worktree-delta",
        directoryChanges: [{ changeType: "delete", path: "guides" }],
      }),
    );

    subscription.release();
    manager.dispose();
  });

  it("publishes a filesystem-only Working Tree outside Git repositories", async () => {
    const projectId = "project-filesystem-only" as UrlProjectId;
    const events: GitWorktreeSubscriptionEvent[] = [];
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-filesystem-only",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      platform: "linux",
      watchDirectory: () => new FakeWatcher() as unknown as fs.FSWatcher,
    });
    const subscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      (event) => events.push(event),
    );

    await subscription.ready;
    expect(events[0]).toMatchObject({
      type: "git-worktree-snapshot",
      headSha: null,
      baseSha: null,
      files: [
        expect.objectContaining({
          path: "src/a.ts",
          tracked: false,
          kind: "untracked",
          present: true,
        }),
      ],
    });
    expect(
      events[0]?.type === "git-worktree-snapshot" &&
        events[0].files.some((entry) => entry.path.startsWith(".git/")),
    ).toBe(false);

    subscription.release();
    manager.dispose();
  });

  it("reconciles index staging and commits through metadata fingerprints", async () => {
    await rm(projectPath, { recursive: true });
    await mkdir(projectPath);
    await runGit(projectPath, ["init"]);
    await runGit(projectPath, ["config", "user.email", "ya-test@example.com"]);
    await runGit(projectPath, ["config", "user.name", "YA Test"]);
    await writeFile(join(projectPath, "base.txt"), "base\n");
    await runGit(projectPath, ["add", "base.txt"]);
    await runGit(projectPath, ["commit", "-m", "Base"]);
    await writeFile(join(projectPath, "pending.txt"), "pending\n");

    const projectId = "project-git-metadata" as UrlProjectId;
    const events: GitWorktreeSubscriptionEvent[] = [];
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-git-metadata",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      fallbackPollMs: 1_000,
      watchDirectory: () => new FakeWatcher() as unknown as fs.FSWatcher,
    });
    const subscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      (event) => events.push(event),
    );

    await subscription.ready;
    expect(events[0]).toMatchObject({
      type: "git-worktree-snapshot",
      files: expect.arrayContaining([
        expect.objectContaining({ path: "pending.txt", kind: "untracked" }),
      ]),
    });

    await runGit(projectPath, ["add", "pending.txt"]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "git-worktree-delta",
          changes: expect.arrayContaining([
            expect.objectContaining({
              path: "pending.txt",
              file: expect.objectContaining({
                kind: "tracked",
                worktreeChanges: expect.arrayContaining([
                  expect.objectContaining({ staged: true }),
                ]),
              }),
            }),
          ]),
        }),
      ),
    );
    const stagedSequence = events.at(-1)?.generation.sequence ?? 0;

    await runGit(projectPath, ["commit", "-m", "Add pending"]);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "git-worktree-delta",
          changes: expect.arrayContaining([
            expect.objectContaining({
              path: "pending.txt",
              file: expect.not.objectContaining({
                worktreeChanges: expect.anything(),
              }),
            }),
          ]),
        }),
      ),
    );
    const committedEvent = events.find(
      (event) =>
        event.type === "git-worktree-delta" &&
        event.changes.some(
          (change) =>
            change.path === "pending.txt" &&
            change.file?.worktreeChanges === undefined,
        ),
    );
    expect(committedEvent?.generation.sequence).toBeGreaterThan(stagedSequence);

    subscription.release();
    manager.dispose();
  });

  it("streams create, modify, and delete deltas from a real repository", async () => {
    vi.useRealTimers();
    await rm(projectPath, { recursive: true });
    await mkdir(projectPath);
    await runGit(projectPath, ["init"]);
    await runGit(projectPath, ["config", "user.email", "ya-test@example.com"]);
    await runGit(projectPath, ["config", "user.name", "YA Test"]);
    await writeFile(join(projectPath, "tracked.txt"), "initial\n");
    await runGit(projectPath, ["add", "tracked.txt"]);
    await runGit(projectPath, ["commit", "-m", "Initial file"]);

    const projectId = "project-live" as UrlProjectId;
    let waiter:
      | {
          afterSequence: number;
          path: string;
          changeType: GitWorktreeDeltaEvent["changes"][number]["changeType"];
          resolve: (event: GitWorktreeDeltaEvent) => void;
        }
      | undefined;
    const manager = new ProjectWorktreeSubscriptionManager({
      scanner: {
        getProject: vi.fn(async () => ({
          id: projectId,
          path: projectPath,
          name: "project-live",
          sessionCount: 0,
          sessionDir: "",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude" as const,
        })),
      },
      debounceMs: 25,
      maxEventAgeMs: 1_000,
      // Exercise the host's supported mode, including polling outside Linux.
      fallbackPollMs: 1_000,
    });
    let sequence = 0;
    const subscription = manager.subscribe(
      projectId,
      { tracked: true, untracked: true, ignored: false },
      (event) => {
        sequence = event.generation.sequence;
        if (
          event.type === "git-worktree-delta" &&
          waiter &&
          event.generation.sequence > waiter.afterSequence &&
          event.changes.some(
            (change) =>
              change.path === waiter?.path &&
              change.changeType === waiter?.changeType,
          )
        ) {
          waiter.resolve(event);
        }
      },
    );
    const waitForDelta = async (
      path: string,
      changeType: GitWorktreeDeltaEvent["changes"][number]["changeType"],
      action: () => Promise<void>,
    ): Promise<GitWorktreeDeltaEvent> => {
      const afterSequence = sequence;
      const event = new Promise<GitWorktreeDeltaEvent>((resolve) => {
        waiter = { afterSequence, path, changeType, resolve };
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await action();
        return await Promise.race([
          event,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`${changeType} delta timeout`)),
              5_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
        waiter = undefined;
      }
    };

    try {
      await subscription.ready;
      const probePath = join(projectPath, "probe.txt");
      await waitForDelta("probe.txt", "create", () =>
        writeFile(probePath, "created\n"),
      );
      // Polling sees Git status changes. Linux also sees edits that keep an
      // untracked file's status unchanged through its native watcher.
      const edited = process.platform === "linux" ? "probe.txt" : "tracked.txt";
      await waitForDelta(edited, "modify", () =>
        writeFile(join(projectPath, edited), "modified\n"),
      );
      await waitForDelta("probe.txt", "delete", () => rm(probePath));
    } finally {
      subscription.release();
      manager.dispose();
    }
  }, 20_000);
});
