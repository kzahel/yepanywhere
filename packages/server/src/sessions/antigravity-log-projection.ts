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
  /** The line's bytes are not valid UTF-8; `text` then has replacements. */
  invalidUtf8?: true;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Decodes without a second pass unless a replacement character appears. */
export function decodeAntigravityLogLine(
  bytes: Buffer,
): Pick<AntigravityLogLine, "text" | "invalidUtf8"> {
  const text = bytes.toString("utf8");
  if (!text.includes("\uFFFD")) return { text };
  try {
    strictUtf8.decode(bytes);
    return { text };
  } catch {
    return { text, invalidUtf8: true };
  }
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
      const line = bytes.subarray(from, newline);
      const decoded = decodeAntigravityLogLine(
        pending.length ? Buffer.concat([...pending, line]) : line,
      );
      const end = position + newline;
      yield { ...decoded, start: pendingStart, end, terminated: true };
      pending = [];
      from = newline + 1;
      pendingStart = position + from;
    }
    if (from < bytes.length) pending.push(bytes.subarray(from));
    position += bytes.length;
  }
  // An unterminated tail may end inside a character; it is not a record.
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
  /** Shown from its first bytes only: too large to hold. */
  oversized?: true;
} & (
  | { type: "USER_INPUT"; text: string }
  | {
      type: "PLANNER_RESPONSE";
      model?: string;
      content?: string;
      thinking?: string;
      calls: ToolCall[];
      error?: string;
      /** Its calls are unknown; the results after it are not shown. */
      opaque?: true;
    }
  | {
      type: "GENERIC";
      status: "DONE" | "ERROR" | "RUNNING";
      content: string;
    }
  /** The text inside the `<SYSTEM_MESSAGE>` wrapper. */
  | { type: "SYSTEM_MESSAGE"; content: string }
  | { type: "CHECKPOINT"; content: string }
  | { type: "ERROR_MESSAGE"; error: string }
);

type RecordType = AntigravityLogRecord["type"];
interface Shape {
  source: string;
  statuses: readonly string[];
  /** The one field the type cannot lack. */
  required?: string;
  /** Optional fields besides the common ones. */
  keys: readonly string[];
}

const TOKEN_KEYS = ["input_tokens", "cache_read_tokens", "output_tokens"];
const COMMON_KEYS = ["step_index", "source", "type", "status", "created_at"];
/** As observed on 1.5.13 and 1.5.14. */
const SHAPES = new Map<string, Shape>([
  [
    "USER_INPUT",
    {
      source: "USER_EXPLICIT",
      statuses: ["DONE"],
      required: "content",
      keys: [],
    },
  ],
  [
    "PLANNER_RESPONSE",
    {
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
  ],
  [
    "GENERIC",
    {
      source: "MODEL",
      statuses: ["DONE", "ERROR", "RUNNING"],
      required: "content",
      keys: ["error", "media"],
    },
  ],
  [
    "SYSTEM_MESSAGE",
    { source: "SYSTEM", statuses: ["DONE"], required: "content", keys: [] },
  ],
  [
    "CHECKPOINT",
    {
      source: "SYSTEM",
      statuses: ["DONE"],
      required: "content",
      keys: TOKEN_KEYS,
    },
  ],
  [
    "ERROR_MESSAGE",
    {
      source: "SYSTEM",
      statuses: ["DONE"],
      required: "error",
      keys: ["content"],
    },
  ],
]);
const STRING_KEYS = new Set(["model", "content", "thinking", "error"]);
const USER_OPEN = "<USER_REQUEST>\n";
const USER_CLOSE = "\n</USER_REQUEST>";
/** The blocks observed after a request, each at most once. */
const USER_TRAILER =
  /^(?:\n<ADDITIONAL_METADATA>\n(?:(?!<\/?ADDITIONAL_METADATA>)[\s\S])*\n<\/ADDITIONAL_METADATA>)?(?:\n<USER_SETTINGS_CHANGE>\n(?:(?!<\/?USER_SETTINGS_CHANGE>)[\s\S])*\n<\/USER_SETTINGS_CHANGE>)?$/;
const SYSTEM_OPEN =
  "The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n";
const SYSTEM_CLOSE = "\n</SYSTEM_MESSAGE>";

/** `agy`'s inbox delivery, as a wake and a notice begin. */
const INBOX_MESSAGE = "[Message] ";
/** The time lines `agy` puts before a tool's output; the step has its time. */
const RESULT_TIMES =
  /^(?:(?:Created|Completed) At: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)\n)+/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** A diagnostic for an arbitrary JSON value that coerces nothing. */
function describe(value: unknown): string {
  return typeof value === "string"
    ? JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)
    : value === null
      ? "null"
      : Array.isArray(value)
        ? "an array"
        : typeof value;
}

/**
 * One log line as a record, or the reason it is not one YA recognizes. A
 * key, source, status, field type or wrapper outside what was observed is a
 * reason, so a later `agy` that adds content makes the log unknown rather
 * than silently projecting less. Never throws.
 */
export function parseAntigravityLogRecord(
  line: string,
): AntigravityLogRecord | { unknown: string } {
  try {
    return parseRecord(line);
  } catch (error) {
    // A bug, not a record shape; callers still fall back.
    return {
      unknown: `the projection failed: ${error instanceof Error ? error.message : describe(error)}`,
    };
  }
}

function parseRecord(line: string): AntigravityLogRecord | { unknown: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { unknown: "a line is not JSON" };
  }
  if (!isObject(raw)) return { unknown: "a line is not a JSON object" };
  const field = (key: string): unknown =>
    Object.hasOwn(raw, key) ? raw[key] : undefined;
  const step = field("step_index");
  if (typeof step !== "number" || !Number.isSafeInteger(step) || step < 0)
    return { unknown: "a record has no valid step_index" };
  const type = field("type");
  const shape = typeof type === "string" ? SHAPES.get(type) : undefined;
  if (typeof type !== "string" || !shape)
    return { unknown: `record type ${describe(type)} at step ${step}` };
  const at = `${type} at step ${step}`;
  const source = field("source");
  const status = field("status");
  if (
    source !== shape.source ||
    typeof status !== "string" ||
    !shape.statuses.includes(status)
  )
    return {
      unknown: `${at} has source ${describe(source)} and status ${describe(status)}`,
    };
  const createdAt = field("created_at");
  if (typeof createdAt !== "string")
    return { unknown: `${at} has no created_at` };
  for (const key of Object.keys(raw)) {
    if (
      !COMMON_KEYS.includes(key) &&
      key !== shape.required &&
      !shape.keys.includes(key)
    )
      return { unknown: `${at} has an unrecognized field ${describe(key)}` };
    const value = raw[key];
    if (
      (STRING_KEYS.has(key) && typeof value !== "string") ||
      (TOKEN_KEYS.includes(key) && typeof value !== "number") ||
      (key === "media" && !Array.isArray(value)) ||
      (key === "tool_calls" && !Array.isArray(value))
    )
      return { unknown: `${at} has ${describe(value)} for ${key}` };
  }
  if (shape.required && typeof field(shape.required) !== "string")
    return { unknown: `${at} has no ${shape.required}` };
  const base = { step, createdAt };
  const text = (key: string) => field(key) as string | undefined;
  switch (type as RecordType) {
    case "USER_INPUT": {
      const content = text("content")!;
      const close = content.lastIndexOf(USER_CLOSE);
      if (
        !content.startsWith(USER_OPEN) ||
        close < USER_OPEN.length - 1 ||
        !USER_TRAILER.test(content.slice(close + USER_CLOSE.length))
      )
        return { unknown: `${at} is not a USER_REQUEST in the observed form` };
      return {
        ...base,
        type: "USER_INPUT",
        text: content.slice(
          USER_OPEN.length,
          Math.max(close, USER_OPEN.length),
        ),
      };
    }
    case "PLANNER_RESPONSE": {
      const calls = (field("tool_calls") as unknown[] | undefined) ?? [];
      if (
        !calls.every(
          (call) =>
            isObject(call) &&
            Object.keys(call).length === 2 &&
            Object.hasOwn(call, "name") &&
            typeof call.name === "string" &&
            Object.hasOwn(call, "args") &&
            isObject(call.args),
        )
      )
        return { unknown: `${at} has unexpected tool_calls` };
      const optional = (key: "model" | "content" | "thinking" | "error") =>
        text(key) ? { [key]: text(key) } : {};
      return {
        ...base,
        type: "PLANNER_RESPONSE",
        calls: calls as ToolCall[],
        ...optional("model"),
        ...optional("content"),
        ...optional("thinking"),
        ...optional("error"),
      };
    }
    case "GENERIC":
      return {
        ...base,
        type: "GENERIC",
        status: status as "DONE" | "ERROR" | "RUNNING",
        content: text("content")!,
      };
    case "SYSTEM_MESSAGE": {
      const content = text("content")!;
      if (
        !content.startsWith(SYSTEM_OPEN) ||
        !content.endsWith(SYSTEM_CLOSE) ||
        content.length < SYSTEM_OPEN.length + SYSTEM_CLOSE.length
      )
        return {
          unknown: `${at} is not a SYSTEM_MESSAGE in the observed form`,
        };
      return {
        ...base,
        type: "SYSTEM_MESSAGE",
        content: content.slice(SYSTEM_OPEN.length, -SYSTEM_CLOSE.length),
      };
    }
    case "CHECKPOINT":
      return { ...base, type: "CHECKPOINT", content: text("content")! };
    default:
      return { ...base, type: "ERROR_MESSAGE", error: text("error")! };
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

/** A record, or a tool group's results together, held in full up to this. */
export const ANTIGRAVITY_LOG_RECORD_BYTES = 16 * 1024 * 1024;
/** Bytes read for a record's head. */
export const ANTIGRAVITY_LOG_HEAD_BYTES = 512;

export interface AntigravityLogHead {
  step: number;
  type: string;
  source: string;
  status: string;
  createdAt: string;
  error?: string;
}

/**
 * Every observed record begins with these keys in this order: an optional
 * `error` (short) after `status`, then `created_at`.
 */
const HEAD =
  /^\{"step_index":(0|[1-9]\d{0,15}),"source":"([A-Z_]{1,32})","type":"([A-Z_]{1,32})","status":"([A-Z_]{1,32})",(?:"error":"((?:[^"\\]|\\.){0,256})",)?"created_at":"([^"\\]{1,64})"[,}]/;

/** A record's leading fields, or undefined when they are not in that form. */
export function parseAntigravityLogHead(
  prefix: string,
): AntigravityLogHead | undefined {
  const match = HEAD.exec(prefix);
  if (!match) return undefined;
  let error: string | undefined;
  if (match[5] !== undefined)
    try {
      error = JSON.parse(`"${match[5]}"`) as string;
    } catch {
      return undefined;
    }
  const shape = SHAPES.get(match[3]!);
  if (
    !shape ||
    shape.source !== match[2] ||
    !shape.statuses.includes(match[4]!) ||
    !Number.isSafeInteger(Number(match[1]))
  )
    return undefined;
  return {
    step: Number(match[1]),
    source: match[2]!,
    type: match[3]!,
    status: match[4]!,
    createdAt: match[6]!,
    ...(error === undefined ? {} : { error }),
  };
}

/** How a system message's content begins in the log's own bytes. */
const SYSTEM_CONTENT = `"content":${JSON.stringify(SYSTEM_OPEN).slice(0, -1)}`;

/**
 * Whether a system message's head already shows a reminder (content that is
 * not an inbox delivery), which is never shown.
 */
export function antigravityHeadIsReminder(prefix: string): boolean {
  const at = prefix.indexOf(SYSTEM_CONTENT);
  return (
    at >= 0 && !prefix.startsWith(INBOX_MESSAGE, at + SYSTEM_CONTENT.length)
  );
}

const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/**
 * A record too large to hold, shown from its head alone. Nothing after the
 * head is read, so nothing after it is checked. A planner's calls are
 * unknown: its placeholder covers the results after it. `group` marks a
 * result held back because its tool group's results are too large.
 */
export function antigravityPlaceholderRecord(
  prefix: string,
  bytes: number,
  group?: number,
): AntigravityLogRecord | { unknown: string } {
  const head = parseAntigravityLogHead(prefix);
  if (!head)
    return { unknown: "a record too large to read does not begin as observed" };
  const notice =
    group === undefined
      ? `This step is too large to show here (${megabytes(bytes)} MB).`
      : `This result is part of a tool step too large to show here (${megabytes(group)} MB of results).`;
  const base = {
    step: head.step,
    createdAt: head.createdAt,
    oversized: true as const,
  };
  switch (head.type) {
    case "USER_INPUT":
      return { ...base, type: "USER_INPUT", text: notice };
    case "PLANNER_RESPONSE":
      return {
        ...base,
        type: "PLANNER_RESPONSE",
        content: notice,
        calls: [],
        opaque: true,
        ...(head.error ? { error: head.error } : {}),
      };
    case "GENERIC":
      return {
        ...base,
        type: "GENERIC",
        status: head.status as "DONE" | "ERROR" | "RUNNING",
        content: notice,
      };
    case "SYSTEM_MESSAGE":
      return antigravityHeadIsReminder(prefix)
        ? {
            step: head.step,
            createdAt: head.createdAt,
            type: "SYSTEM_MESSAGE",
            content: "",
          }
        : { ...base, type: "SYSTEM_MESSAGE", content: notice };
    case "CHECKPOINT":
      return { ...base, type: "CHECKPOINT", content: notice };
    default:
      return { ...base, type: "ERROR_MESSAGE", error: head.error ?? notice };
  }
}

export type AntigravityLogProjectionResult =
  | { status: "known"; messages: Message[] }
  /** `error` is set only when the projection itself threw: a bug, which
   * callers still treat as unknown and tests must not see. */
  | { status: "unknown"; reason: string; error?: unknown };

interface OpenGroup {
  step: number;
  /** A planner shown as a placeholder: its calls, and so its results, are unknown. */
  opaque?: true;
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
  /** A projected planner error, dropped if the next record repeats it. */
  private plannerError?: { message: Message; text: string };
  private failure?: string;
  private error?: unknown;

  constructor(private readonly conversationId: string) {}

  /**
   * A planner record projected here has calls whose outcome is unknown, or
   * an error that the next record may report instead.
   */
  get awaitingGroup(): boolean {
    return !this.failure && (!!this.group?.calls || !!this.plannerError);
  }

  get unknown(): string | undefined {
    return this.failure;
  }

  add(record: AntigravityLogRecord): boolean {
    return this.guard(() => this.take(record, true));
  }

  observe(record: AntigravityLogRecord): boolean {
    return this.guard(() => this.take(record, false));
  }

  /** Parses and adds one line; an unterminated final line is not a record yet. */
  addLine(line: AntigravityLogLine): boolean {
    return this.guard(() => {
      if (!line.terminated) return true;
      const record =
        line.end - line.start > ANTIGRAVITY_LOG_RECORD_BYTES
          ? antigravityPlaceholderRecord(
              line.text.slice(0, ANTIGRAVITY_LOG_HEAD_BYTES),
              line.end - line.start,
            )
          : line.invalidUtf8
            ? { unknown: "a line is not valid UTF-8" }
            : !line.text
              ? { unknown: "the log has an empty line" }
              : parseAntigravityLogRecord(line.text);
      return "unknown" in record
        ? this.fail(record.unknown)
        : this.take(record, true);
    });
  }

  /**
   * Ends the projection. `ownerLive` applies when the log ended inside a
   * group: its missing results are still running under a live owner and are
   * interrupted once the conversation has stopped. The caller must not
   * report a spent read budget as the end of the log.
   */
  finish(options: { ownerLive: boolean }): AntigravityLogProjectionResult {
    if (!options.ownerLive)
      this.guard(() => {
        this.closeGroup();
        return true;
      });
    return this.failure
      ? {
          status: "unknown",
          reason: this.failure,
          ...(this.error === undefined ? {} : { error: this.error }),
        }
      : { status: "known", messages: this.messages };
  }

  /** Every entry point is total: a throw becomes an unknown log. */
  private guard(run: () => boolean): boolean {
    if (this.failure) return false;
    try {
      return run();
    } catch (error) {
      this.error = error;
      return this.fail(
        `the projection failed: ${error instanceof Error ? error.message : describe(error)}`,
      );
    }
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
    this.records++;
    const { step } = record;
    if (this.previous !== undefined && step <= this.previous)
      return this.fail(`step_index ${step} follows ${this.previous}`);
    this.previous = step;
    const group = this.group;
    if (group && !group.opaque && step > group.step + group.seen.length)
      this.closeGroup();
    if (record.type === "GENERIC") {
      const owner = this.group;
      if (!owner)
        return this.fail(
          `GENERIC at step ${step} has no owning planner record`,
        );
      // Covered by its planner's placeholder.
      if (owner.opaque) return true;
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
                content: record.content.replace(RESULT_TIMES, ""),
                is_error: record.status === "ERROR",
              },
            ],
          },
        });
      }
      if (owner.seen.every(Boolean)) this.group = undefined;
      return true;
    }
    if (this.group?.opaque) this.group = undefined;
    if (this.group)
      return this.fail(
        `${record.type} at step ${step} is inside the calls of step ${this.group.step}`,
      );
    const plannerError = this.plannerError;
    this.plannerError = undefined;
    if (
      plannerError &&
      record.type === "ERROR_MESSAGE" &&
      record.error.includes(plannerError.text)
    ) {
      // The next step repeats the same failure, as a 1.5.14 cancel does.
      const index = this.messages.lastIndexOf(plannerError.message);
      if (index >= 0) this.messages.splice(index, 1);
    }
    if (record.type === "PLANNER_RESPONSE" && record.opaque)
      this.group = { step, seen: [], opaque: true };
    else if (record.type === "PLANNER_RESPONSE" && record.calls.length)
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
        // A 1.5.14 cancel logs its cause here and again as the very next
        // step's ERROR_MESSAGE; only that repetition drops this row.
        if (record.error) {
          const message = this.push({
            type: "error",
            uuid: id("error"),
            timestamp,
            error: record.error,
          });
          this.plannerError = record.calls.length
            ? undefined
            : { message, text: record.error };
        }
        return;
      }
      case "SYSTEM_MESSAGE":
        // Reminders `agy` adds to the model's context are not shown, as the
        // live view and other providers' injected instructions are not. An
        // inbox delivery, such as a task's wake, explains the reply after it.
        if (!record.oversized && !record.content.startsWith(INBOX_MESSAGE))
          return;
        this.push({
          type: "system",
          subtype: "informational",
          uuid: id(),
          timestamp,
          content: "System message",
          details: [record.content],
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
