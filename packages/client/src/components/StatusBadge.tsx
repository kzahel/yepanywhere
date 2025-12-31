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
 * Priority: needs-input (blue) > unread (orange) > active (green) > idle (gray)
 */
export function SessionStatusBadge({
  status,
  pendingInputType,
  hasUnread,
}: SessionStatusBadgeProps) {
  // Priority 1: Needs input (tool approval or user question)
  if (pendingInputType) {
    const label =
      pendingInputType === "tool-approval" ? "Approval Needed" : "Question";
    return <NotificationBadge variant="needs-input" label={label} />;
  }

  // Priority 2: Unread content (only show if idle - don't show while actively processing)
  if (hasUnread && status.state === "idle") {
    return <NotificationBadge variant="unread" />;
  }

  // Priority 3+: Regular status badges
  const label =
    status.state === "owned"
      ? "Active"
      : status.state === "external"
        ? "Active, External"
        : "Idle";

  return <span className={`status-badge status-${status.state}`}>{label}</span>;
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
