import type { Message } from "../../types";
import { getMessageId } from "@yep-anywhere/shared/transcript/message";
import { parseTimestampMs } from "../messageAge";

export const DEFAULT_ACTIVE_WINDOW_TURN_TARGET = 20;
export const DEFAULT_ACTIVE_WINDOW_TURN_TRIGGER = 30;
export const ACTIVE_WINDOW_COMPACT_TARGET = 2;
export const ACTIVE_WINDOW_MIN_BOUNDARY_AGE_MS = 60_000;

export type ActiveWindowStructuralKind = "compact_boundary" | "user_turn";

export interface ActiveWindowTrimCheckInput {
  enabled: boolean;
  followingBottom: boolean;
  historyExpanded: boolean;
  tailFrom?: string;
  structuralRevision: number;
  lastEvaluatedStructuralRevision: number;
  completedTranscriptGrowth: boolean;
  pendingCandidateEligibleAfterMs?: number;
  nowMs: number;
}

export interface ActiveWindowTrimPlanInput {
  messages: readonly Message[];
  nowMs: number;
  tailTurns?: number;
}

export interface ActiveWindowTrimCandidate {
  startIndex: number;
  startMessageId: string;
  reason: ActiveWindowStructuralKind;
  boundaryTimestampMs: number;
  eligibleAfterMs: number;
  turnTarget: number;
  turnTrigger: number;
}

export type ActiveWindowTrimPlanningResult =
  | {
      kind: "none";
      reason:
        | "below_threshold"
        | "candidate_at_start"
        | "invalid_timestamp"
        | "missing_message_id";
    }
  | { kind: "deferred"; candidate: ActiveWindowTrimCandidate }
  | { kind: "ready"; candidate: ActiveWindowTrimCandidate };

export interface ActiveWindowTrimEvaluationInput {
  check: ActiveWindowTrimCheckInput;
  plan: ActiveWindowTrimPlanInput;
}

export type ActiveWindowTrimEvaluationResult =
  | { kind: "not_considered" }
  | ActiveWindowTrimPlanningResult;

export type ActiveWindowTrimPlanner = (
  input: ActiveWindowTrimPlanInput,
) => ActiveWindowTrimPlanningResult;

function getMessageText(message: Message): string | undefined {
  if (typeof message.message?.content === "string") {
    return message.message.content;
  }
  return typeof message.content === "string" ? message.content : undefined;
}

function getMessageContentArray(message: Message): unknown[] | undefined {
  const content = message.message?.content ?? message.content;
  return Array.isArray(content) ? content : undefined;
}

function getTextContent(message: Message): string | undefined {
  const text = getMessageText(message);
  if (text !== undefined) {
    return text;
  }
  const content = getMessageContentArray(message);
  if (!content) {
    return undefined;
  }
  const textBlocks = content
    .map((block) =>
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .filter(Boolean);
  return textBlocks.length > 0 ? textBlocks.join("\n") : undefined;
}

function hasOnlyToolResultContent(message: Message): boolean {
  const content = getMessageContentArray(message);
  return (
    content !== undefined &&
    content.length > 0 &&
    content.every(
      (block) =>
        block !== null &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "tool_result",
    )
  );
}

function isSlashCommandSkillBody(message: Message): boolean {
  if (message.isMeta !== true) {
    return false;
  }
  return (
    getTextContent(message)
      ?.trimStart()
      .startsWith("Base directory for this skill:") === true
  );
}

function isLocalCommandTranscriptText(text: string): boolean {
  const trimmed = text.trim();
  const commandNameMatch = /<command-name>[\s\S]*<\/command-name>/.test(
    trimmed,
  );
  const commandRemainder = trimmed
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, "")
    .trim();
  return (
    /^<local-command-caveat>[\s\S]*<\/local-command-caveat>$/.test(trimmed) ||
    /^<local-command-stdout>[\s\S]*<\/local-command-stdout>$/.test(trimmed) ||
    (commandNameMatch && commandRemainder === "")
  );
}

function isSyntheticUserTurn(message: Message): boolean {
  if (message.isCompactSummary === true) {
    return true;
  }
  if (hasOnlyToolResultContent(message)) {
    return true;
  }
  if (isSlashCommandSkillBody(message)) {
    return true;
  }
  const text = getMessageText(message);
  return typeof text === "string" && isLocalCommandTranscriptText(text);
}

export function isActiveWindowCompactBoundary(message: Message): boolean {
  return message.type === "system" && message.subtype === "compact_boundary";
}

export function isActiveWindowRealUserTurn(message: Message): boolean {
  const nestedRole = message.message?.role;
  const role =
    typeof message.role === "string"
      ? message.role
      : typeof nestedRole === "string"
        ? nestedRole
        : undefined;
  return (
    (message.type === "user" || role === "user") &&
    !isSyntheticUserTurn(message)
  );
}

export function getActiveWindowStructuralKind(
  message: Message,
): ActiveWindowStructuralKind | null {
  if (isActiveWindowCompactBoundary(message)) {
    return "compact_boundary";
  }
  return isActiveWindowRealUserTurn(message) ? "user_turn" : null;
}

function normalizeTurnTarget(tailTurns: number | undefined): number {
  if (tailTurns === undefined || !Number.isFinite(tailTurns)) {
    return DEFAULT_ACTIVE_WINDOW_TURN_TARGET;
  }
  return Math.max(1, Math.floor(tailTurns));
}

export function getActiveWindowTurnTrigger(turnTarget: number): number {
  if (turnTarget === DEFAULT_ACTIVE_WINDOW_TURN_TARGET) {
    return DEFAULT_ACTIVE_WINDOW_TURN_TRIGGER;
  }
  return Math.max(turnTarget + 1, Math.ceil(turnTarget * 1.5));
}

/**
 * Constant-time hot-path gate. Callers may invoke this for every session-detail
 * action; it never inspects transcript messages.
 */
export function shouldConsiderActiveWindowTrim({
  enabled,
  followingBottom,
  historyExpanded,
  tailFrom,
  structuralRevision,
  lastEvaluatedStructuralRevision,
  completedTranscriptGrowth,
  pendingCandidateEligibleAfterMs,
  nowMs,
}: ActiveWindowTrimCheckInput): boolean {
  if (
    !enabled ||
    historyExpanded ||
    !followingBottom ||
    (tailFrom !== undefined && tailFrom.length > 0)
  ) {
    return false;
  }
  if (structuralRevision !== lastEvaluatedStructuralRevision) {
    return true;
  }
  return (
    completedTranscriptGrowth &&
    pendingCandidateEligibleAfterMs !== undefined &&
    nowMs > pendingCandidateEligibleAfterMs
  );
}

/**
 * Find the reload-equivalent retained suffix after the cheap gate admits a
 * structural evaluation. The reverse walk stops as soon as older unseen
 * boundaries cannot change the selected start.
 */
export function planActiveWindowTrim({
  messages,
  nowMs,
  tailTurns,
}: ActiveWindowTrimPlanInput): ActiveWindowTrimPlanningResult {
  const turnTarget = normalizeTurnTarget(tailTurns);
  const turnTrigger = getActiveWindowTurnTrigger(turnTarget);
  let turnCount = 0;
  let compactCount = 0;
  let turnCandidateIndex: number | null = null;
  let compactCandidateIndex: number | null = null;
  let turnPressure = false;
  let compactPressure = false;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    const kind = getActiveWindowStructuralKind(message);
    if (kind === "user_turn") {
      turnCount += 1;
      if (turnCount === turnTarget) {
        turnCandidateIndex = index;
      }
      if (turnCount > turnTrigger) {
        turnPressure = true;
        break;
      }
    } else if (kind === "compact_boundary") {
      compactCount += 1;
      if (compactCount === ACTIVE_WINDOW_COMPACT_TARGET) {
        compactCandidateIndex = index;
      }
      if (compactCount > ACTIVE_WINDOW_COMPACT_TARGET) {
        compactPressure = true;
      }
    }

    if (compactPressure && turnCount < turnTarget) {
      // Any unseen turn candidate is older than the compact candidate and
      // therefore cannot win the later-start intersection.
      break;
    }
  }

  if (!turnPressure && !compactPressure) {
    return { kind: "none", reason: "below_threshold" };
  }

  let startIndex: number;
  let reason: ActiveWindowStructuralKind;
  if (
    turnPressure &&
    turnCandidateIndex !== null &&
    (!compactPressure ||
      compactCandidateIndex === null ||
      turnCandidateIndex > compactCandidateIndex)
  ) {
    startIndex = turnCandidateIndex;
    reason = "user_turn";
  } else if (compactCandidateIndex !== null) {
    startIndex = compactCandidateIndex;
    reason = "compact_boundary";
  } else {
    return { kind: "none", reason: "below_threshold" };
  }

  if (startIndex <= 0) {
    return { kind: "none", reason: "candidate_at_start" };
  }
  const boundary = messages[startIndex];
  if (!boundary) {
    return { kind: "none", reason: "missing_message_id" };
  }
  const startMessageId = getMessageId(boundary);
  if (!startMessageId) {
    return { kind: "none", reason: "missing_message_id" };
  }
  const boundaryTimestampMs = parseTimestampMs(boundary.timestamp);
  if (boundaryTimestampMs === null) {
    return { kind: "none", reason: "invalid_timestamp" };
  }

  const candidate: ActiveWindowTrimCandidate = {
    startIndex,
    startMessageId,
    reason,
    boundaryTimestampMs,
    eligibleAfterMs: boundaryTimestampMs + ACTIVE_WINDOW_MIN_BOUNDARY_AGE_MS,
    turnTarget,
    turnTrigger,
  };
  return nowMs > candidate.eligibleAfterMs
    ? { kind: "ready", candidate }
    : { kind: "deferred", candidate };
}

/** Pure orchestration helper used by future store wiring and hot-path tests. */
export function evaluateActiveWindowTrim(
  input: ActiveWindowTrimEvaluationInput,
  planner: ActiveWindowTrimPlanner = planActiveWindowTrim,
): ActiveWindowTrimEvaluationResult {
  if (!shouldConsiderActiveWindowTrim(input.check)) {
    return { kind: "not_considered" };
  }
  return planner(input.plan);
}
