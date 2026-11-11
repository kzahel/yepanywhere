/**
 * Unified activity indicator component for showing active/running state.
 * Uses semantic CSS with pulsing animation.
 *
 * Variants:
 * - "dot": Compact pulsing dot (default)
 * - "badge": Dot wrapped in a badge container
 */

import { Badge } from "./ui/Badge";

interface ActivityIndicatorProps {
  /** Visual variant - "dot" for compact, "badge" for wrapped in badge container */
  variant?: "dot" | "badge";
  /** Optional className for additional styling */
  className?: string;
}

export function ActivityIndicator({
  variant = "dot",
  className,
}: ActivityIndicatorProps) {
  const dot = <span />;

  if (variant === "badge") {
    return <Badge tone="info" size="small" icon={dot} className={className} />;
  }

  return <span className={className ?? ""}>{dot}</span>;
}
