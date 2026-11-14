import type {
  CodexResponseItemEntry,
  CodexSessionEntry,
} from "@yep-anywhere/shared";

export function isCodexCompactionOutput(
  entry: CodexResponseItemEntry,
): boolean {
  return (
    entry.metadata?.compaction_output === true &&
    entry.payload.type === "message" &&
    entry.payload.role === "assistant"
  );
}

export function codexCompactionOutputHasCheckpoint(
  entries: readonly CodexSessionEntry[],
  outputIndex: number,
): boolean {
  for (let index = outputIndex + 1; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    if (
      entry.type === "token_usage_record" ||
      (entry.type === "event_msg" && entry.payload.type === "token_count")
    ) {
      continue;
    }
    return entry.type === "compacted" && Boolean(entry.payload.message?.trim());
  }
  return false;
}
