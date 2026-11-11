import type { SessionIndexListOptions } from "../indexes/types.js";
import type { SessionSummary } from "../supervisor/types.js";

export const SESSION_AUTO_ARCHIVE_DEFAULT_DAYS = 0;

const DAY_MS = 24 * 60 * 60 * 1000;

export function getActiveSessionIndexOptions(
  autoArchiveDays: number | undefined,
  now = Date.now(),
): SessionIndexListOptions | undefined {
  const days = autoArchiveDays ?? SESSION_AUTO_ARCHIVE_DEFAULT_DAYS;
  if (!Number.isFinite(days) || days <= 0) {
    return undefined;
  }

  const cutoff = new Date(now - days * DAY_MS);
  cutoff.setUTCHours(0, 0, 0, 0);
  return { activeAfterMs: cutoff.getTime() };
}

export function isSessionAutoArchived(
  session: Pick<SessionSummary, "updatedAt">,
  activeAfterMs: number | undefined,
): boolean {
  if (activeAfterMs === undefined) {
    return false;
  }
  const updatedAtMs = Date.parse(session.updatedAt);
  return Number.isFinite(updatedAtMs) && updatedAtMs < activeAfterMs;
}
