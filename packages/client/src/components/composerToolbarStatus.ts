import type { SessionLivenessSnapshot } from "@yep-anywhere/shared";
import type { useI18n } from "../i18n";
import type { BtwToolbarMode } from "../lib/btwAsideRouting";
import { formatCompactRelativeAge, parseTimestampMs } from "../lib/messageAge";
type ToolbarTranslate = ReturnType<typeof useI18n>["t"];

export type LivenessTone = "ok" | "warn" | "danger" | "muted";

export interface LivenessDisplay {
  prefix: string;
  timestampMs: number | null;
  tone: LivenessTone;
  title: string;
}

export function describeSessionLiveness(
  snapshot: SessionLivenessSnapshot,
  t: ToolbarTranslate,
): LivenessDisplay {
  const checkedMs = parseTimestampMs(snapshot.checkedAt);
  const stateMs = parseTimestampMs(snapshot.lastStateChangeAt);
  const progressMs = parseTimestampMs(
    snapshot.lastVerifiedProgressAt ?? snapshot.lastProviderMessageAt,
  );
  const idleMs = parseTimestampMs(snapshot.lastVerifiedIdleAt);
  const title = [
    `status: ${snapshot.derivedStatus}`,
    `work: ${snapshot.activeWorkKind}`,
    snapshot.lastRawProviderEventAt
      ? `raw provider: ${snapshot.lastRawProviderEventSource ?? "unknown"} at ${snapshot.lastRawProviderEventAt}`
      : null,
    `evidence: ${snapshot.evidence.join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");

  switch (snapshot.derivedStatus) {
    case "verified-progressing":
      return {
        prefix: t("toolbarLivenessVerifiedProgress"),
        timestampMs: progressMs ?? checkedMs,
        tone: "ok",
        title,
      };
    case "recently-active-unverified":
      return {
        prefix: t("toolbarLivenessUnverifiedTurn"),
        timestampMs: stateMs ?? checkedMs,
        tone: "warn",
        title,
      };
    case "long-silent-unverified":
      return {
        prefix: t("toolbarLivenessLongSilent"),
        timestampMs: progressMs ?? stateMs ?? checkedMs,
        tone: "danger",
        title,
      };
    case "verified-waiting-provider":
      return {
        prefix: t("toolbarLivenessWaitingOnProvider"),
        timestampMs: progressMs ?? stateMs ?? checkedMs,
        tone: "warn",
        title,
      };
    case "verified-idle":
      return {
        prefix: t("toolbarLivenessVerifiedIdle"),
        timestampMs: idleMs ?? stateMs ?? checkedMs,
        tone: "muted",
        title,
      };
    case "needs-attention":
      return {
        prefix:
          snapshot.activeWorkKind === "waiting-input"
            ? t("toolbarLivenessNeedsInput")
            : t("toolbarLivenessNeedsAttention"),
        timestampMs: stateMs ?? checkedMs,
        tone: "danger",
        title,
      };
  }

  const unhandledStatus: never = snapshot.derivedStatus;
  return {
    prefix: t("toolbarLivenessUnknownState"),
    timestampMs: checkedMs,
    tone: "warn",
    title: `${title}\nunknown status: ${String(unhandledStatus)}`,
  };
}

export function formatLivenessAge(
  t: ToolbarTranslate,
  timestampMs: number,
  nowMs: number,
): string {
  const label = formatCompactRelativeAge(timestampMs, nowMs);
  return label === "now"
    ? t("toolbarRelativeAgeNow")
    : t("toolbarRelativeAgePast", { age: label });
}

export function describeLivenessSummary(
  t: ToolbarTranslate,
  display: LivenessDisplay,
  nowMs: number,
): string {
  if (display.timestampMs === null) {
    return display.prefix;
  }
  return t("toolbarLivenessSummary", {
    state: display.prefix,
    age: formatLivenessAge(t, display.timestampMs, nowMs),
  });
}

export function getBtwTitle(mode: BtwToolbarMode, t: ToolbarTranslate): string {
  switch (mode) {
    case "child-session":
      return t("toolbarBtwChildSessionTitle");
    case "focused-footer":
      return t("toolbarBtwFocusedFooterTitle");
    case "focused-pane":
      return t("toolbarBtwFocusedPaneTitle");
    case "focus-existing":
      return t("toolbarBtwFocusExistingTitle");
    case "start":
      return t("toolbarBtwStartTitle");
  }
}

export function isBtwPressed(mode: BtwToolbarMode): boolean {
  return (
    mode === "child-session" ||
    mode === "focused-footer" ||
    mode === "focused-pane"
  );
}

export const LAST_ACTIVITY_TEXT_PREFIX_THRESHOLD_MS = 30 * 60 * 1000;
