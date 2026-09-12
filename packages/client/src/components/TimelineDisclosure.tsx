import type { MouseEventHandler } from "react";
import type { ToolCallItem } from "@yep-anywhere/shared/transcript/items";
import styles from "./TimelineDisclosure.module.css";

export function TimelineDisclosure({
  expanded,
  label,
  onClick,
  controls,
  status,
}: {
  expanded: boolean;
  label: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  controls?: string;
  status?: ToolCallItem["status"];
}) {
  return (
    <button
      type="button"
      className={styles.toggle}
      onClick={onClick}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={controls}
      title={label}
      data-status={status}
    >
      <span aria-hidden="true">{expanded ? "−" : "+"}</span>
    </button>
  );
}
