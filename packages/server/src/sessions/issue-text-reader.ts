import { basename } from "node:path";
import {
  parseCodexSessionEntry,
  type ClaudeSessionEntry,
  type CodexSessionEntry,
  type SessionContentDiagnostic,
} from "@yep-anywhere/shared";
import {
  normalizeIssueEntries,
  tagCodexEntrySourceByteOffset,
} from "./normalization.js";
import type { VisibleMessageText } from "./message-text.js";
import {
  readAppendSourceBatch,
  type AppendSourceSegment,
} from "./transcript-append-source.js";

export interface IssueReadSegment extends AppendSourceSegment {
  /** Identify this segment's Codex records by their ordinal, not their offset. */
  ordinal?: boolean;
}
export interface IssueReadOptions {
  cursor?: string;
  signal: AbortSignal;
  maxRecords?: number;
}
export interface IssueTextBatch {
  messages: VisibleMessageText[];
  cursor: string;
  done: boolean;
  partial: boolean;
  bytesRead: number;
  /** Cumulative malformed/oversized records, excluding an unfinished live tail. */
  recordErrors?: boolean;
  restarted?: boolean;
  diagnostics?: SessionContentDiagnostic[];
}

function decodeClaude(value: unknown): ClaudeSessionEntry {
  if (value === null || typeof value !== "object")
    throw new TypeError("Record is not a JSON object");
  return value as ClaudeSessionEntry;
}
const decodeCodex = (value: unknown) =>
  (value !== null &&
    typeof value === "object" &&
    parseCodexSessionEntry(value)) ||
  undefined;
/** A Codex user message is identified together with the records after it. */
const isCodexUserMessage = (entry: CodexSessionEntry) =>
  entry.type === "response_item" &&
  entry.payload.type === "message" &&
  entry.payload.role === "user";

/**
 * The visible-text projection over the append source, for issue references
 * and content search. The source cursor travels with the id of the last
 * message returned, which anchors a later batch's diagnostics.
 */
export async function readIssueTextBatch(
  provider: "claude" | "codex",
  segments: IssueReadSegment[],
  options: IssueReadOptions,
): Promise<IssueTextBatch> {
  let sourceCursor: string | undefined;
  let lastMessageId: string | undefined;
  // A job that has not read yet stores no cursor; that is a start, not a restart.
  if (options.cursor) {
    try {
      const [source, id] = JSON.parse(options.cursor) as unknown[];
      if (typeof id === "string") lastMessageId = id;
      // Anything else is a cursor from an older layout: the source restarts it.
      sourceCursor = typeof source === "string" ? source : "";
    } catch {
      sourceCursor = "";
    }
  }
  const source = {
    cursor: sourceCursor,
    signal: options.signal,
    budget: { records: options.maxRecords },
  };
  const batch =
    provider === "codex"
      ? await readAppendSourceBatch<CodexSessionEntry>(segments, {
          ...source,
          decode: decodeCodex,
          holdBack: isCodexUserMessage,
        })
      : await readAppendSourceBatch<ClaudeSessionEntry>(segments, {
          ...source,
          decode: decodeClaude,
        });
  if (batch.reset) lastMessageId = undefined;
  // `kept[i]` is how many of the first `i` records the projection reads.
  const entries: Array<ClaudeSessionEntry | CodexSessionEntry> = [];
  const kept = [0];
  for (const record of batch.records) {
    if (provider === "codex") {
      const entry = record.entry as CodexSessionEntry;
      entries.push(
        tagCodexEntrySourceByteOffset(
          entry,
          segments[record.segment]?.ordinal && "ordinal" in entry
            ? Number(entry.ordinal)
            : record.offset,
        ),
      );
    } else {
      const entry = record.entry as ClaudeSessionEntry;
      if (entry.type === "user" || entry.type === "assistant")
        entries.push(entry);
    }
    kept.push(entries.length);
  }
  const messages = normalizeIssueEntries(provider, entries);
  const anchors = new Map<number, string | undefined>();
  const diagnostics = batch.diagnostics.map((diagnostic) => {
    const path = segments[diagnostic.segment]?.path ?? "";
    // A held-back record may have been counted and then left for later.
    const count = kept[Math.min(diagnostic.recordIndex, kept.length - 1)] ?? 0;
    if (!anchors.has(count))
      anchors.set(
        count,
        normalizeIssueEntries(provider, entries.slice(0, count)).at(-1)?.id ??
          lastMessageId,
      );
    return {
      id: `${path}:${diagnostic.offset}`,
      message: `${basename(path)} at byte ${diagnostic.offset}: ${diagnostic.reason}`,
      sourcePath: path,
      byteOffset: diagnostic.offset,
      messageId: anchors.get(count),
    };
  });
  return {
    messages,
    cursor: JSON.stringify([
      batch.cursor,
      messages.at(-1)?.id ?? lastMessageId ?? null,
    ]),
    done: batch.done,
    partial: batch.recordErrors || batch.incomplete,
    recordErrors: batch.recordErrors,
    bytesRead: batch.bytesRead,
    diagnostics,
    ...(batch.reset ? { restarted: true } : {}),
  };
}
