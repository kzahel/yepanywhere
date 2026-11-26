import { randomUUID } from "node:crypto";
import type { SDKMessage } from "../types.js";
import type { AntigravityUpdate } from "./antigravity-runtime.js";

/**
 * The context meter from ACP `usage_update` (`used` tokens in context of a
 * `size`-token window; serialized so by `agy` 1.5.18). Each change becomes
 * the shared `system`/`token_usage` frame clients read as context usage,
 * and the window is reported on the turn's result as `modelUsage`, where
 * Process records an observed context window.
 */
export class AntigravityContextMeter {
  private used?: number;
  private size?: number;
  private model?: string;

  constructor(private readonly sessionId: string) {}

  /** Queues a frame on `out` when the reading changed; returns whether it did. */
  observe(
    update: AntigravityUpdate,
    model: string | undefined,
    out: SDKMessage[],
  ): boolean {
    if (update.sessionUpdate !== "usage_update") return false;
    const { used, size } = update as { used?: unknown; size?: unknown };
    if (!isTokenCount(used) || used === 0) return false;
    const window = isTokenCount(size) && size > 0 ? size : undefined;
    if (used === this.used && window === this.size && model === this.model)
      return false;
    this.used = used;
    this.size = window;
    this.model = model;
    out.push({
      type: "system",
      subtype: "token_usage",
      uuid: randomUUID(),
      session_id: this.sessionId,
      isSynthetic: true,
      usage: { input_tokens: used },
      ...(window ? { model_context_window: window } : {}),
    } as SDKMessage);
    return true;
  }

  /** The observed window for a result frame, keyed by the model it was for. */
  result(): { modelUsage?: Record<string, { contextWindow: number }> } {
    return this.size && this.model
      ? { modelUsage: { [this.model]: { contextWindow: this.size } } }
      : {};
  }
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
