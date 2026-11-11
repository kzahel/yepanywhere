import diffStyles from "../DiffOutput.module.css";
import codeStyles from "../CodeOutput.module.css";
import styles from "./EditRenderer.module.css";
import { diffTextToNewSide, truncateByLines } from "./editDiffText";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useOptionalSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { useVisibilityAwareTextTooltip } from "../../../hooks/useTooltipAppearance";
import { isMarkdownLikeFile } from "../../../lib/markdownFiles";
import { getPathBasename, makeDisplayPath } from "../../../lib/text";
import { FileVersionControlLinks } from "../../FilePathLink";
import {
  FixedFontMathToggle,
  type FixedFontRenderMode,
} from "../../ui/FixedFontMathToggle";
import { HiddenContentBadge } from "../../ui/HiddenContentBadge";
import { InnerHtml } from "../../ui/InnerHtml";
import {
  captureDiffSelection,
  type DiffSelectionSnapshot,
  restoreDiffSelection,
} from "./editSelectionTransfer";
import { getOutputTailTooltip } from "./outputPreview";
import { IconButton } from "../../ui/Button";
import type { EditInput, EditResult, PatchHunk } from "./types";
export const MAX_VISIBLE_LINES = 12;

export interface FileLineRange {
  lineEnd?: number;
  lineNumber: number;
}

/** Extended input type with embedded augment data from server */
export type EditInputWithAugment = EditInput;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractRawPatchFromInput(input?: unknown): string | undefined {
  if (typeof input === "string") {
    return input;
  }
  if (!isRecord(input)) {
    return undefined;
  }
  const rawPatch = input._rawPatch;
  return typeof rawPatch === "string" ? rawPatch : undefined;
}

function extractFilePathsFromRawPatch(rawPatch?: string): string[] {
  if (typeof rawPatch !== "string" || rawPatch.trim().length === 0) {
    return [];
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  const lines = rawPatch.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const match = line.match(
      /^\*\*\*\s+(?:Update File|Add File|Delete File|Move to):\s+(.+?)\s*$/,
    );
    if (match?.[1]) {
      const path = match[1].trim();
      if (path && !seen.has(path)) {
        seen.add(path);
        paths.push(path);
      }
    }
  }

  return paths;
}

function extractFilePathsFromChanges(input?: unknown): string[] {
  if (!isRecord(input) || !Array.isArray(input.changes)) {
    return [];
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const change of input.changes) {
    if (!isRecord(change) || typeof change.path !== "string") {
      continue;
    }
    const path = change.path.trim();
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

export function extractEditFilePaths(
  input?: unknown,
  result?: Partial<EditResult>,
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const addPath = (path: unknown) => {
    if (typeof path !== "string") return;
    const trimmed = path.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    paths.push(trimmed);
  };

  addPath(result?.filePath);
  if (isRecord(input)) {
    addPath(input.file_path);
  }
  for (const path of extractFilePathsFromRawPatch(
    extractRawPatchFromInput(input),
  )) {
    addPath(path);
  }
  for (const path of extractFilePathsFromChanges(input)) {
    addPath(path);
  }
  return paths;
}

export function getEditFilePath(
  input?: unknown,
  result?: Partial<EditResult>,
): string {
  return extractEditFilePaths(input, result)[0] ?? "";
}

export function getEditRenderMode(filePaths: string[]): FixedFontRenderMode {
  return filePaths.length > 0 && filePaths.every(isMarkdownLikeFile)
    ? "rich"
    : "math";
}

export function SourceControlEditLink({ filePath }: { filePath: string }) {
  const session = useOptionalSessionMetadata();
  if (!session?.projectId || !filePath) {
    return null;
  }
  return (
    <FileVersionControlLinks
      projectId={session.projectId}
      filePath={filePath}
    />
  );
}

/**
 * Extract filename from path.
 * Some Codex tool aliases (e.g. apply_patch -> Edit) may not include file_path.
 */
export function getFileName(filePath?: string): string {
  if (typeof filePath !== "string") return "Patch";
  const trimmed = filePath.trim();
  if (!trimmed) return "Patch";
  return getPathBasename(trimmed);
}

export function getPatchTargetSummary(
  input?: unknown,
  result?: Partial<EditResult>,
): string {
  const filePaths = extractEditFilePaths(input, result);
  const firstPath = filePaths[0];
  if (!firstPath) return "Patch";
  const firstFileName = getFileName(firstPath);
  if (filePaths.length <= 1) return firstFileName;
  return `${firstFileName} +${filePaths.length - 1} files`;
}

export function getPatchTargetTitle(
  input: unknown,
  result: Partial<EditResult> | undefined,
  projectPath: string | null,
): string | undefined {
  const displayPaths = getPatchTargetDisplayPaths(input, result, projectPath);
  return displayPaths.length > 0 ? displayPaths.join("\n") : undefined;
}

export function getPatchTargetDisplayPaths(
  input: unknown,
  result: Partial<EditResult> | undefined,
  projectPath: string | null,
): string[] {
  return extractEditFilePaths(input, result).map((path) =>
    makeDisplayPath(path, projectPath),
  );
}

/**
 * Check if this is a Claude plan file
 */
export function isPlanFile(filePath: string): boolean {
  return filePath.includes(".claude/plans/");
}

/**
 * Compute change summary from structuredPatch
 */
export function computeChangeSummary(
  structuredPatch: PatchHunk[],
): string | null {
  if (!structuredPatch || structuredPatch.length === 0) return null;

  const additions = structuredPatch
    .flatMap((h) => h.lines)
    .filter((l) => l.startsWith("+")).length;
  const deletions = structuredPatch
    .flatMap((h) => h.lines)
    .filter((l) => l.startsWith("-")).length;

  if (additions > 0 && deletions > 0) {
    return `Modified ${additions + deletions} lines`;
  }
  if (additions > 0) {
    return `Added ${additions} line${additions !== 1 ? "s" : ""}`;
  }
  if (deletions > 0) {
    return `Removed ${deletions} line${deletions !== 1 ? "s" : ""}`;
  }
  return null;
}

export function getPatchFileLineRange(
  structuredPatch?: PatchHunk[],
): FileLineRange | undefined {
  if (!structuredPatch || structuredPatch.length === 0) {
    return undefined;
  }

  let lineNumber: number | null = null;
  let lineEnd: number | null = null;
  for (const hunk of structuredPatch) {
    const start = Math.max(1, hunk.newStart || 1);
    const end = start + Math.max(1, hunk.newLines || 1) - 1;
    lineNumber = lineNumber === null ? start : Math.min(lineNumber, start);
    lineEnd = lineEnd === null ? end : Math.max(lineEnd, end);
  }

  if (lineNumber === null || lineEnd === null) {
    return undefined;
  }
  return {
    lineNumber,
    lineEnd: lineEnd > lineNumber ? lineEnd : undefined,
  };
}

function renderFixedFontMathPanel(html: string, className: string) {
  return (
    <div
      className={`${className} ${codeStyles.fixedFontRenderedPanel}`}
      data-fixed-font-rendered-panel
    >
      {/* KaTeX output is trusted HTML from local rendering. */}
      <InnerHtml
        className={codeStyles.fixedFontRenderedContent}
        data-fixed-font-rendered__content
        trustedHtml={html}
      />
    </div>
  );
}

function DiffCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    async (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    },
    [text],
  );

  return (
    <IconButton
      variant={copied ? "success-outline" : "outline"}
      size="small"
      className={diffStyles.diffCopyButton}
      data-copied={copied || undefined}
      data-diff-copy-button
      onMouseDown={(event) => event.stopPropagation()}
      onClick={handleCopy}
      label="Copy post-change text"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </IconButton>
  );
}

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
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
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5 6.5 12 13 4" />
    </svg>
  );
}

export function DiffMathView({
  sourceText,
  sourceView,
  truncated = false,
  diffAware = true,
  baseFilePath,
  renderMode,
  initialMode,
  copyText,
  hiddenLineCount = 0,
}: {
  sourceText: string;
  sourceView: ReactNode;
  truncated?: boolean;
  diffAware?: boolean;
  baseFilePath?: string;
  renderMode?: FixedFontRenderMode;
  initialMode?: DiffSelectionSnapshot["renderMode"];
  copyText?: string;
  hiddenLineCount?: number;
}) {
  const effectiveCopyText =
    copyText ?? (diffAware ? diffTextToNewSide(sourceText) : sourceText);
  const effectiveRenderMode =
    renderMode ?? getEditRenderMode(baseFilePath ? [baseFilePath] : []);
  const tailTooltip = truncated
    ? getOutputTailTooltip(sourceText, MAX_VISIBLE_LINES)
    : null;
  const tooltipAttributes = useVisibilityAwareTextTooltip<HTMLDivElement>(
    sourceText,
    tailTooltip,
  );
  return (
    <FixedFontMathToggle
      sourceText={sourceText}
      diffAware={diffAware}
      baseFilePath={baseFilePath}
      renderMode={effectiveRenderMode}
      initialMode={initialMode}
      sourceView={
        <div
          className={`${diffStyles.diffViewContainer} ${diffStyles.diffGutterAligned} `}
          data-diff-view-container
          data-truncated={truncated || undefined}
          data-diff-gutter-aligned
          {...tooltipAttributes}
        >
          <div className={diffStyles.diffView} data-diff-view>
            {sourceView}
          </div>
          {effectiveCopyText && <DiffCopyButton text={effectiveCopyText} />}
          {truncated && (
            <div
              className={diffStyles.diffFadeOverlay}
              data-diff-fade-overlay
            />
          )}
          {hiddenLineCount > 0 && (
            <HiddenContentBadge
              className={styles.editPreviewMore}
              data-edit-preview-more
              count={hiddenLineCount}
              tooltip={tailTooltip ?? sourceText}
            />
          )}
        </div>
      }
      renderRenderedView={(html) => (
        <div
          className={`${diffStyles.diffViewContainer} ${diffStyles.diffGutterAligned} `}
          data-diff-view-container
          data-truncated={truncated || undefined}
          data-diff-gutter-aligned
          {...tooltipAttributes}
        >
          <div className={diffStyles.diffView} data-diff-view>
            {renderFixedFontMathPanel(html, diffStyles.diffContent ?? "")}
          </div>
          {effectiveCopyText && <DiffCopyButton text={effectiveCopyText} />}
          {truncated && (
            <div
              className={diffStyles.diffFadeOverlay}
              data-diff-fade-overlay
            />
          )}
          {hiddenLineCount > 0 && (
            <HiddenContentBadge
              className={styles.editPreviewMore}
              data-edit-preview-more
              count={hiddenLineCount}
              tooltip={tailTooltip ?? sourceText}
            />
          )}
        </div>
      )}
    />
  );
}

export function useRestoreDiffSelection(
  containerRef: { current: HTMLDivElement | null },
  snapshot?: DiffSelectionSnapshot | null,
) {
  useEffect(() => {
    if (!snapshot) return;
    const frame = window.requestAnimationFrame(() => {
      if (containerRef.current) {
        restoreDiffSelection(containerRef.current, snapshot);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [containerRef, snapshot]);
}

/**
 * Tap target wrapping a diff preview: tapping the diff itself opens the
 * full-diff modal (replacing the old dedicated "Show full diff" button).
 * Inner buttons and links (copy, math toggle, file links) keep their own
 * behavior.
 */
export function DiffTapTarget({
  label,
  onOpen,
  children,
}: {
  label: string;
  onOpen: (selection?: DiffSelectionSnapshot) => void;
  children: ReactNode;
}) {
  const hasSelectionWithin = (element: HTMLElement): boolean => {
    const selection = element.ownerDocument.getSelection();
    if (!selection || selection.isCollapsed) {
      return false;
    }
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      if (
        range.startContainer === element ||
        element.contains(range.startContainer) ||
        range.endContainer === element ||
        element.contains(range.endContainer)
      ) {
        return true;
      }
    }
    return false;
  };

  return (
    // A native <button> cannot wrap the diff's inner buttons/links, so this
    // mirrors the bash-collapsed-preview role="button" container pattern.
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      className={diffStyles.diffTapTarget}
      data-diff-tap-target
      onClick={(event) => {
        if (hasSelectionWithin(event.currentTarget)) {
          event.stopPropagation();
          const selection = captureDiffSelection(event.currentTarget);
          if (selection) onOpen(selection);
          return;
        }
        const target = event.target as Element | null;
        if (target?.closest?.("button,a")) {
          return;
        }
        event.stopPropagation();
        onOpen();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      {children}
    </div>
  );
}

/**
 * Render diff lines (shared between pending preview and result fallback)
 * Memoized to prevent scroll reset when parent re-renders.
 */
export const DiffLines = memo(function DiffLines({
  lines,
}: {
  lines: string[];
}) {
  return (
    <div className={diffStyles.diffHunk} data-diff-hunk>
      <pre className={diffStyles.diffContent} data-diff-content>
        {lines.map((line, i) => {
          const prefix = line[0];
          const className =
            prefix === "-"
              ? diffStyles.diffRemoved
              : prefix === "+"
                ? diffStyles.diffAdded
                : diffStyles.diffContext;
          // Use line content hash for stable keys
          const key = `${i}-${line.slice(0, 50)}`;
          return (
            <div
              key={key}
              className={className}
              data-diff-removed={prefix === "-" || undefined}
              data-diff-added={
                (!(prefix === "-") && prefix === "+") || undefined
              }
              data-diff-context={
                (!(prefix === "-") && !(prefix === "+")) || undefined
              }
            >
              <span className={diffStyles.diffPrefix} data-diff-prefix>
                {prefix}
              </span>
              {line.slice(1)}
            </div>
          );
        })}
      </pre>
    </div>
  );
});

/**
 * Render pre-highlighted diff HTML from shiki.
 * Used when diffHtml is available from the augment.
 * Memoized to prevent scroll reset when parent re-renders.
 */
export const HighlightedDiff = memo(function HighlightedDiff({
  diffHtml,
  truncateLines,
}: {
  diffHtml: string;
  truncateLines?: number;
}) {
  // If truncation is needed, we need to limit the visible lines
  // The HTML is wrapped in <pre class="shiki"><code>...</code></pre>
  // Each line is a <span class="line ...">...</span>
  const htmlToRender = useMemo(() => {
    if (!truncateLines) return diffHtml;

    // Parse and truncate by counting line spans
    // Match any span with class starting with "line" (e.g. "line", "line line-deleted")
    const lineRegex = /<span class="line[^"]*">/g;
    const matches = [...diffHtml.matchAll(lineRegex)];
    if (matches.length <= truncateLines) return diffHtml;

    // Find the position to truncate at (after truncateLines lines)
    const lastMatch = matches[truncateLines - 1];
    if (!lastMatch) return diffHtml;

    // Find the closing </span> for this line
    const startPos = (lastMatch.index ?? 0) + lastMatch[0].length;
    const closeSpanPos = diffHtml.indexOf("</span>", startPos);
    if (closeSpanPos === -1) return diffHtml;

    // Truncate and close tags
    return `${diffHtml.slice(0, closeSpanPos + 7)}</code></pre>`;
  }, [diffHtml, truncateLines]);

  // Shiki output is safe.
  return (
    <InnerHtml
      className={diffStyles.highlightedDiff}
      data-highlighted-diff
      trustedHtml={htmlToRender}
    />
  );
});

/**
 * Render a single diff hunk (without @@ header for cleaner display)
 * Memoized to prevent scroll reset when parent re-renders.
 */
export const DiffHunk = memo(function DiffHunk({ hunk }: { hunk: PatchHunk }) {
  return (
    <div className={diffStyles.diffHunk} data-diff-hunk>
      <pre className={diffStyles.diffContent} data-diff-content>
        {hunk.lines.map((line, i) => {
          const prefix = line[0];
          const className =
            prefix === "-"
              ? diffStyles.diffRemoved
              : prefix === "+"
                ? diffStyles.diffAdded
                : diffStyles.diffContext;
          return (
            <div
              key={`${hunk.oldStart}-${i}`}
              className={className}
              data-diff-removed={prefix === "-" || undefined}
              data-diff-added={
                (!(prefix === "-") && prefix === "+") || undefined
              }
              data-diff-context={
                (!(prefix === "-") && !(prefix === "+")) || undefined
              }
            >
              <span className={diffStyles.diffPrefix} data-diff-prefix>
                {prefix}
              </span>
              {line.slice(1)}
            </div>
          );
        })}
      </pre>
    </div>
  );
});

export function RawPatchPreview({
  rawPatch,
  truncateLines,
  baseFilePath,
}: {
  rawPatch: string;
  truncateLines?: number;
  baseFilePath?: string;
}) {
  const targetFilePaths = extractFilePathsFromRawPatch(rawPatch);
  const targetFilePath = baseFilePath ?? targetFilePaths[0];
  const renderMode = getEditRenderMode(
    targetFilePaths.length > 0
      ? targetFilePaths
      : targetFilePath
        ? [targetFilePath]
        : [],
  );
  const preview = useMemo(() => {
    if (!truncateLines) {
      return { hiddenLineCount: 0, text: rawPatch, truncated: false };
    }
    return truncateByLines(rawPatch, truncateLines);
  }, [rawPatch, truncateLines]);
  const tailTooltip = truncateLines
    ? getOutputTailTooltip(rawPatch, truncateLines)
    : null;
  const tooltipAttributes = useVisibilityAwareTextTooltip<HTMLDivElement>(
    rawPatch,
    tailTooltip,
  );

  return (
    <FixedFontMathToggle
      sourceText={preview.text}
      diffAware
      baseFilePath={targetFilePath}
      renderMode={renderMode}
      sourceView={
        <div
          className={diffStyles.diffViewContainer}
          data-truncated={preview.truncated || undefined}
          data-diff-view-container
          {...tooltipAttributes}
        >
          <div className={diffStyles.diffView} data-diff-view>
            <pre className={codeStyles.codeBlock} data-code-block>
              <code>{preview.text}</code>
            </pre>
          </div>
          {preview.truncated && (
            <div
              className={diffStyles.diffFadeOverlay}
              data-diff-fade-overlay
            />
          )}
          {preview.hiddenLineCount > 0 && (
            <HiddenContentBadge
              className={styles.editPreviewMore}
              data-edit-preview-more
              count={preview.hiddenLineCount}
              tooltip={tailTooltip ?? rawPatch}
            />
          )}
        </div>
      }
      renderRenderedView={(html) => (
        <div
          className={diffStyles.diffViewContainer}
          data-truncated={preview.truncated || undefined}
          data-diff-view-container
          {...tooltipAttributes}
        >
          <div className={diffStyles.diffView} data-diff-view>
            {renderFixedFontMathPanel(html, codeStyles.codeBlock ?? "")}
          </div>
          {preview.truncated && (
            <div
              className={diffStyles.diffFadeOverlay}
              data-diff-fade-overlay
            />
          )}
          {preview.hiddenLineCount > 0 && (
            <HiddenContentBadge
              className={styles.editPreviewMore}
              data-edit-preview-more
              count={preview.hiddenLineCount}
              tooltip={tailTooltip ?? rawPatch}
            />
          )}
        </div>
      )}
    />
  );
}

export function RawPatchModalContent({
  rawPatch,
  baseFilePath,
  selection,
}: {
  rawPatch: string;
  baseFilePath?: string;
  selection?: DiffSelectionSnapshot | null;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  useRestoreDiffSelection(contentRef, selection);
  const targetFilePaths = extractFilePathsFromRawPatch(rawPatch);
  const targetFilePath = baseFilePath ?? targetFilePaths[0];
  const renderMode = getEditRenderMode(
    targetFilePaths.length > 0
      ? targetFilePaths
      : targetFilePath
        ? [targetFilePath]
        : [],
  );
  return (
    <div
      className={diffStyles.diffModalContent}
      data-diff-modal-content
      ref={contentRef}
    >
      <FixedFontMathToggle
        sourceText={rawPatch}
        initialMode={selection?.renderMode}
        diffAware
        baseFilePath={targetFilePath}
        renderMode={renderMode}
        sourceView={
          <pre className={codeStyles.codeBlock} data-code-block>
            <code>{rawPatch}</code>
          </pre>
        }
        renderRenderedView={(html) =>
          renderFixedFontMathPanel(html, codeStyles.codeBlock ?? "")
        }
      />
    </div>
  );
}
