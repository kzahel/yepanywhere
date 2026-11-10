import type { ButtonBaseProps } from "./Button";
import { ButtonBase } from "./Button";
import styles from "./SelectableCard.module.css";

/** A rich, whole-card action. Content and layout belong to the caller. */
export function SelectableCard({
  selected,
  variant = "default",
  size = "default",
  className,
  ...props
}: ButtonBaseProps & {
  selected?: boolean;
  variant?: "default" | "quiet" | "accent";
  size?: "default" | "compact";
}) {
  return (
    <ButtonBase
      {...props}
      aria-pressed={selected ?? props["aria-pressed"]}
      className={[
        styles.card,
        variant === "quiet" && styles.quiet,
        variant === "accent" && styles.accent,
        size === "compact" && styles.compact,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
