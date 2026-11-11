/**
 * Brief "time since creation" formatting for session lists, with an explicit
 * unknown/default guard.
 *
 * Some session sources hand us a sentinel/zero `createdAt` (the unix epoch)
 * when the real creation time is unknown. Rendering that verbatim produces an
 * absurd "Created 20625d ago". Treat any timestamp at/near the unix epoch (or
 * unparseable/missing) as unknown so callers can suppress the age entirely
 * rather than special-casing the symptom at each render site.
 */

// Sessions are AI coding sessions; none predate this. Anything older is a
// sentinel/default value, not a real creation time.
const MIN_PLAUSIBLE_CREATED_MS = Date.UTC(2001, 0, 1);

/** True when `timestamp` is a real, plausible creation time (not a default/sentinel). */
export function isKnownSessionTimestamp(timestamp?: string | null): boolean {
  if (!timestamp) return false;
  const ms = new Date(timestamp).getTime();
  return Number.isFinite(ms) && ms >= MIN_PLAUSIBLE_CREATED_MS;
}

/**
 * Brief age (`d` / `h` / `m`) since `timestamp`, or `null` when the timestamp
 * is unknown/default. Callers wrap the result as e.g. `Created {age} ago`.
 */
export function formatBriefAge(timestamp?: string | null): string | null {
  if (!isKnownSessionTimestamp(timestamp)) return null;
  const diffMs = Date.now() - new Date(timestamp as string).getTime();
  if (diffMs < 0) return "0m";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function formatSessionHoverAge(
  updatedAt?: string | null,
  createdAt?: string | null,
): string | null {
  const activityAge = formatBriefAge(updatedAt);
  const establishedAge = formatBriefAge(createdAt);
  return activityAge
    ? `${activityAge} ago${establishedAge ? ` (est. ${establishedAge})` : ""}`
    : establishedAge
      ? `est. ${establishedAge}`
      : null;
}

export function formatSessionRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
