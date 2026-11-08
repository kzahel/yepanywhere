import type { MouseEvent } from "react";
import { ButtonBase } from "./ui/Button";
import styles from "./ViewerCountIndicator.module.css";

interface ViewerCountIndicatorProps {
  className?: string;
  count?: number | null;
  label: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function ViewerCountIndicator({
  className,
  count,
  label,
  onClick,
  onContextMenu,
}: ViewerCountIndicatorProps) {
  const content = (
    <>
      <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.icon}>
        <path d="M4 10a8 8 0 0 1 16 0" />
        <path d="M8 10a4 4 0 0 1 8 0" />
        <path d="M12 10v8" />
        <path d="M9 18h6" />
      </svg>
      {typeof count === "number" && <span>{count}</span>}
    </>
  );
  const interactive = onClick || onContextMenu;
  const classes = [styles.root, interactive ? styles.button : null, className]
    .filter(Boolean)
    .join(" ");

  if (interactive) {
    return (
      <ButtonBase
        className={classes}
        title={label}
        aria-label={label}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        {content}
      </ButtonBase>
    );
  }

  return (
    <span className={classes} title={label} role="status" aria-label={label}>
      {content}
    </span>
  );
}
