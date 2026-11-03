import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectMetadataService } from "../../src/metadata/ProjectMetadataService.js";
import { CodexSessionScanner } from "../../src/projects/codex-scanner.js";
import { GeminiSessionScanner } from "../../src/projects/gemini-scanner.js";
import { ProjectScanner } from "../../src/projects/scanner.js";
import { encodeProjectId, type Project } from "../../src/supervisor/types.js";
import { EventBus } from "../../src/watcher/EventBus.js";

function encodePath(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

async function createClaudeProject(
  projectsDir: string,
  host: string,
  projectPath: string,
  sessionId: string,
): Promise<string> {
  const encodedPath = encodePath(projectPath);
  const sessionDir = join(projectsDir, host, encodedPath);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: "user", cwd: projectPath, message: { content: "hello" } })}\n`,
  );
  return join(host, encodedPath).replace(/\\/g, "/");
}

describe("ProjectScanner missing projectsDir", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("still discovers Codex sessions when ~/.claude/projects is missing", async () => {
    const nonExistentDir = join(
      tmpdir(),
      `project-scanner-missing-${randomUUID()}`,
    );
    // Don't create it — it should not exist

    const codexDir = join(tmpdir(), `codex-sessions-${randomUUID()}`);
    tempDirs.push(codexDir);
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, "rollout-test.jsonl"),
      `{"type":"session_meta","payload":{"id":"test-session","cwd":"/home/user/codex-project","timestamp":"2025-01-01T00:00:00Z"}}\n`,
    );

    const scanner = new ProjectScanner({
      projectsDir: nonExistentDir,
      codexSessionsDir: codexDir,
      enableCodex: true,
      enableGemini: false,
    });

    const projects = await scanner.listProjects();
    // Should find at least the Codex session (possibly plus a home fallback)
    const codexProjects = projects.filter((p) => p.provider === "codex");
    expect(codexProjects.length).toBeGreaterThanOrEqual(1);
  });
});

describe("ProjectScanner cache", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("reuses snapshot results until invalidated", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 60000,
    });

    const first = await scanner.listProjects();
    expect(first).toHaveLength(1);

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-two",
      "sess-2",
    );

    const cached = await scanner.listProjects();
    expect(cached).toHaveLength(1);

    scanner.invalidateCache();
    const refreshed = await scanner.listProjects();
    expect(refreshed).toHaveLength(2);
  });

  it("resolves a known project without refreshing stale aggregates", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);
    const projectPath = "/home/user/project-one";

    await createClaudeProject(projectsDir, "localhost", projectPath, "sess-1");

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 60000,
    });
    await scanner.listProjects();

    const scanSpy = vi.spyOn(
      scanner as unknown as {
        getProjectDirInfo: (projectDirPath: string) => Promise<unknown>;
      },
      "getProjectDirInfo",
    );
    scanner.invalidateCache();

    await expect(
      scanner.getProject(encodeProjectId(projectPath), {
        allowStaleSnapshot: true,
      }),
    ).resolves.toMatchObject({ path: projectPath });
    expect(scanSpy).not.toHaveBeenCalled();

    await scanner.getProject(encodeProjectId(projectPath));
    expect(scanSpy).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent scans into one in-flight refresh", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 0,
    });

    const spy = vi.spyOn(
      scanner as unknown as {
        getProjectDirInfo: (projectDirPath: string) => Promise<unknown>;
      },
      "getProjectDirInfo",
    );

    await Promise.all([
      scanner.listProjects(),
      scanner.listProjects(),
      scanner.listProjects(),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("acquires independent provider inputs while Claude discovery is pending", async () => {
    const projectsDir = join(tmpdir(), `parallel-discovery-${randomUUID()}`);
    tempDirs.push(projectsDir);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const codexScanner = new CodexSessionScanner({
      sessionsDir: join(projectsDir, "codex"),
    });
    const codexRead = vi.spyOn(codexScanner, "listProjects");
    const scanner = new ProjectScanner({
      projectsDir,
      codexScanner,
      enableGemini: false,
    });
    const internals = scanner as unknown as {
      readClaudeDirectories: () => Promise<Map<string, unknown>>;
    };
    const readClaude = internals.readClaudeDirectories.bind(scanner);
    vi.spyOn(internals, "readClaudeDirectories").mockImplementationOnce(
      async () => {
        started();
        await gate;
        return readClaude();
      },
    );
    const result = scanner.listProjects();
    try {
      await entered;
      expect(codexRead).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await result;
      await scanner.dispose();
    }
  });

  it.each(["localhost", ""])(
    "refreshes only the changed Claude directory under %s",
    async (host) => {
      const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
      tempDirs.push(projectsDir);
      const eventBus = new EventBus();
      const first = await createClaudeProject(
        projectsDir,
        host,
        "/home/user/one",
        "one",
      );
      await createClaudeProject(projectsDir, host, "/home/user/two", "two");
      const scanner = new ProjectScanner({
        projectsDir,
        enableCodex: false,
        enableGemini: false,
        eventBus,
      });
      try {
        await scanner.listProjects();
        const read = vi.spyOn(
          scanner as unknown as {
            getProjectDirInfo: (path: string) => Promise<unknown>;
          },
          "getProjectDirInfo",
        );
        await createClaudeProject(projectsDir, host, "/home/user/one", "added");
        eventBus.emit({
          type: "file-change",
          provider: "claude",
          fileType: "session",
          path: join(projectsDir, first, "added.jsonl"),
          relativePath: join(first, "added.jsonl"),
          changeType: "create",
          timestamp: new Date().toISOString(),
        });
        const projects = await scanner.listProjects();
        expect(
          projects.find((p) => p.path === "/home/user/one")?.sessionCount,
        ).toBe(2);
        expect(
          projects.find((p) => p.path === "/home/user/two")?.sessionCount,
        ).toBe(1);
        expect(read.mock.calls).toEqual([[join(projectsDir, first)]]);

        read.mockClear();
        await rm(join(projectsDir, first, "added.jsonl"));
        eventBus.emit({
          type: "file-change",
          provider: "claude",
          fileType: "session",
          path: join(projectsDir, first, "added.jsonl"),
          relativePath: join(first, "added.jsonl"),
          changeType: "delete",
          timestamp: new Date().toISOString(),
        });
        expect(
          (await scanner.listProjects()).map((p) => p.sessionCount),
        ).toEqual([1, 1]);
        expect(read.mock.calls).toEqual([[join(projectsDir, first)]]);

        read.mockClear();
        await writeFile(
          join(projectsDir, first, "one.jsonl"),
          `${JSON.stringify({ type: "user", cwd: "/home/user/two" })}\n`,
        );
        eventBus.emit({
          type: "file-change",
          provider: "claude",
          fileType: "session",
          path: join(projectsDir, first, "one.jsonl"),
          relativePath: join(first, "one.jsonl"),
          changeType: "modify",
          timestamp: new Date().toISOString(),
        });
        expect(await scanner.listProjects()).toEqual([
          expect.objectContaining({ path: "/home/user/two", sessionCount: 2 }),
        ]);
        expect(read.mock.calls).toEqual([[join(projectsDir, first)]]);

        read.mockClear();
        const third = await createClaudeProject(
          projectsDir,
          host,
          "/home/user/three",
          "three",
        );
        eventBus.emit({
          type: "file-change",
          provider: "claude",
          fileType: "session",
          path: join(projectsDir, third, "three.jsonl"),
          relativePath: join(third, "three.jsonl"),
          changeType: "create",
          timestamp: new Date().toISOString(),
        });
        expect(await scanner.listProjects()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: "/home/user/two",
              sessionCount: 2,
            }),
            expect.objectContaining({
              path: "/home/user/three",
              sessionCount: 1,
            }),
          ]),
        );
        expect(read.mock.calls).toEqual([[join(projectsDir, third)]]);

        read.mockClear();
        await createClaudeProject(
          projectsDir,
          host,
          "/home/user/three",
          "four",
        );
        eventBus.emit({
          type: "file-change",
          provider: "claude",
          fileType: "session",
          path: join(projectsDir, third, "four.jsonl"),
          relativePath: join(third, "four.jsonl"),
          changeType: "create",
          timestamp: new Date().toISOString(),
        });
        read.mockRejectedValueOnce(
          new Error("injected directory read failure"),
        );
        await expect(scanner.listProjects()).rejects.toThrow(
          "injected directory read failure",
        );
        expect(
          (await scanner.listProjects()).find(
            (p) => p.path === "/home/user/three",
          )?.sessionCount,
        ).toBe(2);
        expect(read.mock.calls).toEqual([
          [join(projectsDir, third)],
          [join(projectsDir, third)],
        ]);
      } finally {
        await scanner.dispose();
      }
    },
  );

  it("serves retained projects while discovery is blocked", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);
    const eventBus = new EventBus();
    const publish = vi.fn();
    eventBus.subscribe((event) => {
      if (event.type === "projects-changed") publish(event);
    });
    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );
    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      eventBus,
    });
    await scanner.listProjects();
    const internals = scanner as unknown as {
      scanProjects: () => Promise<Project[]>;
    };
    const originalScan = internals.scanProjects.bind(scanner);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scan = vi
      .spyOn(internals, "scanProjects")
      .mockImplementation(async () => {
        await gate;
        return originalScan();
      });
    scanner.invalidateCache();
    const refresh = scanner.refreshRetainedProjects();
    try {
      const results = await Promise.all(
        Array.from({ length: 30 }, () => scanner.readRetainedProjects()),
      );
      expect(scan).toHaveBeenCalledTimes(1);
      for (const result of results) {
        expect(result.projects.map((project) => project.path)).toEqual([
          "/home/user/project-one",
        ]);
        expect(result.complete).toBe(true);
        expect(result.refreshing).toBe(true);
      }
    } finally {
      const disposal = scanner.dispose();
      release();
      await refresh;
      await disposal;
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not resurrect removed registered directories after discovery", async () => {
    const dataDir = join(tmpdir(), `project-metadata-${randomUUID()}`);
    tempDirs.push(dataDir);
    const projectPath = join(dataDir, "registered");
    await mkdir(projectPath, { recursive: true });
    const metadata = new ProjectMetadataService({ dataDir });
    await metadata.initialize();
    await metadata.addProject(encodeProjectId(projectPath), projectPath);
    const scanner = new ProjectScanner({
      projectsDir: join(dataDir, "no-transcripts"),
      enableCodex: false,
      enableGemini: false,
      projectMetadataService: metadata,
    });
    try {
      expect(
        (await scanner.readRetainedProjects()).projects.some(
          (p) => p.path === projectPath,
        ),
      ).toBe(true);
      await scanner.refreshRetainedProjects();
      await rm(projectPath, { recursive: true });
      scanner.invalidateCache();
      await scanner.refreshRetainedProjects();
      const result = await scanner.readRetainedProjects();
      expect(result.complete).toBe(true);
      expect(result.projects.some((p) => p.path === projectPath)).toBe(false);
    } finally {
      await scanner.dispose();
    }
  });

  it.each(["expired", "recent"])(
    "restores %s retained projects without certifying them as current",
    async (age) => {
      const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
      tempDirs.push(projectsDir);
      const projectScanCachePath = join(projectsDir, "project-cache.json");
      const options = {
        projectsDir,
        projectScanCachePath,
        enableCodex: false,
        enableGemini: false,
        cacheTtlMs: 60_000,
      };
      await createClaudeProject(
        projectsDir,
        "localhost",
        "/home/user/one",
        "one",
      );
      const first = new ProjectScanner(options);
      await first.listProjects();
      await first.dispose();
      const saved = JSON.parse(await readFile(projectScanCachePath, "utf-8"));
      saved.generatedAt = age === "expired" ? 0 : Date.now();
      await writeFile(projectScanCachePath, JSON.stringify(saved));
      await createClaudeProject(
        projectsDir,
        "localhost",
        "/home/user/two",
        "two",
      );

      const restored = new ProjectScanner(options);
      try {
        const retained = await restored.readRetainedProjects();
        expect(retained.projects.map((project) => project.path)).toEqual([
          "/home/user/one",
        ]);
        expect(retained.complete).toBe(true);
        expect(retained.refreshing).toBe(true);
        expect(await restored.listProjects()).toHaveLength(2);
      } finally {
        await restored.dispose();
      }

      const otherSource = new ProjectScanner({
        ...options,
        projectsDir: join(projectsDir, "other"),
      });
      try {
        const retained = await otherSource.readRetainedProjects();
        expect(retained.projects).toEqual([]);
        expect(retained.complete).toBe(false);
      } finally {
        await otherSource.dispose();
      }
    },
  );

  it("keeps retained projects on failure and bounds request-driven retries", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);
    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/one",
      "one",
    );
    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
    });
    await scanner.listProjects();
    const internals = scanner as unknown as {
      scanProjects: () => Promise<Project[]>;
    };
    const scan = vi
      .spyOn(internals, "scanProjects")
      .mockRejectedValue(new Error("discovery unavailable"));
    try {
      await scanner.refreshRetainedProjects();
      const results = await Promise.all(
        Array.from({ length: 30 }, () => scanner.readRetainedProjects()),
      );
      expect(scan).toHaveBeenCalledTimes(1);
      for (const result of results) {
        expect(result.projects).toHaveLength(1);
        expect(result.refreshError).toBe("discovery unavailable");
        expect(result.refreshing).toBe(false);
      }
    } finally {
      await scanner.dispose();
    }
  });

  it("publishes a trailing refresh for changes arriving during retained discovery", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);
    const eventBus = new EventBus();
    const publications: string[][] = [];
    eventBus.subscribe((event) => {
      if (event.type === "projects-changed")
        publications.push(event.projectIds);
    });
    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/one",
      "one",
    );
    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      eventBus,
    });
    await scanner.listProjects();
    const internals = scanner as unknown as {
      scanProjects: () => Promise<Project[]>;
    };
    const originalScan = internals.scanProjects.bind(scanner);
    let release!: () => void;
    let captured!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const scan = vi
      .spyOn(internals, "scanProjects")
      .mockImplementationOnce(async () => {
        const result = await originalScan();
        captured();
        await gate;
        return result;
      });
    const refresh = scanner.refreshRetainedProjects();
    try {
      await started;
      await createClaudeProject(
        projectsDir,
        "localhost",
        "/home/user/two",
        "two",
      );
      scanner.invalidateCache();
      release();
      await refresh;
      await vi.waitFor(() =>
        expect(
          publications.some((ids) =>
            ids.includes(encodeProjectId("/home/user/two")),
          ),
        ).toBe(true),
      );
      expect(scan).toHaveBeenCalledTimes(2);
      expect((await scanner.readRetainedProjects()).projects).toHaveLength(2);
    } finally {
      release();
      await refresh;
      await scanner.dispose();
    }
  });

  it("starts first retained discovery without the file-event debounce", async () => {
    const projectsDir = join(tmpdir(), `initial-discovery-${randomUUID()}`);
    tempDirs.push(projectsDir);
    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
    });
    const refresh = vi
      .spyOn(scanner, "refreshRetainedProjects")
      .mockResolvedValue(undefined);
    vi.useFakeTimers();
    try {
      await scanner.readRetainedProjects();
      await vi.advanceTimersByTimeAsync(0);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      await scanner.dispose();
      vi.useRealTimers();
    }
  });

  it("cancels queued retained discovery on disposal", async () => {
    const scanner = new ProjectScanner({
      projectsDir: join(tmpdir(), randomUUID()),
      enableCodex: false,
      enableGemini: false,
    });
    const internals = scanner as unknown as {
      scanProjects: () => Promise<Project[]>;
    };
    const scan = vi.spyOn(internals, "scanProjects");
    const retained = await scanner.readRetainedProjects();
    expect(retained.complete).toBe(false);
    expect(retained.refreshing).toBe(true);
    await scanner.dispose();
    await scanner.refreshRetainedProjects();
    await expect(scanner.readRetainedProjects()).rejects.toThrow(
      "Project scanner is disposed",
    );
    expect(scan).not.toHaveBeenCalled();
  });

  it("preserves invalidation that arrives during an active scan", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);
    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );
    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 60000,
    });
    const internals = scanner as unknown as {
      scanProjects: () => Promise<Project[]>;
    };
    const originalScan = internals.scanProjects.bind(scanner);
    let signalScanCaptured: (() => void) | null = null;
    const scanCaptured = new Promise<void>((resolve) => {
      signalScanCaptured = resolve;
    });
    let releaseScan: (() => void) | null = null;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    vi.spyOn(internals, "scanProjects").mockImplementation(async () => {
      const projects = await originalScan();
      signalScanCaptured?.();
      await scanGate;
      return projects;
    });

    const firstScan = scanner.listProjects();
    await scanCaptured;
    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-two",
      "sess-2",
    );
    scanner.invalidateCache();
    releaseScan?.();

    expect(await firstScan).toHaveLength(1);
    expect(await scanner.listProjects()).toHaveLength(2);
  });

  it("does not join an obsolete scan after invalidation", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);
    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );
    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 60000,
    });
    const internals = scanner as unknown as {
      scanProjects: () => Promise<Project[]>;
    };
    const originalScan = internals.scanProjects.bind(scanner);
    let releaseFirstScan: (() => void) | null = null;
    const firstScanGate = new Promise<void>((resolve) => {
      releaseFirstScan = resolve;
    });
    let firstScanStarted: (() => void) | null = null;
    const firstScanStart = new Promise<void>((resolve) => {
      firstScanStarted = resolve;
    });
    let invocation = 0;
    vi.spyOn(internals, "scanProjects").mockImplementation(async () => {
      invocation += 1;
      if (invocation === 1) {
        const projects = await originalScan();
        firstScanStarted?.();
        await firstScanGate;
        return projects;
      }
      return originalScan();
    });

    const obsoleteScan = scanner.listProjects();
    await firstScanStart;
    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-two",
      "sess-2",
    );
    scanner.invalidateCache();

    await expect(scanner.listProjects()).resolves.toHaveLength(2);
    expect(invocation).toBe(2);
    releaseFirstScan?.();
    await expect(obsoleteScan).resolves.toHaveLength(1);
  });

  it("serializes project snapshot persistence behind the active write", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);
    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );
    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 60000,
      projectScanCachePath: join(projectsDir, "project-cache.json"),
    });
    const internals = scanner as unknown as {
      saveSnapshotToDisk: (
        snapshot: { projects: Project[] },
        revision: number,
      ) => Promise<void>;
    };
    let activeSaves = 0;
    let maxActiveSaves = 0;
    let saveCalls = 0;
    let finalSavedProjectCount = 0;
    let signalFirstSaveStarted: (() => void) | null = null;
    const firstSaveStarted = new Promise<void>((resolve) => {
      signalFirstSaveStarted = resolve;
    });
    let releaseFirstSave: (() => void) | null = null;
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    let signalSecondSaveDone: (() => void) | null = null;
    const secondSaveDone = new Promise<void>((resolve) => {
      signalSecondSaveDone = resolve;
    });
    vi.spyOn(internals, "saveSnapshotToDisk").mockImplementation(
      async (snapshot) => {
        saveCalls += 1;
        activeSaves += 1;
        maxActiveSaves = Math.max(maxActiveSaves, activeSaves);
        if (saveCalls === 1) {
          signalFirstSaveStarted?.();
          await firstSaveGate;
        }
        finalSavedProjectCount = snapshot.projects.length;
        activeSaves -= 1;
        if (saveCalls === 2) signalSecondSaveDone?.();
      },
    );

    await scanner.listProjects();
    await firstSaveStarted;
    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-two",
      "sess-2",
    );
    scanner.invalidateCache();
    await scanner.listProjects();

    expect(saveCalls).toBe(1);
    releaseFirstSave?.();
    await secondSaveDone;
    expect(maxActiveSaves).toBe(1);
    expect(finalSavedProjectCount).toBe(2);
  });

  it("invalidates snapshot from watcher file-change events", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);
    const eventBus = new EventBus();

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 60000,
      eventBus,
    });

    await scanner.listProjects();

    const secondSuffix = await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-two",
      "sess-2",
    );

    const beforeEvent =
      await scanner.getProjectBySessionDirSuffix(secondSuffix);
    expect(beforeEvent).toBeNull();

    eventBus.emit({
      type: "file-change",
      provider: "claude",
      path: join(projectsDir, secondSuffix, "sess-2.jsonl"),
      relativePath: `${secondSuffix}/sess-2.jsonl`,
      changeType: "create",
      timestamp: new Date().toISOString(),
      fileType: "session",
    });

    const afterEvent = await scanner.getProjectBySessionDirSuffix(secondSuffix);
    expect(afterEvent?.id).toBe(encodeProjectId("/home/user/project-two"));
  });

  it("aggregates provider session counts for claude projects", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );

    vi.spyOn(CodexSessionScanner.prototype, "listProjects").mockResolvedValue([
      {
        id: encodeProjectId("/home/user/project-one"),
        path: "/home/user/project-one",
        name: "project-one",
        sessionCount: 3,
        sessionDir: "/codex/sessions",
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: "2099-01-01T00:00:00.000Z",
        provider: "codex",
      },
    ]);
    vi.spyOn(
      GeminiSessionScanner.prototype,
      "registerKnownPaths",
    ).mockResolvedValue(undefined);
    vi.spyOn(GeminiSessionScanner.prototype, "listProjects").mockResolvedValue([
      {
        id: encodeProjectId("/home/user/project-one"),
        path: "/home/user/project-one",
        name: "project-one",
        sessionCount: 2,
        sessionDir: "/gemini/tmp/project-one/chats",
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: "2099-02-01T00:00:00.000Z",
        provider: "gemini",
      },
    ]);

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: true,
      enableGemini: true,
      cacheTtlMs: 60000,
    });

    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.provider).toBe("claude");
    expect(projects[0]).toMatchObject({
      path: "/home/user/project-one",
      sessionCount: 6,
      sessionCountsByProvider: {
        claude: 1,
        codex: 3,
        gemini: 2,
      },
      hasCodexSessions: true,
      hasGeminiSessions: true,
      lastActivity: "2099-02-01T00:00:00.000Z",
    });
  });

  it("merges Windows drive project paths that differ only by case", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);

    const canonicalPath = "C:/Users/sox/Documents/code/mclone";
    const lowerCasePath = "C:/Users/sox/documents/code/mclone";

    await createClaudeProject(
      projectsDir,
      "host-upper",
      canonicalPath,
      "sess-upper-1",
    );
    await createClaudeProject(
      projectsDir,
      "host-upper",
      canonicalPath,
      "sess-upper-2",
    );
    await createClaudeProject(
      projectsDir,
      "host-lower",
      lowerCasePath,
      "sess-lower-1",
    );

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 60000,
    });

    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: encodeProjectId(canonicalPath),
      path: canonicalPath,
      name: "mclone",
      sessionCount: 3,
    });

    await expect(
      scanner.getProject(encodeProjectId(lowerCasePath)),
    ).resolves.toMatchObject({
      id: encodeProjectId(canonicalPath),
      path: canonicalPath,
    });
  });

  it("keeps WSL-like project path casing distinct", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);

    await createClaudeProject(
      projectsDir,
      "host-upper",
      "/mnt/c/Users/sox/Documents/code/mclone",
      "sess-upper",
    );
    await createClaudeProject(
      projectsDir,
      "host-lower",
      "/mnt/c/Users/sox/documents/code/mclone",
      "sess-lower",
    );

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 60000,
    });

    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(2);
  });

  it.each(["claude", "codex", "gemini"] as const)(
    "does not rescan unrelated aged provider inputs for a %s event",
    async (provider) => {
      const root = join(tmpdir(), `provider-isolation-${randomUUID()}`);
      tempDirs.push(root);
      const projectsDir = join(root, "claude");
      const codexDir = join(root, "codex");
      const geminiDir = join(root, "gemini");
      const claudeSuffix = await createClaudeProject(
        projectsDir,
        "localhost",
        "/projects/claude",
        "one",
      );
      await mkdir(codexDir, { recursive: true });
      await mkdir(join(geminiDir, "project", "chats"), { recursive: true });
      const codexFile = join(codexDir, "rollout-one.jsonl");
      const geminiFile = join(
        geminiDir,
        "project",
        "chats",
        "session-one.json",
      );
      await writeFile(
        codexFile,
        `${JSON.stringify({ type: "session_meta", payload: { id: "one", cwd: "/projects/codex", timestamp: "2026-10-09T00:00:00Z" } })}\n`,
      );
      await writeFile(
        geminiFile,
        JSON.stringify({
          sessionId: "one",
          projectHash: "gemini-hash",
          startTime: "2026-10-09T00:00:00Z",
          lastUpdated: "2026-10-09T00:00:00Z",
          messages: [],
        }),
      );
      const codexScanner = new CodexSessionScanner({ sessionsDir: codexDir });
      const geminiScanner = new GeminiSessionScanner({
        sessionsDir: geminiDir,
      });
      const codexScans = vi.spyOn(
        codexScanner as unknown as {
          scanFiles: (...args: unknown[]) => Promise<unknown>;
        },
        "scanFiles",
      );
      const geminiScans = vi.spyOn(
        geminiScanner as unknown as { scanFilesystem: () => Promise<unknown> },
        "scanFilesystem",
      );
      const eventBus = new EventBus();
      const scanner = new ProjectScanner({
        projectsDir,
        codexScanner,
        geminiScanner,
        eventBus,
      });
      try {
        expect(await scanner.listProjects()).toHaveLength(3);
        codexScans.mockClear();
        geminiScans.mockClear();
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
        const path =
          provider === "claude"
            ? join(projectsDir, claudeSuffix, "one.jsonl")
            : provider === "codex"
              ? codexFile
              : geminiFile;
        eventBus.emit({
          type: "file-change",
          provider,
          path,
          relativePath: `${claudeSuffix}/one.jsonl`,
          changeType: "modify",
          timestamp: new Date().toISOString(),
          fileType: "session",
        });
        expect(await scanner.listProjects()).toHaveLength(3);
        if (provider === "codex")
          expect(codexScans).toHaveBeenCalledWith([codexFile]);
        else expect(codexScans).not.toHaveBeenCalled();
        expect(geminiScans).not.toHaveBeenCalled();

        codexScans.mockClear();
        await rm(codexFile);
        await rm(geminiFile);
        scanner.invalidateCache();
        expect(await scanner.listProjects()).toEqual([
          expect.objectContaining({ path: "/projects/claude" }),
        ]);
        expect(codexScans).toHaveBeenCalledTimes(1);
        expect(geminiScans).toHaveBeenCalledTimes(1);
      } finally {
        await scanner.dispose();
      }
    },
  );

  it("updates only the changed Codex rollout through watcher events", async () => {
    const root = join(tmpdir(), `codex-incremental-${randomUUID()}`);
    tempDirs.push(root);
    const sessionsDir = join(root, "codex");
    const eventBus = new EventBus();
    const codexScanner = new CodexSessionScanner({ sessionsDir });
    const files = ["08", "09"].map((day) =>
      join(sessionsDir, "2026", "10", day, `rollout-${day}.jsonl`),
    );
    for (const [index, file] of files.entries()) {
      await mkdir(join(sessionsDir, "2026", "10", index === 0 ? "08" : "09"), {
        recursive: true,
      });
      await writeFile(
        file,
        `${JSON.stringify({ type: "session_meta", payload: { id: String(index), cwd: `/projects/${index}`, timestamp: "2026-10-09T00:00:00Z" } })}\n`,
      );
    }
    const scanner = new ProjectScanner({
      projectsDir: join(root, "claude"),
      codexScanner,
      enableCodex: true,
      enableGemini: false,
      eventBus,
    });
    try {
      expect(await scanner.listProjects()).toHaveLength(2);
      const changed = files[0]!;
      await writeFile(
        changed,
        `${JSON.stringify({ type: "session_meta", payload: { id: "0", cwd: "/projects/1", timestamp: "2026-10-09T00:00:00Z" } })}\n`,
      );
      eventBus.emit({
        type: "file-change",
        provider: "codex",
        path: changed,
        relativePath: "2026/10/08/rollout-08.jsonl",
        changeType: "modify",
        timestamp: new Date().toISOString(),
        fileType: "session",
      });
      expect(await scanner.listProjects()).toEqual([
        expect.objectContaining({ path: "/projects/1", sessionCount: 2 }),
      ]);
      expect(codexScanner.getLastScanMetrics()).toMatchObject({
        directoriesVisited: 0,
        sessionsParsed: 1,
        discovery: { firstLineReadsPlain: 1 },
      });
    } finally {
      await scanner.dispose();
    }
  });

  it("updates only the changed Gemini file through watcher events", async () => {
    const root = join(tmpdir(), `gemini-incremental-${randomUUID()}`);
    tempDirs.push(root);
    const sessionsDir = join(root, "gemini");
    const eventBus = new EventBus();
    const geminiScanner = new GeminiSessionScanner({ sessionsDir });
    const files = ["first", "second"].map((name) =>
      join(sessionsDir, name, "chats", `session-${name}.json`),
    );
    const writeSession = async (file: string, projectHash: string) => {
      await writeFile(
        file,
        JSON.stringify({
          sessionId: file,
          projectHash,
          startTime: "2026-10-09T00:00:00Z",
          lastUpdated: "2026-10-09T00:00:00Z",
          messages: [],
        }),
      );
    };
    for (const [index, file] of files.entries()) {
      await mkdir(
        join(sessionsDir, index === 0 ? "first" : "second", "chats"),
        { recursive: true },
      );
      await writeSession(file, index === 0 ? "first-hash" : "second-hash");
    }
    const scanner = new ProjectScanner({
      projectsDir: join(root, "claude"),
      geminiScanner,
      enableCodex: false,
      enableGemini: true,
      cacheTtlMs: 60_000,
      eventBus,
    });
    const reads = vi.spyOn(
      geminiScanner as unknown as {
        readSessionMeta: (file: string, dir: string) => Promise<unknown>;
      },
      "readSessionMeta",
    );
    try {
      expect(await scanner.listProjects()).toHaveLength(2);
      reads.mockClear();
      const changed = files[0]!;
      await writeSession(changed, "second-hash");
      eventBus.emit({
        type: "file-change",
        provider: "gemini",
        path: changed,
        relativePath: "first/chats/session-first.json",
        changeType: "modify",
        timestamp: new Date().toISOString(),
        fileType: "session",
      });
      expect(await scanner.listProjects()).toEqual([
        expect.objectContaining({ sessionCount: 2, provider: "gemini" }),
      ]);
      expect(reads.mock.calls.map(([file]) => file)).toEqual([changed]);
      const notify = (
        path: string,
        changeType: "create" | "modify" | "delete",
      ) => {
        reads.mockClear();
        eventBus.emit({
          type: "file-change",
          provider: "gemini",
          path,
          relativePath: "first/chats/session-first.json",
          changeType,
          timestamp: new Date().toISOString(),
          fileType: "session",
        });
      };
      await rm(changed);
      notify(changed, "delete");
      expect(await scanner.listProjects()).toEqual([
        expect.objectContaining({ sessionCount: 1 }),
      ]);
      expect(reads.mock.calls.map(([file]) => file)).toEqual([changed]);

      await writeSession(changed, "third-hash");
      notify(changed, "create");
      expect(await scanner.listProjects()).toHaveLength(2);
      expect(reads.mock.calls.map(([file]) => file)).toEqual([changed]);

      await rm(changed);
      await mkdir(changed);
      notify(changed, "modify");
      await expect(scanner.listProjects()).rejects.toMatchObject({
        code: "EISDIR",
      });
      await rm(changed, { recursive: true });
      await writeSession(changed, "second-hash");
      reads.mockClear();
      expect(await scanner.listProjects()).toEqual([
        expect.objectContaining({ sessionCount: 2 }),
      ]);
      expect(reads.mock.calls.map(([file]) => file)).toEqual([changed]);
    } finally {
      await scanner.dispose();
    }
  });

  it("invalidates shared codex scanner cache on codex file-change events", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);
    const eventBus = new EventBus();

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );

    const codexProject = {
      id: encodeProjectId("/home/user/project-one"),
      path: "/home/user/project-one",
      name: "project-one",
      sessionCount: 1,
      sessionDir: "/codex/sessions",
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: "2025-01-01T00:00:00.000Z",
      provider: "codex" as const,
    };
    let nextProjects: (typeof codexProject)[] = [];
    let cachedProjects: (typeof codexProject)[] | null = null;
    const codexScanner = {
      listProjects: vi.fn(async () => {
        if (cachedProjects) return cachedProjects;
        cachedProjects = [...nextProjects];
        return cachedProjects;
      }),
      invalidateCache: vi.fn(() => {
        cachedProjects = null;
      }),
    } as unknown as CodexSessionScanner;

    const scanner = new ProjectScanner({
      projectsDir,
      codexScanner,
      enableCodex: true,
      enableGemini: false,
      cacheTtlMs: 60000,
      eventBus,
    });

    const initialProjects = await scanner.listProjects();
    expect(initialProjects[0]).toMatchObject({
      path: "/home/user/project-one",
      hasCodexSessions: false,
    });

    nextProjects = [codexProject];
    eventBus.emit({
      type: "file-change",
      provider: "codex",
      path: "/codex/sessions/2025/01/01/rollout-1.jsonl",
      relativePath: "2025/01/01/rollout-1.jsonl",
      changeType: "create",
      timestamp: new Date().toISOString(),
      fileType: "session",
    });

    const refreshedProjects = await scanner.listProjects();
    expect(codexScanner.invalidateCache).toHaveBeenCalledTimes(1);
    expect(refreshedProjects[0]).toMatchObject({
      path: "/home/user/project-one",
      hasCodexSessions: true,
    });
  });

  it("skips hidden projects discovered from session logs", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    const dataDir = join(tmpdir(), `project-metadata-${randomUUID()}`);
    tempDirs.push(projectsDir, dataDir);

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );

    const metadata = new ProjectMetadataService({ dataDir });
    await metadata.initialize();
    await metadata.hideProject(
      encodeProjectId("/home/user/project-one"),
      "/home/user/project-one",
    );

    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      projectMetadataService: metadata,
      cacheTtlMs: 60000,
    });

    const projects = await scanner.listProjects();
    expect(projects.some((p) => p.path === "/home/user/project-one")).toBe(
      false,
    );
  });

  it("does not reuse a stale snapshot after its project is hidden", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    const dataDir = join(tmpdir(), `project-metadata-${randomUUID()}`);
    tempDirs.push(projectsDir, dataDir);
    const projectPath = "/home/user/project-one";
    const projectId = encodeProjectId(projectPath);

    await createClaudeProject(projectsDir, "localhost", projectPath, "sess-1");
    const metadata = new ProjectMetadataService({ dataDir });
    await metadata.initialize();
    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      projectMetadataService: metadata,
      cacheTtlMs: 60000,
    });
    await expect(scanner.getProject(projectId)).resolves.not.toBeNull();

    await metadata.hideProject(projectId, projectPath);

    await expect(
      scanner.getProject(projectId, { allowStaleSnapshot: true }),
    ).resolves.toBeNull();
  });

  it("skips hidden Codex projects", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    const dataDir = join(tmpdir(), `project-metadata-${randomUUID()}`);
    tempDirs.push(projectsDir, dataDir);

    const metadata = new ProjectMetadataService({ dataDir });
    await metadata.initialize();
    await metadata.hideProject(
      encodeProjectId("/home/user/codex-project"),
      "/home/user/codex-project",
    );

    const codexScanner = {
      listProjects: vi.fn(async () => [
        {
          id: encodeProjectId("/home/user/codex-project"),
          path: "/home/user/codex-project",
          name: "codex-project",
          sessionCount: 1,
          sessionDir: "/codex/sessions",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: "2025-01-01T00:00:00.000Z",
          provider: "codex" as const,
        },
      ]),
      invalidateCache: vi.fn(),
    } as unknown as CodexSessionScanner;

    const scanner = new ProjectScanner({
      projectsDir,
      codexScanner,
      enableCodex: true,
      enableGemini: false,
      projectMetadataService: metadata,
      cacheTtlMs: 60000,
    });

    const projects = await scanner.listProjects();
    expect(projects.some((p) => p.path === "/home/user/codex-project")).toBe(
      false,
    );
  });
});

describe("ProjectScanner sandbox transcript directories", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("joins sandbox directories to every read without a rescan", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    tempDirs.push(projectsDir);
    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );
    const projectId = encodeProjectId("/home/user/project-one");
    const sandboxDirs = new Map<string, string[]>();
    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 60000,
      getSandboxSessionDirs: () => sandboxDirs,
    });

    const [before] = await scanner.listProjects();
    expect(before?.mergedSessionDirs).toBeUndefined();

    // A sandboxed session starting later must not wait for the cached scan.
    const sandboxDir = join(projectsDir, "sandbox", "claude", "p");
    await mkdir(sandboxDir, { recursive: true });
    await writeFile(join(sandboxDir, "sandboxed.jsonl"), "{}\n");
    await writeFile(join(sandboxDir, "agent-warmup.jsonl"), "{}\n");
    sandboxDirs.set(projectId, [sandboxDir]);
    const [after] = await scanner.listProjects();
    expect(after?.mergedSessionDirs).toEqual([sandboxDir]);
    expect(after?.sessionCount).toBe((before?.sessionCount ?? 0) + 1);
    expect((await scanner.getProject(projectId))?.mergedSessionDirs).toEqual([
      sandboxDir,
    ]);
  });

  it("gives a project known only by id its sandbox directories", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    const projectPath = join(tmpdir(), `sandboxed-project-${randomUUID()}`);
    tempDirs.push(projectsDir, projectPath);
    await mkdir(projectsDir, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    const projectId = encodeProjectId(projectPath);
    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
      getSandboxSessionDirs: () =>
        new Map([[projectId, ["/data/session-sandboxes/key/claude/p"]]]),
    });

    const project = await scanner.getOrCreateProject(projectId);
    expect(project?.mergedSessionDirs).toEqual([
      "/data/session-sandboxes/key/claude/p",
    ]);
  });
});
