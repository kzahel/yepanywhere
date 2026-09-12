import type { Message } from "./message.js";

/**
 * Parsed view of a Claude Code `<task-notification>` entry — the message the SDK
 * injects into the transcript (as a `type: "user"` entry) when a backgrounded
 * task changes state. We render these as a system/event chip rather than a user
 * bubble; see transcriptProjection/messageProjection + TaskNotificationBlock.
 */
export interface TaskNotification {
  taskId?: string;
  toolUseId?: string;
  outputFile?: string;
  status?: string;
  summary?: string;
  /** Streaming progress body (Monitor task `<event>` log dump), when present. */
  event?: string;
}

const TASK_NOTIFICATION_OPEN = "<task-notification>";
const TASK_NOTIFICATION_CLOSE = "</task-notification>";

function messageContentString(msg: Message): string | undefined {
  const content =
    (msg.message as { content?: unknown } | undefined)?.content ?? msg.content;
  return typeof content === "string" ? content : undefined;
}

/**
 * True when a string is exactly a `<task-notification>` element. Used as the
 * carrier-agnostic structural signal (see below): a genuine user turn that
 * merely *mentions* the tag has surrounding prose, so it won't open-and-close on
 * the element itself.
 */
function isTaskNotificationElement(content: string): boolean {
  const trimmed = content.trim();
  return (
    trimmed.startsWith(TASK_NOTIFICATION_OPEN) &&
    trimmed.endsWith(TASK_NOTIFICATION_CLOSE)
  );
}

/**
 * Detect an SDK task-notification regardless of which carrier delivered it. The
 * same `<task-notification>` XML reaches the transcript three ways:
 *   1. a `user` entry stamped `origin.kind: "task-notification"` (the SDK's
 *      async background-task delivery) — the authoritative, non-heuristic signal;
 *   2. a `queue-operation`/enqueue that YA normalizes into a deferred user
 *      message (e.g. Monitor events queued while the agent was busy);
 *   3. a `queued_command` attachment.
 * Carriers 2 and 3 are NOT origin-stamped, so we fall back to the structural
 * marker — the message content being exactly a `<task-notification>` element.
 */
export function isTaskNotificationMessage(msg: Message): boolean {
  const origin = (msg as { origin?: { kind?: unknown } }).origin;
  if (origin?.kind === "task-notification") {
    return true;
  }
  const content = messageContentString(msg);
  return content !== undefined && isTaskNotificationElement(content);
}

function extractTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

/**
 * Parse the `<task-notification>` XML body into structured fields. The body is a
 * flat set of single-value tags, so a few scoped regexes are enough — no XML
 * dependency. Unknown/missing tags simply come back undefined.
 */
export function parseTaskNotification(text: string): TaskNotification {
  return {
    taskId: extractTag(text, "task-id"),
    toolUseId: extractTag(text, "tool-use-id"),
    outputFile: extractTag(text, "output-file"),
    status: extractTag(text, "status"),
    summary: extractTag(text, "summary"),
    event: extractTag(text, "event"),
  };
}
