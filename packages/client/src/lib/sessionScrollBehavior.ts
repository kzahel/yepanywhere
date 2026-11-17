import type { SessionRouteScrollSnapshot } from "./sessionRouteSnapshots";

export const SESSION_SCROLL_BEHAVIOR_MODES = [
  "live-tail",
  "remember-place",
  "no-memory",
] as const;

export type SessionScrollBehaviorMode =
  (typeof SESSION_SCROLL_BEHAVIOR_MODES)[number];

export const DEFAULT_SESSION_SCROLL_BEHAVIOR_MODE: SessionScrollBehaviorMode =
  "live-tail";

export type SessionScrollRestoreDecision =
  | "skip"
  | "follow-bottom"
  | "restore-position";

export type FollowScrollPosition = {
  top: number;
  width: number;
  height: number;
};

// Rounding tolerance for bottom visibility and scroll direction.
export const FOLLOW_BOTTOM_TOLERANCE_PX = 4;

export function readFollowScrollPosition(
  viewport: HTMLElement,
  top = viewport.scrollTop,
): FollowScrollPosition {
  return { top, width: viewport.clientWidth, height: viewport.clientHeight };
}

export function movedUpFromFollowPosition(
  viewport: HTMLElement,
  previous: FollowScrollPosition | null,
): boolean {
  // A reflow can move scrollTop before the resize observer re-pins the tail.
  // Compare positions only in the same viewport geometry. Explicit gestures
  // release follow through their own input handlers.
  return (
    previous !== null &&
    viewport.clientWidth === previous.width &&
    viewport.clientHeight === previous.height &&
    viewport.scrollTop < previous.top - FOLLOW_BOTTOM_TOLERANCE_PX
  );
}

export function parseSessionScrollBehaviorMode(
  value: string | null | undefined,
): SessionScrollBehaviorMode {
  if (value === "manual-follow") {
    return "remember-place";
  }
  return SESSION_SCROLL_BEHAVIOR_MODES.includes(
    value as SessionScrollBehaviorMode,
  )
    ? (value as SessionScrollBehaviorMode)
    : DEFAULT_SESSION_SCROLL_BEHAVIOR_MODE;
}

export function shouldRetainSessionScrollMemory(
  mode: SessionScrollBehaviorMode,
): boolean {
  return mode !== "no-memory";
}

export function decideSessionScrollRestore({
  mode,
  snapshot,
  topTolerancePx,
}: {
  mode: SessionScrollBehaviorMode;
  snapshot: SessionRouteScrollSnapshot | null | undefined;
  topTolerancePx: number;
}): SessionScrollRestoreDecision {
  if (!snapshot || mode === "no-memory") {
    return "skip";
  }

  if (mode === "live-tail" && (snapshot.following ?? snapshot.atBottom)) {
    return "follow-bottom";
  }

  // A top-of-transcript snapshot is usually produced by a transient
  // cached/progressive restore before tail-follow has settled. Treat it as no
  // useful retained position.
  if (!snapshot.atBottom && snapshot.scrollTop <= topTolerancePx) {
    return "skip";
  }

  if (snapshot.anchor) {
    return "restore-position";
  }

  if (snapshot.atBottom) {
    return "follow-bottom";
  }

  return "restore-position";
}
