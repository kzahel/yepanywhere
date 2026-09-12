import { open } from "node:fs/promises";
import {
  parseCodexSessionEntry,
  type ClaudeSessionEntry,
  type CodexSessionEntry,
} from "@yep-anywhere/shared";
import {
  normalizeConversationEntries,
  tagCodexEntrySourceByteOffset,
} from "../sessions/normalization.js";
import {
  MAX_PROJECTION_INPUT_BYTES,
  MAX_PROJECTION_RECORDS,
  type ConversationInput,
} from "./conversation-projection.js";

export const MAX_CONVERSATION_RECORD_BYTES = 1024 * 1024;

/**
 * A finite native acquisition, before normalization or compiler allocation.
 * Refuse oversized histories rather than cutting through Claude branch evidence
 * or silently losing an inherited Codex history. A provider-indexed tail reader
 * can extend this seam later without changing the public query.
 */
export async function readConversationFile(options: {
  path: string;
  provider: "claude" | "codex";
  sessionId: string;
  signal: AbortSignal;
}): Promise<ConversationInput> {
  const { signal } = options;
  signal.throwIfAborted();
  const file = await open(options.path, "r");
  try {
    signal.throwIfAborted();
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_PROJECTION_INPUT_BYTES)
      throw new Error("Conversation acquisition exceeds the byte budget");
    // One descriptor and a fixed allocation: growth after stat cannot turn this
    // into readFile's unbounded allocation. Check cancellation between chunks.
    const buffer = Buffer.alloc(before.size);
    let length = 0;
    while (length < buffer.length) {
      signal.throwIfAborted();
      const result = await file.read(
        buffer,
        length,
        Math.min(64 * 1024, buffer.length - length),
        length,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    signal.throwIfAborted();
    const after = await file.stat();
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new Error("Conversation changed during acquisition");
    const claude: ClaudeSessionEntry[] = [];
    const codex: CodexSessionEntry[] = [];
    let offset = 0;
    let records = 0;
    while (offset < length) {
      signal.throwIfAborted();
      const newline = buffer.indexOf(10, offset);
      // A writer's unfinished final row is not malformed durable content.
      if (newline < 0) break;
      if (
        newline - offset > MAX_CONVERSATION_RECORD_BYTES ||
        ++records > MAX_PROJECTION_RECORDS
      )
        throw new Error("Conversation acquisition exceeds the record budget");
      const line = buffer.toString("utf8", offset, newline).trim();
      if (line) {
        if (options.provider === "codex") {
          const entry = parseCodexSessionEntry(line);
          if (!entry) throw new Error("Unreadable Codex conversation record");
          if (
            codex.length === 0 &&
            (entry.type !== "session_meta" ||
              entry.payload.id !== options.sessionId ||
              entry.payload.history_base)
          )
            throw new Error("Unsupported Codex conversation lineage");
          codex.push(tagCodexEntrySourceByteOffset(entry, offset));
        } else {
          const entry: unknown = JSON.parse(line);
          if (
            !entry ||
            typeof entry !== "object" ||
            !("type" in entry) ||
            typeof entry.type !== "string"
          )
            throw new Error("Unreadable Claude conversation record");
          claude.push(entry as ClaudeSessionEntry);
        }
      }
      offset = newline + 1;
    }
    if (length - offset > MAX_CONVERSATION_RECORD_BYTES)
      throw new Error("Conversation acquisition exceeds the record budget");
    return {
      sessionId: options.sessionId,
      messages: normalizeConversationEntries(
        options.provider === "claude"
          ? { provider: "claude", entries: claude }
          : { provider: "codex", entries: codex },
        options.sessionId,
      ) as ConversationInput["messages"],
      activity: "unknown",
      pendingRequests: [],
      sourceCoverage: {
        complete: offset === length,
        earlierOutsideScope: "no",
      },
    };
  } finally {
    await file.close();
  }
}
