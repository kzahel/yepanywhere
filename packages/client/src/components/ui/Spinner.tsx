/**
 * The shared busy indicator (plan 182, family 5; topics/ui-design.md,
 * "Banners, badges, spinners and tabs").
 *
 * A ring drawn in the current text color with one gap, turning once every
 * 0.8 s (slower under reduced motion). It is the only rotating keyframe set
 * in the client: `pnpm buttons:check` rejects other `rotate` keyframes.
 *
 * Without `label` it is decoration (`aria-hidden`) beside text that already
 * says what is happening ("Loading…", a busy button). With `label` it is the
 * announcement itself: `role="status"` named by the label.
 *
 * The animation honours `--ya-activity-play` (lib/viewportActivityAnimation):
 * a transcript row scrolled out of view pauses its spinner.
 */
import type { CSSProperties } from "react";
import styles from "./Spinner.module.css";

export interface SpinnerProps {
  /** `small` 0.9em (inline with text), `default` 16 px, `large` 32 px. */
  size?: "small" | "default" | "large";
  /** Accessible status text; omit when nearby text already says it. */
  label?: string;
  /** Layout only (margins, alignment). */
  className?: string;
  style?: CSSProperties;
  "data-testid"?: string;
}

const SIZE_CLASS = {
  small: styles.small,
  default: styles.default,
  large: styles.large,
} as const;

export function Spinner({
  size = "default",
  label,
  className,
  style,
  "data-testid": testId,
}: SpinnerProps) {
  const classes = [styles.spinner, SIZE_CLASS[size], className]
    .filter(Boolean)
    .join(" ");
  return label ? (
    <span
      className={classes}
      style={style}
      role="status"
      aria-label={label}
      data-testid={testId}
    />
  ) : (
    <span
      className={classes}
      style={style}
      aria-hidden="true"
      data-testid={testId}
    />
  );
}
