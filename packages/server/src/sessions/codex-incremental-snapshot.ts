import { stat } from "node:fs/promises";
import type { CodexSessionEntry } from "@yep-anywhere/shared";
import type { SessionSummary } from "../supervisor/types.js";
import { normalizeSession } from "./normalization.js";
import type {
  CodexCompactTailSnapshot,
  CodexRolloutWindowReader,
} from "./codex-rollout-window.js";

interface IncrementalSnapshotContext {
  cached?: {
    filePath: string;
    startByte: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
  };
  readEntries(
    sessionId: string,
    filePath: string,
    options: { purpose: "detail"; startByte: number },
  ): Promise<{
    entries: CodexSessionEntry[];
    transcriptSnapshotUpdatedAt: string;
  }>;
  windowReader: CodexRolloutWindowReader;
}

/** Validate bounded catch-up against the same durable anchor and tool context. */
export async function readCodexIncrementalSnapshot(
  context: IncrementalSnapshotContext,
  sessionId: string,
  filePath: string,
  stats: Awaited<ReturnType<typeof stat>>,
  compactBoundaries: number,
  afterMessageId: string,
  summary: SessionSummary,
): Promise<CodexCompactTailSnapshot | null> {
  const cached = context.cached;
  let startByte = cached?.startByte ?? 0;
  let snapshot:
    | { entries: CodexSessionEntry[]; transcriptSnapshotUpdatedAt: string }
    | undefined;
  if (
    cached?.filePath === filePath &&
    startByte > 0 &&
    (cached.size < stats.size ||
      (cached.size === stats.size &&
        cached.mtimeMs === stats.mtimeMs &&
        cached.ctimeMs === stats.ctimeMs))
  ) {
    snapshot = await context.readEntries(sessionId, filePath, {
      purpose: "detail",
      startByte,
    });
    if (
      snapshot.entries.filter((entry) => entry.type === "compacted").length !==
      compactBoundaries
    ) {
      snapshot = undefined;
      stats = await stat(filePath);
    }
  }
  if (!snapshot) {
    const locatedStart = await context.windowReader.findCompactTailStart(
      filePath,
      stats,
      compactBoundaries,
    );
    if (locatedStart === null) return null;
    startByte = locatedStart;
    snapshot = await context.readEntries(sessionId, filePath, {
      purpose: "detail",
      startByte,
    });
  }
  if (snapshot.entries[0]?.type !== "compacted") return null;
  const provider = summary.provider === "codex-oss" ? "codex-oss" : "codex";
  const normalized = normalizeSession({
    summary,
    transcriptSnapshotUpdatedAt: snapshot.transcriptSnapshotUpdatedAt,
    data: { provider, session: { entries: snapshot.entries } },
  });
  // An older or unknown durable id must take the complete catch-up path.
  if (
    !normalized.messages.some(
      (message) => (message.uuid ?? message.id) === afterMessageId,
    )
  ) {
    return null;
  }
  // Results whose calls precede the window need the prefix's tool context.
  const toolCalls = new Set<string>();
  for (const message of normalized.messages) {
    const content = message.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use" && block.id) toolCalls.add(block.id);
      if (
        block.type === "tool_result" &&
        block.tool_use_id &&
        !toolCalls.has(block.tool_use_id)
      )
        return null;
    }
  }
  return {
    ...snapshot,
    kind: "compact-tail",
    omittedPrefix: true,
    startByte,
    compactBoundaries,
  };
}
