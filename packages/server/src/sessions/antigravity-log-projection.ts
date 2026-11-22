import type { Message } from "../supervisor/types.js";
import { normalizeInvokeSubagentInput } from "./antigravity-subagent-links.js";

/**
 * Projects `agy`'s brain log (`transcript_full.jsonl`) into the normalized
 * messages the Antigravity reader returns. Pure: the caller reads the file.
 * topics/antigravity-native-storage.md describes the records, including the
 * tool-group rule this follows, and states what a window needs from outside
 * itself.
 */

export interface AntigravityLogLine {
  text: string;
  /** Byte offsets of the line in the stream, excluding its newline. */
  start: number;
  end: number;
  /** False only for a final line without a newline: an append in progress. */
  terminated: boolean;
}

/** Splits a byte stream into lines without decoding a line twice. */
export async function* antigravityLogLines(
  chunks: AsyncIterable<Uint8Array>,
  offset = 0,
): AsyncGenerator<AntigravityLogLine> {
  let pending: Buffer[] = [];
  let pendingStart = offset;
  let position = offset;
  for await (const chunk of chunks) {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
    let from = 0;
    for (
      let newline = bytes.indexOf(10);
      newline >= 0;
      newline = bytes.indexOf(10, from)
    ) {
      const text = pending.length
        ? Buffer.concat([...pending, bytes.subarray(from, newline)]).toString(
            "utf8",
          )
        : bytes.toString("utf8", from, newline);
      const end = position + newline;
      yield { text, start: pendingStart, end, terminated: true };
      pending = [];
      from = newline + 1;
      pendingStart = position + from;
    }
    if (from < bytes.length) pending.push(bytes.subarray(from));
    position += bytes.length;
  }
  if (pending.length)
    yield {
      text: Buffer.concat(pending).toString("utf8"),
      start: pendingStart,
      end: position,
      terminated: false,
    };
}

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export type AntigravityLogRecord = {
  step: number;
  createdAt: string;
} & (
  | { type: "USER_INPUT"; text: string }
  | {
      type: "PLANNER_RESPONSE";
      model?: string;
      content?: string;
      thinking?: string;
      calls: ToolCall[];
      error?: string;
    }
  | {
      type: "GENERIC";
      status: "DONE" | "ERROR" | "RUNNING";
      content: string;
    }
  | { type: "SYSTEM_MESSAGE"; content: string }
  | { type: "CHECKPOINT"; content: string }
  | { type: "ERROR_MESSAGE"; error: string }
);

const TOKEN_KEYS = ["input_tokens", "cache_read_tokens", "output_tokens"];
const COMMON_KEYS = ["step_index", "source", "type", "status", "created_at"];
/** Source, statuses and optional keys per type, as observed on 1.5.13 and 1.5.14. */
const SHAPES: Record<
  string,
  { source: string; statuses: string[]; keys: string[] }
> = {
  USER_INPUT: { source: "USER_EXPLICIT", statuses: ["DONE"], keys: [] },
  PLANNER_RESPONSE: {
    source: "MODEL",
    statuses: ["DONE", "ERROR"],
    keys: [
      "model",
      "content",
      "thinking",
      "tool_calls",
      "error",
      ...TOKEN_KEYS,
    ],
  },
  GENERIC: {
    source: "MODEL",
    statuses: ["DONE", "ERROR", "RUNNING"],
    keys: ["error", "media"],
  },
  SYSTEM_MESSAGE: { source: "SYSTEM", statuses: ["DONE"], keys: [] },
  CHECKPOINT: { source: "SYSTEM", statuses: ["DONE"], keys: TOKEN_KEYS },
  ERROR_MESSAGE: { source: "SYSTEM", statuses: ["DONE"], keys: ["content"] },
};
const REQUIRED: Record<string, string> = {
  USER_INPUT: "content",
  GENERIC: "content",
  SYSTEM_MESSAGE: "content",
  CHECKPOINT: "content",
  ERROR_MESSAGE: "error",
};
const STRING_KEYS = new Set(["model", "content", "thinking", "error"]);
const USER_OPEN = "<USER_REQUEST>\n";
const USER_CLOSE = "\n</USER_REQUEST>";
const SYSTEM_BODY = /^[\s\S]*?<SYSTEM_MESSAGE>\n([\s\S]*)\n<\/SYSTEM_MESSAGE>$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * One log line as a record, or the reason it is not one YA recognizes. A
 * key, source, status or field type outside what was observed is a reason,
 * so a later `agy` that adds content makes the log unknown rather than
 * silently projecting less.
 */
export function parseAntigravityLogRecord(
  line: string,
): AntigravityLogRecord | { unknown: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { unknown: "a line is not JSON" };
  }
  if (!isObject(raw)) return { unknown: "a line is not a JSON object" };
  const { step_index: step, type, source, status, created_at } = raw;
  if (!Number.isSafeInteger(step) || (step as number) < 0)
    return { unknown: "a record has no valid step_index" };
  const shape = typeof type === "string" ? SHAPES[type] : undefined;
  if (!shape) return { unknown: `unrecognized record type ${String(type)}` };
  const at = `${type} at step ${step}`;
  if (source !== shape.source || !shape.statuses.includes(status as string))
    return { unknown: `${at} has source ${source} and status ${status}` };
  if (typeof created_at !== "string")
    return { unknown: `${at} has no created_at` };
  const required = REQUIRED[type as string];
  for (const key of Object.keys(raw)) {
    if (
      !COMMON_KEYS.includes(key) &&
      key !== required &&
      !shape.keys.includes(key)
    )
      return { unknown: `${at} has an unrecognized field ${key}` };
    const value = raw[key];
    if (
      (STRING_KEYS.has(key) && typeof value !== "string") ||
      (TOKEN_KEYS.includes(key) && typeof value !== "number") ||
      (key === "media" && !Array.isArray(value))
    )
      return { unknown: `${at} has an unexpected ${key}` };
  }
  if (required && typeof raw[required] !== "string")
    return { unknown: `${at} has no ${required}` };
  const base = { step: step as number, createdAt: created_at };
  switch (type) {
    case "USER_INPUT": {
      const content = raw.content as string;
      const close = content.lastIndexOf(USER_CLOSE);
      if (!content.startsWith(USER_OPEN) || close < USER_OPEN.length - 1)
        return { unknown: `${at} has no USER_REQUEST` };
      return { ...base, type, text: content.slice(USER_OPEN.length, close) };
    }
    case "PLANNER_RESPONSE": {
      const calls = raw.tool_calls ?? [];
      if (
        !Array.isArray(calls) ||
        !calls.every(
          (call) =>
            isObject(call) &&
            Object.keys(call).length === 2 &&
            typeof call.name === "string" &&
            isObject(call.args),
        )
      )
        return { unknown: `${at} has unexpected tool_calls` };
      return {
        ...base,
        type,
        calls: calls as ToolCall[],
        ...(raw.model !== undefined ? { model: raw.model as string } : {}),
        ...(raw.content ? { content: raw.content as string } : {}),
        ...(raw.thinking ? { thinking: raw.thinking as string } : {}),
        ...(raw.error ? { error: raw.error as string } : {}),
      };
    }
    case "GENERIC":
      return {
        ...base,
        type,
        status: status as "DONE" | "ERROR" | "RUNNING",
        content: raw.content as string,
      };
    case "SYSTEM_MESSAGE":
    case "CHECKPOINT":
      return { ...base, type, content: raw.content as string };
    default:
      return { ...base, type: "ERROR_MESSAGE", error: raw.error as string };
  }
}

/** The message ID of a log step, or of one part of it. */
export function antigravityStepMessageId(
  conversationId: string,
  step: number,
  part?: "thinking" | "text" | "error",
): string {
  return `${conversationId}:step-${step}${part ? `:${part}` : ""}`;
}

/** Call `index` (zero-based) of the planner record at `step`. */
export function antigravityStepToolId(
  conversationId: string,
  step: number,
  index: number,
): string {
  return `${conversationId}:step-${step}:tool-${index}`;
}

export type AntigravityLogProjectionResult =
  | { status: "known"; messages: Message[] }
  | { status: "unknown"; reason: string };

interface OpenGroup {
  step: number;
  /** Results seen, by call index. */
  seen: boolean[];
  /** The calls' messages, when this window projected the planner record. */
  calls?: Message[];
}

/**
 * Projects records in order into `messages`. A window is a run of records
 * passed to `add`; records outside it go to `observe`, which updates the
 * tool-group state and checks without projecting:
 *
 * - Before a window that does not start the file, observe the records from
 *   the last record before it that is not `GENERIC`. That record owns any
 *   results at the window's start, or proves they have no owner.
 * - After the window, while `awaitingGroup` is true, observe the following
 *   records. A call's interrupted state is on its own message, so it is
 *   known only once a record past the group arrives or the log ends.
 *
 * Messages are a function of their step and these records, so every window
 * that projects a step produces the same IDs and content.
 */
export class AntigravityLogProjection {
  readonly messages: Message[] = [];
  records = 0;
  private previous?: number;
  private group?: OpenGroup;
  private failure?: string;

  constructor(private readonly conversationId: string) {}

  /** A planner record projected here has calls whose outcome is unknown. */
  get awaitingGroup(): boolean {
    return !this.failure && !!this.group?.calls;
  }

  get unknown(): string | undefined {
    return this.failure;
  }

  add(record: AntigravityLogRecord): boolean {
    return this.take(record, true);
  }

  observe(record: AntigravityLogRecord): boolean {
    return this.take(record, false);
  }

  /** Parses and adds one line; an unterminated final line is not a record yet. */
  addLine(line: AntigravityLogLine): boolean {
    if (this.failure) return false;
    if (!line.terminated) return true;
    if (!line.text) return this.fail("the log has an empty line");
    const record = parseAntigravityLogRecord(line.text);
    return "unknown" in record ? this.fail(record.unknown) : this.add(record);
  }

  /**
   * Ends the projection. `ownerLive` applies when the log ended inside a
   * group: its missing results are still running under a live owner and are
   * interrupted once the conversation has stopped.
   */
  finish(options: { ownerLive: boolean }): AntigravityLogProjectionResult {
    if (!this.failure && !options.ownerLive) this.closeGroup();
    return this.failure
      ? { status: "unknown", reason: this.failure }
      : { status: "known", messages: this.messages };
  }

  private fail(reason: string): false {
    this.failure ??= reason;
    return false;
  }

  private closeGroup(): void {
    const group = this.group;
    this.group = undefined;
    group?.calls?.forEach((message, index) => {
      const [block] = message.message!.content as Array<{ id: string }>;
      if (!group.seen[index]) message.orphanedToolUseIds = [block!.id];
    });
  }

  private take(record: AntigravityLogRecord, project: boolean): boolean {
    if (this.failure) return false;
    this.records++;
    const { step } = record;
    if (this.previous !== undefined && step <= this.previous)
      return this.fail(`step_index ${step} follows ${this.previous}`);
    this.previous = step;
    const group = this.group;
    if (group && step > group.step + group.seen.length) this.closeGroup();
    if (record.type === "GENERIC") {
      const owner = this.group;
      if (!owner)
        return this.fail(
          `GENERIC at step ${step} has no owning planner record`,
        );
      const index = step - owner.step - 1;
      owner.seen[index] = true;
      if (project) {
        const id = antigravityStepToolId(
          this.conversationId,
          owner.step,
          index,
        );
        this.push({
          type: "user",
          uuid: `${id}:result`,
          timestamp: record.createdAt,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: id,
                content: record.content,
                is_error: record.status === "ERROR",
              },
            ],
          },
        });
      }
      if (owner.seen.every(Boolean)) this.group = undefined;
      return true;
    }
    if (this.group)
      return this.fail(
        `${record.type} at step ${step} is inside the calls of step ${this.group.step}`,
      );
    if (record.type === "PLANNER_RESPONSE" && record.calls.length)
      this.group = {
        step,
        seen: record.calls.map(() => false),
        ...(project ? { calls: [] } : {}),
      };
    if (project) this.project(record);
    return true;
  }

  private push(message: Message): Message {
    const full: Message = { ...message, session_id: this.conversationId };
    this.messages.push(full);
    return full;
  }

  private project(record: AntigravityLogRecord): void {
    const id = (part?: "thinking" | "text" | "error") =>
      antigravityStepMessageId(this.conversationId, record.step, part);
    const timestamp = record.createdAt;
    switch (record.type) {
      case "USER_INPUT":
        this.push({
          type: "user",
          uuid: id(),
          timestamp,
          message: { role: "user", content: record.text },
        });
        return;
      case "PLANNER_RESPONSE": {
        const assistant = (content: Message["message"]) => ({
          role: "assistant",
          ...(record.model ? { model: record.model } : {}),
          ...content,
        });
        if (record.thinking)
          this.push({
            type: "assistant",
            uuid: id("thinking"),
            timestamp,
            message: assistant({
              content: [{ type: "thinking", thinking: record.thinking }],
            }),
          });
        if (record.content)
          this.push({
            type: "assistant",
            uuid: id("text"),
            timestamp,
            message: assistant({ content: record.content }),
          });
        record.calls.forEach((call, index) => {
          const toolId = antigravityStepToolId(
            this.conversationId,
            record.step,
            index,
          );
          const subagent = call.name === "invoke_subagent";
          this.group?.calls?.push(
            this.push({
              type: "assistant",
              uuid: `${toolId}:call`,
              timestamp,
              message: assistant({
                content: [
                  {
                    type: "tool_use",
                    id: toolId,
                    name: subagent ? "spawn_agent" : call.name,
                    input: subagent
                      ? normalizeInvokeSubagentInput(call.args)
                      : call.args,
                  },
                ],
              }),
            }),
          );
        });
        if (record.error)
          this.push({
            type: "error",
            uuid: id("error"),
            timestamp,
            error: record.error,
          });
        return;
      }
      case "SYSTEM_MESSAGE":
        this.push({
          type: "system",
          subtype: "informational",
          uuid: id(),
          timestamp,
          content: "System message",
          details: [SYSTEM_BODY.exec(record.content)?.[1] ?? record.content],
        });
        return;
      case "CHECKPOINT":
        this.push({
          type: "system",
          subtype: "compact_boundary",
          uuid: id(),
          timestamp,
          content: "Context compacted",
          compactSummaryText: record.content,
        });
        return;
      case "ERROR_MESSAGE":
        this.push({
          type: "error",
          uuid: id(),
          timestamp,
          error: record.error,
        });
        return;
      default:
        return;
    }
  }
}

/** Projects a whole log from its lines. */
export async function projectAntigravityLog(
  lines: AsyncIterable<AntigravityLogLine>,
  options: { conversationId: string; ownerLive: boolean },
): Promise<AntigravityLogProjectionResult & { records: number }> {
  const projection = new AntigravityLogProjection(options.conversationId);
  for await (const line of lines) if (!projection.addLine(line)) break;
  return {
    ...projection.finish({ ownerLive: options.ownerLive }),
    records: projection.records,
  };
}
