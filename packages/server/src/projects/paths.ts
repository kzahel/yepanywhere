/**
 * Project Path Utilities
 *
 * This module handles the different path encoding schemes used in Claude's
 * session storage. There are TWO different encodings to be aware of:
 *
 * ## 1. Project ID (used in URLs/API)
 *
 * The `projectId` is a **base64url** encoding of the absolute project path.
 * Example: `/home/user/my-project` → `L2hvbWUvdXNlci9teS1wcm9qZWN0`
 *
 * This encoding is:
 * - Reversible via `decodeProjectId()`
 * - URL-safe (no special characters)
 * - Used in API routes and client URLs
 *
 * ## 2. Directory Names (in ~/.claude/projects/)
 *
 * Session files are stored in directories with **slash-to-hyphen** encoding.
 * Example: `/home/user/my-project` → `-home-user-my-project`
 *
 * The directory structure is:
 * ```
 * ~/.claude/projects/
 *   ├── -home-user-project/              # Direct encoding (no hostname)
 *   │   └── session-123.jsonl
 *   └── hostname/                        # With hostname prefix
 *       └── -home-user-project/
 *           └── session-456.jsonl
 * ```
 *
 * ## Why Two Encodings?
 *
 * The slash-to-hyphen encoding is **LOSSY** - you cannot reliably decode it
 * back to the original path because hyphens in the original path create
 * ambiguity:
 *
 * Directory: `-home-user-name-my-project`
 * Could be:  `/home/user-name/my-project`
 *       or:  `/home/user/name-my-project`
 *       or:  `/home/user/name/my-project`
 *
 * ## The Solution: Read CWD from Session Files
 *
 * Instead of decoding directory names, we read the actual project path from
 * the `cwd` field in session JSONL files. This is reliable because the Claude
 * SDK writes the working directory to session files when they're created.
 *
 * See `ProjectScanner.getProjectPathFromSessions()` for the implementation.
 *
 * ## Best Practices
 *
 * 1. Always use `Project.path` for the absolute path - never try to decode
 *    directory names.
 * 2. Use `projectId` (base64url) for API calls and URLs.
 * 3. Use `Project.sessionDir` to access the session files directory.
 * 4. Use `getSessionFilePath()` to construct paths to specific session files.
 */

import { open } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { stripBom } from "../utils/jsonl.js";

/** Check if a path is absolute (works for both Unix and Windows paths). */
export function isAbsolutePath(p: string): boolean {
  return isAbsolute(p);
}

/** The root directory where Claude stores project sessions */
export const CLAUDE_DIR =
  process.env.CLAUDE_SESSIONS_DIR?.replace(
    new RegExp(`\\${sep}projects$`),
    "",
  ) ??
  process.env.CLAUDE_CONFIG_DIR ??
  join(homedir(), ".claude");
export const CLAUDE_PROJECTS_DIR =
  process.env.CLAUDE_SESSIONS_DIR ?? join(CLAUDE_DIR, "projects");
export const DETACHED_PROJECT_PATH = join(tmpdir(), "yep-anywhere-no-project");
export const DETACHED_PROJECT_NAME = "No project";

/** Stable private workspace; never grants access to the shared detached root. */
export function limitedDetachedProjectPath(username: string): string {
  return join(
    DETACHED_PROJECT_PATH,
    "users",
    Buffer.from(username).toString("base64url"),
  );
}

/** Root for Grok Build sessions (persistent across restarts, similar to Gemini/Codex) */
export const GROK_DIR =
  process.env.GROK_SESSIONS_DIR?.replace(new RegExp(`\\${sep}sessions$`), "") ??
  join(homedir(), ".grok");
export const GROK_SESSIONS_DIR =
  process.env.GROK_SESSIONS_DIR ?? join(GROK_DIR, "sessions");

/** Session-scoped Grok media roots YA may materialize (images + videos). */
export function grokSessionMediaRoots(
  sessionsDir: string,
  projectPath: string,
  sessionId: string,
): string[] {
  const sessionDir = join(
    sessionsDir,
    encodeURIComponent(projectPath),
    sessionId,
  );
  return [join(sessionDir, "images"), join(sessionDir, "videos")];
}

/** Root for pi sessions (append-only JSONL, persistent across restarts) */
export const PI_DIR =
  process.env.PI_SESSIONS_DIR?.replace(new RegExp(`\\${sep}sessions$`), "") ??
  join(homedir(), ".pi", "agent");
export const PI_SESSIONS_DIR =
  process.env.PI_SESSIONS_DIR ?? join(PI_DIR, "sessions");

/**
 * Encode an absolute project path to a projectId (base64url).
 * This is reversible via `decodeProjectId()`.
 *
 * @example
 * encodeProjectId("/home/user/my-project")
 * // => "L2hvbWUvdXNlci9teS1wcm9qZWN0"
 */
export function encodeProjectId(path: string): UrlProjectId {
  return Buffer.from(path).toString("base64url") as UrlProjectId;
}

/**
 * Decode a projectId back to an absolute project path.
 *
 * @example
 * decodeProjectId("L2hvbWUvdXNlci9teS1wcm9qZWN0")
 * // => "/home/user/my-project"
 */
export function decodeProjectId(id: UrlProjectId): string {
  return Buffer.from(id, "base64url").toString("utf-8");
}

/**
 * Get the name (basename) of a project from its path.
 *
 * @example
 * getProjectName("/home/user/my-project")
 * // => "my-project"
 */
export function isDetachedProjectPath(projectPath: string): boolean {
  const normalized = canonicalizeProjectPath(projectPath);
  return (
    normalized === canonicalizeProjectPath(DETACHED_PROJECT_PATH) ||
    dirname(normalized) ===
      canonicalizeProjectPath(join(DETACHED_PROJECT_PATH, "users"))
  );
}

export function getProjectName(projectPath: string): string {
  return isDetachedProjectPath(projectPath)
    ? DETACHED_PROJECT_NAME
    : basename(projectPath);
}

/**
 * Names a project for display: the user's chosen project name when one is
 * stored, else {@link getProjectName}. `ProjectMetadataService` owns the
 * chosen name, so surfaces that name a project take this rather than calling
 * {@link getProjectName} on its path.
 */
export type ProjectDisplayNameResolver = (projectPath: string) => string;

/**
 * Canonicalize a project path for identity comparisons.
 *
 * This keeps the path semantically the same while normalizing Windows-only
 * variations that otherwise create duplicate project records:
 * - backslashes vs forward slashes
 * - lowercase vs uppercase drive letters
 */
export function canonicalizeProjectPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.replace(/^([a-z]):/, (_match, drive: string) => {
    return `${drive.toUpperCase()}:`;
  });
}

function isWindowsProjectPath(path: string): boolean {
  return /^[a-zA-Z]:\//.test(path) || /^\/\/[^/]+\/[^/]+(?:\/|$)/.test(path);
}

/**
 * Return the internal identity key used for project membership comparisons.
 *
 * Windows drive paths are case-insensitive in the common Win32 path model, so
 * path spellings that differ only by casing should not create separate YA
 * projects. POSIX/WSL-style paths remain case-sensitive.
 */
export function getProjectIdentityKey(path: string): string {
  const normalized = canonicalizeProjectPath(path);
  return isWindowsProjectPath(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

/**
 * Normalize a project path for cross-machine deduplication.
 *
 * Strips OS-specific home directory prefixes so the same project
 * on different machines (macOS vs Linux) merges into one entry.
 *
 * @example
 * normalizeProjectPathForDedup("/Users/kgraehl/dotfiles")  // => "kgraehl/dotfiles"
 * normalizeProjectPathForDedup("/home/kgraehl/dotfiles")   // => "kgraehl/dotfiles"
 * normalizeProjectPathForDedup("/root/dotfiles")           // => "root/dotfiles"
 * normalizeProjectPathForDedup("/opt/shared/project")      // => "/opt/shared/project"
 */
export function normalizeProjectPathForDedup(path: string): string {
  const normalized = canonicalizeProjectPath(path);
  const caseInsensitive = isWindowsProjectPath(normalized);
  // Unix: /Users/kgraehl/dotfiles or /home/kgraehl/dotfiles
  const unixMatch = normalized.match(/^\/(?:Users|home)\/(.+)$/);
  if (unixMatch?.[1]) return unixMatch[1];
  // Windows: C:/Users/kgraehl/dotfiles (after backslash normalization)
  const winMatch = normalized.match(/^[a-zA-Z]:\/(?:Users|home)\/(.+)$/i);
  if (winMatch?.[1]) {
    return caseInsensitive ? winMatch[1].toLowerCase() : winMatch[1];
  }
  const rootMatch = normalized.match(/^\/root\/(.+)$/);
  if (rootMatch?.[1]) return `root/${rootMatch[1]}`;
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

/**
 * Get the full path to a session file.
 *
 * @param sessionDir - The project's session directory (Project.sessionDir)
 * @param sessionId - The session ID (filename without .jsonl)
 *
 * @example
 * getSessionFilePath("/home/user/.claude/projects/-home-user-proj", "abc123")
 * // => "/home/user/.claude/projects/-home-user-proj/abc123.jsonl"
 */
export function getSessionFilePath(
  sessionDir: string,
  sessionId: string,
): string {
  return join(sessionDir, `${sessionId}.jsonl`);
}

/**
 * Extract the session ID from a file path.
 * Works with both absolute paths and relative paths.
 *
 * @example
 * getSessionIdFromPath("/path/to/projects/xxx/my-session.jsonl")
 * // => "my-session"
 *
 * getSessionIdFromPath("projects/xxx/my-session.jsonl")
 * // => "my-session"
 */
export function getSessionIdFromPath(filePath: string): string | null {
  const match = filePath.match(/([^/\\]+)\.jsonl$/);
  return match?.[1] ?? null;
}

const CWD_SCAN_CHUNK_BYTES = 8192;
const CWD_SCAN_MAX_BYTES = 256 * 1024;

function extractCwdFromJsonLine(line: string): string | null {
  const trimmed = stripBom(line).trim();
  if (!trimmed) return null;

  try {
    const data = JSON.parse(trimmed) as { cwd?: unknown };
    if (typeof data.cwd === "string") {
      return data.cwd;
    }
  } catch {
    // Skip invalid or partial JSONL lines.
  }

  return null;
}

/**
 * Read the working directory (cwd) from a session file.
 * This is the most reliable way to get the actual project path.
 *
 * The cwd is stored near the start of Claude JSONL files, but YA queue
 * bookkeeping can prepend long prompt lines before the first cwd-bearing entry.
 * Scan complete JSONL records up to a bounded prefix rather than assuming a
 * single fixed-size read reaches the field.
 *
 * @param sessionFilePath - Absolute path to the session .jsonl file
 * @returns The cwd field value, or null if not found
 */
export async function readCwdFromSessionFile(
  sessionFilePath: string,
): Promise<string | null> {
  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fd = await open(sessionFilePath, "r");
    const decoder = new StringDecoder("utf8");
    let bytesScanned = 0;
    let pending = "";

    while (bytesScanned < CWD_SCAN_MAX_BYTES) {
      const bytesToRead = Math.min(
        CWD_SCAN_CHUNK_BYTES,
        CWD_SCAN_MAX_BYTES - bytesScanned,
      );
      const buf = Buffer.alloc(bytesToRead);
      const { bytesRead } = await fd.read(buf, 0, bytesToRead, bytesScanned);
      if (bytesRead === 0) {
        break;
      }

      bytesScanned += bytesRead;
      pending += decoder.write(buf.subarray(0, bytesRead));

      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const cwd = extractCwdFromJsonLine(line);
        if (cwd) return cwd;
      }
    }

    pending += decoder.end();
    const cwd = extractCwdFromJsonLine(pending);
    if (cwd) return cwd;

    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  } finally {
    await fd?.close();
  }
}

/**
 * Determine the file type from a relative path within ~/.claude.
 *
 * @param relativePath - Path relative to ~/.claude (e.g., "projects/xxx/session.jsonl")
 */
export function getFileTypeFromRelativePath(
  relativePath: string,
):
  | "session"
  | "agent-session"
  | "settings"
  | "credentials"
  | "telemetry"
  | "other" {
  // Session files: projects/<encoded-path>/<session-id>.jsonl
  if (
    (relativePath.includes("projects/") ||
      relativePath.includes("projects\\")) &&
    relativePath.endsWith(".jsonl")
  ) {
    const filename = basename(relativePath);
    if (filename.startsWith("agent-")) {
      return "agent-session";
    }
    return "session";
  }

  // Settings file
  if (relativePath === "settings.json") {
    return "settings";
  }

  // Credentials
  if (
    relativePath === "credentials.json" ||
    relativePath.includes("credentials")
  ) {
    return "credentials";
  }

  // Telemetry (statsig, analytics)
  if (
    relativePath.startsWith("statsig/") ||
    relativePath.startsWith("statsig\\")
  ) {
    return "telemetry";
  }

  return "other";
}
