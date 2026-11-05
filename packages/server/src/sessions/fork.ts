import {
  captureClaudeCopyBoundary,
  type ClaudeCopyBoundary,
} from "./claude-copy-boundary.js";
/**
 * Legacy Claude storage cloning. Codex clones use the native fork adapter.
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Until scoped cold launch is qualified, copies must remain CLI-discoverable. */
export async function assertClaudeCopyRoot(
  storageScope: string,
  configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
): Promise<void> {
  const projects = await realpath(join(configDir, "projects")).catch(
    () => undefined,
  );
  if (!projects || dirname(storageScope) !== projects)
    throw new Error(
      "Claude copy source is outside the launch transcript store; scoped resume is not qualified",
    );
}

/** A session id names one file in the directory, never a path. */
const CLONE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertCloneSessionId(sessionId: string): void {
  if (!CLONE_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("Invalid Claude session id for clone");
  }
}

/**
 * Result of cloning a session.
 */
export interface CloneResult {
  copyBoundary?: ClaudeCopyBoundary;
  /** The new session ID */
  newSessionId: string;
  /** Number of JSONL entries copied */
  entries: number;
}

/**
 * Clone a Claude session by copying the JSONL file with a new session_id.
 *
 * The clone copies the entire conversation history, preserving:
 * - All messages (user, assistant, system)
 * - DAG structure (uuid/parentUuid relationships)
 * - Tool use history
 *
 * The only change is the session_id field (when present) is updated to the new ID.
 *
 * Neither file is opened through a symbolic link, and the clone never
 * replaces an existing file: a sandboxed session's directory is writable by
 * its agent, which could otherwise plant a link that redirects the host-side
 * copy (topics/session-sandboxing.md § Session Lifetime). Pass such a
 * directory as an already anchored `/proc/self/fd/<fd>` path.
 *
 * @param sessionDir - Directory containing session JSONL files
 * @param sourceSessionId - The session ID to clone
 * @param newSessionId - Optional new session ID (generated if not provided)
 * @returns Clone result with new session ID and entry count
 */
export async function cloneClaudeSession(
  sessionDir: string,
  sourceSessionId: string,
  newSessionId?: string,
): Promise<CloneResult> {
  assertCloneSessionId(sourceSessionId);
  const source = await open(
    join(sessionDir, `${sourceSessionId}.jsonl`),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let content: string;
  try {
    content = await source.readFile("utf-8");
  } finally {
    await source.close();
  }
  const trimmed = content.trim();

  if (!trimmed) {
    throw new Error("Source session is empty");
  }

  const lines = trimmed.split("\n");
  const targetId = newSessionId ?? randomUUID();
  assertCloneSessionId(targetId);

  // Transform each line: update session_id if present
  let copiedEntries = 0;
  let copyBoundary: ClaudeCopyBoundary | undefined;
  const transformedLines = lines.map((line) => {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;

      // Update session_id if present (some entries have it, some don't)
      if ("session_id" in entry) {
        entry.session_id = targetId;
      }

      const tip = captureClaudeCopyBoundary([entry]);
      if (tip)
        copyBoundary = {
          kind: "claude-rows",
          entries: copiedEntries + 1,
          anchor: { index: copiedEntries, uuid: tip.anchor.uuid },
        };
      copiedEntries++;
      return JSON.stringify(entry);
    } catch {
      // Keep malformed lines as-is (shouldn't happen, but be safe)
      return line;
    }
  });

  const target = await open(
    join(sessionDir, `${targetId}.jsonl`),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await target.writeFile(`${transformedLines.join("\n")}\n`, "utf-8");
  } finally {
    await target.close();
  }

  if (copyBoundary) {
    copyBoundary.entries = copiedEntries;
    if (copiedEntries - copyBoundary.anchor.index > 256)
      copyBoundary = undefined;
  }
  return {
    newSessionId: targetId,
    entries: lines.length,
    copyBoundary,
  };
}
