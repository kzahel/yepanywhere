/**
 * Bounded hover-card excerpts (topics/session-hovercard-recent-activity.md):
 * the latest regular agent turn, read backward from the end of a native
 * transcript within TRANSCRIPT_TAIL_POINT_BYTE_BUDGET. Prose found inside the
 * budget is the exact answer. A tool label is the answer only once the read
 * reaches the start of a self-contained transcript with no prose. Anything
 * else is unknown and returns undefined rather than falling back to a
 * complete read (topics/provider-history-facts.md).
 */
import {
  isSyntheticNoResponseTurn,
  parseCodexSessionEntry,
  type CodexSessionEntry,
} from "@yep-anywhere/shared";
import {
  assistantContentParts,
  formatAgentExcerpt,
  scanAgentExcerpt,
  systemAwaySummaryExcerpt,
  toolExcerpt,
} from "./agent-excerpt.js";
import { isCompressedCodexRolloutPath } from "../utils/codexRolloutFiles.js";
import { normalizeConversationEntries } from "./normalization.js";
import {
  createTailPointQuery,
  readLinesBackward,
  TRANSCRIPT_TAIL_POINT_BYTE_BUDGET,
} from "./transcript-tail.js";

/** Undefined is unknown; the wrapper lets the cache retain that answer too. */
interface ExcerptAnswer {
  excerpt?: string;
}

const RETAINED_ANSWER_BYTES = 2 * 1024 * 1024;
const estimateBytes = (answer: ExcerptAnswer) =>
  128 + (answer.excerpt?.length ?? 0) * 2;

const claudeExcerpts = createTailPointQuery<ExcerptAnswer>({
  name: "claude-latest-agent-excerpt",
  maxRetainedBytes: RETAINED_ANSWER_BYTES,
  estimateBytes,
  compute: async (filePath, size) => {
    let trailingTool: string | undefined;
    for await (const batch of readLinesBackward(filePath, {
      endByte: size,
      maxBytes: TRANSCRIPT_TAIL_POINT_BYTE_BUDGET,
    })) {
      for (let i = batch.lines.length - 1; i >= 0; i--) {
        let entry: {
          type?: string;
          message?: { content?: unknown };
        };
        try {
          entry = JSON.parse(batch.lines[i]!);
        } catch {
          continue;
        }
        const awaySummary = systemAwaySummaryExcerpt(entry);
        if (awaySummary) return { excerpt: awaySummary };
        if (entry?.type !== "assistant") continue;
        // No model produced this text, so quoting it would attribute a reply
        // to the agent that it never gave.
        if (isSyntheticNoResponseTurn(entry)) continue;
        const { text, toolName } = assistantContentParts(
          entry.message?.content,
        );
        const excerpt = formatAgentExcerpt(text);
        if (excerpt) return { excerpt };
        if (!trailingTool && toolName) trailingTool = toolName;
      }
      if (batch.reachedStart) return { excerpt: toolExcerpt(trailingTool) };
    }
    return {};
  },
});

const codexExcerpts = createTailPointQuery<ExcerptAnswer>({
  name: "codex-latest-agent-excerpt",
  maxRetainedBytes: RETAINED_ANSWER_BYTES,
  estimateBytes,
  compute: async (filePath, size) => {
    // Codex presentation pairs records (calls with outputs, response items
    // with their events, compaction output with its checkpoint), so each
    // batch re-normalizes the whole window with the full reader's rules
    // rather than classifying lines one at a time.
    let entries: CodexSessionEntry[] = [];
    for await (const batch of readLinesBackward(filePath, {
      endByte: size,
      maxBytes: TRANSCRIPT_TAIL_POINT_BYTE_BUDGET,
    })) {
      const older: CodexSessionEntry[] = [];
      for (const line of batch.lines) {
        const entry = parseCodexSessionEntry(line);
        if (entry) older.push(entry);
      }
      entries = older.concat(entries);
      const { prose, trailingTool } = scanAgentExcerpt(
        normalizeConversationEntries({ provider: "codex", entries }, ""),
      );
      if (prose) return { excerpt: prose };
      if (batch.reachedStart) {
        // A forked rollout starts from its parent's history, which this file
        // does not contain; the parent may hold the prose. Only parsed
        // metadata can show the rollout is self-contained.
        const meta = entries[0];
        const selfContained =
          meta?.type === "session_meta" && !meta.payload.history_base;
        return selfContained ? { excerpt: toolExcerpt(trailingTool) } : {};
      }
    }
    return {};
  },
});

async function answer(
  query: (filePath: string) => Promise<ExcerptAnswer | undefined>,
  filePath: string,
): Promise<string | undefined> {
  try {
    return (await query(filePath))?.excerpt;
  } catch {
    // A transcript that vanished or shrank mid-read has no answer to give.
    return undefined;
  }
}

export function readClaudeLatestAgentExcerpt(
  filePath: string,
): Promise<string | undefined> {
  return answer(claudeExcerpts, filePath);
}

/** Compressed rollouts cannot be read from the end, so theirs is unknown. */
export async function readCodexLatestAgentExcerpt(
  filePath: string,
): Promise<string | undefined> {
  if (isCompressedCodexRolloutPath(filePath)) return undefined;
  return answer(codexExcerpts, filePath);
}
