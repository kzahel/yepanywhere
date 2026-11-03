/**
 * Billable token usage: which frames of each provider's stream carry what the
 * provider charged for, and how to read them into the four token classes.
 *
 * Contract: topics/limited-users.md § Delivery v1 — Usage.
 *
 * This is deliberately not the cache-miss monitor's extractor. That one serves
 * the prompt-growth baseline, so it drops subagent frames, whose prompt is a
 * different conversation; a bill must count them. Each provider reports usage
 * on exactly one frame kind here, because several also repeat it elsewhere —
 * Claude's `result` and Codex's `turn_complete` restate what their per-request
 * frames already said, and reading both would bill a turn twice.
 */

import type { ProviderName, UsageTokenClasses } from "@yep-anywhere/shared";
import type { SDKMessage } from "./types.js";

/** The one frame kind a provider's billable usage arrives on. */
type UsageFrame =
  /** A per-request assistant frame, usage on the nested API message. */
  | "assistant"
  /** A per-request out-of-band `system`/`token_usage` frame. */
  | "token-usage"
  /** A `system`/`turn_complete` frame carrying the whole turn's total. */
  | "turn-complete"
  /** The turn's `result` frame carrying the whole turn's total. */
  | "result"
  /** The provider reports no usage YA can read. */
  | "none";

interface ProviderUsageSource {
  frame: UsageFrame;
  /**
   * The OpenAI and Google convention reports cached reads as a subset of
   * `input_tokens`; the Anthropic one reports input, cache reads and cache
   * writes disjointly. This follows the protocol a provider speaks, not its
   * name, so a new OpenAI-protocol provider is not read the Anthropic way.
   */
  cachedReadsInInput: boolean;
}

const ANTHROPIC_ASSISTANT: ProviderUsageSource = {
  frame: "assistant",
  cachedReadsInInput: false,
};

/** Exhaustive, so a new provider has to say where its usage is. */
const USAGE_SOURCE_BY_PROVIDER: Readonly<
  Record<ProviderName, ProviderUsageSource>
> = {
  claude: ANTHROPIC_ASSISTANT,
  "claude-gateway": ANTHROPIC_ASSISTANT,
  "claude-ollama": ANTHROPIC_ASSISTANT,
  codex: { frame: "token-usage", cachedReadsInInput: true },
  "codex-oss": { frame: "turn-complete", cachedReadsInInput: true },
  gemini: { frame: "result", cachedReadsInInput: true },
  "gemini-acp": { frame: "none", cachedReadsInInput: true },
  antigravity: { frame: "none", cachedReadsInInput: true },
  grok: { frame: "none", cachedReadsInInput: false },
  opencode: { frame: "result", cachedReadsInInput: false },
  pi: { frame: "result", cachedReadsInInput: false },
};

/** Whether a provider counts cached prompt reads inside `input_tokens`. */
export function cachedReadsCountedInInput(provider: ProviderName): boolean {
  return USAGE_SOURCE_BY_PROVIDER[provider]?.cachedReadsInInput ?? false;
}

/** One frame's charge, split into the classes a price list distinguishes. */
export interface BillableUsage extends UsageTokenClasses {
  /**
   * The prompt one request sent, which decides its context tier. Absent when
   * the frame reports a turn's total, whose sum says nothing about any single
   * request's length.
   */
  requestPromptTokens?: number;
  /** The provider's id for the response, when it names one. */
  responseId?: string;
  /**
   * The model that served this frame, when the frame names it. A subagent's
   * requests may run another model than the session's, and are priced at it.
   */
  model?: string;
}

/**
 * The provider's own id for the API response a frame belongs to. While a
 * Claude response streams, the SDK emits one assistant message per completed
 * content block, each repeating the same `message.usage`, so a reader counting
 * charges or judging prompt growth must take each id once. Undefined means the
 * provider named no response, and each frame is then its own request: two real
 * requests may legitimately report equal counts.
 */
export function usageResponseId(message: SDKMessage): string | undefined {
  const candidate = (message as { message?: { id?: unknown } }).message?.id;
  return typeof candidate === "string" && candidate.trim()
    ? candidate
    : undefined;
}

function isUsageFrame(message: SDKMessage, frame: UsageFrame): boolean {
  switch (frame) {
    case "assistant":
      return message.type === "assistant";
    case "token-usage":
      return message.type === "system" && message.subtype === "token_usage";
    case "turn-complete":
      return message.type === "system" && message.subtype === "turn_complete";
    case "result":
      return message.type === "result";
    case "none":
      return false;
  }
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

/**
 * The charge a frame reports, or undefined when this frame is not the one the
 * provider bills on or reports nothing. Subagent frames count: a Task
 * subagent's requests are billed to the session that delegated to it.
 */
export function readBillableUsage(
  message: SDKMessage,
  provider: ProviderName,
): BillableUsage | undefined {
  const source = USAGE_SOURCE_BY_PROVIDER[provider];
  if (!source || !isUsageFrame(message, source.frame)) return undefined;
  const raw =
    source.frame === "assistant"
      ? (message as { message?: { usage?: unknown } }).message?.usage
      : (message as { usage?: unknown }).usage;
  if (!raw || typeof raw !== "object") return undefined;
  const fields = raw as Record<string, unknown>;

  const inputTokens = tokenCount(fields.input_tokens);
  const cachedInputTokens = tokenCount(
    fields.cache_read_input_tokens ?? fields.cached_input_tokens,
  );
  const cacheWriteTokens = tokenCount(fields.cache_creation_input_tokens);
  const outputTokens = tokenCount(fields.output_tokens);
  const promptTokens = source.cachedReadsInInput
    ? Math.max(inputTokens, cachedInputTokens)
    : inputTokens + cachedInputTokens + cacheWriteTokens;
  if (promptTokens === 0 && outputTokens === 0) return undefined;

  const responseId = usageResponseId(message);
  const perRequest =
    source.frame === "assistant" || source.frame === "token-usage";
  const servedModel =
    source.frame === "assistant"
      ? (message as { message?: { model?: unknown } }).message?.model
      : undefined;
  const model =
    typeof servedModel === "string" &&
    servedModel.trim() &&
    servedModel !== "<synthetic>"
      ? servedModel
      : undefined;
  return {
    freshInputTokens: Math.max(
      0,
      promptTokens - cachedInputTokens - cacheWriteTokens,
    ),
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    ...(perRequest ? { requestPromptTokens: promptTokens } : {}),
    ...(responseId ? { responseId } : {}),
    ...(model ? { model } : {}),
  };
}
