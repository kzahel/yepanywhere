import type { Message } from "../types";

export const MESSAGE_STALE_THRESHOLD_MS = 5 * 60 * 1000;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export function parseTimestampMs(
  timestamp: string | number | null | undefined,
): number | null {
  if (timestamp === null || timestamp === undefined) {
    return null;
  }
  const value =
    typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime();
  return Number.isFinite(value) ? value : null;
}

export function getLatestMessageTimestampMs(
  messages: readonly Message[],
): number | null {
  let latest: number | null = null;
  for (const message of messages) {
    const timestampMs = parseTimestampMs(message.timestamp);
    if (timestampMs === null) {
      continue;
    }
    latest = latest === null ? timestampMs : Math.max(latest, timestampMs);
  }
  return latest;
}

/** Earliest source-message time — a tool row's start (e.g. command start),
 * where the latest is its most recent result. */
export function getEarliestMessageTimestampMs(
  messages: readonly Message[],
): number | null {
  let earliest: number | null = null;
  for (const message of messages) {
    const timestampMs = parseTimestampMs(message.timestamp);
    if (timestampMs === null) {
      continue;
    }
    earliest =
      earliest === null ? timestampMs : Math.min(earliest, timestampMs);
  }
  return earliest;
}

export function isStaleTimestamp(
  timestampMs: number | null | undefined,
  nowMs: number,
  thresholdMs = MESSAGE_STALE_THRESHOLD_MS,
): boolean {
  return timestampMs !== null && timestampMs !== undefined
    ? nowMs - timestampMs >= thresholdMs
    : false;
}

export function formatCompactRelativeAge(
  timestampMs: number,
  nowMs: number,
): string {
  const elapsedMs = Math.max(0, nowMs - timestampMs);
  if (elapsedMs < MINUTE_MS) {
    return "now";
  }
  if (elapsedMs < HOUR_MS) {
    return `${Math.floor(elapsedMs / MINUTE_MS)}m`;
  }
  if (elapsedMs < DAY_MS) {
    return `${Math.floor(elapsedMs / HOUR_MS)}h`;
  }
  if (elapsedMs < WEEK_MS) {
    const days = Math.floor(elapsedMs / DAY_MS);
    const hours = Math.floor((elapsedMs % DAY_MS) / HOUR_MS);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  return dateFormat("day", { month: "short", day: "numeric" }).format(
    timestampMs,
  );
}

export function formatAbsoluteTimestamp(timestampMs: number): string {
  return dateFormat("absolute", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(timestampMs);
}

/**
 * `toLocaleString` with options builds a formatter on every call, about
 * twenty microseconds each, and a transcript formats a timestamp per row on
 * every render. A formatter keeps the locale and time zone it was built
 * with, so each is rebuilt after a minute rather than kept for the page's
 * life.
 */
const FORMAT_LIFETIME_MS = 60 * 1000;
const dateFormats = new Map<
  string,
  { format: Intl.DateTimeFormat; builtAt: number }
>();
function dateFormat(
  key: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const now = Date.now();
  const cached = dateFormats.get(key);
  if (cached && Math.abs(now - cached.builtAt) < FORMAT_LIFETIME_MS)
    return cached.format;
  const format = new Intl.DateTimeFormat(undefined, options);
  dateFormats.set(key, { format, builtAt: now });
  return format;
}
