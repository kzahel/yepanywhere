import {
  ALL_PROVIDERS,
  type EffortLevel,
  type ProviderName,
  type ReviewNewSessionOptions,
  type ThinkingConfig,
} from "@yep-anywhere/shared";
import type { SourceReviewDefaultSession } from "../contexts/SourceReviewDefaultSessionContext";

export interface SourceControlNavigationState {
  defaultSession?: SourceReviewDefaultSession;
}

const EFFORT_LEVELS: readonly EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isProviderName(value: unknown): value is ProviderName {
  return (
    typeof value === "string" &&
    (ALL_PROVIDERS as readonly string[]).includes(value)
  );
}

export function parseThinkingConfig(
  value: unknown,
): ThinkingConfig | undefined {
  if (!isRecord(value)) return undefined;
  const display =
    value.display === undefined
      ? undefined
      : value.display === "summarized" || value.display === "omitted"
        ? value.display
        : null;
  if (display === null) return undefined;
  if (value.type === "adaptive") {
    return { type: "adaptive", ...(display ? { display } : {}) };
  }
  if (value.type === "disabled") {
    return value.display === undefined ? { type: "disabled" } : undefined;
  }
  if (value.type === "enabled") {
    const budgetTokens =
      typeof value.budgetTokens === "number" &&
      Number.isInteger(value.budgetTokens) &&
      value.budgetTokens > 0
        ? value.budgetTokens
        : undefined;
    return {
      type: "enabled",
      ...(budgetTokens !== undefined ? { budgetTokens } : {}),
      ...(display ? { display } : {}),
    };
  }
  return undefined;
}

function parseNewSessionOptions(
  value: unknown,
): (ReviewNewSessionOptions & { provider: ProviderName }) | undefined {
  if (!isRecord(value) || !isProviderName(value.provider)) return undefined;
  const thinking = parseThinkingConfig(value.thinking);
  if (value.thinking !== undefined && !thinking) return undefined;
  const effort =
    typeof value.effort === "string" &&
    (EFFORT_LEVELS as readonly string[]).includes(value.effort)
      ? (value.effort as EffortLevel)
      : undefined;
  if (value.effort !== undefined && !effort) return undefined;
  if (
    value.model !== undefined &&
    (typeof value.model !== "string" || value.model.length === 0)
  ) {
    return undefined;
  }
  return {
    provider: value.provider,
    ...(typeof value.model === "string" && value.model.length > 0
      ? { model: value.model }
      : {}),
    ...(thinking ? { thinking } : {}),
    ...(effort ? { effort } : {}),
  };
}

export function parseSourceControlNavigationState(
  value: unknown,
): SourceControlNavigationState {
  if (!isRecord(value) || !isRecord(value.defaultSession)) return {};
  const session = value.defaultSession;
  const newSession = parseNewSessionOptions(session.newSession);
  if (
    typeof session.projectId !== "string" ||
    session.projectId.length === 0 ||
    typeof session.id !== "string" ||
    session.id.length === 0 ||
    typeof session.title !== "string" ||
    session.title.length === 0 ||
    !newSession
  ) {
    return {};
  }
  return {
    defaultSession: {
      projectId: session.projectId,
      id: session.id,
      title: session.title,
      newSession,
    },
  };
}

/**
 * The new-session settings a review submits from the default session. The
 * server carries that session's router selection, sandbox and tier to the
 * review session it starts (plan 183).
 */
export function reviewNewSessionFromDefault(
  defaultSession: SourceReviewDefaultSession | null | undefined,
): ReviewNewSessionOptions | undefined {
  return defaultSession
    ? { ...defaultSession.newSession, sourceSessionId: defaultSession.id }
    : undefined;
}

export function createSourceControlNavigationState(
  defaultSession: SourceReviewDefaultSession,
): SourceControlNavigationState {
  return { defaultSession };
}
