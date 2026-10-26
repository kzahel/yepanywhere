import * as path from "node:path";

export type CodexRolloutRepresentation = "plain" | "zstd";

/** Native archives are siblings of the standard sessions root, not ancestors. */
export function getCodexSessionRoots(sessionsDir: string): string[] {
  return path.basename(sessionsDir) === "sessions"
    ? [sessionsDir, path.join(path.dirname(sessionsDir), "archived_sessions")]
    : [sessionsDir];
}

/** Active storage wins during an archive/unarchive copy transition. */
export function preferActiveCodexRollouts(
  sessionsDir: string,
  filePaths: string[],
): string[] {
  const roots = getCodexSessionRoots(sessionsDir);
  const isActive = (file: string) => {
    const relative = path.relative(sessionsDir, file);
    return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
  };
  const active = new Set(
    filePaths
      .filter(isActive)
      .map((file) => path.basename(plainCodexRolloutPath(file))),
  );
  return preferPlainCodexRollouts(filePaths).filter(
    (file) =>
      roots.length === 1 ||
      isActive(file) ||
      !active.has(path.basename(plainCodexRolloutPath(file))),
  );
}

export interface CodexRolloutDiscoveryIdentity {
  key: string;
  shardKey: string;
  relativePath: string;
  canonicalRelativePath: string;
  representation: CodexRolloutRepresentation;
}

export interface CodexRolloutFileIdentity {
  /** Stable logical thread id, encoded before an optional `_rollout-id`. */
  threadId: string;
  /** Physical immutable rollout id, encoded after `_` when it differs. */
  rolloutId: string;
  /** Canonical filename timestamp, when the provider supplied one. */
  timestamp?: string;
}

const CODEX_UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CODEX_ROLLOUT_IDS_PATTERN = new RegExp(
  `(${CODEX_UUID_PATTERN})(?:_(${CODEX_UUID_PATTERN}))?$`,
  "i",
);
const CODEX_ROLLOUT_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

export function isCodexRolloutFileName(name: string): boolean {
  return name.endsWith(".jsonl") || name.endsWith(".jsonl.zst");
}

export function getCodexRolloutFileIdentity(
  nameOrPath: string,
): CodexRolloutFileIdentity | null {
  const fileName = path.posix.basename(nameOrPath.replace(/\\/g, "/"));
  if (!fileName.startsWith("rollout-")) return null;
  const plainFileName = fileName.endsWith(".jsonl.zst")
    ? fileName.slice(0, -".jsonl.zst".length)
    : fileName.endsWith(".jsonl")
      ? fileName.slice(0, -".jsonl".length)
      : null;
  if (!plainFileName) return null;

  const core = plainFileName.slice("rollout-".length);
  const match = CODEX_ROLLOUT_IDS_PATTERN.exec(core);
  if (!match || (match.index > 0 && core[match.index - 1] !== "-")) {
    return null;
  }

  const threadId = match[1];
  if (!threadId) return null;
  const rolloutId = match[2] ?? threadId;
  const timestampCandidate =
    match.index > 0 ? core.slice(0, match.index - 1) : undefined;
  const timestamp =
    timestampCandidate &&
    CODEX_ROLLOUT_TIMESTAMP_PATTERN.test(timestampCandidate)
      ? timestampCandidate
      : undefined;

  return {
    threadId,
    rolloutId,
    ...(timestamp ? { timestamp } : {}),
  };
}

export function getCodexRolloutSessionId(nameOrPath: string): string | null {
  return getCodexRolloutFileIdentity(nameOrPath)?.threadId ?? null;
}

export function getCodexRolloutId(nameOrPath: string): string | null {
  return getCodexRolloutFileIdentity(nameOrPath)?.rolloutId ?? null;
}

export function isCompressedCodexRolloutPath(filePath: string): boolean {
  return filePath.endsWith(".jsonl.zst");
}

export function plainCodexRolloutPath(filePath: string): string {
  return isCompressedCodexRolloutPath(filePath)
    ? filePath.slice(0, -".zst".length)
    : filePath;
}

export function preferPlainCodexRollouts(filePaths: string[]): string[] {
  const plainPaths = new Set(
    filePaths
      .filter((filePath) => filePath.endsWith(".jsonl"))
      .map((filePath) => filePath),
  );

  return filePaths.filter((filePath) => {
    if (!isCompressedCodexRolloutPath(filePath)) return true;
    return !plainPaths.has(plainCodexRolloutPath(filePath));
  });
}

export function codexRolloutRepresentation(
  filePath: string,
): CodexRolloutRepresentation {
  return isCompressedCodexRolloutPath(filePath) ? "zstd" : "plain";
}

/**
 * Windows can defer a file's last-write timestamp until every write handle is
 * closed. Codex keeps plain rollout files open for the lifetime of a session,
 * while Windows change time advances on each append. Keep mtime authoritative
 * everywhere else, including immutable compressed rollouts.
 */
export function getCodexRolloutActivityTimeMs(
  filePath: string,
  stats: { mtimeMs: number | bigint; ctimeMs: number | bigint },
  platform: NodeJS.Platform = process.platform,
): number {
  const mtimeMs = Number(stats.mtimeMs);
  if (platform !== "win32" || isCompressedCodexRolloutPath(filePath)) {
    return mtimeMs;
  }

  const ctimeMs = Number(stats.ctimeMs);
  return Number.isFinite(ctimeMs) ? Math.max(mtimeMs, ctimeMs) : mtimeMs;
}

export function getCodexRolloutDiscoveryIdentity(
  sessionsDir: string,
  filePath: string,
): CodexRolloutDiscoveryIdentity {
  const relativePath = path.relative(sessionsDir, filePath).replace(/\\/g, "/");
  const canonicalRelativePath = plainCodexRolloutPath(relativePath);
  const shardDir = path.posix.dirname(canonicalRelativePath);
  return {
    key: path.posix.basename(canonicalRelativePath),
    shardKey: shardDir === "." ? "_root" : shardDir,
    relativePath,
    canonicalRelativePath,
    representation: codexRolloutRepresentation(filePath),
  };
}
