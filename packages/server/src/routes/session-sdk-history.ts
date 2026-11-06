import type { ContextUsage, ProviderName } from "@yep-anywhere/shared";
import { getModelContextWindow } from "@yep-anywhere/shared";
import { collapseMessageSnapshots } from "@yep-anywhere/shared/transcript/message";
import type { SDKMessage } from "../sdk/types.js";
import type { ContentBlock, Message } from "../supervisor/types.js";

function isCompactBoundaryMessage(message: SDKMessage | Message): boolean {
  return message.type === "system" && message.subtype === "compact_boundary";
}

/**
 * Convert SDK messages to client Message format.
 * Used for mock SDK sessions where messages aren't persisted to disk.
 */
export function sdkMessagesToClientMessages(
  sdkMessages: SDKMessage[],
): Message[] {
  const messages: Message[] = [];
  for (const msg of sdkMessages) {
    const rawFields = msg as Record<string, unknown>;
    if (isCompactBoundaryMessage(msg)) {
      const content =
        (typeof msg.message?.content === "string"
          ? msg.message.content
          : undefined) ??
        (typeof msg.content === "string" ? msg.content : "Context compacted");
      messages.push({
        ...rawFields,
        id: msg.uuid ?? `msg-${Date.now()}-${messages.length}`,
        type: "system",
        role: "system",
        subtype: "compact_boundary",
        content,
        message: { role: "system", content },
        timestamp:
          typeof msg.timestamp === "string" && msg.timestamp.trim().length > 0
            ? msg.timestamp
            : new Date().toISOString(),
      });
      continue;
    }

    // Only include user and assistant messages with content
    if (
      (msg.type === "user" || msg.type === "assistant") &&
      msg.message?.content
    ) {
      const rawContent = msg.message.content;
      // Both user and assistant messages can have string or array content.
      // User messages with tool_result blocks have array content that must be preserved.
      // Assistant messages need ContentBlock[] for transcript projection.
      let content: string | ContentBlock[];
      if (typeof rawContent === "string") {
        // String content: keep as-is for user messages, wrap in text block for assistant
        content =
          msg.type === "user"
            ? rawContent
            : [{ type: "text" as const, text: rawContent }];
      } else if (Array.isArray(rawContent)) {
        // Array content: pass through as ContentBlock[] for both user and assistant
        content = rawContent as ContentBlock[];
      } else {
        // Unknown content type - skip this message
        continue;
      }

      messages.push({
        ...rawFields,
        id: msg.uuid ?? `msg-${Date.now()}-${messages.length}`,
        type: msg.type,
        role: msg.type as "user" | "assistant",
        content,
        timestamp:
          typeof msg.timestamp === "string" && msg.timestamp.trim().length > 0
            ? msg.timestamp
            : new Date().toISOString(),
      });
    }
  }
  return collapseMessageSnapshots(messages);
}

/**
 * Extract context usage from SDK messages.
 * Finds the last assistant message with usage data.
 *
 * @param sdkMessages - SDK messages to search
 * @param model - Model ID for determining context window size
 * @param provider - Provider for model-less context-window fallback
 */
export function extractContextUsageFromSDKMessages(
  sdkMessages: SDKMessage[],
  model: string | undefined,
  provider?: ProviderName,
  resolveContextWindow?: (
    model: string | undefined,
    provider?: ProviderName,
  ) => number,
): ContextUsage | undefined {
  const contextWindowSize = resolveContextWindow
    ? resolveContextWindow(model, provider)
    : getModelContextWindow(model, provider);

  const isCodexProvider = provider === "codex" || provider === "codex-oss";

  // Find the last assistant message with usage data (iterate backwards)
  for (let i = sdkMessages.length - 1; i >= 0; i--) {
    const msg = sdkMessages[i];
    if (msg && msg.type === "assistant" && msg.usage) {
      const usage = msg.usage as {
        input_tokens?: number;
        output_tokens?: number;
        cached_input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };

      // Codex context meter is based on fresh input tokens from the latest turn.
      // Claude/OpenCode/Gemini paths continue to include cached+creation tokens.
      const rawInputTokens = isCodexProvider
        ? (usage.input_tokens ?? 0)
        : (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0);

      // Skip messages with zero input tokens (incomplete streaming messages)
      if (rawInputTokens === 0) {
        continue;
      }

      const percentage = Math.round((rawInputTokens / contextWindowSize) * 100);

      const result: ContextUsage = {
        inputTokens: rawInputTokens,
        percentage,
        contextWindow: contextWindowSize,
      };

      // Add optional fields if available
      if (usage.output_tokens !== undefined && usage.output_tokens > 0) {
        result.outputTokens = usage.output_tokens;
      }
      if (isCodexProvider) {
        if (
          usage.cached_input_tokens !== undefined &&
          usage.cached_input_tokens > 0
        ) {
          result.cacheReadTokens = usage.cached_input_tokens;
        }
      } else if (
        usage.cache_read_input_tokens !== undefined &&
        usage.cache_read_input_tokens > 0
      ) {
        result.cacheReadTokens = usage.cache_read_input_tokens;
      }
      if (
        usage.cache_creation_input_tokens !== undefined &&
        usage.cache_creation_input_tokens > 0
      ) {
        result.cacheCreationTokens = usage.cache_creation_input_tokens;
      }

      return result;
    }
  }
  return undefined;
}
