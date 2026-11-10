import { useEffect, useState } from "react";
import { OUTPUT_APPEARANCE_CHANGE_EVENT } from "../../hooks/useOutputAppearance";
import type { ToolCallItem } from "@yep-anywhere/shared/transcript/items";
export const DEFERRED_PREVIEW_HEIGHT = {
  outputRowChromePx: 12,
  previewBorderPx: 2,
  emptyOutputRowPx: 28,
  minOutputRowPx: 35,
  outputLineHeightPx: 18,
  maxOutputPx: 80,
  minPx: 28,
  maxPx: 94,
  defaultContentWidthPx: 720,
  minCharsPerLine: 24,
  maxCharsPerLine: 160,
  averageCharWidthPx: 7.5,
} as const;

interface DeferredPreviewTypographyMetrics {
  averageCharWidthPx: number;
  outputLineHeightPx: number;
  outputRowChromePx: number;
}

const DEFAULT_DEFERRED_PREVIEW_TYPOGRAPHY: DeferredPreviewTypographyMetrics = {
  averageCharWidthPx: DEFERRED_PREVIEW_HEIGHT.averageCharWidthPx,
  outputLineHeightPx: DEFERRED_PREVIEW_HEIGHT.outputLineHeightPx,
  outputRowChromePx: DEFERRED_PREVIEW_HEIGHT.outputRowChromePx,
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeTypographyMetrics(
  metrics?: Partial<DeferredPreviewTypographyMetrics>,
): DeferredPreviewTypographyMetrics {
  return {
    averageCharWidthPx: clamp(
      metrics?.averageCharWidthPx ??
        DEFAULT_DEFERRED_PREVIEW_TYPOGRAPHY.averageCharWidthPx,
      4,
      18,
    ),
    outputLineHeightPx: clamp(
      metrics?.outputLineHeightPx ??
        DEFAULT_DEFERRED_PREVIEW_TYPOGRAPHY.outputLineHeightPx,
      12,
      42,
    ),
    outputRowChromePx: clamp(
      metrics?.outputRowChromePx ??
        DEFAULT_DEFERRED_PREVIEW_TYPOGRAPHY.outputRowChromePx,
      4,
      32,
    ),
  };
}

export function estimatePreviewCharsPerLine(
  rowWidthPx?: number | null,
  typography?: DeferredPreviewTypographyMetrics,
): number {
  const contentWidthPx =
    typeof rowWidthPx === "number" && rowWidthPx > 0
      ? Math.max(120, rowWidthPx - 112)
      : DEFERRED_PREVIEW_HEIGHT.defaultContentWidthPx;
  const metrics = normalizeTypographyMetrics(typography);
  return clamp(
    Math.floor(contentWidthPx / metrics.averageCharWidthPx),
    DEFERRED_PREVIEW_HEIGHT.minCharsPerLine,
    DEFERRED_PREVIEW_HEIGHT.maxCharsPerLine,
  );
}

export function estimateWrappedLineCount(
  text: string,
  charsPerLine: number,
): number {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let count = 0;
  for (const line of lines) {
    count += Math.max(1, Math.ceil(line.length / charsPerLine));
  }
  return count;
}

export function estimateDeferredPreviewHeightPx(params: {
  toolName: string;
  toolInput: unknown;
  result: unknown;
  status: ToolCallItem["status"];
  rowWidthPx?: number | null;
  typography?: Partial<DeferredPreviewTypographyMetrics>;
  /** Output-preview-lines appearance setting; the rendered preview clamps
   * to this many visual lines, so the estimate must share the cap. */
  previewLineCount?: number;
}): number | null {
  if (
    !canDeferRichToolRow(params.status) ||
    !isBashLikeToolName(params.toolName)
  ) {
    return null;
  }

  const output = getBashResultOutputForRichPreview(
    params.result,
    params.status === "error",
  ).trimEnd();
  if (params.result === undefined && !output) {
    return null;
  }

  const typography = normalizeTypographyMetrics(params.typography);
  const charsPerLine = estimatePreviewCharsPerLine(
    params.rowWidthPx,
    typography,
  );
  const previewLines = clamp(Math.round(params.previewLineCount ?? 4), 1, 8);
  const maxOutputPx = previewLines * typography.outputLineHeightPx;
  const outputPx = output
    ? Math.max(
        DEFERRED_PREVIEW_HEIGHT.minOutputRowPx,
        Math.min(
          maxOutputPx,
          estimateWrappedLineCount(output, charsPerLine) *
            typography.outputLineHeightPx,
        ) + typography.outputRowChromePx,
      )
    : params.result
      ? DEFERRED_PREVIEW_HEIGHT.emptyOutputRowPx
      : 0;

  return clamp(
    outputPx + DEFERRED_PREVIEW_HEIGHT.previewBorderPx,
    DEFERRED_PREVIEW_HEIGHT.minPx,
    Math.max(
      DEFERRED_PREVIEW_HEIGHT.maxPx,
      maxOutputPx +
        typography.outputRowChromePx +
        DEFERRED_PREVIEW_HEIGHT.previewBorderPx,
    ),
  );
}

function readDeferredPreviewTypographyMetrics(): DeferredPreviewTypographyMetrics {
  if (typeof document === "undefined") {
    return DEFAULT_DEFERRED_PREVIEW_TYPOGRAPHY;
  }

  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.left = "-9999px";
  probe.style.top = "-9999px";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  probe.style.fontFamily = "var(--output-prose-font-family)";
  probe.style.fontSize = "var(--output-prose-font-size)";
  probe.style.lineHeight = "var(--output-prose-line-height)";
  probe.textContent =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  document.body.appendChild(probe);
  const computed = window.getComputedStyle(probe);
  const rect = probe.getBoundingClientRect();
  const fontSizePx = Number.parseFloat(computed.fontSize);
  const lineHeightPx = Number.parseFloat(computed.lineHeight);
  probe.remove();

  const effectiveFontSizePx = Number.isFinite(fontSizePx)
    ? fontSizePx
    : DEFAULT_DEFERRED_PREVIEW_TYPOGRAPHY.outputLineHeightPx / 1.5;
  const averageCharWidthPx =
    rect.width > 0 && probe.textContent
      ? rect.width / probe.textContent.length
      : effectiveFontSizePx * 0.5;
  const outputLineHeightPx = Number.isFinite(lineHeightPx)
    ? lineHeightPx
    : effectiveFontSizePx * 1.5;
  const outputRowChromePx =
    DEFERRED_PREVIEW_HEIGHT.outputRowChromePx +
    (outputLineHeightPx -
      DEFAULT_DEFERRED_PREVIEW_TYPOGRAPHY.outputLineHeightPx) *
      0.5;

  return normalizeTypographyMetrics({
    averageCharWidthPx,
    outputLineHeightPx,
    outputRowChromePx,
  });
}

export function useDeferredPreviewTypographyMetrics(): DeferredPreviewTypographyMetrics {
  const [metrics, setMetrics] = useState(readDeferredPreviewTypographyMetrics);

  useEffect(() => {
    const updateMetrics = () =>
      setMetrics(readDeferredPreviewTypographyMetrics());
    updateMetrics();
    window.addEventListener(OUTPUT_APPEARANCE_CHANGE_EVENT, updateMetrics);
    return () =>
      window.removeEventListener(OUTPUT_APPEARANCE_CHANGE_EVENT, updateMetrics);
  }, []);

  return metrics;
}

export function isBashLikeToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "bash" ||
    normalized === "exec_command" ||
    normalized === "shell_command"
  );
}

export function canDeferRichToolRow(
  status: ToolCallItem["status"],
  deferRichContent = true,
): boolean {
  return deferRichContent && (status === "complete" || status === "error");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function getBashResultOutputForRichPreview(
  result: unknown,
  bareExitCodeIsEnvelope = false,
): string {
  if (typeof result === "string") {
    const parsed = parseShellToolOutput(result, { bareExitCodeIsEnvelope });
    return parsed.hasEnvelope ? parsed.output : result;
  }

  if (!isRecord(result)) {
    return "";
  }

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (stdout || stderr) {
    return [stdout, stderr].filter(Boolean).join("\n");
  }

  if (typeof result.content === "string") {
    const parsed = parseShellToolOutput(result.content, {
      bareExitCodeIsEnvelope,
    });
    return parsed.hasEnvelope ? parsed.output : result.content;
  }

  return "";
}

import { parseShellToolOutput } from "@yep-anywhere/shared/transcript/shellToolOutput";

export function getHiddenCommandCount({
  hiddenChars,
  hiddenLines,
}: {
  hiddenChars: number;
  hiddenLines: number;
}): number | null {
  return hiddenLines || hiddenChars || null;
}
