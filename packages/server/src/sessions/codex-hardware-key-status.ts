import { basename, dirname, join } from "node:path";
import type {
  NativeSessionRef,
  ProviderRuntimeStatus,
} from "@yep-anywhere/shared";
import { openCodexStateQuery } from "./codex-thread-index.js";

const LATEST_TURN = `SELECT turn_id, status, completed_at,
  CASE WHEN length(error_json) <= 4096 THEN error_json END AS error_json
  FROM thread_turns INDEXED BY idx_thread_turns_page
  WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1`;

/** Recover a provider error that Codex persisted outside the rollout. */
export async function readCodexHardwareKeyStatus(
  native: NativeSessionRef,
): Promise<ProviderRuntimeStatus> {
  const root = native.storageScope;
  if (native.family !== "codex" || basename(root).toLowerCase() !== "sessions")
    return null;
  const lease = await openCodexStateQuery(
    root,
    LATEST_TURN,
    join(dirname(root), "thread_history_1.sqlite"),
  );
  if (!lease) return null;
  try {
    const turn = lease.query.get<{
      turn_id: string;
      status: string;
      completed_at: number | null;
      error_json: string | null;
    }>(native.id);
    if (turn?.status !== "failed" || !turn.error_json || !turn.completed_at)
      return null;
    const error: { codexErrorInfo?: unknown; message?: unknown } = JSON.parse(
      turn.error_json,
    );
    if (
      error.codexErrorInfo !== "cyberPolicy" ||
      typeof error.message !== "string" ||
      !/re-authenticate with your hardware key/i.test(error.message)
    )
      return null;
    return {
      kind: "terminal",
      provider: "codex",
      reason: "unknown",
      message: error.message,
      turnId: turn.turn_id,
      occurredAt: new Date(turn.completed_at * 1000).toISOString(),
      source: "codex.error",
    };
  } catch {
    return null;
  } finally {
    lease.close();
  }
}
