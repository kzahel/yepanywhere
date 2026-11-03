import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectScanner } from "../../src/projects/scanner.js";
import {
  canonicalizeProjectPath,
  encodeProjectId,
} from "../../src/projects/paths.js";
import { SessionReader } from "../../src/sessions/reader.js";

// Control enumeration order while retaining real transcript I/O and discovery.
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

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

describe("Claude folder ownership", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it.each([
    "/home/first.last/repo",
    "/Users/first.last/repo",
    "C:\\Users\\first.last\\repo",
  ])(
    "keeps %s sessions reachable when worktree transcripts precede its cwd",
    async (root) => {
      const projectsDir = join(
        tmpdir(),
        `project-scanner-worktrees-${randomUUID()}`,
      );
      tempDirs.push(projectsDir);
      const canonicalRoot = canonicalizeProjectPath(root);
      const suffix = await createClaudeProject(
        projectsDir,
        "localhost",
        root,
        "root-session",
      );
      const sessionDir = join(projectsDir, suffix);
      // More than one cwd batch, as in claude --worktree's shared launch folder.
      for (let i = 0; i < 30; i++) {
        await writeFile(
          join(sessionDir, `worktree-${i}.jsonl`),
          `${JSON.stringify({ cwd: `${root}/.claude/worktrees/w${i}` })}\n`,
        );
      }
      const readDirectory = fs.readdir;
      let rootFirst = false;
      vi.spyOn(fs, "readdir").mockImplementation((async (
        ...args: Parameters<typeof fs.readdir>
      ) => {
        const entries = await readDirectory(...args);
        if (String(args[0]) === sessionDir) {
          entries.sort((a, b) => {
            const first = a.name.toString() === "root-session.jsonl";
            const second = b.name.toString() === "root-session.jsonl";
            return (Number(first) - Number(second)) * (rootFirst ? -1 : 1);
          });
        }
        return entries;
      }) as typeof fs.readdir);
      const scanner = new ProjectScanner({
        projectsDir,
        enableCodex: false,
        enableGemini: false,
      });
      try {
        for (const order of [false, true]) {
          rootFirst = order;
          scanner.invalidateCache();
          const project = await scanner.getProject(
            encodeProjectId(canonicalRoot),
          );
          expect(project).toMatchObject({
            path: canonicalRoot,
            sessionDir,
            sessionCount: 31,
          });
          expect(
            await scanner.getProjectBySessionDirSuffix(suffix),
          ).toMatchObject({ id: encodeProjectId(canonicalRoot) });
          const reader = new SessionReader({ sessionDir: project!.sessionDir });
          expect(
            (await reader.getSessionSummary("root-session", project!.id))?.id,
          ).toBe("root-session");
        }
      } finally {
        await scanner.dispose();
      }
    },
  );

  it("rejects pre-fix disk mappings and rebuilds without a manual cache deletion", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-cache-${randomUUID()}`);
    tempDirs.push(projectsDir);
    const root = "/home/user/repo";
    await createClaudeProject(projectsDir, "localhost", root, "root-session");
    const projectScanCachePath = join(projectsDir, "cache.json");
    const options = {
      projectsDir,
      projectScanCachePath,
      enableCodex: false,
      enableGemini: false,
    };
    const first = new ProjectScanner(options);
    await first.listProjects();
    await first.dispose();
    const saved = JSON.parse(await readFile(projectScanCachePath, "utf8"));
    saved.cacheVersion = 5;
    saved.projects[0].path = `${root}/.claude/worktrees/wrong`;
    saved.projects[0].id = encodeProjectId(saved.projects[0].path);
    await writeFile(projectScanCachePath, JSON.stringify(saved));
    const restored = new ProjectScanner(options);
    try {
      expect((await restored.readRetainedProjects()).projects).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: saved.projects[0].path }),
        ]),
      );
      expect(await restored.getProject(encodeProjectId(root))).toMatchObject({
        path: root,
        sessionCount: 1,
      });
    } finally {
      await restored.dispose();
    }
  });

  it("keeps the first regular cwd as fallback when no transcript matches the folder key", async () => {
    const projectsDir = join(
      tmpdir(),
      `project-scanner-fallback-${randomUUID()}`,
    );
    tempDirs.push(projectsDir);
    const sessionDir = join(projectsDir, "-different-launch-folder");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "agent-first.jsonl"),
      JSON.stringify({ cwd: "/home/user/agent" }),
    );
    await writeFile(
      join(sessionDir, "regular.jsonl"),
      JSON.stringify({ cwd: "/home/user/actual" }),
    );
    const scanner = new ProjectScanner({
      projectsDir,
      enableCodex: false,
      enableGemini: false,
    });
    try {
      expect(
        await scanner.getProject(encodeProjectId("/home/user/actual")),
      ).toMatchObject({ sessionDir, sessionCount: 1 });
    } finally {
      await scanner.dispose();
    }
  });

  it("uses Claude's punctuation encoding for a new project before and after discovery", async () => {
    const projectsDir = join(tmpdir(), `project-scanner-new-${randomUUID()}`);
    tempDirs.push(projectsDir);
    const root = join(projectsDir, "first.last", "my_repo");
    await mkdir(root, { recursive: true });
    const scanner = new ProjectScanner({
      projectsDir: join(projectsDir, "native"),
      enableCodex: false,
      enableGemini: false,
    });
    try {
      const project = await scanner.getOrCreateProject(
        encodeProjectId(root),
        "claude",
      );
      expect(project?.sessionDir).toBe(
        join(projectsDir, "native", encodePath(root)),
      );
      await mkdir(project!.sessionDir, { recursive: true });
      await writeFile(
        join(project!.sessionDir, "new-session.jsonl"),
        JSON.stringify({ cwd: root }),
      );
      scanner.invalidateCache();
      expect(await scanner.getProject(project!.id)).toMatchObject({
        sessionDir: project!.sessionDir,
        sessionCount: 1,
      });
    } finally {
      await scanner.dispose();
    }
  });
});
