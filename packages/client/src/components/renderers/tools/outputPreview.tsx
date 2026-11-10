import bashStyles from "./BashRenderer.module.css";
import { useCallback, useState } from "react";
import { IconButton } from "../../ui/Button";

/**
 * Shared building blocks for collapsed tool-output previews: the first-N-line
 * truncation that pairs with the output-preview-lines appearance setting, the
 * hidden-line count behind the `+N` badge, and the hover-reveal copy button.
 * Extracted from the Bash preview so text-output tools (Bash, Web) present
 * one set of affordances; the consumer chooses the text styling (code vs
 * prose font).
 */

/** Character budget per preview line. CSS height clipping counts wrapped
 * visual lines; this only bounds how much text enters the DOM, so it must
 * exceed any plausible visual line width. */
export const PREVIEW_MAX_CHARS_PER_LINE = 320;

export function getPreviewLimits(lineCount: number): {
  maxLines: number;
  maxChars: number;
} {
  const normalizedLineCount = Math.max(1, Math.round(lineCount));
  return {
    maxLines: normalizedLineCount,
    maxChars: normalizedLineCount * PREVIEW_MAX_CHARS_PER_LINE,
  };
}

export function getHiddenOutputLineCount(
  output: string,
  visibleLineCount: number,
): number {
  if (!output) {
    return 0;
  }
  return Math.max(
    0,
    output.trimEnd().split("\n").length -
      Math.max(1, Math.round(visibleLineCount)),
  );
}

/**
 * Plain-text tail shared by truncated output and diff previews. The tooltip
 * mirrors the preview's line budget: show an ellipsis plus the last N lines,
 * and return null when all content already fits.
 */
export function getOutputTailTooltip(
  output: string,
  visibleLineCount: number,
  prefix = "",
): string | null {
  const normalized = output.trimEnd();
  if (!normalized) return null;
  const lines = normalized.split("\n");
  const tailLineCount = Math.max(1, Math.round(visibleLineCount));
  if (lines.length <= tailLineCount) return null;
  return `${prefix}...\n${lines.slice(-tailLineCount).join("\n")}`;
}

export function truncateOutput(
  text: string,
  limits: { maxLines: number; maxChars: number },
): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  let result = "";
  let charCount = 0;
  let lineCount = 0;

  for (const line of lines) {
    if (lineCount >= limits.maxLines || charCount >= limits.maxChars) {
      return { text: result.trimEnd(), truncated: true };
    }
    const remaining = limits.maxChars - charCount;
    if (line.length > remaining) {
      result += `${line.slice(0, remaining)}...`;
      return { text: result.trimEnd(), truncated: true };
    }
    result += `${line}\n`;
    charCount += line.length + 1;
    lineCount++;
  }

  return { text: result.trimEnd(), truncated: false };
}

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

/**
 * Hover-reveal clipboard button for one section of tool output.
 * Owns the `data-bash-section-copy` boundary: the copy-button style all
 * output sections use (the name predates non-Bash consumers).
 */
export function OutputCopyButton({
  text,
  label,
}: {
  text: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 3000);
      } catch (error) {
        console.error("Failed to copy output section:", error);
      }
    },
    [text],
  );

  return (
    <IconButton
      variant={copied ? "success-outline" : "outline"}
      size="dense"
      className={bashStyles.bashSectionCopy}
      data-copied={copied || undefined}
      data-bash-section-copy
      onClick={handleCopy}
      disabled={!text}
      label={copied ? "Copied" : label}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </IconButton>
  );
}
