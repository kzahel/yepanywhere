import { augmentTaskListSnapshots } from "../../src/augments/task-list-augments.js";
import { inspect } from "node:util";
import { getMessageId } from "@yep-anywhere/shared/transcript/message";
import { compileTranscriptProjection } from "@yep-anywhere/shared/transcript/compiler";
import type { TranscriptProjectionAugments } from "@yep-anywhere/shared/transcript/types";
import type { Message as ClientMessage } from "@yep-anywhere/shared/transcript/message";
import type { RenderItem } from "@yep-anywhere/shared/transcript/items";
import { createStreamAugmenter } from "../../src/augments/stream-augmenter.js";
import { normalizeSession } from "../../src/sessions/normalization.js";
import { augmentPersistedSessionMessages } from "../../src/sessions/persisted-augments.js";
import type { LoadedSession } from "../../src/sessions/types.js";
import { normalizeStreamMessage } from "../../src/subscriptions.js";
import type { Message as ServerMessage } from "../../src/supervisor/types.js";

export interface PersistedPipelineResult {
  messages: ClientMessage[];
  renderItems: RenderItem[];
}

export interface StreamPipelineResult {
  messages: ClientMessage[];
  renderItems: RenderItem[];
}

const NON_SEMANTIC_KEYS = new Set([
  "timestamp",
  "session_id",
  "sessionId",
  "_source",
]);

export interface RenderParityNormalizationOptions {
  idAliases?: Readonly<Record<string, string>>;
  includeSourceRelationships?: boolean;
}

export interface RenderParityAssertionOptions {
  persisted?: RenderParityNormalizationOptions;
  stream?: RenderParityNormalizationOptions;
}

const HTML_PRESENCE_KEYS = new Set([
  "_diffHtml",
  "_highlightedContentHtml",
  "_renderedMarkdownHtml",
  "_renderedHtml",
]);

function normalizeHtml(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeUnknown(item));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (NON_SEMANTIC_KEYS.has(key)) continue;
      const nested = record[key];
      if (nested === undefined) continue;

      if (HTML_PRESENCE_KEYS.has(key)) {
        out[key] = typeof nested === "string" && nested.trim().length > 0;
        continue;
      }

      out[key] = normalizeUnknown(nested);
    }
    return out;
  }
  return value;
}

function normalizeUserPromptContent(content: unknown): unknown {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: string }).type === "text" &&
          typeof (block as { text?: string }).text === "string"
        ) {
          return (block as { text: string }).text;
        }
        return null;
      })
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    if (text.length > 0) {
      return text;
    }
  }
  return normalizeUnknown(content);
}

function normalizeId(
  id: string,
  aliases: Readonly<Record<string, string>> | undefined,
): string {
  return aliases?.[id] ?? id;
}

function normalizeSourceRelationships(
  item: RenderItem,
  aliases: Readonly<Record<string, string>> | undefined,
): unknown[] {
  return item.sourceMessages.map((message) => {
    const record = message as unknown as Record<string, unknown>;
    const parentUuid = record.parentUuid;
    const parentToolUseId = record.parentToolUseId ?? record.parent_tool_use_id;
    return {
      id: normalizeId(getMessageId(message), aliases),
      parentUuid:
        typeof parentUuid === "string"
          ? normalizeId(parentUuid, aliases)
          : (parentUuid ?? undefined),
      parentToolUseId:
        typeof parentToolUseId === "string"
          ? normalizeId(parentToolUseId, aliases)
          : (parentToolUseId ?? undefined),
    };
  });
}

export function normalizeRenderItemsForComparison(
  items: RenderItem[],
  options: RenderParityNormalizationOptions = {},
): unknown[] {
  return items.map((item) => {
    const base = {
      type: item.type,
      id: normalizeId(item.id, options.idAliases),
      isSubagent: item.isSubagent ?? false,
      ...(options.includeSourceRelationships
        ? {
            sourceRelationships: normalizeSourceRelationships(
              item,
              options.idAliases,
            ),
          }
        : {}),
    };

    if (item.type === "tool_call") {
      return {
        ...base,
        status: item.status,
        toolName: item.toolName,
        toolInput: normalizeUnknown(item.toolInput),
        displayActions: normalizeUnknown(item.displayActions),
        toolResult: item.toolResult
          ? {
              content: item.toolResult.content,
              isError: item.toolResult.isError,
              structured: normalizeUnknown(item.toolResult.structured),
              media: normalizeUnknown(item.toolResult.media),
            }
          : null,
      };
    }

    if (item.type === "text") {
      return {
        ...base,
        text: item.text,
        isStreaming: item.isStreaming ?? false,
        hasAugmentHtml: Boolean(item.augmentHtml),
        augmentHtml: normalizeHtml(item.augmentHtml),
      };
    }

    if (item.type === "thinking") {
      return {
        ...base,
        thinking: item.thinking,
        signature: item.signature,
        status: item.status,
      };
    }

    if (item.type === "user_prompt") {
      return {
        ...base,
        content: normalizeUserPromptContent(item.content),
      };
    }

    if (item.type === "session_setup") {
      return {
        ...base,
        title: item.title,
        prompts: normalizeUnknown(item.prompts),
      };
    }

    if (item.type === "transcript_display_object") {
      return {
        ...base,
        object: normalizeUnknown(item.object),
      };
    }

    if (item.type === "system") {
      return {
        ...base,
        subtype: item.subtype,
        content: item.content,
        details: normalizeUnknown(item.details),
        status: item.status ?? null,
        configChanged: item.configChanged,
      };
    }

    if (item.type === "task_notification") {
      return {
        ...base,
        raw: item.raw,
        taskId: item.taskId,
        toolUseId: item.toolUseId,
        outputFile: item.outputFile,
        status: item.status,
        summary: item.summary,
        event: item.event,
      };
    }

    return {
      ...base,
      activityCount: item.activityCount,
      active: item.active,
      expanded: item.expanded,
      thinkingPreviews: normalizeUnknown(item.thinkingPreviews),
      recentActivities: normalizeUnknown(item.recentActivities),
      startedAtMs: item.startedAtMs,
      endedAtMs: item.endedAtMs,
    };
  });
}

function findFirstDifference(
  left: unknown,
  right: unknown,
  path = "$",
): { path: string; left: unknown; right: unknown } | null {
  if (Object.is(left, right)) return null;

  if (typeof left !== typeof right) {
    return { path, left, right };
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return { path: `${path}.length`, left: left.length, right: right.length };
    }
    for (let i = 0; i < left.length; i++) {
      const diff = findFirstDifference(left[i], right[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }

  if (
    left &&
    right &&
    typeof left === "object" &&
    typeof right === "object" &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = new Set([
      ...Object.keys(leftRecord),
      ...Object.keys(rightRecord),
    ]);

    for (const key of [...keys].sort()) {
      if (!(key in leftRecord)) {
        return {
          path: `${path}.${key}`,
          left: undefined,
          right: rightRecord[key],
        };
      }
      if (!(key in rightRecord)) {
        return {
          path: `${path}.${key}`,
          left: leftRecord[key],
          right: undefined,
        };
      }
      const diff = findFirstDifference(
        leftRecord[key],
        rightRecord[key],
        `${path}.${key}`,
      );
      if (diff) return diff;
    }
    return null;
  }

  return { path, left, right };
}

function mergeProjectionAugments(
  base: TranscriptProjectionAugments | undefined,
  markdown: Record<string, { html: string }>,
): TranscriptProjectionAugments | undefined {
  if (Object.keys(markdown).length === 0) {
    return base;
  }
  return {
    ...base,
    markdown: {
      ...base?.markdown,
      ...markdown,
    },
  };
}

export async function runPersistedPipeline(
  loadedSession: LoadedSession,
  projectionAugments?: TranscriptProjectionAugments,
): Promise<PersistedPipelineResult> {
  const normalizedSession = normalizeSession(
    structuredClone(loadedSession),
  ) as { messages: ClientMessage[] };
  augmentTaskListSnapshots(normalizedSession.messages as ServerMessage[]);
  await augmentPersistedSessionMessages(
    normalizedSession.messages as unknown as ServerMessage[],
  );
  const renderItems = compileTranscriptProjection(
    normalizedSession.messages,
    projectionAugments,
  );
  return {
    messages: normalizedSession.messages,
    renderItems,
  };
}

export async function runStreamPipeline(
  streamMessages: Array<Record<string, unknown>>,
  projectionAugments?: TranscriptProjectionAugments,
): Promise<StreamPipelineResult> {
  const markdownAugments: Record<string, { html: string }> = {};
  const collectedMessages: ClientMessage[] = [];

  const augmenter = await createStreamAugmenter({
    onMarkdownAugment: (data) => {
      if (
        data.messageId &&
        data.blockIndex === undefined &&
        typeof data.html === "string"
      ) {
        markdownAugments[data.messageId] = { html: data.html };
      }
    },
    onPending: () => {},
  });

  for (const rawMessage of streamMessages) {
    const message = structuredClone(rawMessage);
    normalizeStreamMessage(message);
    await augmenter.processMessage(message);

    const type = message.type;
    if (
      type === "assistant" ||
      type === "user" ||
      type === "system" ||
      type === "error" ||
      type === "summary"
    ) {
      collectedMessages.push(message as unknown as ClientMessage);
    }
  }

  await augmenter.flush();

  const renderItems = compileTranscriptProjection(
    collectedMessages,
    mergeProjectionAugments(projectionAugments, markdownAugments),
  );

  return {
    messages: collectedMessages,
    renderItems,
  };
}

export function assertRenderParity(
  fixtureName: string,
  persistedItems: RenderItem[],
  streamItems: RenderItem[],
  options: RenderParityAssertionOptions = {},
): void {
  const persistedComparable = normalizeRenderItemsForComparison(
    persistedItems,
    options.persisted,
  );
  const streamComparable = normalizeRenderItemsForComparison(
    streamItems,
    options.stream,
  );
  const diff = findFirstDifference(persistedComparable, streamComparable);

  if (!diff) return;

  throw new Error(
    [
      `[${fixtureName}] Render parity drift at ${diff.path}`,
      `Persisted: ${inspect(diff.left, { depth: 8, breakLength: 120 })}`,
      `Stream: ${inspect(diff.right, { depth: 8, breakLength: 120 })}`,
      "Persisted normalized render items:",
      JSON.stringify(persistedComparable, null, 2),
      "Stream normalized render items:",
      JSON.stringify(streamComparable, null, 2),
    ].join("\n"),
  );
}
