import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type GitDiffResult,
  type GitIntegrationOptionsResult,
  type GitPullResult,
  type GitPushResult,
  type GitRemoteCheckResult,
  type GitStatusInfo,
  type GitUntrackedFolderInfo,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createGitStatusRoutes } from "../../src/routes/git-status.js";
import type { DirtyFileEditorService } from "../../src/services/DirtyFileEditorService.js";
import type { Project } from "../../src/supervisor/types.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

function createRoutesForProject(
  projectPath: string,
  dirtyFileEditorService?: DirtyFileEditorService,
) {
  const projectId = toUrlProjectId(projectPath);
  const project: Project = {
    id: projectId,
    path: projectPath,
    name: "repo",
    sessionCount: 0,
    sessionDir: join(projectPath, ".sessions"),
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };

  return {
    projectId,
    routes: createGitStatusRoutes({
      scanner: {
        async getProject(id: string) {
          return id === projectId ? project : null;
        },
      } as unknown as ProjectScanner,
      dirtyFileEditorService,
    }),
  };
}

async function commitFile(
  repoDir: string,
  fileName: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(join(repoDir, fileName), content);
  await runGit(repoDir, ["add", fileName]);
  await runGit(repoDir, ["commit", "-m", message]);
}

describe("git-status routes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "yep-git-status-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function createRepoWithUpstream(): Promise<string> {
    const remoteDir = join(tempDir, "remote.git");
    const repoDir = join(tempDir, "repo");

    await mkdir(repoDir, { recursive: true });
    await execFileAsync("git", ["init", "--bare", remoteDir]);
    await execFileAsync("git", ["init", repoDir]);
    await runGit(repoDir, ["config", "user.email", "ya-test@example.com"]);
    await runGit(repoDir, ["config", "user.name", "YA Test"]);
    await commitFile(repoDir, "README.md", "hello\n", "Initial commit");
    await runGit(repoDir, ["remote", "add", "origin", remoteDir]);
    await runGit(repoDir, ["push", "-u", "origin", "HEAD"]);

    return repoDir;
  }

  async function createDivergedRepo(): Promise<string> {
    const repoDir = await createRepoWithUpstream();
    const remoteDir = join(tempDir, "remote.git");
    const peerDir = join(tempDir, "peer");

    await execFileAsync("git", ["clone", remoteDir, peerDir]);
    await runGit(peerDir, ["config", "user.email", "ya-test@example.com"]);
    await runGit(peerDir, ["config", "user.name", "YA Test"]);
    await commitFile(peerDir, "REMOTE.md", "remote\n", "Remote commit");
    await runGit(peerDir, ["push"]);

    await runGit(repoDir, ["fetch", "origin"]);
    await commitFile(repoDir, "LOCAL.md", "local\n", "Local commit");

    return repoDir;
  }

  it("shares one status read across polls until fresh or an operation", async () => {
    const repoDir = await createRepoWithUpstream();
    const { projectId, routes } = createRoutesForProject(repoDir);
    const dirtyFiles = async (query = "") =>
      (
        (await (
          await routes.request(`/${projectId}/git${query}`)
        ).json()) as GitStatusInfo
      ).files.map((file) => file.path);

    expect(await dirtyFiles()).toEqual([]);
    await writeFile(join(repoDir, "README.md"), "edited\n");
    // Ordinary polls within the window reuse the earlier read...
    expect(await dirtyFiles()).toEqual([]);
    // ...the Source Control view's fresh read sees the edit...
    expect(await dirtyFiles("?fresh=1")).toEqual(["README.md"]);
    await writeFile(join(repoDir, "OTHER.md"), "new\n");
    expect(await dirtyFiles()).toEqual(["README.md"]);
    // ...and a finished git operation forgets the shared read.
    await routes.request(`/${projectId}/git/push`, { method: "POST" });
    expect((await dirtyFiles()).sort()).toEqual(["OTHER.md", "README.md"]);
  });

  it("reports up-to-date when push has nothing to send", async () => {
    const repoDir = await createRepoWithUpstream();
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/push`, {
      method: "POST",
    });
    const body = (await response.json()) as GitPushResult;

    expect(response.status).toBe(200);
    expect(body.status).toBe("up-to-date");
    expect(body.gitStatus?.ahead).toBe(0);
  });

  it("reports pushed when push sends local commits", async () => {
    const repoDir = await createRepoWithUpstream();
    await commitFile(repoDir, "README.md", "hello again\n", "Update readme");
    await commitFile(repoDir, "SECOND.md", "second\n", "Add second file");
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/push`, {
      method: "POST",
    });
    const body = (await response.json()) as GitPushResult;

    expect(response.status).toBe(200);
    expect(body.status).toBe("pushed");
    expect(body.commitsAdvanced).toBe(2);
    expect(body.gitStatus?.ahead).toBe(0);
  });

  it("reports how many commits a pull advances", async () => {
    const repoDir = await createRepoWithUpstream();
    const remoteDir = join(tempDir, "remote.git");
    const peerDir = join(tempDir, "peer");

    await execFileAsync("git", ["clone", remoteDir, peerDir]);
    await runGit(peerDir, ["config", "user.email", "ya-test@example.com"]);
    await runGit(peerDir, ["config", "user.name", "YA Test"]);
    await commitFile(peerDir, "REMOTE.md", "remote\n", "Remote commit");
    await commitFile(
      peerDir,
      "REMOTE-SECOND.md",
      "remote second\n",
      "Second remote commit",
    );
    await runGit(peerDir, ["push"]);

    const { projectId, routes } = createRoutesForProject(repoDir);
    const response = await routes.request(`/${projectId}/git/pull`, {
      method: "POST",
    });
    const body = (await response.json()) as GitPullResult;

    expect(response.status).toBe(200);
    expect(body.status).toBe("pulled");
    expect(body.commitsAdvanced).toBe(2);
    expect(body.gitStatus?.behind).toBe(0);
  });

  it("reports zero commits when pull is already up to date", async () => {
    const repoDir = await createRepoWithUpstream();
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/pull`, {
      method: "POST",
    });
    const body = (await response.json()) as GitPullResult;

    expect(response.status).toBe(200);
    expect(body.status).toBe("pulled");
    expect(body.commitsAdvanced).toBe(0);
  });

  it("reports the last fetch time recorded by git", async () => {
    const repoDir = await createRepoWithUpstream();
    const { projectId, routes } = createRoutesForProject(repoDir);
    const beforeFetchMs = Date.now() - 2_000;

    await runGit(repoDir, ["fetch", "origin"]);

    const afterFetchMs = Date.now() + 2_000;
    const response = await routes.request(`/${projectId}/git`);
    const body = (await response.json()) as GitStatusInfo;
    const checkedRemoteMs = Date.parse(body.checkedRemoteAt ?? "");

    expect(response.status).toBe(200);
    expect(body.checkedRemoteAt).toEqual(expect.any(String));
    expect(Number.isFinite(checkedRemoteMs)).toBe(true);
    expect(checkedRemoteMs).toBeGreaterThanOrEqual(beforeFetchMs);
    expect(checkedRemoteMs).toBeLessThanOrEqual(afterFetchMs);
  });

  it("decorates dirty files through the editor-attribution service", async () => {
    const repoDir = await createRepoWithUpstream();
    await writeFile(join(repoDir, "README.md"), "edited\n");
    const reconcileGitStatus = (status: GitStatusInfo): GitStatusInfo => ({
      ...status,
      files: status.files.map((file) => ({
        ...file,
        lastEditor: {
          sessionId: "session-1",
          observedAt: "2026-08-02T10:00:00.000Z",
        },
      })),
    });
    const dirtyFileEditorService = {
      reconcileGitStatus: (_projectPath: string, status: GitStatusInfo) =>
        reconcileGitStatus(status),
    } as DirtyFileEditorService;
    const { projectId, routes } = createRoutesForProject(
      repoDir,
      dirtyFileEditorService,
    );

    const response = await routes.request(`/${projectId}/git`);
    const body = (await response.json()) as GitStatusInfo;

    expect(response.status).toBe(200);
    expect(body.files[0]?.lastEditor).toEqual({
      sessionId: "session-1",
      observedAt: "2026-08-02T10:00:00.000Z",
    });
  });

  it("marks a failed fallback status as non-authoritative", async () => {
    const projectPath = join(tempDir, "broken-repo");
    await mkdir(projectPath, { recursive: true });
    await writeFile(join(projectPath, ".git"), "invalid git file\n");
    const reconciliations: Array<{ authoritative?: boolean }> = [];
    const dirtyFileEditorService = {
      reconcileGitStatus: (
        _projectPath: string,
        status: GitStatusInfo,
        options: { authoritative?: boolean },
      ) => {
        reconciliations.push(options);
        return status;
      },
    } as DirtyFileEditorService;
    const { projectId, routes } = createRoutesForProject(
      projectPath,
      dirtyFileEditorService,
    );

    const response = await routes.request(`/${projectId}/git/check-remote`, {
      method: "POST",
    });
    const body = (await response.json()) as GitRemoteCheckResult;

    expect(body.status).toBe("failed");
    expect(reconciliations).toContainEqual({ authoritative: false });
  });

  it("reports compact untracked folders as dirty entries", async () => {
    const repoDir = await createRepoWithUpstream();
    await mkdir(join(repoDir, "transport", "__tests__"), { recursive: true });
    await writeFile(join(repoDir, "transport", "types.ts"), "export {};\n");
    await writeFile(
      join(repoDir, "transport", "__tests__", "types.test.ts"),
      "export {};\n",
    );
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git`);
    const body = (await response.json()) as GitStatusInfo;

    expect(response.status).toBe(200);
    expect(body.isClean).toBe(false);
    expect(body.files).toContainEqual({
      path: "transport/",
      status: "?",
      staged: false,
      linesAdded: null,
      linesDeleted: null,
    });
  });

  it("omits Git untracked enumeration for cache-backed status", async () => {
    const repoDir = await createRepoWithUpstream();
    await writeFile(join(repoDir, "README.md"), "edited\n");
    await writeFile(join(repoDir, "untracked.txt"), "untracked\n");
    const reconciliations: Array<{ authoritative?: boolean }> = [];
    const dirtyFileEditorService = {
      reconcileGitStatus: (
        _projectPath: string,
        status: GitStatusInfo,
        options: { authoritative?: boolean },
      ) => {
        reconciliations.push(options);
        return status;
      },
    } as DirtyFileEditorService;
    const { projectId, routes } = createRoutesForProject(
      repoDir,
      dirtyFileEditorService,
    );

    const cacheResponse = await routes.request(
      `/${projectId}/git?untracked=cache`,
    );
    const cacheBody = (await cacheResponse.json()) as GitStatusInfo;
    const noneResponse = await routes.request(
      `/${projectId}/git?untracked=none`,
    );
    const noneBody = (await noneResponse.json()) as GitStatusInfo;

    expect(cacheResponse.status).toBe(200);
    expect(noneResponse.status).toBe(200);
    expect(cacheBody.files.map((file) => file.path)).toEqual(["README.md"]);
    expect(noneBody.files.map((file) => file.path)).toEqual(["README.md"]);
    expect(reconciliations).toEqual([
      { authoritative: false },
      { authoritative: false },
    ]);
  });

  it("round-trips non-ASCII untracked folder paths", async () => {
    const repoDir = await createRepoWithUpstream();
    await mkdir(join(repoDir, "fö"), { recursive: true });
    await writeFile(join(repoDir, "fö", "naïve file.txt"), "hello\n");
    const { projectId, routes } = createRoutesForProject(repoDir);

    const statusResponse = await routes.request(`/${projectId}/git`);
    const statusBody = (await statusResponse.json()) as GitStatusInfo;

    expect(statusResponse.status).toBe(200);
    expect(statusBody.files).toContainEqual({
      path: "fö/",
      status: "?",
      staged: false,
      linesAdded: null,
      linesDeleted: null,
    });

    const expandResponse = await routes.request(
      `/${projectId}/git/untracked-folder?path=${encodeURIComponent("fö/")}`,
    );
    const expandBody = (await expandResponse.json()) as GitUntrackedFolderInfo;

    expect(expandResponse.status).toBe(200);
    expect(expandBody).toEqual({
      path: "fö/",
      files: ["fö/naïve file.txt"],
      truncated: false,
      limit: 500,
    });
  });

  it("keeps line counts for non-ASCII changed files", async () => {
    const repoDir = await createRepoWithUpstream();
    await mkdir(join(repoDir, "fö"), { recursive: true });
    await commitFile(repoDir, "fö/naïve file.txt", "hello\n", "Add file");
    await writeFile(join(repoDir, "fö", "naïve file.txt"), "hello\nagain\n");
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git`);
    const body = (await response.json()) as GitStatusInfo;

    expect(response.status).toBe(200);
    expect(body.files).toContainEqual({
      path: "fö/naïve file.txt",
      status: "M",
      staged: false,
      linesAdded: 1,
      linesDeleted: 0,
    });
  });

  it("expands one untracked folder on demand", async () => {
    const repoDir = await createRepoWithUpstream();
    await mkdir(join(repoDir, "transport", "__tests__"), { recursive: true });
    await writeFile(join(repoDir, "transport", "types.ts"), "export {};\n");
    await writeFile(
      join(repoDir, "transport", "__tests__", "types.test.ts"),
      "export {};\n",
    );
    const dirtyFileEditorService = {
      editorsForPaths: () => ({
        "transport/types.ts": {
          sessionId: "session-1",
          observedAt: "2026-08-02T10:00:00.000Z",
        },
      }),
    } as DirtyFileEditorService;
    const { projectId, routes } = createRoutesForProject(
      repoDir,
      dirtyFileEditorService,
    );

    const response = await routes.request(
      `/${projectId}/git/untracked-folder?path=${encodeURIComponent("transport/")}`,
    );
    const body = (await response.json()) as GitUntrackedFolderInfo;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      path: "transport/",
      files: ["transport/__tests__/types.test.ts", "transport/types.ts"],
      lastEditors: {
        "transport/types.ts": {
          sessionId: "session-1",
          observedAt: "2026-08-02T10:00:00.000Z",
        },
      },
      truncated: false,
      limit: 500,
    });
  });

  it("returns a bounded skipped preview for long-line untracked files", async () => {
    const repoDir = await createRepoWithUpstream();
    await writeFile(
      join(repoDir, "large.json"),
      `{"value":"${"x".repeat(30_000)}"}`,
    );
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "large.json",
        staged: false,
        status: "?",
      }),
    });
    const rawBody = await response.text();
    const body = JSON.parse(rawBody) as GitDiffResult;

    expect(response.status).toBe(200);
    expect(rawBody.length).toBeLessThan(2_000);
    expect(body).toMatchObject({
      diffHtml: "",
      structuredPatch: [],
      previewSkipped: {
        reason: "line-too-long",
        maxLineChars: 30_012,
        maxLineCharsLimit: 20_000,
      },
    });
    expect(body.previewSkipped?.totalChars).toBeGreaterThan(30_000);
  });

  it("skips an untracked file over the plain-preview line budget", async () => {
    const repoDir = await createRepoWithUpstream();
    await writeFile(join(repoDir, "large.txt"), "line\n".repeat(60_000));
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "large.txt",
        staged: false,
        status: "?",
      }),
    });
    const rawBody = await response.text();
    const body = JSON.parse(rawBody) as GitDiffResult;

    expect(response.status).toBe(200);
    expect(rawBody.length).toBeLessThan(2_000);
    expect(body).toMatchObject({
      diffHtml: "",
      structuredPatch: [],
      previewSkipped: {
        reason: "content-too-large",
        maxTotalChars: 16_777_216,
        maxTotalLines: 20_000,
        maxLineCharsLimit: 20_000,
      },
    });
    expect(body.previewSkipped?.totalLines).toBeGreaterThan(20_000);
  });

  it("previews a large untracked evidence file as plain text", async () => {
    const repoDir = await createRepoWithUpstream();
    const content = Array.from(
      { length: 19_000 },
      (_, index) => `{"index":${index},"value":"record ${index}"}`,
    ).join("\n");
    expect(Buffer.byteLength(content)).toBeGreaterThan(256 * 1024);
    await writeFile(join(repoDir, "evidence.json"), content);
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "evidence.json",
        staged: false,
        status: "?",
      }),
    });
    const body = (await response.json()) as GitDiffResult;

    expect(response.status).toBe(200);
    expect(body.previewSkipped).toBeUndefined();
    expect(body.renderMode).toBe("plain");
    expect(body.diffHtml).toBe("");
    expect(body.structuredPatch[0]?.lines).toHaveLength(19_000);
  });

  it("previews a small change inside a file far larger than the render budget", async () => {
    const repoDir = await createRepoWithUpstream();
    const lines = Array.from(
      { length: 12_000 },
      (_, index) => `  "key${index}": "value ${index}",`,
    );
    await commitFile(
      repoDir,
      "big.json",
      `{\n${lines.join("\n")}\n}\n`,
      "Add big file",
    );
    lines[6_000] = `  "key6000": "edited",`;
    await writeFile(join(repoDir, "big.json"), `{\n${lines.join("\n")}\n}\n`);
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "big.json",
        staged: false,
        status: "M",
      }),
    });
    const body = (await response.json()) as GitDiffResult;

    expect(response.status).toBe(200);
    expect(body.previewSkipped).toBeUndefined();
    expect(body.structuredPatch).toHaveLength(1);
    expect(body.structuredPatch[0]?.lines).toContain(`+  "key6000": "edited",`);
    // Hunk coordinates stay absolute even though only the hunk was highlighted.
    expect(body.structuredPatch[0]?.newStart).toBeGreaterThan(5_990);
    expect(body.diffHtml).toContain("line-inserted");
    expect(body.diffHtml).toContain("edited");
    expect(body.reviewProjections).toEqual({
      old: { kind: "index", path: "big.json", side: "old" },
      new: { kind: "worktree", path: "big.json", side: "new" },
    });
    expect(response.headers.get("Server-Timing")).toMatch(
      /project;dur=.*preflight;dur=.*versions;dur=.*render;dur=.*projections;dur=.*total;dur=/,
    );
    // Only the hunk is rendered, not the file it came from.
    expect(body.diffHtml.length).toBeLessThan(20_000);
  });

  it("skips a large file rewritten wholesale", async () => {
    const repoDir = await createRepoWithUpstream();
    const original = Array.from(
      { length: 12_000 },
      (_, index) => `line ${index} ${"padding".repeat(4)}`,
    ).join("\n");
    await commitFile(repoDir, "rewritten.txt", `${original}\n`, "Add file");
    const rewritten = Array.from(
      { length: 12_000 },
      (_, index) => `changed ${index} ${"different".repeat(4)}`,
    ).join("\n");
    await writeFile(join(repoDir, "rewritten.txt"), `${rewritten}\n`);
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "rewritten.txt",
        staged: false,
        status: "M",
      }),
    });
    const rawBody = await response.text();
    const body = JSON.parse(rawBody) as GitDiffResult;

    expect(response.status).toBe(200);
    expect(rawBody.length).toBeLessThan(2_000);
    expect(body).toMatchObject({
      diffHtml: "",
      structuredPatch: [],
      previewSkipped: { reason: "content-too-large" },
    });
  });

  it("measures line length across the diff rather than the whole file", async () => {
    const repoDir = await createRepoWithUpstream();
    // The long line sits well outside the changed hunk's context window.
    const minified = `const bundled = "${"x".repeat(30_000)}";`;
    const filler = Array.from(
      { length: 50 },
      (_, index) => `const spacer${index} = ${index};`,
    ).join("\n");
    await commitFile(
      repoDir,
      "mixed.ts",
      `${minified}\n${filler}\nexport const value = 1;\n`,
      "Add mixed file",
    );
    await writeFile(
      join(repoDir, "mixed.ts"),
      `${minified}\n${filler}\nexport const value = 2;\n`,
    );
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "mixed.ts",
        staged: false,
        status: "M",
      }),
    });
    const body = (await response.json()) as GitDiffResult;

    expect(response.status).toBe(200);
    // The 30k-character line is context the hunk never touches.
    expect(body.previewSkipped).toBeUndefined();
    expect(body.structuredPatch[0]?.lines).toContain(
      "+export const value = 2;",
    );
  });

  it("keeps a 12k-line full-context request syntax highlighted", async () => {
    const repoDir = await createRepoWithUpstream();
    const lines = Array.from(
      { length: 12_000 },
      (_, index) => `  "key${index}": "value ${index}",`,
    );
    await commitFile(
      repoDir,
      "big.json",
      `{\n${lines.join("\n")}\n}\n`,
      "Add big file",
    );
    lines[6_000] = `  "key6000": "edited",`;
    await writeFile(join(repoDir, "big.json"), `{\n${lines.join("\n")}\n}\n`);
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "big.json",
        staged: false,
        status: "M",
        fullContext: true,
      }),
    });
    const body = (await response.json()) as GitDiffResult;

    expect(response.status).toBe(200);
    expect(body.previewSkipped).toBeUndefined();
    expect(body.diffHtml).toContain('<pre class="shiki">');
    expect(body.renderMode).toBeUndefined();
    expect(body.structuredPatch[0]?.lines.length).toBeGreaterThan(12_000);
  });

  it("returns normal git diff previews for small untracked files", async () => {
    const repoDir = await createRepoWithUpstream();
    await writeFile(join(repoDir, "small.ts"), "export const value = 1;\n");
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "small.ts",
        staged: false,
        status: "?",
      }),
    });
    const body = (await response.json()) as GitDiffResult;

    expect(response.status).toBe(200);
    expect(body.previewSkipped).toBeUndefined();
    expect(body.diffHtml).toContain("<pre");
    expect(body.structuredPatch).toHaveLength(1);
    expect(body.structuredPatch[0]?.lines).toContain(
      "+export const value = 1;",
    );
  });

  it("skips small untracked binary content regardless of its extension", async () => {
    const repoDir = await createRepoWithUpstream();
    await writeFile(
      join(repoDir, "misleading.txt"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0x01]),
    );
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "misleading.txt",
        staged: false,
        status: "?",
      }),
    });
    const body = (await response.json()) as GitDiffResult;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      diffHtml: "",
      structuredPatch: [],
      previewSkipped: {
        reason: "binary",
        totalBytes: 7,
      },
    });
  });

  it("renders UTF-8 text even when its extension usually denotes binary", async () => {
    const repoDir = await createRepoWithUpstream();
    await writeFile(join(repoDir, "notes.png"), "plain UTF-8 notes\n");
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "notes.png",
        staged: false,
        status: "?",
      }),
    });
    const body = (await response.json()) as GitDiffResult;

    expect(response.status).toBe(200);
    expect(body.previewSkipped).toBeUndefined();
    expect(body.structuredPatch[0]?.lines).toContain("+plain UTF-8 notes");
  });

  it("uses Git attributes when classifying a tracked diff", async () => {
    const repoDir = await createRepoWithUpstream();
    await writeFile(join(repoDir, ".gitattributes"), "forced.txt -diff\n");
    await writeFile(join(repoDir, "forced.txt"), "before\n");
    await runGit(repoDir, ["add", ".gitattributes", "forced.txt"]);
    await runGit(repoDir, ["commit", "-m", "Add binary diff policy"]);
    await writeFile(join(repoDir, "forced.txt"), "after\n");
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "forced.txt",
        staged: false,
        status: "M",
      }),
    });
    const body = (await response.json()) as GitDiffResult;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      diffHtml: "",
      structuredPatch: [],
      previewSkipped: { reason: "binary" },
    });
  });

  it("rejects unsafe bytes even when Git attributes force a text diff", async () => {
    const repoDir = await createRepoWithUpstream();
    await writeFile(join(repoDir, ".gitattributes"), "forced.data diff\n");
    await writeFile(
      join(repoDir, "forced.data"),
      Buffer.from([0xff, 0xfe, 0x41]),
    );
    await runGit(repoDir, ["add", ".gitattributes", "forced.data"]);
    await runGit(repoDir, ["commit", "-m", "Force text diff policy"]);
    await writeFile(
      join(repoDir, "forced.data"),
      Buffer.from([0xff, 0xfe, 0x42]),
    );
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "forced.data",
        staged: false,
        status: "M",
      }),
    });
    const body = (await response.json()) as GitDiffResult;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      diffHtml: "",
      structuredPatch: [],
      previewSkipped: {
        reason: "binary",
        totalBytes: 6,
      },
    });
  });

  it("skips staged binary changes before reading them as text", async () => {
    const repoDir = await createRepoWithUpstream();
    await writeFile(join(repoDir, "artifact.data"), Buffer.from([0, 1, 2, 3]));
    await runGit(repoDir, ["add", "artifact.data"]);
    await runGit(repoDir, ["commit", "-m", "Add artifact"]);
    await writeFile(join(repoDir, "artifact.data"), Buffer.from([0, 1, 2, 4]));
    await runGit(repoDir, ["add", "artifact.data"]);
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "artifact.data",
        staged: true,
        status: "M",
      }),
    });
    const body = (await response.json()) as GitDiffResult;

    expect(response.status).toBe(200);
    expect(body.previewSkipped).toEqual({ reason: "binary" });
    expect(body.diffHtml).toBe("");
    expect(body.structuredPatch).toEqual([]);
  });

  it("can hide whitespace-only working-tree changes", async () => {
    const repoDir = await createRepoWithUpstream();
    await writeFile(join(repoDir, "README.md"), "hello   \n");
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "README.md",
        staged: false,
        status: "M",
        ignoreWhitespace: true,
      }),
    });
    const body = (await response.json()) as GitDiffResult;

    expect(response.status).toBe(200);
    expect(body.structuredPatch).toEqual([]);
  });

  it("can diff the current filesystem directly against HEAD", async () => {
    const repoDir = await createRepoWithUpstream();
    await writeFile(join(repoDir, "README.md"), "staged\n");
    await runGit(repoDir, ["add", "README.md"]);
    await writeFile(join(repoDir, "README.md"), "working\n");
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "README.md",
        staged: false,
        status: "M",
        againstHead: true,
      }),
    });
    const body = (await response.json()) as GitDiffResult;
    const lines = body.structuredPatch.flatMap((hunk) => hunk.lines);

    expect(response.status).toBe(200);
    expect(lines).toContain("-hello");
    expect(lines).toContain("+working");
    expect(lines).not.toContain("+staged");
  });

  it("reports automatic integration options for a clean diverged branch", async () => {
    const repoDir = await createDivergedRepo();
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(
      `/${projectId}/git/integration-options`,
    );
    const body = (await response.json()) as GitIntegrationOptionsResult;

    expect(response.status).toBe(200);
    expect(body.status).toBe("available");
    expect(body.canAutoRebase).toBe(true);
    expect(body.canAutoMerge).toBe(true);
    expect(body.reasons).toEqual([]);
    expect(body.ahead).toBe(1);
    expect(body.behind).toBe(1);
    expect(body.isClean).toBe(true);
    expect(body.hasSequencerState).toBe(false);
  });

  it("blocks automatic integration options for a dirty diverged branch", async () => {
    const repoDir = await createDivergedRepo();
    await writeFile(join(repoDir, "dirty.txt"), "dirty\n");
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(
      `/${projectId}/git/integration-options`,
    );
    const body = (await response.json()) as GitIntegrationOptionsResult;

    expect(response.status).toBe(200);
    expect(body.status).toBe("unavailable");
    expect(body.canAutoRebase).toBe(false);
    expect(body.canAutoMerge).toBe(false);
    expect(body.reasons).toContain("dirty-worktree");
    expect(body.ahead).toBe(1);
    expect(body.behind).toBe(1);
    expect(body.isClean).toBe(false);
  });
});
