/**
 * The rewind bound (topics/session-rewind.md), stored as
 * `SessionRewindRecord.droppedThroughMessageId`: the non-empty string uuid of
 * the last non-progress row, in file order, among a Claude transcript's lines
 * that parse. File order needs no branch selection, so a bounded read
 * backward from the end finds it without loading the rest of the transcript,
 * and it equals the complete read's answer whenever that read succeeds. When
 * the bounded read cannot decide, the named complete read decides instead: a
 * missing bound would make the rewind group fall back to timestamps
 * (topics/provider-history-facts.md).
 */
import type { UrlProjectId } from "@yep-anywhere/shared";
import { lastRewindableClaudeRowId } from "./claude-messages.js";
import {
  createTailPointQuery,
  readLinesBackward,
  TRANSCRIPT_TAIL_POINT_BYTE_BUDGET,
} from "./transcript-tail.js";
import type { ISessionReader, RewindBoundRead } from "./types.js";

const tailBounds = createTailPointQuery<RewindBoundRead>({
  name: "claude-rewind-bound",
  maxRetainedBytes: 1024 * 1024,
  estimateBytes: () => 256,
  compute: async (filePath, size) => {
    for await (const batch of readLinesBackward(filePath, {
      endByte: size,
      maxBytes: TRANSCRIPT_TAIL_POINT_BYTE_BUDGET,
    })) {
      for (let i = batch.lines.length - 1; i >= 0; i--) {
        // The complete reader trims each line (dropping CR and any BOM) and
        // parses it, keeping an unterminated last line that parses and
        // skipping one that does not.
        let row: unknown;
        try {
          row = JSON.parse(batch.lines[i]!.trim());
        } catch {
          continue;
        }
        // A row that is not an object has no uuid and is skipped.
        if (!row || typeof row !== "object") continue;
        const { type, uuid } = row as { type?: unknown; uuid?: unknown };
        if (type === "progress") continue;
        if (typeof uuid === "string" && uuid) return { rowId: uuid };
      }
    }
    // Beyond the budget, or a transcript with no such row, where the answer
    // also depends on whether the complete reader yields a session at all.
    return "unknown";
  },
});

/** The bounded read of one Claude transcript file. */
export async function readClaudeTailRewindBound(
  filePath: string,
): Promise<RewindBoundRead> {
  try {
    return (await tailBounds(filePath)) ?? "unknown";
  } catch {
    // Vanished, shrank or unreadable mid-read: the complete read decides.
    return "unknown";
  }
}

/**
 * The bound for a session already resolved to `reader`, or undefined for a
 * session that is not Claude or has no such row. A bounded read answers when
 * it can; otherwise this takes the complete read.
 */
export async function readSessionRewindBoundRowId(
  reader: ISessionReader,
  nativeSessionId: string,
  projectId: UrlProjectId,
): Promise<string | undefined> {
  const bounded = await reader.readRewindBound?.(nativeSessionId);
  if (bounded && typeof bounded === "object") return bounded.rowId;
  const loaded = await reader.getSession(
    nativeSessionId,
    projectId,
    undefined,
    { includeOrphans: false },
  );
  const data = loaded?.data;
  switch (data?.provider) {
    case "claude":
    case "claude-gateway":
    case "claude-ollama":
      return lastRewindableClaudeRowId(data.session.messages);
    default:
      return undefined;
  }
}
