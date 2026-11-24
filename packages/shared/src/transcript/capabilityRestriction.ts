/**
 * Restricted capability: evidence that a provider answered a refusal by moving
 * work to a different model, and whether that model is still the one
 * answering. Claude Code records each refusal fallback as a
 * `model_refusal_fallback` system row.
 */

/** One refusal fallback, addressed by the transcript row that records it. */
export interface CapabilityRestrictionEvent {
  messageId: string;
  /** When the row was recorded, when the provider stamped it. */
  at?: string;
  fromModel: string;
  toModel: string;
  /** The provider's refusal category, such as `cyber`; open vocabulary. */
  category?: string;
  /**
   * `session`: the session's model was swapped. `response`: one subagent or
   * side-question reply came from the fallback and the session model stayed.
   */
  scope: "session" | "response";
}

/** Bounded recent refusal fallbacks of one session, oldest first. */
export interface CapabilityRestrictionSummary {
  events: CapabilityRestrictionEvent[];
  /**
   * The fallback model the session was last swapped to, while it is still the
   * one answering; absent once another model has answered.
   */
  activeModel?: string;
  /** Earlier events exist beyond `events`. */
  omitted: boolean;
}

export type ModelRefusalFallback = Omit<
  CapabilityRestrictionEvent,
  "messageId" | "at"
>;

export const MAX_CAPABILITY_RESTRICTION_EVENTS = 8;

const text = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;

/**
 * Reads a Claude `model_refusal_fallback` system row, else null. Durable
 * transcript rows spell fields in camelCase and live SDK messages in
 * snake_case; both are accepted.
 */
export function readModelRefusalFallback(
  row: Record<string, unknown>,
): ModelRefusalFallback | null {
  if (row.type !== "system" || row.subtype !== "model_refusal_fallback")
    return null;
  const fromModel = text(row.originalModel ?? row.original_model);
  const toModel = text(row.fallbackModel ?? row.fallback_model);
  if (!fromModel || !toModel) return null;
  const category = text(row.apiRefusalCategory ?? row.api_refusal_category);
  return {
    fromModel,
    toModel,
    ...(category ? { category } : {}),
    // Rows from before the provider recorded a scope swapped the session.
    scope: row.scope === "local" ? "response" : "session",
  };
}

/**
 * Whether a model id names the fallback model. A transcript may record a
 * dated id where the fallback row names the alias, or the reverse.
 */
function isFallbackModel(model: string, toModel: string): boolean {
  return model.startsWith(toModel) || toModel.startsWith(model);
}

/**
 * Folds a transcript's refusal fallbacks and the models that answered, fed in
 * transcript order, into a summary. Given an earlier summary of the same
 * transcript, it continues from it: rows the earlier summary already covers
 * may be fed again.
 */
export class CapabilityRestrictionFold {
  private readonly events: CapabilityRestrictionEvent[];
  private omitted: boolean;
  /** The model the session was swapped to, until another model answers. */
  private swappedTo: string | undefined;

  constructor(earlier?: CapabilityRestrictionSummary) {
    this.events = [...(earlier?.events ?? [])];
    this.omitted = earlier?.omitted ?? false;
    this.swappedTo = earlier?.activeModel;
  }

  fallback(event: CapabilityRestrictionEvent): void {
    if (!this.events.some((known) => known.messageId === event.messageId))
      this.events.push(event);
    if (event.scope === "session") this.swappedTo = event.toModel;
  }

  answeredBy(model: string): void {
    if (this.swappedTo && !isFallbackModel(model, this.swappedTo))
      this.swappedTo = undefined;
  }

  /** Undefined when the transcript holds no fallback. */
  summary(): CapabilityRestrictionSummary | undefined {
    if (this.events.length === 0) return undefined;
    return {
      events: this.events.slice(-MAX_CAPABILITY_RESTRICTION_EVENTS),
      ...(this.swappedTo ? { activeModel: this.swappedTo } : {}),
      omitted:
        this.omitted || this.events.length > MAX_CAPABILITY_RESTRICTION_EVENTS,
    };
  }
}
