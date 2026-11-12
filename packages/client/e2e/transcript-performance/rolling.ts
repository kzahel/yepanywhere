import type { Message } from "../../src/types";
import { turn } from "./fixture";

/** Two old compaction windows, as a normal bounded initial read would return. */
export function rollingHistory(totalTurns: number): Message[] {
  const start = Math.max(0, totalTurns - 20);
  return Array.from({ length: totalTurns - start }, (_, offset) => {
    const index = start + offset;
    const rows = turn(index, `history-${index}`).map((message) => ({
      ...message,
      _source: "jsonl" as const,
    }));
    return offset % 10 === 0
      ? [compact(`initial-${index}`, rows[0]!.timestamp!), ...rows]
      : rows;
  }).flat();
}
function compact(id: string, timestamp: string): Message {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid: `compact-${id}`,
    timestamp,
    content: "Compacted conversation",
    _source: "jsonl",
  };
}

/** Real-time writes: a new human prompt every five updates, tool work between. */
export function rollingUpdate(index: number, rows: Message[]): Message[] {
  const timestamp = new Date().toISOString();
  const messages = (index % 5 === 0 ? rows : rows.slice(1)).map((message) => ({
    ...message,
    timestamp,
    _source: "jsonl" as const,
  }));
  return index === 10 || index === 30
    ? [compact(`live-${index}`, timestamp), ...messages]
    : messages;
}
