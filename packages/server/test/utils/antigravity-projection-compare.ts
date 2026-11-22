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

/** Mismatches after a longest-common-subsequence alignment of the items. */
export function compareProjectionWithReplay(
  projection: readonly Message[],
  replay: readonly Message[],
): {
  projection: ComparedItem[];
  replay: ComparedItem[];
  mismatches: ProjectionMismatch[];
} {
  const a = comparedItems(projection, "projection");
  const b = comparedItems(replay, "replay");
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] = same(a[i]!, b[j]!)
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  const mismatches: ProjectionMismatch[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && same(a[i]!, b[j]!)) {
      i++;
      j++;
      continue;
    }
    // Unmatched items at the same point with the same kind differ in value.
    const skipA =
      i < a.length &&
      (j >= b.length ||
        table[(i + 1) * width + j]! >= table[i * width + j + 1]!);
    if (
      i < a.length &&
      j < b.length &&
      a[i]!.kind === b[j]!.kind &&
      table[(i + 1) * width + j + 1] === table[i * width + j]
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
