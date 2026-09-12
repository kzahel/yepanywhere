import { createHash } from "node:crypto";
import type {
  Content,
  ConversationMessage,
  ActivityState,
} from "@yep-anywhere/shared/experimental/simple-client.generated";
import type {
  Message,
  ContentBlock,
} from "@yep-anywhere/shared/transcript/message";
import { getMessageId } from "@yep-anywhere/shared/transcript/message";
import type {
  RenderItem,
  ToolCallItem,
} from "@yep-anywhere/shared/transcript/items";
import { getCommandResultMeta } from "@yep-anywhere/shared/transcript/shellToolOutput";

export function boundedText(text: string, count: number): string {
  // Avoid splitting surrogate pairs, and avoid allocating the unbounded tail.
  let end = 0;
  for (const character of text) {
    if (count-- <= 0) break;
    end += character.length;
  }
  return text.slice(0, end);
}

export function derivedId(prefix: string, source: string): string {
  const id = `${prefix}:${source}`;
  return Array.from(id).length <= 256
    ? id
    : `${prefix}:sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function timestamp(message: Message | undefined): string | null {
  const value = message?.timestamp;
  if (!value || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value
    ? value
    : null;
}

interface Group {
  message: ConversationMessage;
  pendingTools: string[];
  dropped: boolean;
  droppedFailure: boolean;
  byteLimited: boolean;
  active: boolean;
  terminal: boolean;
  unavailable: boolean;
  activity: { tools: number; failed: number } | null;
}

function group(id: string, role: "user" | "agent", date: string | null): Group {
  return {
    message: {
      id,
      role,
      createdAt: date,
      state: "complete",
      truncated: false,
      content: [],
    },
    pendingTools: [],
    dropped: false,
    droppedFailure: false,
    byteLimited: false,
    active: false,
    terminal: false,
    unavailable: false,
    activity: null,
  };
}

function append(target: Group, content: Content): void {
  // Reserve the last row for an honest omission notice. Never silently discard
  // a late failure after the content-count ceiling is reached.
  if (target.message.content.length >= 63) {
    target.dropped = true;
    target.byteLimited = true;
    target.droppedFailure ||= content.kind === "failure";
    target.message.truncated = true;
    return;
  }
  target.message.content.push(content);
}

function flushActivity(target: Group): void {
  const activity = target.activity;
  if (!activity) return;
  append(target, {
    kind: "activity",
    summary: `${activity.tools} tool call${activity.tools === 1 ? "" : "s"}`,
    toolCount: activity.tools,
    failedToolCount: activity.failed,
  });
  target.activity = null;
}

function text(
  target: Group,
  value: string,
  format: "plain" | "markdown",
): void {
  flushActivity(target);
  const bounded = boundedText(value, 16000);
  target.message.truncated ||= bounded !== value;
  target.byteLimited ||= bounded !== value;
  if (bounded) append(target, { kind: "text", format, text: bounded });
}

function failureText(target: Group, value: string): string {
  const bounded = boundedText(value, 2048);
  target.message.truncated ||= bounded !== value;
  target.byteLimited ||= bounded !== value;
  return bounded;
}

function unsupported(target: Group, sourceType: string): void {
  flushActivity(target);
  target.message.truncated = true;
  target.unavailable = true;
  append(target, {
    kind: "unknown",
    originalKind: "unsupported-content",
    raw: {
      kind: "unsupported-content",
      sourceType: boundedText(sourceType, 128),
      message: "Open the full client for this content",
    },
  });
}

function blocks(
  target: Group,
  content: string | ContentBlock[],
  sourceId: string,
): void {
  if (typeof content === "string") {
    text(target, content, "plain");
    return;
  }
  content.forEach((block, index) => {
    if (block.type === "text" && typeof block.text === "string")
      text(target, block.text, "plain");
    else if (["image", "input_image", "document"].includes(block.type)) {
      flushActivity(target);
      append(target, {
        kind: "media",
        mediaId: derivedId("unavailable", `${sourceId}:${index}`),
        description: "Media requires the full client",
        availability: "unavailable",
      });
    } else unsupported(target, block.type);
  });
}

function tool(target: Group, item: ToolCallItem): void {
  target.terminal = false;
  target.message.state = item.status === "aborted" ? "interrupted" : "complete";
  target.activity ??= { tools: 0, failed: 0 };
  target.activity.tools++;
  if (item.status === "error") target.activity.failed++;
  if (item.status === "pending") target.pendingTools.push(item.toolName);
  if (item.status === "aborted") target.message.state = "interrupted";
  if (item.status === "error" || item.status === "incomplete") {
    // Keep failures at their original position, not at the end of a whole reply.
    flushActivity(target);
    const output =
      item.status === "incomplete"
        ? "Tool result unavailable"
        : item.toolResult?.content.trim() || "Tool failed";
    const message = failureText(target, output);
    target.message.truncated ||= item.status === "incomplete";
    target.unavailable ||= item.status === "incomplete";
    const exit = getCommandResultMeta(item.toolResult?.structured).exitCode;
    append(target, {
      kind: "failure",
      toolName: boundedText(item.toolName, 128) || "Tool",
      message,
      exitCode:
        Number.isInteger(exit) && exit! >= -2147483648 && exit! <= 2147483647
          ? exit!
          : null,
    });
  }
  for (const media of item.toolResult?.media ?? []) {
    flushActivity(target);
    const available =
      media.state === "stored" &&
      media.id.length > 0 &&
      boundedText(media.id, 256) === media.id;
    append(target, {
      kind: "media",
      mediaId: available ? media.id : derivedId("unavailable", item.id),
      description: boundedText(media.filename || "Tool result media", 512),
      availability: available ? "available" : "unavailable",
    });
  }
  if (
    ["UpdatePlan", "TodoWrite", "TaskCreate", "TaskUpdate"].includes(
      item.toolName,
    ) ||
    item.workflow?.markers.length
  )
    unsupported(target, item.toolName);
}

export interface GroupedConversation {
  messages: ConversationMessage[];
  unavailableMessageIds: ReadonlySet<string>;
  byteLimitedMessageIds: ReadonlySet<string>;
}

/** A new data projection over existing semantic rows. No renderer or store. */
export function groupConversation(
  items: RenderItem[],
  sources: Message[],
  activity: ActivityState,
  leadingUserId: string | null,
  prefixIncomplete: boolean,
  unmatchedResults: ReadonlySet<string>,
): GroupedConversation {
  const groups: Group[] = [];
  let userId = leadingUserId;
  let agent: Group | undefined;
  const positions = new Map(
    sources.map((source, index) => [getMessageId(source), index]),
  );
  const ensureAgent = (source: Message): Group => {
    if (agent) return agent;
    const id = getMessageId(source);
    if (!id) throw new Error("Visible content has no stable source ID");
    agent = group(
      derivedId(userId ? "agent" : "orphan", userId ?? id),
      "agent",
      null,
    );
    // An unanchored agent response must never claim complete history.
    agent.message.truncated =
      !userId || (groups.length === 0 && prefixIncomplete);
    agent.unavailable = !userId;
    groups.push(agent);
    return agent;
  };
  const finishAgent = (newUser = false) => {
    if (agent) {
      flushActivity(agent);
      if (newUser && agent.active && !agent.terminal) {
        agent.message.state = "interrupted";
        agent.active = false;
      }
    }
    agent = undefined;
  };

  // The compiler deliberately does not emit completion metadata or unsupported
  // assistant blocks. Merge those observations at their source/block positions.
  type Extra = {
    position: number;
    blockIndex: number;
    source: Message;
    block?: ContentBlock;
    terminal?: boolean;
  };
  const extras: Extra[] = [];
  sources.forEach((source, position) => {
    if (
      source.type === "system" &&
      (source.subtype === "turn_complete" ||
        (source.subtype === "stop_hook_summary" &&
          source.preventedContinuation === false))
    )
      extras.push({ position, blockIndex: Infinity, source, terminal: true });
    if (unmatchedResults.has(getMessageId(source)))
      extras.push({
        position,
        blockIndex: 0,
        source,
        block: { type: "tool-result-without-invocation" },
      });
    const content = source.message?.content ?? source.content;
    if (
      source.type === "assistant" &&
      !source.isSubagent &&
      Array.isArray(content)
    )
      content.forEach((block, blockIndex) => {
        if (
          !["text", "thinking", "redacted_thinking", "tool_use"].includes(
            block.type,
          ) ||
          (block.type === "text" && typeof block.text !== "string") ||
          (block.type === "tool_use" && (!block.id || !block.name))
        )
          extras.push({ position, blockIndex, source, block });
      });
  });
  let extraIndex = 0;
  const applyExtra = (extra: Extra) => {
    if (extra.terminal) {
      if (agent) {
        agent.terminal = true;
        agent.active = false;
      }
      return;
    }
    const target = ensureAgent(extra.source);
    target.message.createdAt ??= timestamp(extra.source);
    if (
      extra.block &&
      ["image", "input_image", "document"].includes(extra.block.type)
    )
      blocks(
        target,
        [extra.block],
        `${getMessageId(extra.source)}:${extra.blockIndex}`,
      );
    else unsupported(target, extra.block?.type ?? "unknown");
  };
  for (const item of items) {
    if (item.isSubagent) continue;
    const source = item.sourceMessages[0];
    if (!source) throw new Error("Semantic row has no source");
    const position = positions.get(getMessageId(source)) ?? -1;
    const sourceContent = source.message?.content ?? source.content;
    const blockIndex =
      item.type === "tool_call" && Array.isArray(sourceContent)
        ? sourceContent.findIndex((block) => block.id === item.id)
        : Number(item.id.slice(getMessageId(source).length + 1)) || 0;
    while (
      extras[extraIndex] &&
      (extras[extraIndex]!.position < position ||
        (extras[extraIndex]!.position === position &&
          extras[extraIndex]!.blockIndex < blockIndex))
    )
      applyExtra(extras[extraIndex++]!);
    if (item.type === "user_prompt") {
      finishAgent(true);
      userId = item.id;
      const prompt = group(item.id, "user", timestamp(source));
      blocks(prompt, item.content, item.id);
      groups.push(prompt);
      continue;
    }
    // Scope boundaries are represented by coverage; setup is not a user input.
    if (
      item.type === "session_setup" ||
      (item.type === "system" && item.subtype === "compact_boundary")
    )
      continue;
    if (
      item.type === "task_notification" &&
      !["failed", "error"].includes(item.status?.toLowerCase() ?? "")
    )
      continue;
    const target = ensureAgent(source);
    if (item.type === "thinking") {
      target.active ||= item.status === "streaming";
      continue;
    }
    target.message.createdAt ??= timestamp(source);
    if (item.type === "text") {
      text(target, item.text, "markdown");
      target.message.state =
        item.abortedMidStream || source.isAbortedMidStream
          ? "interrupted"
          : "complete";
      target.active = item.isStreaming === true || source._isStreaming === true;
      target.terminal = false;
    } else if (item.type === "tool_call") tool(target, item);
    else if (item.type === "system") {
      if (["error", "warning", "turn_aborted"].includes(item.subtype)) {
        flushActivity(target);
        append(target, {
          kind: "failure",
          toolName: "Agent",
          message: failureText(target, item.content) || "Agent interrupted",
          exitCode: null,
        });
        if (item.subtype === "turn_aborted" || item.subtype === "error") {
          target.message.state = "interrupted";
          target.active = false;
        }
      } else text(target, item.content, "plain");
    } else if (item.type === "task_notification") {
      flushActivity(target);
      append(target, {
        kind: "failure",
        toolName: "Task",
        message: failureText(target, item.summary ?? item.raw) || "Task failed",
        exitCode: null,
      });
    } else unsupported(target, item.type);
  }
  while (extras[extraIndex]) applyExtra(extras[extraIndex++]!);
  if (!agent && userId && (activity === "working" || activity === "waiting")) {
    const source = sources.at(-1);
    if (source) ensureAgent(source);
  }
  finishAgent();
  const unavailableMessageIds = new Set<string>();
  const byteLimitedMessageIds = new Set<string>();
  for (const [index, target] of groups.entries()) {
    if (target.message.role === "agent") {
      const latest = index === groups.length - 1;
      if (
        target.message.state !== "interrupted" &&
        !target.terminal &&
        (target.active ||
          (latest && (activity === "working" || activity === "waiting")))
      )
        target.message.state = "growing";
      if (target.message.state !== "growing" && target.pendingTools.length) {
        target.message.truncated = true;
        target.unavailable = true;
        append(target, {
          kind: "failure",
          toolName: "Tool",
          message: `${target.pendingTools.length} tool result(s) unavailable`,
          exitCode: null,
        });
      }
    }
    if (!target.message.content.length)
      append(target, {
        kind: "activity",
        summary:
          target.message.state === "growing"
            ? "Working"
            : "No visible response",
        toolCount: 0,
        failedToolCount: 0,
      });
    if (target.dropped)
      target.message.content.push(
        target.droppedFailure
          ? {
              kind: "failure",
              toolName: "Transcript",
              message: "Additional content, including failures, omitted",
              exitCode: null,
            }
          : {
              kind: "text",
              format: "plain",
              text: "Additional content omitted",
            },
      );
    if (target.unavailable) unavailableMessageIds.add(target.message.id);
    if (target.byteLimited) byteLimitedMessageIds.add(target.message.id);
  }
  return {
    messages: groups.map((entry) => entry.message),
    unavailableMessageIds,
    byteLimitedMessageIds,
  };
}
