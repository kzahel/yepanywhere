import type { Message } from "../../src/supervisor/types.js";

/**
 * Compares the brain-log projection of a conversation with YA's ACP replay
 * of it, after removing the differences that are expected:
 *
 * - IDs: replay IDs are positional or ACP's random tool call IDs; the
 *   projection's come from step indexes. IDs are not compared.
 * - Only in the projection: tool results (cold replay reports each ordinary
 *   call once, as a completed `tool_call`, and YA keeps no result from it),
 *   system messages, compaction checkpoints, errors, timestamps and models.
 * - Only in replay: the result YA synthesizes for a `spawn_agent` call.
 * - Tool names: replay uses ACP's title, the projection `agy`'s tool name.
 *   Only `spawn_agent` is compared by name.
 * - Runs: replay joins consecutive user inputs, or the text or thinking of
 *   consecutive steps, into one message when nothing it replays falls
 *   between them. User text is joined with nothing between; text and
 *   thinking carry `agy`'s "\n\n" before each later step's part. The
 *   projection's runs are joined the same way.
 * - Steps only in the database (an interrupted step on 1.5.14, an
 *   unlogged `ERROR_MESSAGE` replayed as "⚠" text) are only in replay, and
 *   replay omits the thinking and calls of steps whose database status is
 *   5. The census reports these as mismatch classes; a native case must
 *   have none.
 *
 * Everything else, in order, must be equal: user text, assistant text,
 * thinking, and each call's input.
 */
export interface ComparedItem {
  kind: "user" | "text" | "thinking" | "tool";
  name?: string;
  value: string;
  /** The projection's log step, from its message ID. */
  step?: number;
}

export interface ProjectionMismatch {
  /** For example "text differs" or "only in projection: tool". */
  kind: string;
  projection?: number;
  replay?: number;
}

const blocks = (message: Message) =>
  Array.isArray(message.message?.content)
    ? (message.message.content as Array<Record<string, unknown>>)
    : [];

/** Comparable items in order, with runs of text or thinking joined. */
export function comparedItems(
  messages: readonly Message[],
  side: "projection" | "replay",
): ComparedItem[] {
  const items: ComparedItem[] = [];
  let step: number | undefined;
  const append = (kind: "text" | "thinking" | "user", value: string) => {
    const last = items.at(-1);
    if (side === "projection" && last?.kind === kind)
      last.value += kind === "user" ? value : `\n\n${value}`;
    else items.push({ kind, value, ...(step === undefined ? {} : { step }) });
  };
  for (const message of messages) {
    const match = /:step-(\d+)/.exec(message.uuid ?? "");
    step = side === "projection" && match ? Number(match[1]) : undefined;
    const content = message.message?.content;
    if (message.type === "user" && typeof content === "string")
      append("user", content);
    else if (message.type === "assistant" && typeof content === "string")
      append("text", content);
    else if (message.type === "assistant")
      for (const block of blocks(message)) {
        if (block.type === "thinking")
          append("thinking", String(block.thinking));
        else if (block.type === "tool_use")
          items.push({
            kind: "tool",
            name: String(block.name),
            value: JSON.stringify(block.input),
            ...(step === undefined ? {} : { step }),
          });
      }
  }
  if (side === "replay")
    for (const item of items)
      if (item.kind === "text" || item.kind === "thinking")
        item.value = item.value.replace(/^\n\n/, "");
  return items;
}

function same(a: ComparedItem, b: ComparedItem): boolean {
  return (
    a.kind === b.kind &&
    a.value === b.value &&
    (a.name === "spawn_agent") === (b.name === "spawn_agent")
  );
}

/** Table cells the alignment may use (4 bytes each), after the equal
 * prefix and suffix are set aside. */
const ALIGNMENT_BUDGET = 25_000_000;

/**
 * Mismatches after a longest-common-subsequence alignment of the items.
 * When the unequal middle exceeds the work budget, it is reported as one
 * "not compared" mismatch rather than aligned.
 */
export function compareProjectionWithReplay(
  projection: readonly Message[],
  replay: readonly Message[],
  budget = ALIGNMENT_BUDGET,
): {
  projection: ComparedItem[];
  replay: ComparedItem[];
  mismatches: ProjectionMismatch[];
} {
  const a = comparedItems(projection, "projection");
  const b = comparedItems(replay, "replay");
  let start = 0;
  while (start < a.length && start < b.length && same(a[start]!, b[start]!))
    start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && same(a[endA - 1]!, b[endB - 1]!)) {
    endA--;
    endB--;
  }
  const mismatches: ProjectionMismatch[] = [];
  const width = endB - start + 1;
  if ((endA - start + 1) * width > budget) {
    mismatches.push({
      kind: "not compared: over the alignment budget",
      projection: start,
      replay: start,
    });
    return { projection: a, replay: b, mismatches };
  }
  // table[(i - start) * width + (j - start)]: LCS length of a[i..endA), b[j..endB).
  const table = new Uint32Array((endA - start + 1) * width);
  const cell = (i: number, j: number) => (i - start) * width + (j - start);
  for (let i = endA - 1; i >= start; i--)
    for (let j = endB - 1; j >= start; j--)
      table[cell(i, j)] = same(a[i]!, b[j]!)
        ? table[cell(i + 1, j + 1)]! + 1
        : Math.max(table[cell(i + 1, j)]!, table[cell(i, j + 1)]!);
  let i = start;
  let j = start;
  while (i < endA || j < endB) {
    if (i < endA && j < endB && same(a[i]!, b[j]!)) {
      i++;
      j++;
      continue;
    }
    // Unmatched items at the same point with the same kind differ in value.
    const skipA =
      i < endA &&
      (j >= endB || table[cell(i + 1, j)]! >= table[cell(i, j + 1)]!);
    if (
      i < endA &&
      j < endB &&
      a[i]!.kind === b[j]!.kind &&
      table[cell(i + 1, j + 1)] === table[cell(i, j)]
    ) {
      mismatches.push({
        kind:
          a[i]!.kind === "tool" && a[i]!.value === b[j]!.value
            ? "spawn_agent name differs"
            : `${a[i]!.kind} differs`,
        projection: i++,
        replay: j++,
      });
    } else if (skipA)
      mismatches.push({
        kind: `only in projection: ${a[i]!.kind}`,
        projection: i++,
      });
    else
      mismatches.push({ kind: `only in replay: ${b[j]!.kind}`, replay: j++ });
  }
  return { projection: a, replay: b, mismatches };
}
