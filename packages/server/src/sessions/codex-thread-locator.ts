import type { SessionDiscoveryIndex } from "../indexes/SessionDiscoveryIndex.js";
import { getLogger } from "../logging/logger.js";
import { getProjectIdentityKey } from "../projects/paths.js";
import { getCodexRolloutSessionId } from "../utils/codexRolloutFiles.js";
import { readCodexSessionFile } from "./codex-discovery.js";
import { codexRootFileIndex } from "./codex-root-file-index.js";
import type { CodexSessionFile } from "./codex-shared-scan-cache.js";
import {
  createCodexRolloutPathMapper,
  openCodexStateQuery,
} from "./codex-thread-index.js";
import { getForkedSessionFile } from "./fork-discovery.js";

// Pinned rust-v0.169.0 rollout/src/list.rs find_thread_path_by_id_str_in_subdir
// asks `threads` for rollout_path before searching filenames, and
// state/migrations/0001_threads.sql makes `id` the primary key.
const ROLLOUT_PATH = `SELECT rollout_path AS rolloutPath FROM threads
  WHERE id = ?`;

const THREAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why the native row did not answer; every reason means enumerate. */
export type CodexThreadFallback =
  | "unsupported-id"
  | "unavailable"
  | "missing-row"
  | "archived"
  | "outside"
  | "escaped"
  | "missing-file"
  | "mismatched-name"
  | "mismatched-head";

export type CodexThreadLocation =
  /** A null session is a rejected fork hint, which readers report as absent. */
  | {
      kind: "found";
      session: CodexSessionFile | null;
      via: "index" | "fork" | "sql";
    }
  /** The root's authority changed during the lookup; start again. */
  | { kind: "retry" }
  /** The caller closed: nothing was published, and it must not enumerate. */
  | { kind: "retired" }
  | { kind: "fallback"; reason: CodexThreadFallback };

export interface CodexThreadLookup {
  sessionsDir: string;
  threadId: string;
  /** The caller's head reader; defaults to discovery metadata. */
  readMeta?: (filePath: string) => Promise<CodexSessionFile | null>;
  discoveryIndex?: SessionDiscoveryIndex;
  /** A project reader's filter applies only to the fork hint, as before. */
  projectIdentityKey?: string | undefined;
  /** A closed caller neither opens SQL, publishes, nor falls back. */
  isRetired?: () => boolean;
}

/**
 * Physical point location of one logical thread in one native root, without
 * enumerating it: the accepted root index, the YA fork hint, then Codex's
 * `threads` row. The result is root-wide and includes subagents; callers that
 * need narrower semantics filter it. A fallback is never native absence, and
 * a row never serves rollout-id (ancestor) lookups. Published points merge
 * under `isNewerCodexSessionFile`, so a known filename-newer rollout keeps
 * precedence over a row that lags a revert.
 */
export async function locateCodexThread(
  lookup: CodexThreadLookup,
): Promise<CodexThreadLocation> {
  const { sessionsDir, threadId } = lookup;
  const index = codexRootFileIndex(sessionsDir);
  const read = index.readVersion();
  const known = index.getSession(threadId);
  if (known) return { kind: "found", session: known, via: "index" };
  const readMeta =
    lookup.readMeta ??
    ((filePath: string) =>
      readCodexSessionFile({
        sessionsDir,
        filePath,
        ...(lookup.discoveryIndex
          ? { discoveryIndex: lookup.discoveryIndex }
          : {}),
      }));
  const retired = () => lookup.isRetired?.() === true;
  // Synchronous from the check to observePoints: no await can interleave.
  const publish = (
    session: CodexSessionFile,
    via: "fork" | "sql",
  ): CodexThreadLocation => {
    if (retired()) return { kind: "retired" };
    if (!index.accepts(read)) return { kind: "retry" };
    index.observePoints([session], read);
    return { kind: "found", session: index.getSession(threadId) ?? null, via };
  };

  // Fork completion supplies an exact path before the scan cache catches up.
  // Read only that file; an older in-flight scan cannot erase this hint.
  const forkPath = await getForkedSessionFile("codex", threadId, sessionsDir);
  if (forkPath) {
    const session = await readMeta(forkPath);
    if (
      session?.id === threadId &&
      !session.isSubagent &&
      (!lookup.projectIdentityKey ||
        getProjectIdentityKey(session.cwd) === lookup.projectIdentityKey)
    )
      return publish(session, "fork");
    if (session) return { kind: "found", session: null, via: "fork" };
  }

  if (retired()) return { kind: "retired" };
  const row = await readThreadRow(lookup, readMeta);
  const outcome = "reason" in row ? row.reason : "hit";
  getLogger().debug(
    { event: "codex_thread_locator", outcome },
    `CODEX_THREAD_LOCATOR: ${outcome}`,
  );
  if (!("reason" in row)) return publish(row.session, "sql");
  return retired()
    ? { kind: "retired" }
    : { kind: "fallback", reason: row.reason };
}

/** A validated `threads` row for this root, or why it cannot be trusted. */
async function readThreadRow(
  { sessionsDir, threadId }: CodexThreadLookup,
  readMeta: (filePath: string) => Promise<CodexSessionFile | null>,
): Promise<{ session: CodexSessionFile } | { reason: CodexThreadFallback }> {
  if (!THREAD_ID.test(threadId)) return { reason: "unsupported-id" };
  const lease = await openCodexStateQuery(sessionsDir, ROLLOUT_PATH);
  if (!lease) return { reason: "unavailable" };
  let rolloutPath: unknown;
  try {
    rolloutPath = lease.query.get<{ rolloutPath: unknown }>(
      threadId,
    )?.rolloutPath;
  } catch {
    // Busy or locked: the synchronous adapter sets no busy timeout.
    return { reason: "unavailable" };
  } finally {
    lease.close();
  }
  if (typeof rolloutPath !== "string") return { reason: "missing-row" };
  try {
    const located =
      await createCodexRolloutPathMapper(sessionsDir)(rolloutPath);
    if (located.kind !== "active")
      return {
        reason: located.kind === "missing" ? "missing-file" : located.kind,
      };
    // Rows are never pruned, and a row can lag its rollout; only a filename
    // and head naming this thread prove the file is still its rollout.
    if (getCodexRolloutSessionId(located.path) !== threadId)
      return { reason: "mismatched-name" };
    const session = await readMeta(located.path);
    return session?.id === threadId
      ? { session }
      : { reason: "mismatched-head" };
  } catch {
    return { reason: "missing-file" };
  }
}
