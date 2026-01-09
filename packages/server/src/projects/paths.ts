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

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";

/** The root directory where Claude stores project sessions */
export const CLAUDE_DIR =
  process.env.CLAUDE_SESSIONS_DIR?.replace(/\/projects$/, "") ??
  join(homedir(), ".claude");
export const CLAUDE_PROJECTS_DIR =
  process.env.CLAUDE_SESSIONS_DIR ?? join(CLAUDE_DIR, "projects");

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
export function getProjectName(projectPath: string): string {
  return basename(projectPath);
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

/**
 * Read the working directory (cwd) from a session file.
 * This is the most reliable way to get the actual project path.
 *
 * The cwd is stored in the first few lines of the JSONL file by the Claude SDK.
 *
 * @param sessionFilePath - Absolute path to the session .jsonl file
 * @returns The cwd field value, or null if not found
 */
export async function readCwdFromSessionFile(
  sessionFilePath: string,
): Promise<string | null> {
  try {
    const content = await readFile(sessionFilePath, { encoding: "utf-8" });
    const lines = content.split("\n").slice(0, 20); // Check first 20 lines

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (data.cwd && typeof data.cwd === "string") {
          return data.cwd;
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    return null;
  } catch {
    return null;
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
  if (relativePath.includes("projects/") && relativePath.endsWith(".jsonl")) {
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
  if (relativePath.startsWith("statsig/")) {
    return "telemetry";
  }

  return "other";
}
