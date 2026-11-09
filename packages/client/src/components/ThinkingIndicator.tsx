/**
 * Unified thinking/running indicator component.
 * Use this for all "thinking", "running", or "processing" state indicators.
 *
 * Variants:
 * - "dot": Compact pulsing dot only (8x8px)
 * - "pill": Pill badge with pulsing dot and text label
 * - "icon": Icon-only badge with an accessible label
 *
 * Examples:
 *   <ThinkingIndicator />                    // Just a pulsing dot
 *   <ThinkingIndicator variant="pill" />     // Pill with "Thinking" text
 *   <ThinkingIndicator variant="pill" label="Running" />
 *   <ThinkingIndicator variant="icon" />     // Icon-only thinking badge
 */

import { useEffect, useRef } from "react";
import { observeViewportActivityAnimation } from "../lib/viewportActivityAnimation";
import { Badge } from "./ui/Badge";
import styles from "./ThinkingIndicator.module.css";

interface ThinkingIndicatorProps {
  /** Visual variant - "dot" for compact, "pill" for text, "icon" for badge */
  variant?: "dot" | "pill" | "icon";
  /** Text label for pill/icon variants (default: "Thinking") */
  label?: string;
  /** Optional className for additional styling */
  className?: string;
  /** The parent observes visibility and supplies the inherited play state. */
  animationVisibilityManaged?: boolean;
}

export function ThinkingIndicator({
  variant = "dot",
  label = "Thinking",
  className,
  animationVisibilityManaged = false,
}: ThinkingIndicatorProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (animationVisibilityManaged || !rootRef.current) return;
    return observeViewportActivityAnimation(rootRef.current);
  }, [animationVisibilityManaged]);

  const dot = <span className={styles.dot} />;

  if (variant === "icon") {
    return (
      <span
        ref={rootRef}
        className={`${styles.icon} ${className ?? ""}`}
        title={label}
        aria-label={label}
        role="img"
      >
        <svg
          className={styles.iconSvg}
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 18V5" />
          <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
          <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
          <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
          <path d="M18 18a4 4 0 0 0 2-7.464" />
          <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
          <path d="M6 18a4 4 0 0 1-2-7.464" />
          <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
        </svg>
      </span>
    );
  }

  if (variant === "pill") {
    return (
      <Badge
        ref={rootRef}
        size="small"
        icon={dot}
        className={`${styles.thinking} ${styles.pill} ${className ?? ""}`}
      >
        {label}
      </Badge>
    );
  }

  return (
    <span ref={rootRef} className={`${styles.root} ${className ?? ""}`}>
      {dot}
    </span>
  );
}
