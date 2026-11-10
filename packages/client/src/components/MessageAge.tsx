import styles from "./MessageAge.module.css";
import {
  formatAbsoluteTimestamp,
  formatCompactRelativeAge,
} from "../lib/messageAge";

interface Props {
  timestampMs: number | null | undefined;
  nowMs: number;
  className?: string;
  prefix?: string;
  suffix?: string;
  formatLabel?: (label: string) => string;
}

export function MessageAge({
  timestampMs,
  nowMs,
  className,
  prefix,
  suffix,
  formatLabel,
}: Props) {
  if (timestampMs === null || timestampMs === undefined) {
    return null;
  }

  const date = new Date(timestampMs);
  const label = formatCompactRelativeAge(timestampMs, nowMs);
  const absolute = formatAbsoluteTimestamp(timestampMs);
  const text =
    formatLabel?.(label) ??
    `${prefix ? `${prefix} ` : ""}${label}${suffix ? ` ${suffix}` : ""}`;

  return (
    <time
      className={className ?? styles.messageAge}
      data-message-age
      dateTime={date.toISOString()}
      title={absolute}
    >
      {text}
    </time>
  );
}
