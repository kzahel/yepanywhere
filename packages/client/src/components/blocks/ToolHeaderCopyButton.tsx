import rowsStyles from "./ToolCallRow.module.css";
import { useState } from "react";
import { IconButton } from "../ui/Button";
import styles from "./ToolHeaderCopyButton.module.css";

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="8" height="8" rx="1.5" />
      <path d="M3 10.5H2.5A1.5 1.5 0 0 1 1 9V2.5A1.5 1.5 0 0 1 2.5 1H9a1.5 1.5 0 0 1 1.5 1.5V3" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5 6.5 12 13 4" />
    </svg>
  );
}

export function ToolHeaderCopyButton({
  text,
  label,
}: {
  text: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <IconButton
      variant={copied ? "success-outline" : "outline"}
      size="dense"
      className={`${rowsStyles.toolHeaderCopy} ${styles.headerCopy}`}
      data-tool-header-copy
      data-copied={copied || undefined}
      onKeyDown={(event) => {
        // The containing tool header also activates on Enter/Space. Preserve
        // native button activation without toggling that disclosure.
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 3000);
          })
          .catch((error) => {
            console.error("Failed to copy tool header text:", error);
          });
      }}
      label={copied ? "Copied" : label}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </IconButton>
  );
}
