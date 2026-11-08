import type { MouseEventHandler } from "react";
import type { ToolCallItem } from "@yep-anywhere/shared/transcript/items";
import { ButtonBase } from "./ui/Button";
import styles from "./TimelineDisclosure.module.css";

export function TimelineDisclosure({
  expanded,
  label,
  onClick,
  controls,
  status,
  inline = false,
}: {
  expanded: boolean;
  label: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  controls?: string;
  status?: ToolCallItem["status"];
  inline?: boolean;
}) {
  return (
    <ButtonBase
      className={`${styles.toggle} ${inline ? styles.inline : ""}`}
      onClick={onClick}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={controls}
      title={label}
      data-status={status}
    >
      <span aria-hidden="true">{expanded ? "−" : "+"}</span>
    </ButtonBase>
  );
}
