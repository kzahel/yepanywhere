import { readFile, stat } from "node:fs/promises";
import type {
  GitDiffResult,
  GitFileChange,
  GitFileDiffMode,
  GitFileProjectionManifest,
  ReviewSourceProjection,
} from "@yep-anywhere/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { buildGitDiffResultFromBytes } from "../git/diffResult.js";
import { gitDiffReportsBinary } from "../git/binaryDiff.js";
import {
  GIT_DIFF_PREVIEW_MAX_TOTAL_BYTES,
  skippedBinaryGitDiffResult,
  skippedGitDiffResult,
} from "../git/diffPreviewGuards.js";
import { readGitDiffFileChanges } from "../git/fileChanges.js";
import { GIT_DECODE_PATHS_ARGS, runGit, runGitBytes } from "../git/gitExec.js";
import { readHeadSha } from "../git/headSha.js";
import type { ProjectScanner } from "../projects/scanner.js";
import {
  repositoryFilePathIfExists,
  repositoryRelativePath,
} from "../review/repositoryPath.js";
import { resolveProjectPath } from "./projectParam.js";

export interface GitFileProjectionDeps {
  scanner: ProjectScanner;
}

const PROJECTION_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Exact project-wide corpora and per-file diffs for the shared file viewer.
 * HEAD is the ordinary baseline; HEAD^1 is the cumulative first-parent
 * baseline. Both comparisons end at the live filesystem, including untracked
 * files, so a later worktree edit can cancel a committed change exactly.
 */
export function createGitFileProjectionRoutes(
  deps: GitFileProjectionDeps,
): Hono {
  const routes = new Hono();

  routes.get("/:projectId/git/file-projections", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;

    try {
      return c.json(await readFileProjectionManifest(projectPath));
    } catch (error) {
      return gitError(c, error);
    }
  });

  routes.post("/:projectId/git/file-projection-diff", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;

    let body: {
      path?: unknown;
      origPath?: unknown;
      mode?: unknown;
      fullContext?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (typeof body.path !== "string") {
      return c.json({ error: "Missing required field: path" }, 400);
    }
    if (body.mode !== "worktree" && body.mode !== "cumulative") {
      return c.json({ error: "Invalid file diff mode" }, 400);
    }
    if (
      body.fullContext !== undefined &&
      typeof body.fullContext !== "boolean"
    ) {
      return c.json({ error: "Invalid fullContext" }, 400);
    }

    let requestedPath: string;
    let originalPath: string | undefined;
    try {
      requestedPath = repositoryRelativePath(body.path);
      if (body.origPath !== undefined) {
        if (typeof body.origPath !== "string") {
          return c.json({ error: "Invalid origPath" }, 400);
        }
        originalPath = repositoryRelativePath(body.origPath);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid path";
      return c.json({ error: message }, 400);
    }

    try {
      const projection = await readFileProjectionSelection(
        projectPath,
        requestedPath,
        body.mode,
        originalPath,
      );
      if (!projection.file || !projection.baseSha) {
        return c.json({ error: "File has no selected projection" }, 404);
      }

      return c.json(
        await renderFileProjection(
          c.req.param("projectId"),
          projectPath,
          projection.baseSha,
          projection.file,
          body.fullContext,
        ),
      );
    } catch (error) {
      return gitError(c, error);
    }
  });

  return routes;
}

export async function readFileProjectionManifest(
  cwd: string,
): Promise<GitFileProjectionManifest> {
  const [headSha, baseSha, untrackedFiles] = await Promise.all([
    resolveCommit(cwd, "HEAD"),
    resolveCommit(cwd, "HEAD^1"),
    listUntrackedFiles(cwd),
  ]);
  if (!headSha) {
    return {
      headSha: null,
      baseSha: null,
      worktreeFiles: [],
      cumulativeFiles: [],
    };
  }

  const [worktreeFiles, cumulativeFiles] = await Promise.all([
    readWorktreeChanges(cwd, headSha, untrackedFiles),
    baseSha
      ? readWorktreeChanges(cwd, baseSha, untrackedFiles)
      : Promise.resolve([]),
  ]);
  return {
    headSha,
    baseSha,
    worktreeFiles,
    cumulativeFiles,
  };
}

interface FileProjectionSelection {
  baseSha: string | null;
  file: GitFileChange | null;
}

export async function readFileProjectionSelection(
  cwd: string,
  requestedPath: string,
  mode: GitFileDiffMode,
  originalPath?: string,
): Promise<FileProjectionSelection> {
  const baseSha = await resolveCommit(
    cwd,
    mode === "worktree" ? "HEAD" : "HEAD^1",
  );
  if (!baseSha) {
    return { baseSha: null, file: null };
  }

  const paths =
    originalPath && originalPath !== requestedPath
      ? [requestedPath, originalPath]
      : [requestedPath];
  const tracked = await readGitDiffFileChanges(cwd, [baseSha], {
    maxBuffer: PROJECTION_MAX_BUFFER,
    paths,
  });
  const file = tracked.find(
    (candidate) =>
      paths.includes(candidate.path) ||
      (candidate.origPath !== undefined && paths.includes(candidate.origPath)),
  );
  if (file) {
    return { baseSha, file };
  }
  if (!(await isUntrackedFile(cwd, requestedPath))) {
    return { baseSha, file: null };
  }
  return {
    baseSha,
    file: {
      path: requestedPath,
      status: "?",
      staged: false,
      linesAdded: null,
      linesDeleted: null,
    },
  };
}

async function readWorktreeChanges(
  cwd: string,
  baseSha: string,
  untrackedFiles: readonly string[],
): Promise<GitFileChange[]> {
  const tracked = await readGitDiffFileChanges(cwd, [baseSha], {
    maxBuffer: PROJECTION_MAX_BUFFER,
  });
  const paths = new Set(tracked.map((file) => file.path));
  for (const path of untrackedFiles) {
    if (paths.has(path)) continue;
    tracked.push({
      path,
      status: "?",
      staged: false,
      linesAdded: null,
      linesDeleted: null,
    });
  }
  return tracked;
}

async function listUntrackedFiles(cwd: string): Promise<string[]> {
  const { stdout } = await runGit(
    cwd,
    [
      ...GIT_DECODE_PATHS_ARGS,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { maxBuffer: PROJECTION_MAX_BUFFER },
  );
  const paths = stdout.split("\0");
  if (paths.at(-1) === "") paths.pop();
  return paths;
}

async function isUntrackedFile(cwd: string, path: string): Promise<boolean> {
  const { stdout } = await runGit(cwd, [
    ...GIT_DECODE_PATHS_ARGS,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    `:(literal)${path}`,
  ]);
  return stdout.split("\0").includes(path);
}

async function renderFileProjection(
  projectId: string,
  cwd: string,
  baseSha: string,
  file: GitFileChange,
  fullContext?: boolean,
): Promise<GitDiffResult> {
  const oldPath = file.origPath ?? file.path;
  if (
    file.status !== "?" &&
    (await gitDiffReportsBinary(
      cwd,
      ["diff", "--no-ext-diff", "-M", baseSha],
      file.path,
    ))
  ) {
    return skippedBinaryGitDiffResult();
  }
  if (file.status === "?") {
    const resolved = await repositoryFilePathIfExists(cwd, file.path);
    const metadata = resolved ? await stat(resolved) : null;
    if (metadata && metadata.size > GIT_DIFF_PREVIEW_MAX_TOTAL_BYTES) {
      return skippedGitDiffResult({
        reason: "content-too-large",
        totalBytes: metadata.size,
        maxTotalBytes: GIT_DIFF_PREVIEW_MAX_TOTAL_BYTES,
      });
    }
  }
  const [oldContent, newContent] = await Promise.all([
    file.status === "A" || file.status === "?"
      ? Promise.resolve(Buffer.alloc(0))
      : showAt(cwd, baseSha, oldPath),
    readWorktreeFile(cwd, file.path),
  ]);
  const result = await buildGitDiffResultFromBytes({
    path: file.path,
    oldContent,
    newContent,
    markdownProject: { id: projectId, path: cwd },
    fullContext,
  });
  if (!result.previewSkipped) {
    result.reviewProjections = {
      old: revisionProjection(baseSha, oldPath, "old"),
      new: { kind: "worktree", path: file.path, side: "new" },
    };
  }
  return result;
}

async function readWorktreeFile(cwd: string, path: string): Promise<Buffer> {
  const resolved = await repositoryFilePathIfExists(cwd, path);
  if (!resolved) return Buffer.alloc(0);
  const metadata = await stat(resolved);
  if (metadata.size > PROJECTION_MAX_BUFFER) {
    const error = new Error(`File exceeds ${PROJECTION_MAX_BUFFER} bytes`);
    Object.assign(error, { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    throw error;
  }
  return readFile(resolved);
}

async function showAt(
  cwd: string,
  revision: string,
  path: string,
): Promise<Buffer> {
  const { stdout } = await runGitBytes(cwd, ["show", `${revision}:${path}`], {
    maxBuffer: PROJECTION_MAX_BUFFER,
  });
  return stdout;
}

/** A commit's first parent never changes; bounded by distinct HEADs seen. */
const firstParentByHead = new Map<string, Promise<string | null>>();
const FIRST_PARENT_CACHE_MAX = 256;

async function resolveCommit(
  cwd: string,
  revision: string,
): Promise<string | null> {
  // The manifest asks for HEAD and HEAD^1 on every read; neither needs a
  // git process while HEAD stays put.
  if (revision === "HEAD" || revision === "HEAD^1") {
    const head = await readHeadSha(cwd).catch(() => null);
    if (!head || revision === "HEAD") return head;
    const key = `${cwd}\0${head}`;
    let parent = firstParentByHead.get(key);
    if (!parent) {
      parent = resolveCommitWithGit(cwd, `${head}^1`);
      if (firstParentByHead.size >= FIRST_PARENT_CACHE_MAX)
        firstParentByHead.delete(firstParentByHead.keys().next().value ?? "");
      firstParentByHead.set(key, parent);
    }
    return parent;
  }
  return resolveCommitWithGit(cwd, revision);
}

async function resolveCommitWithGit(cwd: string, revision: string) {
  try {
    const { stdout } = await runGit(cwd, [
      "rev-parse",
      "--verify",
      `${revision}^{commit}`,
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function revisionProjection(
  revision: string,
  path: string,
  side: "old" | "new",
): ReviewSourceProjection {
  return { kind: "revision", revision, path, side };
}

function gitError(c: Context, error: unknown): Response {
  const message =
    error instanceof Error ? error.message : "Failed to compute file diff";
  return c.json({ error: message }, 500);
}
