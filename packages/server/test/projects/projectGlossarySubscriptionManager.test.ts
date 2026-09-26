import { statSync, type Stats, writeFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GlossaryPathChangedEvent,
  type GlossaryPathsSnapshotEvent,
  type GlossarySubscriptionEvent,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlossaryPathObservation } from "../../src/projects/glossaryIndexService.js";
import {
  ProjectGlossarySubscriptionManager,
  type ProjectGlossarySubscriptionManagerOptions,
} from "../../src/projects/projectGlossarySubscriptionManager.js";
import type { ProjectPathIndex } from "../../src/projects/projectPathIndex.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import type { Project } from "../../src/supervisor/types.js";

const temporaryDirectories: string[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function observedIdentity(path: string): GlossaryPathObservation["identity"] {
  try {
    const fileStats = statSync(path);
    return {
      ctimeMs: fileStats.ctimeMs,
      dev: fileStats.dev,
      ino: fileStats.ino,
      mtimeMs: fileStats.mtimeMs,
      size: fileStats.size,
    };
  } catch {
    return null;
  }
}

/**
 * Stand in for the resolver's observation set: tests observe the candidates a
 * source context would have named, and each new one notifies the manager the
 * way `GlossaryIndexService.observePaths` does.
 */
async function createHarness(
  options: {
    debounceMs?: number;
    getPathIndex?: (projectPath: string) => Promise<ProjectPathIndex>;
    maxRetainedProjects?: number;
    pollMs?: number;
    statPath?: ProjectGlossarySubscriptionManagerOptions["statPath"];
    onActivationSettling?: ProjectGlossarySubscriptionManagerOptions["onActivationSettling"];
  } = {},
) {
  const projectPath = await realpath(
    await mkdtemp(join(tmpdir(), "ya-glossary-watch-")),
  );
  temporaryDirectories.push(projectPath);
  const projectId = toUrlProjectId(projectPath);
  const project: Project = {
    id: projectId,
    path: projectPath,
    name: "glossary-watch",
    sessionCount: 0,
    sessionDir: join(projectPath, ".sessions"),
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
  const scanner = {
    getProject: vi.fn(async (id: string) =>
      id === projectId ? project : null,
    ),
  } as unknown as ProjectScanner;
  const invalidateProject = vi.fn();
  const observations = new Map<string, GlossaryPathObservation["identity"]>();
  const observationListeners = new Set<(projectRoot: string) => void>();
  const glossaryIndexService: ProjectGlossarySubscriptionManagerOptions["glossaryIndexService"] =
    {
      getObservedGlossaryPaths: vi.fn(() =>
        [...observations.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([path, identity]) => ({ identity, path })),
      ),
      invalidateProject,
      onObservationsChanged: vi.fn((listener) => {
        observationListeners.add(listener);
        return () => {
          observationListeners.delete(listener);
        };
      }),
    };
  // Stands in for the shared path cache. The subscription only holds the
  // claim — it never reads through it — so counting live claims is the whole
  // contract under test.
  const pathIndexClaims = { held: 0, taken: 0 };
  const defaultGetPathIndex = vi.fn(async () => {
    pathIndexClaims.held += 1;
    pathIndexClaims.taken += 1;
    let released = false;
    return {
      findExisting: async () => new Set<string>(),
      has: async () => false,
      knownFile: () => false,
      sourceRevision: () => 1,
      release: () => {
        if (released) return;
        released = true;
        pathIndexClaims.held -= 1;
      },
    };
  });
  const getPathIndex = options.getPathIndex ?? defaultGetPathIndex;
  const manager = new ProjectGlossarySubscriptionManager({
    scanner,
    glossaryIndexService,
    debounceMs: options.debounceMs ?? 25,
    pollMs: options.pollMs ?? 600_000,
    getPathIndex,
    ...(options.maxRetainedProjects !== undefined
      ? { maxRetainedProjects: options.maxRetainedProjects }
      : {}),
    ...(options.statPath ? { statPath: options.statPath } : {}),
    ...(options.onActivationSettling
      ? { onActivationSettling: options.onActivationSettling }
      : {}),
  });
  return {
    getPathIndex,
    glossaryIndexService,
    invalidateProject,
    manager,
    pathIndexClaims,
    observePath: (
      path: string,
      identity = observedIdentity(join(projectPath, path)),
    ) => {
      if (observations.has(path)) return;
      observations.set(path, identity);
      for (const listener of observationListeners) listener(projectPath);
    },
    projectId,
    projectPath,
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function changeEvents(
  events: readonly GlossarySubscriptionEvent[],
): GlossaryPathChangedEvent[] {
  return events.filter(
    (event): event is GlossaryPathChangedEvent =>
      event.type === "glossary-path-changed",
  );
}

function claimedPathIndex() {
  const release = vi.fn();
  const index: ProjectPathIndex = {
    findExisting: async () => new Set<string>(),
    has: async () => false,
    knownFile: () => false,
    release,
    sourceRevision: () => 1,
  };
  return { index, release };
}

async function subscribeReady(
  manager: ProjectGlossarySubscriptionManager,
  projectId: ReturnType<typeof toUrlProjectId>,
  listener: (event: GlossarySubscriptionEvent) => void,
): Promise<() => void> {
  const subscription = manager.subscribe(projectId, listener);
  await subscription.ready;
  return subscription.release;
}

afterEach(async () => {
  // vi.spyOn returns the existing spy for an already-spied method, so an
  // unrestored timer spy would carry one test's calls into the next.
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("ProjectGlossarySubscriptionManager", () => {
  it("sends observed glossary paths first and reports later changes", async () => {
    const { manager, projectId, projectPath, invalidateProject, observePath } =
      await createHarness({ pollMs: 1_000 });
    await mkdir(join(projectPath, "papers"));
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    await writeFile(join(projectPath, "papers", "GLOSSARY.md"), "paper");
    observePath("GLOSSARY.md");
    observePath("papers/GLOSSARY.md");
    const events: GlossarySubscriptionEvent[] = [];

    const unsubscribe = await subscribeReady(manager, projectId, (event) => {
      events.push(event);
    });

    expect(events[0]).toMatchObject({
      type: "glossary-paths-snapshot",
      paths: ["GLOSSARY.md", "papers/GLOSSARY.md"],
    } satisfies Partial<GlossaryPathsSnapshotEvent>);
    expect(manager.diagnostics().watchedDirectories).toBe(2);

    await writeFile(join(projectPath, "papers", "GLOSSARY.md"), "revised");
    await waitFor(
      () => changeEvents(events).length > 0,
      "Expected glossary modification event",
    );

    const change = changeEvents(events)[0];
    expect(change).toMatchObject({
      changeType: "modify",
      path: "papers/GLOSSARY.md",
    });
    expect(change?.generation.sequence).toBe(1);
    expect(invalidateProject).toHaveBeenCalledWith(projectPath);

    unsubscribe();
    expect(manager.diagnostics()).toEqual({
      activeProjects: 0,
      retainedProjects: 1,
      subscribers: 0,
      watchedDirectories: 0,
    });
    manager.dispose();
  });

  it("watches only directories holding an observed candidate", async () => {
    const { manager, observePath, projectId, projectPath } =
      await createHarness();
    await mkdir(join(projectPath, "unqueried"));
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    await writeFile(join(projectPath, "unqueried", "GLOSSARY.md"), "unqueried");
    observePath("GLOSSARY.md");
    const events: GlossarySubscriptionEvent[] = [];

    const unsubscribe = await subscribeReady(manager, projectId, (event) => {
      events.push(event);
    });

    expect(events[0]).toMatchObject({
      type: "glossary-paths-snapshot",
      paths: ["GLOSSARY.md"],
    } satisfies Partial<GlossaryPathsSnapshotEvent>);
    expect(manager.diagnostics().watchedDirectories).toBe(1);

    await writeFile(join(projectPath, "unqueried", "GLOSSARY.md"), "edited");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(changeEvents(events)).toEqual([]);

    unsubscribe();
    manager.dispose();
  });

  it("detects a nearer glossary created in an observed directory", async () => {
    const { manager, observePath, projectId, projectPath } =
      await createHarness({ pollMs: 1_000 });
    await mkdir(join(projectPath, "papers"));
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    // The nearest candidate is missing, so it stays observed for its creation.
    observePath("papers/GLOSSARY.md");
    observePath("GLOSSARY.md");
    const events: GlossarySubscriptionEvent[] = [];
    const unsubscribe = await subscribeReady(manager, projectId, (event) => {
      events.push(event);
    });

    expect(events[0]).toMatchObject({
      type: "glossary-paths-snapshot",
      paths: ["GLOSSARY.md"],
    } satisfies Partial<GlossaryPathsSnapshotEvent>);

    await writeFile(join(projectPath, "papers", "GLOSSARY.md"), "nearer");
    await waitFor(
      () => changeEvents(events).length > 0,
      "Expected nearer glossary creation event",
    );

    expect(changeEvents(events)[0]).toMatchObject({
      changeType: "create",
      path: "papers/GLOSSARY.md",
    });
    unsubscribe();
    manager.dispose();
  });

  it("invalidates an observed absence created before the first scan", async () => {
    const {
      glossaryIndexService,
      invalidateProject,
      manager,
      observePath,
      projectId,
      projectPath,
    } = await createHarness();
    await mkdir(join(projectPath, "papers"));
    await writeFile(join(projectPath, "GLOSSARY.md"), "parent");
    observePath("papers/GLOSSARY.md", null);
    observePath("GLOSSARY.md");
    const resolutionObservations =
      glossaryIndexService.getObservedGlossaryPaths(projectPath);
    vi.mocked(
      glossaryIndexService.getObservedGlossaryPaths,
    ).mockImplementationOnce(() => {
      // Resolution chose the parent while this candidate was absent. It appears
      // after that exact observation but before subscription activation scans.
      writeFileSync(join(projectPath, "papers/GLOSSARY.md"), "nearer");
      return resolutionObservations;
    });
    const events: GlossarySubscriptionEvent[] = [];

    const subscription = manager.subscribe(projectId, (event) => {
      events.push(event);
    });
    await subscription.ready;

    expect(events).toHaveLength(1);
    const activationEvent = events[0];
    expect(activationEvent?.type).toBe("glossary-paths-snapshot");
    if (activationEvent?.type !== "glossary-paths-snapshot") {
      throw new Error("Expected activation snapshot");
    }
    const activationGeneration = activationEvent.generation;
    expect(activationGeneration.epoch).not.toBe("");
    expect(activationEvent).toMatchObject({
      type: "glossary-paths-snapshot",
      generation: { epoch: activationGeneration.epoch, sequence: 1 },
      paths: ["GLOSSARY.md", "papers/GLOSSARY.md"],
    } satisfies Partial<GlossaryPathsSnapshotEvent>);
    expect(invalidateProject).toHaveBeenCalledOnce();
    expect(invalidateProject).toHaveBeenCalledWith(projectPath);

    subscription.release();
    manager.dispose();
  });

  it("watches a directory resolution observes after subscription", async () => {
    const { manager, observePath, projectId, projectPath } =
      await createHarness({ pollMs: 1_000 });
    await mkdir(join(projectPath, "docs"));
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    observePath("GLOSSARY.md");
    const events: GlossarySubscriptionEvent[] = [];
    const unsubscribe = await subscribeReady(manager, projectId, (event) => {
      events.push(event);
    });
    expect(manager.diagnostics().watchedDirectories).toBe(1);

    // The handoff, not the poll, is what makes the new directory watched.
    observePath("docs/GLOSSARY.md");
    await waitFor(
      () => manager.diagnostics().watchedDirectories === 2,
      "Expected the newly observed directory to be watched",
    );

    await writeFile(join(projectPath, "docs", "GLOSSARY.md"), "docs");
    await waitFor(
      () => changeEvents(events).length > 0,
      "Expected creation event from the newly watched directory",
    );
    expect(changeEvents(events)[0]).toMatchObject({
      changeType: "create",
      path: "docs/GLOSSARY.md",
    });

    unsubscribe();
    manager.dispose();
  });

  it("treats an already existing observed candidate as discovery, not creation", async () => {
    const { manager, observePath, projectId, projectPath } =
      await createHarness({ pollMs: 1_000 });
    await mkdir(join(projectPath, "papers"));
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    await writeFile(join(projectPath, "papers", "GLOSSARY.md"), "paper");
    observePath("GLOSSARY.md");
    const events: GlossarySubscriptionEvent[] = [];
    const unsubscribe = await subscribeReady(manager, projectId, (event) => {
      events.push(event);
    });

    observePath("papers/GLOSSARY.md");
    await waitFor(
      () => manager.diagnostics().watchedDirectories === 2,
      "Expected the newly observed directory to be watched",
    );
    // A create event would invalidate every artifact the tab holds, and
    // nothing on disk changed — the path was merely learned about.
    expect(changeEvents(events)).toEqual([]);

    await writeFile(join(projectPath, "papers", "GLOSSARY.md"), "revised");
    await waitFor(
      () => changeEvents(events).length > 0,
      "Expected a later edit to that candidate to report a modification",
    );
    expect(changeEvents(events)[0]).toMatchObject({
      changeType: "modify",
      path: "papers/GLOSSARY.md",
    });

    unsubscribe();
    manager.dispose();
  });

  it("polls as the backstop for a candidate whose directory is unwatchable", async () => {
    const { manager, observePath, projectId, projectPath } =
      await createHarness({ pollMs: 1_000 });
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    observePath("GLOSSARY.md");
    // No `absent` directory exists, so this candidate gets no watch at all.
    observePath("absent/GLOSSARY.md");
    const events: GlossarySubscriptionEvent[] = [];
    const unsubscribe = await subscribeReady(manager, projectId, (event) => {
      events.push(event);
    });
    expect(manager.diagnostics().watchedDirectories).toBe(1);

    await mkdir(join(projectPath, "absent"));
    await writeFile(join(projectPath, "absent", "GLOSSARY.md"), "late");
    await waitFor(
      () => changeEvents(events).length > 0,
      "Expected the poll to report the unwatched candidate's creation",
    );
    expect(changeEvents(events)[0]).toMatchObject({
      changeType: "create",
      path: "absent/GLOSSARY.md",
    });
    // The same refresh retries the attach, so later edits need no poll.
    expect(manager.diagnostics().watchedDirectories).toBe(2);

    unsubscribe();
    manager.dispose();
  });

  it("shares one project state across subscribers and detects offline edits", async () => {
    const { manager, observePath, projectId, projectPath } =
      await createHarness();
    await writeFile(join(projectPath, "GLOSSARY.md"), "one");
    observePath("GLOSSARY.md");
    const firstEvents: GlossarySubscriptionEvent[] = [];
    const secondEvents: GlossarySubscriptionEvent[] = [];

    const unsubscribeFirst = await subscribeReady(
      manager,
      projectId,
      (event) => {
        firstEvents.push(event);
      },
    );
    const unsubscribeSecond = await subscribeReady(
      manager,
      projectId,
      (event) => {
        secondEvents.push(event);
      },
    );
    expect(manager.diagnostics()).toEqual({
      activeProjects: 1,
      retainedProjects: 1,
      subscribers: 2,
      watchedDirectories: 1,
    });
    expect(firstEvents[0]?.type).toBe("glossary-paths-snapshot");
    expect(secondEvents[0]?.type).toBe("glossary-paths-snapshot");

    unsubscribeFirst();
    unsubscribeSecond();
    await writeFile(join(projectPath, "GLOSSARY.md"), "two");

    const resumedEvents: GlossarySubscriptionEvent[] = [];
    const unsubscribeResumed = await subscribeReady(
      manager,
      projectId,
      (event) => {
        resumedEvents.push(event);
      },
    );
    expect(resumedEvents).toHaveLength(1);
    expect(resumedEvents[0]).toMatchObject({
      type: "glossary-paths-snapshot",
      generation: { sequence: 1 },
      paths: ["GLOSSARY.md"],
    });

    unsubscribeResumed();
    manager.dispose();
  });

  it("refreshes pending observations before a joining subscriber snapshot", async () => {
    const {
      glossaryIndexService,
      manager,
      observePath,
      projectId,
      projectPath,
    } = await createHarness();
    await mkdir(join(projectPath, "docs"));
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    await writeFile(join(projectPath, "docs", "GLOSSARY.md"), "docs");
    observePath("GLOSSARY.md");
    const first = manager.subscribe(projectId, () => {});
    await first.ready;
    // A late watcher event for the fixture writes may add activation refreshes
    // under load, so count only the joiner's work.
    const observedBeforeJoin = vi.mocked(
      glossaryIndexService.getObservedGlossaryPaths,
    ).mock.calls.length;

    vi.useFakeTimers();
    let second: ReturnType<typeof manager.subscribe> | null = null;
    try {
      observePath("docs/GLOSSARY.md");
      const secondEvents: GlossarySubscriptionEvent[] = [];
      second = manager.subscribe(projectId, (event) => {
        secondEvents.push(event);
      });
      await second.ready;

      expect(
        vi.mocked(glossaryIndexService.getObservedGlossaryPaths).mock.calls
          .length,
      ).toBeGreaterThan(observedBeforeJoin);
      expect(secondEvents).toHaveLength(1);
      expect(secondEvents[0]).toMatchObject({
        type: "glossary-paths-snapshot",
        paths: ["docs/GLOSSARY.md", "GLOSSARY.md"],
      });
      expect(manager.diagnostics().watchedDirectories).toBe(2);
    } finally {
      second?.release();
      first.release();
      manager.dispose();
      vi.useRealTimers();
    }
  });

  it("shares one post-observation snapshot barrier across concurrent joiners", async () => {
    const olderRefreshStarted = deferred<void>();
    const releaseOlderRefresh = deferred<void>();
    let statCalls = 0;
    const statPath = vi.fn(async (path: string) => {
      statCalls += 1;
      if (statCalls === 2) {
        olderRefreshStarted.resolve(undefined);
        await releaseOlderRefresh.promise;
      }
      return stat(path);
    });
    const {
      glossaryIndexService,
      manager,
      observePath,
      projectId,
      projectPath,
    } = await createHarness({ debounceMs: 1_000, pollMs: 1_000, statPath });
    await mkdir(join(projectPath, "docs"));
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    await writeFile(join(projectPath, "docs/GLOSSARY.md"), "docs");
    observePath("GLOSSARY.md");

    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
    let first: ReturnType<typeof manager.subscribe> | null = null;
    let second: ReturnType<typeof manager.subscribe> | null = null;
    let third: ReturnType<typeof manager.subscribe> | null = null;
    try {
      first = manager.subscribe(projectId, () => {});
      await first.ready;

      // The poll starts an older scan and leaves it blocked after it captured only
      // the root observation.
      await vi.advanceTimersByTimeAsync(1_000);
      await olderRefreshStarted.promise;
      observePath("docs/GLOSSARY.md");

      const secondEvents: GlossarySubscriptionEvent[] = [];
      const thirdEvents: GlossarySubscriptionEvent[] = [];
      second = manager.subscribe(projectId, (event) => {
        secondEvents.push(event);
      });
      third = manager.subscribe(projectId, (event) => {
        thirdEvents.push(event);
      });
      for (
        let attempts = 0;
        manager.diagnostics().subscribers < 3;
        attempts += 1
      ) {
        if (attempts >= 1_000) throw new Error("Subscribers did not attach");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      releaseOlderRefresh.resolve(undefined);
      await Promise.all([second.ready, third.ready]);

      // Both joiners wait for one shared fresh scan after the pending observation;
      // neither may publish the older scan's incomplete snapshot.
      expect(
        glossaryIndexService.getObservedGlossaryPaths,
      ).toHaveBeenCalledTimes(3);
      for (const events of [secondEvents, thirdEvents]) {
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: "glossary-paths-snapshot",
          paths: ["docs/GLOSSARY.md", "GLOSSARY.md"],
        });
      }
      expect(manager.diagnostics().watchedDirectories).toBe(2);
    } finally {
      releaseOlderRefresh.resolve(undefined);
      third?.release();
      second?.release();
      first?.release();
      manager.dispose();
      vi.useRealTimers();
    }
  });

  it("single-flights concurrent first-subscriber activation", async () => {
    const acquisition = deferred<ProjectPathIndex>();
    const getPathIndex = vi.fn(() => acquisition.promise);
    const {
      glossaryIndexService,
      manager,
      observePath,
      projectId,
      projectPath,
    } = await createHarness({ getPathIndex });
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    observePath("GLOSSARY.md");
    const firstEvents: GlossarySubscriptionEvent[] = [];
    const secondEvents: GlossarySubscriptionEvent[] = [];
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const first = manager.subscribe(projectId, (event) => {
      firstEvents.push(event);
    });
    const second = manager.subscribe(projectId, (event) => {
      secondEvents.push(event);
    });
    await waitFor(
      () => getPathIndex.mock.calls.length === 1,
      "Expected one shared path-index acquisition",
    );

    const claim = claimedPathIndex();
    acquisition.resolve(claim.index);
    await Promise.all([first.ready, second.ready]);
    const unsubscribeFirst = first.release;
    const unsubscribeSecond = second.release;

    expect(getPathIndex).toHaveBeenCalledOnce();
    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(
      glossaryIndexService.getObservedGlossaryPaths,
    ).toHaveBeenCalledOnce();
    expect(firstEvents.map((event) => event.type)).toEqual([
      "glossary-paths-snapshot",
    ]);
    expect(secondEvents.map((event) => event.type)).toEqual([
      "glossary-paths-snapshot",
    ]);
    expect(claim.release).not.toHaveBeenCalled();

    unsubscribeFirst();
    expect(claim.release).not.toHaveBeenCalled();
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    unsubscribeSecond();
    expect(claim.release).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    manager.dispose();
    expect(claim.release).toHaveBeenCalledOnce();
  });

  it("cancels before a deferred first claim arrives", async () => {
    const acquisition = deferred<ProjectPathIndex>();
    const getPathIndex = vi.fn(() => acquisition.promise);
    const { manager, observePath, projectId, projectPath } =
      await createHarness({
        getPathIndex,
      });
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    observePath("GLOSSARY.md");
    const listener = vi.fn();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const subscription = manager.subscribe(projectId, listener);
    await waitFor(
      () => getPathIndex.mock.calls.length === 1,
      "Expected path-index acquisition to start",
    );

    subscription.release();
    expect(manager.diagnostics().subscribers).toBe(0);
    const claim = claimedPathIndex();
    acquisition.resolve(claim.index);
    await subscription.ready;

    expect(claim.release).toHaveBeenCalledOnce();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    subscription.release();
    expect(claim.release).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("coalesces observations learned while the first claim is deferred", async () => {
    const acquisition = deferred<ProjectPathIndex>();
    const getPathIndex = vi.fn(() => acquisition.promise);
    const {
      glossaryIndexService,
      manager,
      observePath,
      projectId,
      projectPath,
    } = await createHarness({ getPathIndex });
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    const events: GlossarySubscriptionEvent[] = [];
    const subscription = manager.subscribe(projectId, (event) => {
      events.push(event);
    });
    await waitFor(
      () => getPathIndex.mock.calls.length === 1,
      "Expected path-index acquisition to start",
    );

    observePath("GLOSSARY.md");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      glossaryIndexService.getObservedGlossaryPaths,
    ).not.toHaveBeenCalled();
    expect(manager.diagnostics().watchedDirectories).toBe(0);

    const claim = claimedPathIndex();
    acquisition.resolve(claim.index);
    await subscription.ready;

    expect(
      glossaryIndexService.getObservedGlossaryPaths,
    ).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "glossary-paths-snapshot",
      paths: ["GLOSSARY.md"],
    });
    subscription.release();
    expect(claim.release).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("releases a deferred claim that arrives after manager teardown", async () => {
    const acquisition = deferred<ProjectPathIndex>();
    const getPathIndex = vi.fn(() => acquisition.promise);
    const { manager, observePath, projectId, projectPath } =
      await createHarness({
        getPathIndex,
      });
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    observePath("GLOSSARY.md");
    const listener = vi.fn();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const subscribing = manager.subscribe(projectId, listener);
    await waitFor(
      () => getPathIndex.mock.calls.length === 1,
      "Expected path-index acquisition to start",
    );

    manager.dispose();
    const claim = claimedPathIndex();
    acquisition.resolve(claim.index);
    await subscribing.ready;
    const unsubscribe = subscribing.release;

    expect(claim.release).toHaveBeenCalledOnce();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(manager.diagnostics()).toEqual({
      activeProjects: 0,
      retainedProjects: 0,
      subscribers: 0,
      watchedDirectories: 0,
    });
    unsubscribe();
    unsubscribe();
    expect(claim.release).toHaveBeenCalledOnce();
  });

  it("cancels while the initial refresh is deferred", async () => {
    const statGate = deferred<Stats>();
    const statPath = vi.fn(() => statGate.promise);
    const claim = claimedPathIndex();
    const getPathIndex = vi.fn(async () => claim.index);
    const { manager, observePath, projectId, projectPath } =
      await createHarness({
        getPathIndex,
        statPath,
      });
    const glossaryPath = join(projectPath, "GLOSSARY.md");
    await writeFile(glossaryPath, "root");
    const fileStats = await stat(glossaryPath);
    observePath("GLOSSARY.md");
    const listener = vi.fn();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const subscription = manager.subscribe(projectId, listener);
    await waitFor(
      () => statPath.mock.calls.length === 1,
      "Expected initial refresh to reach stat",
    );

    subscription.release();
    expect(claim.release).toHaveBeenCalledOnce();
    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
    expect(manager.diagnostics()).toMatchObject({
      activeProjects: 0,
      subscribers: 0,
      watchedDirectories: 0,
    });

    statGate.resolve(fileStats);
    await subscription.ready;
    expect(listener).not.toHaveBeenCalled();
    expect(claim.release).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("restarts activation for a replacement after last-subscriber cancellation", async () => {
    const firstStat = deferred<Stats>();
    let statCalls = 0;
    const statPath = vi.fn(async (path: string) => {
      statCalls += 1;
      if (statCalls === 1) return firstStat.promise;
      return stat(path);
    });
    const { manager, observePath, pathIndexClaims, projectId, projectPath } =
      await createHarness({ statPath });
    const glossaryPath = join(projectPath, "GLOSSARY.md");
    await writeFile(glossaryPath, "root");
    const fileStats = await stat(glossaryPath);
    observePath("GLOSSARY.md");
    const firstListener = vi.fn();
    const replacementListener = vi.fn();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const first = manager.subscribe(projectId, firstListener);
    await waitFor(
      () => statPath.mock.calls.length === 1,
      "Expected the first activation to reach stat",
    );
    first.release();
    expect(pathIndexClaims).toEqual({ held: 0, taken: 1 });

    const replacement = manager.subscribe(projectId, replacementListener);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pathIndexClaims.taken).toBe(1);

    firstStat.resolve(fileStats);
    await Promise.all([first.ready, replacement.ready]);

    expect(pathIndexClaims).toEqual({ held: 1, taken: 2 });
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(firstListener).not.toHaveBeenCalled();
    expect(replacementListener).toHaveBeenCalledOnce();
    expect(manager.diagnostics()).toMatchObject({
      activeProjects: 1,
      subscribers: 1,
      watchedDirectories: 1,
    });

    replacement.release();
    expect(pathIndexClaims.held).toBe(0);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    manager.dispose();
  });

  it("drains an observation queued at activation settlement before readiness", async () => {
    let observeAtSettlement: () => void = () => {
      throw new Error("settlement observer not installed");
    };
    let settledOnce = false;
    const harness = await createHarness({
      onActivationSettling: () => {
        if (settledOnce) return;
        settledOnce = true;
        observeAtSettlement();
      },
    });
    const {
      glossaryIndexService,
      manager,
      observePath,
      projectId,
      projectPath,
    } = harness;
    await mkdir(join(projectPath, "docs"));
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    await writeFile(join(projectPath, "docs", "GLOSSARY.md"), "docs");
    observePath("GLOSSARY.md");
    observeAtSettlement = () => observePath("docs/GLOSSARY.md");
    const events: GlossarySubscriptionEvent[] = [];

    const subscription = manager.subscribe(projectId, (event) => {
      events.push(event);
    });
    await subscription.ready;

    expect(settledOnce).toBe(true);
    expect(glossaryIndexService.getObservedGlossaryPaths).toHaveBeenCalledTimes(
      2,
    );
    expect(manager.diagnostics().watchedDirectories).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "glossary-paths-snapshot",
      paths: ["docs/GLOSSARY.md", "GLOSSARY.md"],
    });

    subscription.release();
    manager.dispose();
  });

  it("releases shared activation resources when initial refresh fails", async () => {
    const acquisition = deferred<ProjectPathIndex>();
    const getPathIndex = vi.fn(() => acquisition.promise);
    const {
      glossaryIndexService,
      manager,
      observePath,
      projectId,
      projectPath,
    } = await createHarness({ getPathIndex });
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    observePath("GLOSSARY.md");
    vi.mocked(glossaryIndexService.getObservedGlossaryPaths).mockImplementation(
      () => {
        throw new Error("initial refresh failed");
      },
    );
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const first = manager.subscribe(projectId, () => {});
    const second = manager.subscribe(projectId, () => {});
    const settled = Promise.allSettled([first.ready, second.ready]);
    await waitFor(
      () => getPathIndex.mock.calls.length === 1,
      "Expected one shared path-index acquisition",
    );
    const claim = claimedPathIndex();
    acquisition.resolve(claim.index);
    const results = await settled;

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toEqual(new Error("initial refresh failed"));
      }
    }
    expect(getPathIndex).toHaveBeenCalledOnce();
    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(claim.release).toHaveBeenCalledOnce();
    expect(manager.diagnostics()).toEqual({
      activeProjects: 0,
      retainedProjects: 1,
      subscribers: 0,
      watchedDirectories: 0,
    });
    manager.dispose();
    expect(claim.release).toHaveBeenCalledOnce();
  });

  it("bounds retained projects after repeated activation failures", async () => {
    const projects = new Map<string, Project>();
    for (let index = 0; index < 6; index += 1) {
      const projectPath = await realpath(
        await mkdtemp(join(tmpdir(), "ya-glossary-failure-")),
      );
      temporaryDirectories.push(projectPath);
      const projectId = toUrlProjectId(projectPath);
      projects.set(projectId, {
        id: projectId,
        path: projectPath,
        name: `failure-${index}`,
        sessionCount: 0,
        sessionDir: join(projectPath, ".sessions"),
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
        provider: "claude",
      });
    }
    const scanner = {
      getProject: vi.fn(async (projectId: string) => projects.get(projectId)),
    } as unknown as ProjectScanner;
    const glossaryIndexService: ProjectGlossarySubscriptionManagerOptions["glossaryIndexService"] =
      {
        getObservedGlossaryPaths: vi.fn(() => []),
        invalidateProject: vi.fn(),
        onObservationsChanged: vi.fn(() => () => {}),
      };
    const manager = new ProjectGlossarySubscriptionManager({
      scanner,
      glossaryIndexService,
      maxRetainedProjects: 2,
      getPathIndex: vi.fn(async () => {
        throw new Error("claim failed");
      }),
    });

    for (const projectId of projects.keys()) {
      const subscription = manager.subscribe(
        projectId as ReturnType<typeof toUrlProjectId>,
        () => {},
      );
      await expect(subscription.ready).rejects.toThrow("claim failed");
      expect(manager.diagnostics().retainedProjects).toBeLessThanOrEqual(2);
    }

    expect(manager.diagnostics()).toMatchObject({
      activeProjects: 0,
      retainedProjects: 2,
      subscribers: 0,
      watchedDirectories: 0,
    });
    manager.dispose();
  });

  it("holds one path-cache claim for as long as the project is subscribed", async () => {
    const { manager, observePath, pathIndexClaims, projectId, projectPath } =
      await createHarness();
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    observePath("GLOSSARY.md");
    expect(pathIndexClaims).toEqual({ held: 0, taken: 0 });

    const unsubscribeFirst = await subscribeReady(manager, projectId, () => {});
    const unsubscribeSecond = await subscribeReady(
      manager,
      projectId,
      () => {},
    );
    // Resolution hydrated these directories through the shared cache; the claim
    // is what keeps them from being evicted between two artifact requests. A
    // second tab shares the project's one claim rather than taking another.
    expect(pathIndexClaims).toEqual({ held: 1, taken: 1 });

    unsubscribeFirst();
    expect(pathIndexClaims.held).toBe(1);

    // The last subscriber leaving makes the project evictable again, so an
    // unwatched project cannot pin cached paths indefinitely.
    unsubscribeSecond();
    expect(pathIndexClaims.held).toBe(0);

    const unsubscribeResumed = await subscribeReady(
      manager,
      projectId,
      () => {},
    );
    expect(pathIndexClaims).toEqual({ held: 1, taken: 2 });

    unsubscribeResumed();
    manager.dispose();
    expect(pathIndexClaims.held).toBe(0);
  });
});
