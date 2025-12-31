import type { ContextUsage } from "../types";

interface ContextUsageIndicatorProps {
  /** Context usage data */
  usage?: ContextUsage;
  /** Size of the indicator in pixels (default: 16) */
  size?: number;
  /** Whether to show the percentage label (default: true) */
  showLabel?: boolean;
}

/**
 * Small pie chart indicator showing context window usage percentage.
 * Displays a gray pie chart that fills based on usage, with percentage label.
 */
export function ContextUsageIndicator({
  usage,
  size = 16,
  showLabel = true,
}: ContextUsageIndicatorProps) {
  if (!usage) return null;

  const { percentage } = usage;
  // Clamp percentage to 0-100
  const clampedPercentage = Math.min(100, Math.max(0, percentage));

  // Calculate the stroke-dasharray for the pie chart
  // Circumference of circle with r=8 (for size=16) = 2 * PI * r
  const radius = size / 2 - 1; // Leave 1px for stroke
  const circumference = 2 * Math.PI * radius;
  const filled = (clampedPercentage / 100) * circumference;

  // Fill color - lighter color that shows usage amount
  const getFillColor = () => {
    if (clampedPercentage >= 90) return "var(--color-error, #dc3545)";
    if (clampedPercentage >= 75) return "var(--color-warning, #ffc107)";
    return "var(--text-muted, #9d9d9d)";
  };

  return (
    <span
      className="context-usage-indicator"
      title={`Context: ${percentage}% (${formatTokens(usage.inputTokens)} tokens)`}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="context-usage-pie"
        aria-hidden="true"
      >
        {/* Background circle - darker */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--border-color, #3c3c3c)"
          strokeWidth="2"
        />
        {/* Filled arc - lighter color showing usage, rotated -90deg so it starts from top */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={getFillColor()}
          strokeWidth="2"
          strokeDasharray={`${filled} ${circumference}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {showLabel && (
        <span className="context-usage-label">{clampedPercentage}%</span>
      )}
    </span>
  );
}

/**
 * Format token count for display (e.g., 34500 -> "34.5K")
 */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return tokens.toString();
}
