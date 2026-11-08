import { useEffect, useState } from "react";
import { writeClipboardText, writeClipboardTextLater } from "../lib/clipboard";
import { IconButton } from "./ui/Button";

/**
 * A small copy-to-clipboard button used by the source-control copy affordances
 * (branch name, commit hash, file path — topic: source-review-to-session). Shows
 * a transient check on success and stops click propagation so it can sit inside
 * a clickable row without also selecting the row. A value resolver supports
 * content that must be loaded after the user clicks.
 */
export function CopyButton({
  value,
  title,
  className,
  disabled = false,
  icon = "copy",
}: {
  value: string | (() => Promise<string>);
  /** Tooltip + accessible label (e.g. "Copy branch name"). */
  title: string;
  className?: string;
  disabled?: boolean;
  icon?: "copy" | "path" | "content";
}) {
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <IconButton
      size="small"
      label={title}
      className={className}
      disabled={disabled || copying}
      onClick={async (event) => {
        event.stopPropagation();
        setCopying(true);
        const success =
          typeof value === "function"
            ? await writeClipboardTextLater(value())
            : await writeClipboardText(value);
        setCopying(false);
        if (success) setCopied(true);
      }}
    >
      {copied ? (
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <CopyGlyph icon={icon} />
      )}
    </IconButton>
  );
}

function CopyGlyph({ icon }: { icon: "copy" | "path" | "content" }) {
  const common = {
    width: 13,
    height: 13,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  if (icon === "path") {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M3 7h6l2 2h10v9H3z" />
        <path d="M8 14h8" />
        <path d="m13 11 3 3-3 3" />
      </svg>
    );
  }
  if (icon === "content") {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M6 2h8l4 4v16H6z" />
        <path d="M14 2v5h5" />
        <path d="M9 12h6M9 16h6" />
      </svg>
    );
  }
  return (
    <svg {...common} aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
