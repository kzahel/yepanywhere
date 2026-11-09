/**
 * The shared banner (plan 182, family 5; topics/ui-design.md, "Banners,
 * badges, spinners and tabs").
 *
 * A message about a page, panel or form, in one of four tones: `info`,
 * `success`, `warning`, `error`. It is a tinted box with a tone-colored
 * border and edge; the text stays in the primary text color so it reads in
 * every theme. `title` is a bold first line; `actions` sit at the end (or
 * under the text when the banner is narrow); `onDismiss` adds a close
 * button named by `dismissLabel`, the caller's translated label. The
 * control takes no i18n context, so it renders in tests and the playground
 * without providers.
 *
 * An error banner is `role="alert"`, the others `role="status"`, so a
 * banner that appears after an action is announced. A banner that is part
 * of the page from the start and need not interrupt passes `role="none"`
 * (or `"note"` for an aside). A live region announces changes to content
 * already on the page: to announce a result that replaces an earlier one,
 * keep one region mounted and change its text, rather than mounting a new
 * status banner per result. A validation error under one field is that
 * `Field`'s `error`, never an alert that fires per keystroke.
 *
 * An error that belongs to one field is that `Field`'s `error`, not a
 * banner. A caller's `className` adds layout (margins, placement) only.
 */
import type { ReactNode, Ref } from "react";
import styles from "./Banner.module.css";
import { IconButton } from "./Button";

export type BannerTone = "info" | "success" | "warning" | "error";

type Dismiss =
  | { onDismiss: () => void; dismissLabel: string }
  | { onDismiss?: undefined; dismissLabel?: undefined };

export type BannerProps = Dismiss & {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Buttons or links acting on the message. */
  actions?: ReactNode;
  /** Default: `alert` for errors, `status` otherwise. */
  role?: "alert" | "status" | "note" | "none";
  /** Tighter padding for a banner inside a row or small panel. */
  compact?: boolean;
  className?: string;
  id?: string;
  "data-testid"?: string;
  ref?: Ref<HTMLDivElement>;
};

const TONE_CLASS: Record<BannerTone, string | undefined> = {
  info: styles.info,
  success: styles.success,
  warning: styles.warning,
  error: styles.error,
};

export function Banner({
  tone = "info",
  title,
  children,
  actions,
  onDismiss,
  dismissLabel,
  role,
  compact = false,
  className,
  ref,
  ...rest
}: BannerProps) {
  const resolvedRole = role ?? (tone === "error" ? "alert" : "status");
  const classes = [
    styles.banner,
    TONE_CLASS[tone],
    compact && styles.compact,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      {...rest}
      ref={ref}
      role={resolvedRole === "none" ? undefined : resolvedRole}
      className={classes}
    >
      <div className={styles.body}>
        {title ? <div className={styles.title}>{title}</div> : null}
        {children}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
      {onDismiss ? (
        <IconButton
          size="small"
          className={styles.dismiss}
          label={dismissLabel}
          onClick={onDismiss}
        >
          ×
        </IconButton>
      ) : null}
    </div>
  );
}
