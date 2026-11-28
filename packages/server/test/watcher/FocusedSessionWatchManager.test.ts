import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../src/supervisor/types.js";
import {
  type FocusedSessionWatchEvent,
  FocusedSessionWatchManager,
} from "../../src/watcher/FocusedSessionWatchManager.js";

import * as sharedWatches from "../../src/watcher/SharedDirectoryWatcher.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForChange(
  collector: FocusedSessionWatchEvent[],
  timeoutMs = 3000,
): Promise<FocusedSessionWatchEvent> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      const first = collector[0];
      if (first) {
        clearInterval(interval);
        resolve(first);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error("Timed out waiting for focused watch change event"));
      }
    }, 25);
  });
}

describe("FocusedSessionWatchManager", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map(async (dir) => {
        try {
          await rm(dir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }),
    );
    tempDirs.length = 0;
  });

  it("checks on the leading edge and keeps a trailing validation", () => {
    vi.useFakeTimers();
    try {
      const manager = new FocusedSessionWatchManager({
        scanner: {
          getProject: async () => null,
          getOrCreateProject: async () => null,
        },
        codexScanner: {
          getSessionsForProject: async () => [],
        },
        geminiScanner: {
          getSessionsForProject: async () => [],
        },
        debounceMs: 200,
      });
      const internals = manager as unknown as {
        createTarget(request: {
          sessionId: string;
          projectId: UrlProjectId;
        }): unknown;
        requestCheck(target: unknown, source: "fs-watch" | "poll"): void;
        scheduleDebouncedCheck(
          target: unknown,
          source: "fs-watch" | "poll",
        ): void;
        checkForChanges(
          target: unknown,
          request: {
            source: "fs-watch" | "poll";
            sourceObservedAtMs: number;
          },
        ): Promise<void>;
      };
      const target = internals.createTarget({
        sessionId: "session-leading",
        projectId: "project-leading" as UrlProjectId,
      }) as {
        subscribers: Map<number, (event: FocusedSessionWatchEvent) => void>;
      };
      target.subscribers.set(1, vi.fn());
      const check = vi.spyOn(internals, "checkForChanges").mockResolvedValue();

      internals.requestCheck(target, "fs-watch");
      internals.scheduleDebouncedCheck(target, "fs-watch");

      expect(check).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(199);
      expect(check).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(check).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["claude", "claude-gateway"] as const)(
    "emits change events for a watched %s session file",
    async (provider) => {
      const root = await mkdtemp(join(tmpdir(), "focused-watch-claude-"));
      tempDirs.push(root);
      const sessionDir = join(root, "projects", "demo");
      await mkdir(sessionDir, { recursive: true });

      const sessionId = "session-claude-1";
      const filePath = join(sessionDir, `${sessionId}.jsonl`);
      await writeFile(filePath, '{"type":"user","message":"hello"}\n');

      const projectId = "L3RtcC9kZW1v" as UrlProjectId;
      const project: Project = {
        id: projectId,
        path: "/tmp/demo",
        name: "demo",
        sessionCount: 1,
        sessionDir,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider,
      };

      const manager = new FocusedSessionWatchManager({
        scanner: {
          getProject: async () => project,
          getOrCreateProject: async () => project,
        },
        codexScanner: {
          getSessionsForProject: async () => [],
        },
        geminiScanner: {
          getSessionsForProject: async () => [],
        },
        pollMs: 100,
        debounceMs: 30,
      });

      const events: FocusedSessionWatchEvent[] = [];
      const unsubscribe = manager.subscribe({ sessionId, projectId }, (event) =>
        events.push(event),
      );

      await delay(250);
      await appendFile(filePath, '{"type":"assistant","message":"world"}\n');

      const event = await waitForChange(events);
      expect(event.type).toBe("session-watch-change");
      expect(event.sessionId).toBe(sessionId);
      expect(event.projectId).toBe(projectId);
      expect(event.provider).toBe("claude");
      expect(event.path).toBe(filePath);
      expect(event.changeVersion).toBeGreaterThan(0);
      expect(event.sourceObservedAt).toEqual(expect.any(String));
      expect(event.mtimeMs).toEqual(expect.any(Number));
      expect(event.size).toBeGreaterThan(0);

      unsubscribe();
      manager.dispose();
    },
  );

  it("shares one directory watcher across focused session targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "focused-watch-shared-"));
    tempDirs.push(root);
    const sessionDir = join(root, "projects", "demo");
    await mkdir(sessionDir, { recursive: true });
    const sessionIds = ["session-shared-1", "session-shared-2"] as const;
    const filePaths = [
      join(sessionDir, `${sessionIds[0]}.jsonl`),
      join(sessionDir, `${sessionIds[1]}.jsonl`),
    ] as const;
    await Promise.all(
      filePaths.map((filePath) =>
        writeFile(filePath, '{"type":"user","message":"hello"}\n'),
      ),
    );

    const projectId = "L3RtcC9kZW1vLXNoYXJlZA" as UrlProjectId;
    const project: Project = {
      id: projectId,
      path: "/tmp/demo-shared",
      name: "demo-shared",
      sessionCount: 2,
      sessionDir,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "claude",
    };
    const manager = new FocusedSessionWatchManager({
      scanner: {
        getProject: async () => project,
        getOrCreateProject: async () => project,
      },
      codexScanner: { getSessionsForProject: async () => [] },
      geminiScanner: { getSessionsForProject: async () => [] },
      pollMs: 100,
      debounceMs: 30,
    });
    const firstEvents: FocusedSessionWatchEvent[] = [];
    const secondEvents: FocusedSessionWatchEvent[] = [];
    const unsubscribeFirst = manager.subscribe(
      { sessionId: sessionIds[0], projectId },
      (event) => firstEvents.push(event),
    );
    const unsubscribeSecond = manager.subscribe(
      { sessionId: sessionIds[1], projectId },
      (event) => secondEvents.push(event),
    );
    const directoryWatches = (
      manager as unknown as {
        directoryWatches: Map<string, { targets: Set<unknown> }>;
      }
    ).directoryWatches;

    await vi.waitFor(() => {
      expect(directoryWatches.size).toBe(1);
      expect(directoryWatches.get(sessionDir)?.targets.size).toBe(2);
    });

    await appendFile(filePaths[0], '{"type":"assistant","message":"world"}\n');
    const event = await waitForChange(firstEvents);
    expect(event.sessionId).toBe(sessionIds[0]);
    await delay(150);
    expect(secondEvents).toEqual([]);

    unsubscribeFirst();
    expect(directoryWatches.get(sessionDir)?.targets.size).toBe(1);
    unsubscribeSecond();
    expect(directoryWatches.size).toBe(0);
    manager.dispose();
  });

  it("checks writes during attachment and lets a new viewer recover a failed directory watch", async () => {
    const root = await mkdtemp(join(tmpdir(), "focused-recover-"));
    tempDirs.push(root);
    for (const name of ["a", "b"]) await writeFile(join(root, name), "initial");
    const handles: EventEmitter[] = [];
    const factory = vi
      .spyOn(sharedWatches, "watchSharedDirectory")
      .mockImplementation((_dir, _options, listener) => {
        const handle = Object.assign(new EventEmitter(), { close: vi.fn() });
        handles.push(handle.on("change", listener));
        return handle as unknown as FSWatcher;
      });
    const manager = new FocusedSessionWatchManager({
      scanner: {
        getProject: async () => null,
        getOrCreateProject: async () => null,
      },
      codexScanner: { getSessionsForProject: async () => [] },
      geminiScanner: { getSessionsForProject: async () => [] },
      resolveStoredSessionFile: async ({ sessionId }) => ({
        filePath: join(root, sessionId),
        provider: "claude",
      }),
      // Only the native signal can pass this check within the test deadline.
      pollMs: 60_000,
      debounceMs: 60_000,
    });
    const projectId = "project" as UrlProjectId;
    const changed = vi.fn();
    try {
      manager.subscribe({ sessionId: "a", projectId }, changed);
      await vi.waitFor(() => expect(handles).toHaveLength(1));
      await appendFile(join(root, "a"), "during attachment");
      handles[0]?.emit("change", "rename", null);
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
      handles[0]?.emit("error", new Error("injected watch loss"));
      manager.subscribe({ sessionId: "b", projectId }, vi.fn());
      await vi.waitFor(() => expect(handles).toHaveLength(2));
      await appendFile(join(root, "a"), "after recovery");
      handles[1]?.emit("change", "change", "a");
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    } finally {
      manager.dispose();
      factory.mockRestore();
    }
  });

  it("does not attach a watcher after the last subscriber leaves", async () => {
    const root = await mkdtemp(join(tmpdir(), "focused-watch-cancelled-"));
    tempDirs.push(root);
    const sessionDir = join(root, "projects", "demo");
    await mkdir(sessionDir, { recursive: true });
    const sessionId = "session-cancelled";
    await writeFile(
      join(sessionDir, `${sessionId}.jsonl`),
      '{"type":"user","message":"hello"}\n',
    );
    const projectId = "L3RtcC9kZW1vLWNhbmNlbGxlZA" as UrlProjectId;
    const project: Project = {
      id: projectId,
      path: "/tmp/demo-cancelled",
      name: "demo-cancelled",
      sessionCount: 1,
      sessionDir,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "claude",
    };
    let releaseProject: ((project: Project) => void) | undefined;
    const projectPromise = new Promise<Project>((resolve) => {
      releaseProject = resolve;
    });
    const manager = new FocusedSessionWatchManager({
      scanner: {
        getProject: async () => await projectPromise,
        getOrCreateProject: async () => project,
      },
      codexScanner: { getSessionsForProject: async () => [] },
      geminiScanner: { getSessionsForProject: async () => [] },
    });
    const internals = manager as unknown as {
      directoryWatches: Map<string, unknown>;
      targets: Map<string, unknown>;
    };

    const unsubscribe = manager.subscribe({ sessionId, projectId }, () => {});
    unsubscribe();
    releaseProject?.(project);
    await delay(25);

    expect(internals.targets.size).toBe(0);
    expect(internals.directoryWatches.size).toBe(0);
    manager.dispose();
  });

  it("uses providerHint=codex to resolve codex session files", async () => {
    const root = await mkdtemp(join(tmpdir(), "focused-watch-codex-"));
    tempDirs.push(root);
    const codexDir = join(root, "codex", "sessions", "2026", "02", "18");
    await mkdir(codexDir, { recursive: true });

    const sessionId = "7e0cd95f-8f16-4a8d-b96f-938b3ca42ad8";
    const filePath = join(
      codexDir,
      `rollout-2026-02-18T00-00-00-${sessionId}.jsonl`,
    );
    await writeFile(filePath, '{"type":"session_meta","payload":{"id":"x"}}\n');

    const projectId = "L3RtcC9kZW1vLWNvZGV4" as UrlProjectId;
    const project: Project = {
      id: projectId,
      path: "/tmp/demo-codex",
      name: "demo-codex",
      sessionCount: 1,
      sessionDir: join(root, "projects", "unused"),
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "claude",
    };

    const codexScanner = {
      getSessionsForProject: vi
        .fn<() => Promise<Array<{ id: string; filePath: string }>>>()
        .mockResolvedValue([{ id: sessionId, filePath }]),
    };

    const manager = new FocusedSessionWatchManager({
      scanner: {
        getProject: async () => project,
        getOrCreateProject: async () => project,
      },
      codexScanner,
      geminiScanner: {
        getSessionsForProject: async () => [],
      },
      pollMs: 100,
      debounceMs: 30,
    });

    const events: FocusedSessionWatchEvent[] = [];
    const unsubscribe = manager.subscribe(
      { sessionId, projectId, providerHint: "codex" },
      (event) => events.push(event),
    );

    await delay(250);
    await appendFile(
      filePath,
      '{"type":"response_item","payload":{"ok":true}}\n',
    );

    const event = await waitForChange(events);
    expect(event.provider).toBe("codex");
    expect(event.path).toBe(filePath);
    expect(codexScanner.getSessionsForProject).toHaveBeenCalledWith(
      project.path,
    );

    unsubscribe();
    manager.dispose();
  });
});
