import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSessionScanner } from "../../src/projects/codex-scanner.js";
import { ProjectMetadataService } from "../../src/metadata/ProjectMetadataService.js";
import { ProjectScanner } from "../../src/projects/scanner.js";
import { encodeProjectId } from "../../src/supervisor/types.js";
import { EventBus } from "../../src/watcher/EventBus.js";

function encodePath(path: string): string {
  return path.replace(/[/\\:]/g, "-");
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
    `{"type":"user","cwd":"${projectPath}","message":{"content":"hello"}}\n`,
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
    const dataDir = join(tmpdir(), `project-scanner-data-${randomUUID()}`);
    tempDirs.push(dataDir);
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
      dataDir,
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
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("reuses snapshot results until invalidated", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    const dataDir = join(tmpdir(), `project-scanner-data-${randomUUID()}`);
    tempDirs.push(projectsDir, dataDir);

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );

    const scanner = new ProjectScanner({
      projectsDir,
      dataDir,
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

  it("marks claude projects that also have codex sessions", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    const dataDir = join(tmpdir(), `project-scanner-data-${randomUUID()}`);
    tempDirs.push(projectsDir, dataDir);

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
        lastActivity: "2025-01-01T00:00:00.000Z",
        provider: "codex",
      },
    ]);

    const scanner = new ProjectScanner({
      projectsDir,
      dataDir,
      enableCodex: true,
      enableGemini: false,
      cacheTtlMs: 60000,
    });

    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.provider).toBe("claude");
    expect(projects[0]).toMatchObject({
      path: "/home/user/project-one",
      hasCodexSessions: true,
    });
  });

  it("loads projects from a persisted snapshot before scanning", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    const dataDir = join(tmpdir(), `project-scanner-data-${randomUUID()}`);
    tempDirs.push(projectsDir, dataDir);
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "project-snapshot.json"),
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        projects: [
          {
            id: encodeProjectId("/home/user/persisted"),
            path: "/home/user/persisted",
            name: "persisted",
            sessionCount: 3,
            sessionDir: join(projectsDir, "localhost", "-home-user-persisted"),
            activeOwnedCount: 0,
            activeExternalCount: 0,
            lastActivity: "2026-01-01T00:00:00.000Z",
            provider: "claude",
            hasCodexSessions: false,
            hasGeminiSessions: false,
          },
        ],
      }),
      "utf-8",
    );

    const scanner = new ProjectScanner({
      projectsDir,
      dataDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 60000,
    });

    const getProjectDirInfoSpy = vi.spyOn(
      scanner as unknown as {
        getProjectDirInfo: (projectDirPath: string) => Promise<unknown>;
      },
      "getProjectDirInfo",
    );

    const projects = await scanner.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.path).toBe("/home/user/persisted");
    expect(getProjectDirInfoSpy).not.toHaveBeenCalled();
  });

  it("filters hidden projects out of a persisted snapshot", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    const dataDir = join(tmpdir(), `project-scanner-data-${randomUUID()}`);
    const metadataDir = join(tmpdir(), `project-metadata-${randomUUID()}`);
    tempDirs.push(projectsDir, dataDir, metadataDir);
    await mkdir(dataDir, { recursive: true });

    const hiddenPath = "/home/user/hidden-project";
    await writeFile(
      join(dataDir, "project-snapshot.json"),
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        projects: [
          {
            id: encodeProjectId(hiddenPath),
            path: hiddenPath,
            name: "hidden-project",
            sessionCount: 3,
            sessionDir: join(projectsDir, "localhost", "-home-user-hidden-project"),
            activeOwnedCount: 0,
            activeExternalCount: 0,
            lastActivity: "2026-01-01T00:00:00.000Z",
            provider: "claude",
            hasCodexSessions: false,
            hasGeminiSessions: false,
          },
        ],
      }),
      "utf-8",
    );

    const metadataService = new ProjectMetadataService({ dataDir: metadataDir });
    await metadataService.initialize();
    await metadataService.hideProject(
      encodeProjectId(hiddenPath),
      hiddenPath,
    );

    const scanner = new ProjectScanner({
      projectsDir,
      dataDir,
      enableCodex: false,
      enableGemini: false,
      projectMetadataService: metadataService,
      cacheTtlMs: 60000,
    });

    const projects = await scanner.listProjects();
    expect(projects).toEqual([]);
  });

  it("refreshes the persisted snapshot during prewarm", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    const dataDir = join(tmpdir(), `project-scanner-data-${randomUUID()}`);
    tempDirs.push(projectsDir, dataDir);
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "project-snapshot.json"),
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        projects: [
          {
            id: encodeProjectId("/home/user/stale"),
            path: "/home/user/stale",
            name: "stale",
            sessionCount: 1,
            sessionDir: join(projectsDir, "localhost", "-home-user-stale"),
            activeOwnedCount: 0,
            activeExternalCount: 0,
            lastActivity: "2026-01-01T00:00:00.000Z",
            provider: "claude",
            hasCodexSessions: false,
            hasGeminiSessions: false,
          },
        ],
      }),
      "utf-8",
    );

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/fresh",
      "sess-1",
    );

    const scanner = new ProjectScanner({
      projectsDir,
      dataDir,
      enableCodex: false,
      enableGemini: false,
      cacheTtlMs: 60000,
    });

    const initial = await scanner.listProjects();
    expect(initial.map((project) => project.path)).toEqual([
      "/home/user/stale",
    ]);

    await scanner.prewarm();

    const refreshed = await scanner.listProjects();
    expect(refreshed.map((project) => project.path)).toEqual([
      "/home/user/fresh",
    ]);
  });

  it("hides discovered projects and suppresses the home fallback once hidden", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-${randomUUID()}`);
    const dataDir = join(tmpdir(), `project-metadata-${randomUUID()}`);
    tempDirs.push(projectsDir, dataDir);

    await createClaudeProject(
      projectsDir,
      "localhost",
      "/home/user/project-one",
      "sess-1",
    );
    const metadataService = new ProjectMetadataService({ dataDir });
    await metadataService.initialize();
    await metadataService.hideProject(
      encodeProjectId("/home/user/project-one"),
      "/home/user/project-one",
    );

    const scanner = new ProjectScanner({
      projectsDir,
      dataDir,
      enableCodex: false,
      enableGemini: false,
      projectMetadataService: metadataService,
    });

    expect(await scanner.listProjects()).toEqual([]);

    await metadataService.addProject(
      encodeProjectId("/home/user/project-one"),
      "/home/user/project-one",
    );
    scanner.invalidateCache();

    const restored = await scanner.listProjects();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.path).toBe("/home/user/project-one");
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
});
