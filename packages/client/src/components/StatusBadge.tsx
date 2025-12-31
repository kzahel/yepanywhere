import type { ProcessStateType } from "../hooks/useFileActivity";
import type { SessionStatus } from "../types";

type BadgeVariant = "owned" | "external" | "idle";
type NotificationVariant = "needs-input" | "unread";
type PendingInputType = "tool-approval" | "user-question";

interface SessionStatusBadgeProps {
  /** Session status object */
  status: SessionStatus;
  /** Type of pending input if session needs user action */
  pendingInputType?: PendingInputType;
  /** Whether session has unread content */
  hasUnread?: boolean;
  /** Current process state (running/waiting-input) for activity indicators */
  processState?: ProcessStateType;
}

interface CountBadgeProps {
  /** Badge variant */
  variant: BadgeVariant;
  /** Count to display (e.g., "2 Active") */
  count: number;
}

interface NotificationBadgeProps {
  /** Type of notification badge */
  variant: NotificationVariant;
  /** Optional label override */
  label?: string;
}

/**
 * Notification badge indicating action needed or unread content.
 * - "needs-input" (blue): Tool approval or user question pending
 * - "unread" (orange): New content since last viewed
 */
export function NotificationBadge({ variant, label }: NotificationBadgeProps) {
  const defaultLabel = variant === "needs-input" ? "Input Needed" : "New";

  return (
    <span className={`status-badge notification-${variant}`}>
      {label ?? defaultLabel}
    </span>
  );
}

/**
 * Status badge for a single session in a list.
 * Priority: needs-input (blue) > running (pulsing) > unread (orange) > active (outline) > idle (nothing)
 */
export function SessionStatusBadge({
  status,
  pendingInputType,
  hasUnread,
  processState,
}: SessionStatusBadgeProps) {
  // Priority 1: Needs input (tool approval or user question)
  if (pendingInputType) {
    const label =
      pendingInputType === "tool-approval" ? "Approval Needed" : "Question";
    return <NotificationBadge variant="needs-input" label={label} />;
  }

  // Priority 2: Running (agent is thinking) - show pulsing indicator
  if (processState === "running") {
    return <span className="status-badge status-running">Thinking</span>;
  }

  // Priority 3: Unread content (show when not actively running)
  // This includes idle sessions and owned sessions that are waiting for input
  if (hasUnread) {
    return <NotificationBadge variant="unread" />;
  }

  // Priority 4: Active session (has a hot process) - subtle green outline, no text badge
  // External sessions still get a text badge since that's useful info
  if (status.state === "owned") {
    return <span className="status-indicator status-active" />;
  }

  if (status.state === "external") {
    return (
      <span className="status-badge status-external">Active, External</span>
    );
  }

  // Idle sessions - no badge needed
  return null;
}

/**
 * Status badge showing a count of active sessions.
 * Used on the projects list page.
 */
export function ActiveCountBadge({ variant, count }: CountBadgeProps) {
  if (count === 0) return null;

  const label =
    variant === "owned"
      ? `${count} Active`
      : variant === "external"
        ? `${count} External`
        : null;

  if (!label) return null;

  return <span className={`status-badge status-${variant}`}>{label}</span>;
}
