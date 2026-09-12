/** Exact source capture and append-only git-object pinning. */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ReviewCapture,
  ReviewCapturedSource,
  ReviewCommentAnchor,
  ReviewSourceChangeStatus,
  ReviewSourceProjection,
} from "@yep-anywhere/shared";
import { DEFAULT_SNIPPET_CONTEXT_RADIUS } from "@yep-anywhere/shared";
import { getDataDir } from "../config.js";
import { buildGitArgs, runGit, runGitBytes } from "../git/gitExec.js";
import { HttpError } from "../middleware/error-handler.js";
import { ProjectStoragePolicy } from "../projects/projectStoragePolicy.js";
import { syncDirectory } from "../utils/syncDirectory.js";
import {
  repositoryFilePath,
  repositoryFilePathIfExists,
  repositoryRelativePath,
} from "./repositoryPath.js";

export const SOURCE_REVIEW_CAPTURE_REF =
  "refs/yep/source-review/captures" as const;
const MAX_PIN_RETRIES = 12;
const MAX_CAPTURE_SOURCE_BYTES = 1024 * 1024;
const MAX_CAPTURE_EXCERPT_CHARS = 64 * 1024;
const CAPTURE_CONTEXT_LINES = 6;
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export class ReviewCaptureService {
  private readonly storagePolicy: ProjectStoragePolicy;

  constructor(options: { storagePolicy?: ProjectStoragePolicy } = {}) {
    this.storagePolicy =
      options.storagePolicy ??
      new ProjectStoragePolicy({
        dataDir: getDataDir(),
        getMode: () => "app-data",
      });
  }

  async capture(
    projectPath: string,
    projection: ReviewSourceProjection,
  ): Promise<ReviewCapture> {
    const projectStorageEnabled = this.storagePolicy.mode === "project";
    const path = repositoryRelativePath(projection.path);
    const safeProjection: ReviewSourceProjection =
      projection.kind === "revision"
        ? {
            kind: "revision",
            revision: projection.revision,
            path,
            side: projection.side,
          }
        : { kind: projection.kind, path, side: projection.side };
    const captureBlobId = projectStorageEnabled
      ? await resolveProjectionBlob(projectPath, safeProjection)
      : await this.captureInAppData(projectPath, safeProjection);
    if (projectStorageEnabled) {
      await this.pin(projectPath, captureBlobId);
    }
    return {
      status: "captured",
      captureBlobId,
      projection: safeProjection,
    };
  }

  /** Read a bounded, binary-safe excerpt around the originally reviewed line. */
  async readExcerpt(
    projectPath: string,
    capture: ReviewCapture,
    anchor: ReviewCommentAnchor,
  ): Promise<ReviewCapturedSource> {
    if (capture.status === "legacy-missing") {
      return { status: "legacy-missing" };
    }
    const captureBlobId = capture.captureBlobId;
    const captured = await readCaptureText(
      projectPath,
      captureBlobId,
      this.storagePolicy,
    );
    if (captured.status === "unavailable") {
      return { ...captured, captureBlobId };
    }
    try {
      const text = captured.text;
      const lines = text.split("\n");
      const requestedLine =
        (anchor.side === "old" ? anchor.oldLine : anchor.newLine) ??
        anchor.newLine ??
        anchor.oldLine ??
        1;
      const highlightLine = Math.min(
        Math.max(1, requestedLine),
        Math.max(1, lines.length),
      );
      const startIndex = Math.max(0, highlightLine - 1 - CAPTURE_CONTEXT_LINES);
      const endIndex = Math.min(
        lines.length,
        highlightLine + CAPTURE_CONTEXT_LINES,
      );
      return {
        status: "captured",
        captureBlobId,
        content: lines
          .slice(startIndex, endIndex)
          .join("\n")
          .slice(0, MAX_CAPTURE_EXCERPT_CHARS),
        startLine: startIndex + 1,
        highlightLine,
      };
    } catch {
      return { status: "unavailable", captureBlobId, reason: "missing" };
    }
  }

  /** Compare the capture neighborhood with today's worktree, ignoring spaces. */
  async compareNeighborhood(
    projectPath: string,
    capture: ReviewCapture,
    anchor: ReviewCommentAnchor,
  ): Promise<ReviewSourceChangeStatus> {
    if (capture.status === "legacy-missing") return "unavailable";
    const captured = await readCaptureText(
      projectPath,
      capture.captureBlobId,
      this.storagePolicy,
    );
    if (captured.status === "unavailable") return "unavailable";
    if (anchor.newLine === null) return "changed";

    const safePath = repositoryRelativePath(anchor.path);
    const currentPath = await repositoryFilePathIfExists(projectPath, safePath);
    if (!currentPath) return "changed";
    let current: string | null;
    try {
      current = await readTextFileBounded(currentPath);
    } catch {
      return "unavailable";
    }
    if (current === null) return "unavailable";

    const capturedLines = captured.text.split("\n");
    const capturedLineNumber =
      (anchor.side === "old" ? anchor.oldLine : anchor.newLine) ??
      anchor.newLine ??
      anchor.oldLine;
    if (!capturedLineNumber) return "unavailable";
    const target = normalizeWhitespace(
      capturedLines[capturedLineNumber - 1] ?? "",
    );
    const currentLines = current.split("\n");
    const matches: number[] = [];
    for (let index = 0; index < currentLines.length; index++) {
      if (normalizeWhitespace(currentLines[index] ?? "") === target) {
        matches.push(index + 1);
      }
    }
    if (matches.length === 0) return "changed";
    const capturedNeighborhood = normalizeWhitespace(
      sourceNeighborhood(capturedLines, capturedLineNumber),
    );
    return matches.some(
      (line) =>
        normalizeWhitespace(sourceNeighborhood(currentLines, line)) ===
        capturedNeighborhood,
    )
      ? "unchanged"
      : "changed";
  }

  /** Add a blob to the shared-worktree ref with compare-and-swap retries. */
  async pin(projectPath: string, blobId: string): Promise<void> {
    if (!OBJECT_ID_RE.test(blobId)) {
      throw new Error(`Invalid source-review capture object id: ${blobId}`);
    }
    await assertBlob(projectPath, blobId);

    if (this.storagePolicy.mode !== "project") {
      const bytes = await readGitBlobBytes(projectPath, blobId);
      await this.writeAppDataCapture(projectPath, blobId, bytes);
      return;
    }

    for (let attempt = 0; attempt < MAX_PIN_RETRIES; attempt++) {
      const current = await readCaptureTree(projectPath);
      if (current.blobIds.has(blobId)) return;
      const nextIds = [...current.blobIds, blobId].sort();
      const nextTree = await writeCaptureTree(projectPath, nextIds);
      const expected = current.treeId ?? "0".repeat(nextTree.length);
      try {
        await runGit(projectPath, [
          "update-ref",
          SOURCE_REVIEW_CAPTURE_REF,
          nextTree,
          expected,
        ]);
        return;
      } catch {
        // A concurrent writer may have advanced the ref. Re-read and union.
      }
    }
    throw new Error(
      "Could not update the source-review capture ref after retries",
    );
  }

  private async captureInAppData(
    projectPath: string,
    projection: ReviewSourceProjection,
  ): Promise<string> {
    const bytes = await resolveProjectionBytes(projectPath, projection);
    const captureId = createHash("sha256").update(bytes).digest("hex");
    await this.writeAppDataCapture(projectPath, captureId, bytes);
    return captureId;
  }

  private async writeAppDataCapture(
    projectPath: string,
    captureId: string,
    bytes: Buffer,
  ): Promise<void> {
    const capturePath = await this.storagePolicy.ensureParentForWrite(
      projectPath,
      "source-review",
      "captures",
      captureId,
    );
    try {
      const existing = await readFile(capturePath);
      if (existing.equals(bytes)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const temporaryPath = `${capturePath}.${randomUUID()}.tmp`;
    let published = false;
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, capturePath);
      published = true;
      await syncDirectory(dirname(capturePath));
    } finally {
      if (!published) {
        await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
  }
}

type CaptureTextResult =
  | { status: "captured"; text: string }
  | { status: "unavailable"; reason: "binary" | "too-large" | "missing" };

async function readCaptureText(
  projectPath: string,
  captureBlobId: string,
  storagePolicy: ProjectStoragePolicy,
): Promise<CaptureTextResult> {
  for (const capturePath of storagePolicy.readPaths(
    projectPath,
    "source-review",
    "captures",
    captureBlobId,
  )) {
    try {
      const bytes = await readFile(capturePath);
      if (
        captureBlobId.length === 64 &&
        createHash("sha256").update(bytes).digest("hex") !== captureBlobId
      ) {
        continue;
      }
      if (bytes.length > MAX_CAPTURE_SOURCE_BYTES) {
        return { status: "unavailable", reason: "too-large" };
      }
      const text = decodeText(bytes);
      return text === null
        ? { status: "unavailable", reason: "binary" }
        : { status: "captured", text };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") break;
    }
  }
  try {
    const { stdout: sizeText } = await runGit(projectPath, [
      "cat-file",
      "-s",
      captureBlobId,
    ]);
    const size = Number(sizeText.trim());
    if (!Number.isSafeInteger(size) || size < 0) {
      return { status: "unavailable", reason: "missing" };
    }
    if (size > MAX_CAPTURE_SOURCE_BYTES) {
      return { status: "unavailable", reason: "too-large" };
    }
    const { stdout } = await runGitBytes(
      projectPath,
      ["cat-file", "blob", captureBlobId],
      { maxBuffer: MAX_CAPTURE_SOURCE_BYTES + 1 },
    );
    const text = decodeText(stdout);
    return text === null
      ? { status: "unavailable", reason: "binary" }
      : { status: "captured", text };
  } catch {
    return { status: "unavailable", reason: "missing" };
  }
}

async function resolveProjectionBytes(
  projectPath: string,
  projection: ReviewSourceProjection,
): Promise<Buffer> {
  try {
    if (projection.kind === "worktree") {
      const absolutePath = await repositoryFilePath(
        projectPath,
        projection.path,
      );
      const bytes = await readFile(absolutePath);
      if (bytes.length > MAX_CAPTURE_SOURCE_BYTES) {
        throw new Error("source projection is too large");
      }
      return bytes;
    }
    const objectSpec =
      projection.kind === "index"
        ? `:${projection.path}`
        : `${projection.revision}:${projection.path}`;
    const { stdout } = await runGitBytes(projectPath, ["show", objectSpec], {
      maxBuffer: MAX_CAPTURE_SOURCE_BYTES + 1,
    });
    return stdout;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      400,
      `Could not capture the rendered source projection for ${projection.path}`,
    );
  }
}

async function readGitBlobBytes(
  projectPath: string,
  blobId: string,
): Promise<Buffer> {
  const { stdout } = await runGitBytes(
    projectPath,
    ["cat-file", "blob", blobId],
    { maxBuffer: MAX_CAPTURE_SOURCE_BYTES + 1 },
  );
  return stdout;
}

async function readTextFileBounded(filePath: string): Promise<string | null> {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    if (stats.size > MAX_CAPTURE_SOURCE_BYTES) return null;
    const bytes = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    return decodeText(bytes.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, "");
}

function sourceNeighborhood(lines: string[], line: number): string {
  const index = line - 1;
  return lines
    .slice(
      Math.max(0, index - DEFAULT_SNIPPET_CONTEXT_RADIUS),
      Math.min(lines.length, index + DEFAULT_SNIPPET_CONTEXT_RADIUS + 1),
    )
    .join("\n");
}

async function resolveProjectionBlob(
  projectPath: string,
  projection: ReviewSourceProjection,
): Promise<string> {
  try {
    let stdout: string;
    if (projection.kind === "worktree") {
      const absolutePath = await repositoryFilePath(
        projectPath,
        projection.path,
      );
      ({ stdout } = await runGit(projectPath, [
        "hash-object",
        "-w",
        "--",
        absolutePath,
      ]));
    } else if (projection.kind === "index") {
      ({ stdout } = await runGit(projectPath, [
        "rev-parse",
        "--verify",
        `:${projection.path}`,
      ]));
    } else {
      ({ stdout } = await runGit(projectPath, [
        "rev-parse",
        "--verify",
        `${projection.revision}:${projection.path}`,
      ]));
    }
    const blobId = stdout.trim();
    if (!OBJECT_ID_RE.test(blobId))
      throw new Error("git returned an invalid blob id");
    await assertBlob(projectPath, blobId);
    return blobId;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      400,
      `Could not capture the rendered source projection for ${projection.path}`,
    );
  }
}

async function assertBlob(projectPath: string, blobId: string): Promise<void> {
  await runGit(projectPath, ["cat-file", "-e", `${blobId}^{blob}`]);
}

async function readCaptureTree(projectPath: string): Promise<{
  treeId: string | null;
  blobIds: Set<string>;
}> {
  let refTarget: string;
  try {
    const result = await runGit(projectPath, [
      "rev-parse",
      "--verify",
      SOURCE_REVIEW_CAPTURE_REF,
    ]);
    refTarget = result.stdout.trim();
  } catch {
    return { treeId: null, blobIds: new Set() };
  }
  let treeId: string;
  try {
    const result = await runGit(projectPath, [
      "rev-parse",
      "--verify",
      `${refTarget}^{tree}`,
    ]);
    treeId = result.stdout.trim();
  } catch {
    throw new Error("Source-review capture ref does not point to a tree");
  }
  if (!OBJECT_ID_RE.test(treeId)) {
    throw new Error("Source-review capture ref does not point to a valid tree");
  }
  const { stdout } = await runGit(projectPath, [
    "ls-tree",
    "-z",
    "--name-only",
    treeId,
  ]);
  const blobIds = new Set(stdout.split("\0").filter(Boolean));
  for (const id of blobIds) {
    if (!OBJECT_ID_RE.test(id)) {
      throw new Error("Source-review capture tree has an invalid entry name");
    }
  }
  return { treeId, blobIds };
}

async function writeCaptureTree(
  projectPath: string,
  blobIds: string[],
): Promise<string> {
  const input = blobIds.map((id) => `100644 blob ${id}\t${id}\0`).join("");
  const output = await runGitWithInput(projectPath, ["mktree", "-z"], input);
  const treeId = output.trim();
  if (!OBJECT_ID_RE.test(treeId)) {
    throw new Error("git mktree returned an invalid object id");
  }
  return treeId;
}

function runGitWithInput(
  projectPath: string,
  args: string[],
  input: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", buildGitArgs(projectPath, args), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("git mktree timed out"));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf-8"));
      else reject(new Error(Buffer.concat(stderr).toString("utf-8")));
    });
    child.stdin.end(input);
  });
}
