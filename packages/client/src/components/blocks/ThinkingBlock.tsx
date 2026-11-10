import styles from "./ThinkingBlock.module.css";
import collapsibleStyles from "../Collapsible.module.css";
import timelineStyles from "../TranscriptTimeline.module.css";
import { memo } from "react";
import { ThinkingText } from "../ThinkingText";

interface Props {
  thinking: string;
  status: "streaming" | "complete";
  isExpanded: boolean;
  onToggle: () => void;
  durationMs?: number;
}

function formatThinkingDuration(durationMs: number): string {
  const seconds = Math.max(0, durationMs) / 1000;
  if (seconds < 10) {
    return `${seconds.toFixed(1)} sec`;
  }
  if (seconds < 60) {
    return `${Math.round(seconds)} sec`;
  }
  const minutes = seconds / 60;
  if (minutes < 10) {
    return `${minutes.toFixed(1)} min`;
  }
  return `${Math.round(minutes)} min`;
}

export const ThinkingBlock = memo(function ThinkingBlock({
  thinking,
  status,
  isExpanded,
  onToggle,
  durationMs,
}: Props) {
  const isStreaming = status === "streaming";
  const durationLabel =
    durationMs !== undefined && durationMs >= 100
      ? formatThinkingDuration(durationMs)
      : null;
  const className = [
    styles.thinkingBlock,
    timelineStyles.timelineItem,
    isStreaming && !isExpanded ? styles.thinkingStreamingCollapsed : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <details
      className={className}
      data-thinking-block
      data-timeline-item
      data-thinking-streaming-collapsed={
        (isStreaming && !isExpanded) || undefined
      }
      open={isExpanded}
      onToggle={(e) => {
        if (e.currentTarget.open !== isExpanded) {
          onToggle();
        }
      }}
    >
      <summary
        className={collapsibleStyles.collapsibleSummary}
        data-collapsible__summary
        aria-label={isExpanded ? "Collapse thinking" : "Expand thinking"}
        title={isExpanded ? "Collapse thinking" : "Expand thinking"}
      >
        <span
          className={timelineStyles.timelineDotBtn}
          data-timeline-dot-btn
          aria-hidden
        />
        <span>
          {isStreaming ? "Thinking..." : "Thinking"}
          {durationLabel && (
            <span className={styles.thinkingDuration} data-thinking-duration>
              for {durationLabel}
            </span>
          )}
        </span>
        <span
          className={collapsibleStyles.collapsibleIcon}
          data-collapsible__icon
        >
          ▸
        </span>
      </summary>
      <div
        className={collapsibleStyles.collapsibleContent}
        data-collapsible__content
      >
        <ThinkingText text={thinking} isStreaming={isStreaming} />
      </div>
    </details>
  );
});
