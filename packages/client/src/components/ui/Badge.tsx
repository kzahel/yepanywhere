/**
 * The shared badge (plan 182, family 5; topics/ui-design.md, "Banners,
 * badges, spinners and tabs").
 *
 * A short, non-interactive label beside other content: a state ("Running",
 * "Archived"), a kind ("Default", "Secret"), a count. `tone` picks the color
 * (`neutral`, `info`, `success`, `warning`, `danger`, `accent` for the brand
 * green); `emphasis="soft"` (default) is a tint with colored text, `solid` a
 * filled chip for counts that ask for attention. `shape="count"` is a pill
 * with tabular figures for numbers. `mono` sets the code font (tool names,
 * ids). `tooltip` shows through TooltipLayer like IconButton's.
 *
 * A badge is text, not a control: put the click on the row or button around
 * it. A caller's `className` adds layout (margins, alignment); a color that
 * comes from data (a provider's brand color) is set as `--badge-color` and
 * `--badge-soft` on a compounded caller selector (`.badge.claude`), never
 * as `color` or `background`. A count or state the text does not name
 * needs `role="img"` with an `aria-label`.
 */
import type { ComponentProps, ReactNode, Ref } from "react";
import { useTextTooltipAttributes } from "../../hooks/useTooltipAppearance";
import styles from "./Badge.module.css";

export type BadgeTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "accent";

export interface BadgeProps {
  tone?: BadgeTone;
  emphasis?: "soft" | "solid";
  size?: "default" | "small";
  shape?: "tag" | "count";
  mono?: boolean;
  /** Shown before the text; decorative. */
  icon?: ReactNode;
  tooltip?: string;
  className?: string;
  children?: ReactNode;
  id?: string;
  role?: "status" | "img";
  "aria-label"?: string;
  "aria-hidden"?: boolean;
  "data-testid"?: string;
  ref?: Ref<HTMLSpanElement>;
}

const TONE_CLASS: Record<BadgeTone, string | undefined> = {
  neutral: styles.neutral,
  info: styles.info,
  success: styles.success,
  warning: styles.warning,
  danger: styles.danger,
  accent: styles.accent,
};

export function Badge({
  tone = "neutral",
  emphasis = "soft",
  size = "default",
  shape = "tag",
  mono = false,
  icon,
  tooltip,
  className,
  children,
  ref,
  ...rest
}: BadgeProps) {
  const classes = [
    styles.badge,
    TONE_CLASS[tone],
    emphasis === "solid" && styles.solid,
    size === "small" && styles.small,
    shape === "count" && styles.count,
    mono && styles.mono,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const content = (
    <>
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </>
  );
  // Badges fill transcripts; only those with a tooltip subscribe to the
  // tooltip setting.
  return tooltip ? (
    <TooltipSpan {...rest} ref={ref} className={classes} tooltip={tooltip}>
      {content}
    </TooltipSpan>
  ) : (
    <span {...rest} ref={ref} className={classes}>
      {content}
    </span>
  );
}

function TooltipSpan({
  tooltip,
  ...props
}: ComponentProps<"span"> & { tooltip: string }) {
  const tooltipAttributes = useTextTooltipAttributes(tooltip);
  return <span {...props} {...tooltipAttributes} />;
}
