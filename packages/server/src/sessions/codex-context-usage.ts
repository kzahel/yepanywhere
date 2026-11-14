import {
  type CodexSessionEntry,
  getModelContextWindow,
} from "@yep-anywhere/shared";
import type { ContextUsage } from "../supervisor/types.js";

/** The latest-turn context meter a Codex summary reports. */
export interface CodexSummaryContextCandidate {
  inputTokens: number;
  contextWindow?: number;
}

export function codexContextUsageFromCandidate(
  candidate: CodexSummaryContextCandidate | undefined,
  model: string | undefined,
  provider: "codex" | "codex-oss",
): ContextUsage | undefined {
  if (!candidate) {
    return undefined;
  }

  const contextWindow =
    candidate.contextWindow ?? getModelContextWindow(model, provider);
  const percentage = Math.min(
    100,
    Math.round((candidate.inputTokens / contextWindow) * 100),
  );
  return {
    inputTokens: candidate.inputTokens,
    percentage,
    contextWindow,
  };
}

/**
 * Extract context usage from token_count events.
 *
 * @param entries - Codex session entries
 * @param model - Model ID for determining context window size (fallback)
 * @param provider - Provider for model-less context-window fallback
 */
export function extractCodexContextUsage(
  entries: CodexSessionEntry[],
  model: string | undefined,
  provider: "codex" | "codex-oss",
): ContextUsage | undefined {
  // Find last token_count event
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry &&
      entry.type === "event_msg" &&
      entry.payload.type === "token_count"
    ) {
      const info = entry.payload.info;
      if (info?.last_token_usage || info?.total_token_usage) {
        // Codex context meter is based on the latest turn's input_tokens,
        // not cumulative totals and not cached-input totals.
        const usage = info.last_token_usage ?? info.total_token_usage;
        if (!usage) continue;
        const inputTokens = usage.input_tokens;

        if (inputTokens === 0) continue;

        // Prefer model_context_window from Codex if available, fall back to model-based lookup
        const contextWindow =
          info.model_context_window && info.model_context_window > 0
            ? info.model_context_window
            : getModelContextWindow(model, provider);
        const percentage = Math.min(
          100,
          Math.round((inputTokens / contextWindow) * 100),
        );

        return { inputTokens, percentage, contextWindow };
      }
    }
  }

  return undefined;
}
