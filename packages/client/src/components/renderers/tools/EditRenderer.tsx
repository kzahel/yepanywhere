import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { useOptionalSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { useExpandedDiff } from "../../../hooks/useExpandedDiff";
import { useVisibilityAwareTextTooltip } from "../../../hooks/useTooltipAppearance";
import { useI18n } from "../../../i18n";
import {
  captureScrollPositionAnchor,
  restoreScrollPositionAnchor,
  type ScrollPositionAnchor,
} from "../../../lib/scrollAnchor";
import {
  classifyToolError,
  getErrorClassSuffix,
  isUserRejection,
} from "../../../lib/classifyToolError";
import { isMarkdownLikeFile } from "../../../lib/markdownFiles";
import { getPathBasename, makeDisplayPath } from "../../../lib/text";
import { validateToolResult } from "../../../lib/validateToolResult";
import { ActivityDetailModal } from "../../ActivityDetailModal";
import {
  FilePathLink,
  FileVersionControlLinks,
  getProjectViewerFilePath,
} from "../../FilePathLink";
import { SchemaWarning } from "../../SchemaWarning";
import { Badge } from "../../ui/Badge";
import { SourceFileHeaderActions } from "../../SourceFileHeaderActions";
import { FileRevisionLink } from "../../FileRevisionLink";
import { FileDiffLinkCluster } from "../../FileDiffViewLinks";
import { FilePathDisplay } from "../../ui/FilePathDisplay";
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
import { Button, ButtonBase, IconButton } from "../../ui/Button";
import {
  CHANGED_DIFF_LINE_SELECTOR,
  UnifiedDiff,
} from "../../../pages/UnifiedDiff";
import type { EditInput, EditResult, PatchHunk } from "./types";

const MAX_VISIBLE_LINES = 12;

interface FileLineRange {
  lineEnd?: number;
  lineNumber: number;
}

/** Extended input type with embedded augment data from server */
type EditInputWithAugment = EditInput;

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

function extractEditFilePaths(
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

function getEditFilePath(
  input?: unknown,
  result?: Partial<EditResult>,
): string {
  return extractEditFilePaths(input, result)[0] ?? "";
}

function getEditRenderMode(filePaths: string[]): FixedFontRenderMode {
  return filePaths.length > 0 && filePaths.every(isMarkdownLikeFile)
    ? "rich"
    : "math";
}

function SourceControlEditLink({ filePath }: { filePath: string }) {
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
function getFileName(filePath?: string): string {
  if (typeof filePath !== "string") return "Patch";
  const trimmed = filePath.trim();
  if (!trimmed) return "Patch";
  return getPathBasename(trimmed);
}

function getPatchTargetSummary(
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

function getPatchTargetTitle(
  input: unknown,
  result: Partial<EditResult> | undefined,
  projectPath: string | null,
): string | undefined {
  const displayPaths = getPatchTargetDisplayPaths(input, result, projectPath);
  return displayPaths.length > 0 ? displayPaths.join("\n") : undefined;
}

function getPatchTargetDisplayPaths(
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
function isPlanFile(filePath: string): boolean {
  return filePath.includes(".claude/plans/");
}

/**
 * Compute change summary from structuredPatch
 */
function computeChangeSummary(structuredPatch: PatchHunk[]): string | null {
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

function getPatchFileLineRange(
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

function diffTextToNewSide(diffText: string): string {
  const lines = diffText.split("\n");
  const newSideLines: string[] = [];
  for (const line of lines) {
    const prefix = line[0];
    if (prefix === "-") {
      continue;
    }
    if (prefix === "+" || prefix === " ") {
      newSideLines.push(line.slice(1));
      continue;
    }
    if (line.trim().length > 0 && !line.startsWith("@@")) {
      newSideLines.push(line);
    }
  }
  return newSideLines.join("\n");
}

function truncateByLines(
  text: string,
  maxLines: number,
): { hiddenLineCount: number; text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return { hiddenLineCount: 0, text, truncated: false };
  }
  return {
    hiddenLineCount: lines.length - maxLines,
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
  };
}

function renderFixedFontMathPanel(html: string, className: string) {
  return (
    <div className={`${className} fixed-font-rendered-panel`}>
      {/* KaTeX output is trusted HTML from local rendering. */}
      <InnerHtml className="fixed-font-rendered__content" trustedHtml={html} />
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
      variant="outline"
      size="small"
      className={`diff-copy-button ${copied ? "copied" : ""}`}
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

function DiffMathView({
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
          className={`diff-view-container diff-gutter-aligned ${
            truncated ? "truncated" : ""
          }`}
          {...tooltipAttributes}
        >
          <div className="diff-view">{sourceView}</div>
          {effectiveCopyText && <DiffCopyButton text={effectiveCopyText} />}
          {truncated && <div className="diff-fade-overlay" />}
          {hiddenLineCount > 0 && (
            <HiddenContentBadge
              className="edit-preview-more"
              count={hiddenLineCount}
              tooltip={tailTooltip ?? sourceText}
            />
          )}
        </div>
      }
      renderRenderedView={(html) => (
        <div
          className={`diff-view-container diff-gutter-aligned ${
            truncated ? "truncated" : ""
          }`}
          {...tooltipAttributes}
        >
          <div className="diff-view">
            {renderFixedFontMathPanel(html, "diff-content")}
          </div>
          {effectiveCopyText && <DiffCopyButton text={effectiveCopyText} />}
          {truncated && <div className="diff-fade-overlay" />}
          {hiddenLineCount > 0 && (
            <HiddenContentBadge
              className="edit-preview-more"
              count={hiddenLineCount}
              tooltip={tailTooltip ?? sourceText}
            />
          )}
        </div>
      )}
    />
  );
}

function useRestoreDiffSelection(
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
function DiffTapTarget({
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
      className="diff-tap-target"
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
const DiffLines = memo(function DiffLines({ lines }: { lines: string[] }) {
  return (
    <div className="diff-hunk">
      <pre className="diff-content">
        {lines.map((line, i) => {
          const prefix = line[0];
          const className =
            prefix === "-"
              ? "diff-removed"
              : prefix === "+"
                ? "diff-added"
                : "diff-context";
          // Use line content hash for stable keys
          const key = `${i}-${line.slice(0, 50)}`;
          return (
            <div key={key} className={className}>
              <span className="diff-prefix">{prefix}</span>
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
const HighlightedDiff = memo(function HighlightedDiff({
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
  return <InnerHtml className="highlighted-diff" trustedHtml={htmlToRender} />;
});

/**
 * Render a single diff hunk (without @@ header for cleaner display)
 * Memoized to prevent scroll reset when parent re-renders.
 */
const DiffHunk = memo(function DiffHunk({ hunk }: { hunk: PatchHunk }) {
  return (
    <div className="diff-hunk">
      <pre className="diff-content">
        {hunk.lines.map((line, i) => {
          const prefix = line[0];
          const className =
            prefix === "-"
              ? "diff-removed"
              : prefix === "+"
                ? "diff-added"
                : "diff-context";
          return (
            <div key={`${hunk.oldStart}-${i}`} className={className}>
              <span className="diff-prefix">{prefix}</span>
              {line.slice(1)}
            </div>
          );
        })}
      </pre>
    </div>
  );
});

function RawPatchPreview({
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
          className={`diff-view-container ${preview.truncated ? "truncated" : ""}`}
          {...tooltipAttributes}
        >
          <div className="diff-view">
            <pre className="code-block">
              <code>{preview.text}</code>
            </pre>
          </div>
          {preview.truncated && <div className="diff-fade-overlay" />}
          {preview.hiddenLineCount > 0 && (
            <HiddenContentBadge
              className="edit-preview-more"
              count={preview.hiddenLineCount}
              tooltip={tailTooltip ?? rawPatch}
            />
          )}
        </div>
      }
      renderRenderedView={(html) => (
        <div
          className={`diff-view-container ${preview.truncated ? "truncated" : ""}`}
          {...tooltipAttributes}
        >
          <div className="diff-view">
            {renderFixedFontMathPanel(html, "code-block")}
          </div>
          {preview.truncated && <div className="diff-fade-overlay" />}
          {preview.hiddenLineCount > 0 && (
            <HiddenContentBadge
              className="edit-preview-more"
              count={preview.hiddenLineCount}
              tooltip={tailTooltip ?? rawPatch}
            />
          )}
        </div>
      )}
    />
  );
}

function RawPatchModalContent({
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
    <div className="diff-modal-content" ref={contentRef}>
      <FixedFontMathToggle
        sourceText={rawPatch}
        initialMode={selection?.renderMode}
        diffAware
        baseFilePath={targetFilePath}
        renderMode={renderMode}
        sourceView={
          <pre className="code-block">
            <code>{rawPatch}</code>
          </pre>
        }
        renderRenderedView={(html) =>
          renderFixedFontMathPanel(html, "code-block")
        }
      />
    </div>
  );
}

/**
 * Edit tool use - shows file path and diff preview
 * Reads augment data directly from input._structuredPatch and input._diffHtml.
 */
function EditToolUse({ input }: { input: EditInputWithAugment }) {
  // Show loading state if augment data not yet available
  if (!input._structuredPatch || input._structuredPatch.length === 0) {
    if (input._rawPatch) {
      return (
        <div className="edit-result">
          <RawPatchPreview
            rawPatch={input._rawPatch}
            baseFilePath={getEditFilePath(input)}
          />
        </div>
      );
    }
    return (
      <div className="edit-result">
        <div className="edit-loading">Computing diff...</div>
      </div>
    );
  }

  const diffLines = input._structuredPatch.flatMap((hunk) => hunk.lines);
  const filePath = getEditFilePath(input);
  const renderMode = getEditRenderMode(extractEditFilePaths(input));
  const changeSummary = computeChangeSummary(input._structuredPatch);
  const isTruncated = diffLines.length > MAX_VISIBLE_LINES;

  return (
    <div className="edit-result">
      {changeSummary && (
        <div className="edit-change-summary">{changeSummary}</div>
      )}
      <DiffMathView
        sourceText={diffLines.join("\n")}
        baseFilePath={filePath}
        renderMode={renderMode}
        truncated={isTruncated}
        hiddenLineCount={Math.max(0, diffLines.length - MAX_VISIBLE_LINES)}
        sourceView={
          input._diffHtml ? (
            <HighlightedDiff
              diffHtml={input._diffHtml}
              truncateLines={isTruncated ? MAX_VISIBLE_LINES : undefined}
            />
          ) : (
            <DiffLines lines={diffLines} />
          )
        }
      />
    </div>
  );
}

/**
 * Modal content for viewing complete diff with optional full file context.
 * The toggle reads the SDK originalFile snapshot when present, otherwise the
 * current file. Diff markers stay only when the replacement can be uniquely
 * located.
 */
function DiffModalContent({
  diffHtml,
  structuredPatch,
  filePath,
  oldString,
  newString,
  originalFile,
  selection,
}: {
  diffHtml?: string;
  structuredPatch: PatchHunk[];
  filePath: string;
  oldString: string;
  newString: string;
  /** Complete file content from SDK Edit result when the provider supplies it. */
  originalFile?: string | null;
  selection?: DiffSelectionSnapshot | null;
}) {
  const sessionMetadata = useOptionalSessionMetadata();
  const projectPath = sessionMetadata?.projectPath ?? null;
  const [showFullContext, setShowFullContext] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const pendingScrollAnchorRef = useRef<ScrollPositionAnchor | null>(null);
  useRestoreDiffSelection(contentRef, selection);

  const canExpandContext = Boolean(
    filePath && (originalFile || sessionMetadata?.projectId),
  );
  const { loading, error, result, fetchExpandedDiff } = useExpandedDiff({
    filePath,
    oldString,
    newString,
    originalFile: originalFile ?? "",
    structuredPatch,
  });

  const handleToggle = useCallback(async () => {
    if (!canExpandContext) return;
    if (!showFullContext && !result) {
      await fetchExpandedDiff();
    }
    const content = contentRef.current;
    const scrollRoot =
      content?.closest<HTMLElement>(".modal-content") ?? content;
    pendingScrollAnchorRef.current = captureScrollPositionAnchor(
      scrollRoot,
      content?.querySelector(CHANGED_DIFF_LINE_SELECTOR) ?? null,
    );
    setShowFullContext(!showFullContext);
  }, [canExpandContext, showFullContext, result, fetchExpandedDiff]);

  const fullContextDiff =
    showFullContext && result?.kind === "diff" ? result : null;
  const fullContextFile =
    showFullContext && result?.kind === "file" ? result : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: projection changes trigger restoring the ref-held DOM anchor
  useLayoutEffect(() => {
    const anchor = pendingScrollAnchorRef.current;
    if (!anchor) return;
    pendingScrollAnchorRef.current = null;
    restoreScrollPositionAnchor(
      anchor,
      contentRef.current?.querySelector(CHANGED_DIFF_LINE_SELECTOR) ?? null,
    );
  }, [fullContextDiff, showFullContext]);

  const displayHtml = fullContextDiff?.diffHtml ?? diffHtml;
  const displayPatch = fullContextDiff?.structuredPatch ?? structuredPatch;
  const fileLineRange = fullContextFile
    ? undefined
    : getPatchFileLineRange(displayPatch);

  // Strip project path prefix for display
  const displayPath = makeDisplayPath(filePath, projectPath);

  return (
    <div className="diff-modal-content" ref={contentRef}>
      <div className="diff-context-controls">
        {sessionMetadata?.projectId ? (
          <FilePathLink
            projectId={sessionMetadata.projectId}
            filePath={filePath}
            displayText={displayPath}
            lineNumber={fileLineRange?.lineNumber}
            lineEnd={fileLineRange?.lineEnd}
            showCopyButton={false}
            showVersionControlLinks={false}
          />
        ) : (
          <span className="diff-context-path">{displayPath}</span>
        )}
        {canExpandContext && (
          <Button onClick={handleToggle} busy={loading}>
            {loading
              ? "Loading..."
              : showFullContext
                ? "Show diff only"
                : "Show full context"}
          </Button>
        )}
        {error && <span className="diff-context-error">{error}</span>}
      </div>

      {fullContextFile ? (
        <DiffMathView
          sourceText={fullContextFile.content}
          diffAware={false}
          baseFilePath={displayPath}
          initialMode={selection?.renderMode}
          sourceView={
            <pre className="code-block">
              <code>{fullContextFile.content}</code>
            </pre>
          }
        />
      ) : (
        <DiffMathView
          sourceText={displayPatch.flatMap((h) => h.lines).join("\n")}
          baseFilePath={displayPath}
          initialMode={selection?.renderMode}
          sourceView={
            <UnifiedDiff
              diffHtml={displayHtml ?? ""}
              structuredPatch={displayPatch}
            />
          }
        />
      )}
    </div>
  );
}

function EditModalTitle({
  filePath,
  displayText,
  lineRange,
}: {
  filePath: string;
  displayText?: string;
  lineRange?: FileLineRange;
}) {
  const sessionMetadata = useOptionalSessionMetadata();
  const text = displayText ?? getFileName(filePath);

  if (sessionMetadata?.projectId && filePath) {
    return (
      <FilePathLink
        projectId={sessionMetadata.projectId}
        filePath={filePath}
        displayText={text}
        lineNumber={lineRange?.lineNumber}
        lineEnd={lineRange?.lineEnd}
        showCopyButton={false}
        showVersionControlLinks={false}
      />
    );
  }

  return (
    <span className="file-path" title={filePath}>
      {text}
    </span>
  );
}

function EditDetailModal({
  filePath,
  displayText,
  lineRange,
  label,
  children,
  onClose,
}: {
  filePath: string;
  displayText?: string;
  lineRange?: FileLineRange;
  label: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const sessionMetadata = useOptionalSessionMetadata();
  const { t } = useI18n();
  const projectId = sessionMetadata?.projectId;
  const viewerPath =
    projectId && filePath
      ? getProjectViewerFilePath(projectId, filePath)
      : filePath;
  const actions =
    projectId && filePath ? (
      <>
        <FileRevisionLink
          projectId={projectId}
          path={viewerPath}
          dirtyLabel={t("fileRevisionDirty" as never)}
          uncommittedLabel={t("fileRevisionUncommitted" as never)}
        />
        <FileVersionControlLinks projectId={projectId} filePath={filePath} />
        <SourceFileHeaderActions path={viewerPath} t={t} />
      </>
    ) : undefined;

  return (
    <ActivityDetailModal
      title={
        <EditModalTitle
          filePath={filePath}
          displayText={displayText}
          lineRange={lineRange}
        />
      }
      actions={actions}
      label={label}
      onClose={onClose}
    >
      {children}
    </ActivityDetailModal>
  );
}

/**
 * Collapsed preview showing diff with expand button
 * Clicking opens a modal with the full diff.
 * Reads augment data directly from input._structuredPatch and input._diffHtml.
 */
function EditCollapsedPreview({
  input,
  result,
  isError,
}: {
  input: EditInputWithAugment;
  result: EditResult | undefined;
  isError: boolean;
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalSelection, setModalSelection] =
    useState<DiffSelectionSnapshot | null>(null);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Edit", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Edit", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Edit");

  const handleClose = useCallback(() => {
    setIsModalOpen(false);
    setModalSelection(null);
  }, []);
  const handleOpen = useCallback((selection?: DiffSelectionSnapshot) => {
    setModalSelection(selection ?? null);
    setIsModalOpen(true);
  }, []);

  // Use result data if available, fall back to input
  const filePath = getEditFilePath(input, result);
  const renderMode = getEditRenderMode(extractEditFilePaths(input, result));
  const fileName = getFileName(filePath);
  const oldString = result?.oldString ?? input.old_string;
  const newString = result?.newString ?? input.new_string;
  const originalFile = result?.originalFile;

  // Get structuredPatch - prefer result, then input augment
  const structuredPatch =
    result?.structuredPatch ?? input._structuredPatch ?? [];
  const fileLineRange = getPatchFileLineRange(structuredPatch);

  // Get diffHtml from input augment (only used for tool_use display)
  const diffHtml = input._diffHtml;
  const rawPatch = input._rawPatch;

  if (isError) {
    const errorMessage = result?.content ?? null;

    // Classify the error for appropriate styling
    const classification = errorMessage
      ? classifyToolError(errorMessage)
      : {
          classification: "unknown" as const,
          label: "Error",
          cleanedMessage: "",
        };
    const classSuffix = getErrorClassSuffix(classification.classification);
    const isRejection = isUserRejection(classification.classification);

    // For user rejections, show the proposed diff alongside the declined badge
    const hasProposedDiff =
      isRejection &&
      input._structuredPatch &&
      input._structuredPatch.length > 0;
    const proposedDiffLines = hasProposedDiff
      ? (input._structuredPatch?.flatMap((hunk) => hunk.lines) ?? [])
      : [];
    const proposedDiffTruncated = proposedDiffLines.length > MAX_VISIBLE_LINES;

    return (
      <>
        <div className={`edit-collapsed-preview edit-collapsed-${classSuffix}`}>
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Edit" errors={validationErrors} />
          )}
          <Badge tone={classSuffix === "muted" ? "neutral" : "warning"}>
            {isRejection
              ? classification.label
              : `Edit ${classification.label.toLowerCase()}`}
          </Badge>
          {classification.userReason ? (
            <span className="edit-error-message">
              {classification.userReason}
            </span>
          ) : classification.cleanedMessage && !isRejection ? (
            <span className="edit-error-message">
              {classification.cleanedMessage}
            </span>
          ) : null}
          {hasProposedDiff && (
            <DiffTapTarget label="Show full diff" onOpen={handleOpen}>
              <DiffMathView
                sourceText={proposedDiffLines.join("\n")}
                baseFilePath={filePath}
                renderMode={renderMode}
                truncated={proposedDiffTruncated}
                hiddenLineCount={Math.max(
                  0,
                  proposedDiffLines.length - MAX_VISIBLE_LINES,
                )}
                sourceView={
                  input._diffHtml ? (
                    <HighlightedDiff
                      diffHtml={input._diffHtml}
                      truncateLines={
                        proposedDiffTruncated ? MAX_VISIBLE_LINES : undefined
                      }
                    />
                  ) : (
                    <DiffLines lines={proposedDiffLines} />
                  )
                }
              />
            </DiffTapTarget>
          )}
        </div>
        {isModalOpen && hasProposedDiff && (
          <EditDetailModal
            filePath={filePath}
            displayText={fileName}
            lineRange={fileLineRange}
            label={fileName}
            onClose={handleClose}
          >
            <DiffModalContent
              diffHtml={diffHtml}
              structuredPatch={structuredPatch}
              filePath={filePath}
              oldString={oldString ?? ""}
              newString={newString ?? ""}
              selection={modalSelection}
            />
          </EditDetailModal>
        )}
      </>
    );
  }

  // A plain-text result reaches this preview as `undefined`, so an absent
  // result does not mean pending; show any raw patch before waiting on one.
  if (structuredPatch.length === 0) {
    if (rawPatch) {
      return (
        <>
          <div className="edit-collapsed-preview">
            {showValidationWarning && validationErrors && (
              <SchemaWarning toolName="Edit" errors={validationErrors} />
            )}
            <DiffTapTarget label="Show full patch" onOpen={handleOpen}>
              <RawPatchPreview
                rawPatch={rawPatch}
                truncateLines={MAX_VISIBLE_LINES}
                baseFilePath={filePath}
              />
            </DiffTapTarget>
          </div>
          {isModalOpen && (
            <EditDetailModal
              filePath={filePath}
              displayText={fileName}
              label={fileName}
              onClose={handleClose}
            >
              <RawPatchModalContent
                rawPatch={rawPatch}
                baseFilePath={filePath}
                selection={modalSelection}
              />
            </EditDetailModal>
          )}
        </>
      );
    }

    if (result === undefined) {
      return (
        <div className="edit-collapsed-preview">
          <div className="edit-loading">Computing diff...</div>
        </div>
      );
    }

    return (
      <div className="edit-collapsed-preview">
        <span>Patch preview unavailable</span>
      </div>
    );
  }

  const diffLines = structuredPatch.flatMap((hunk) => hunk.lines);
  const isTruncated = diffLines.length > MAX_VISIBLE_LINES;

  return (
    <>
      <div className="edit-collapsed-preview">
        {result?.userModified && <Badge tone="info">User modified</Badge>}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Edit" errors={validationErrors} />
        )}
        <DiffTapTarget label="Show full diff" onOpen={handleOpen}>
          <DiffMathView
            sourceText={diffLines.join("\n")}
            baseFilePath={filePath}
            renderMode={renderMode}
            truncated={isTruncated}
            hiddenLineCount={Math.max(0, diffLines.length - MAX_VISIBLE_LINES)}
            sourceView={
              diffHtml ? (
                <HighlightedDiff
                  diffHtml={diffHtml}
                  truncateLines={isTruncated ? MAX_VISIBLE_LINES : undefined}
                />
              ) : (
                <DiffLines lines={diffLines} />
              )
            }
          />
        </DiffTapTarget>
      </div>
      {isModalOpen && (
        <EditDetailModal
          filePath={filePath}
          displayText={fileName}
          lineRange={fileLineRange}
          label={fileName}
          onClose={handleClose}
        >
          <DiffModalContent
            diffHtml={diffHtml}
            structuredPatch={structuredPatch}
            filePath={filePath}
            oldString={oldString ?? ""}
            newString={newString ?? ""}
            originalFile={originalFile}
            selection={modalSelection}
          />
        </EditDetailModal>
      )}
    </>
  );
}

/**
 * Interactive summary for Edit tool - shows filename and change summary inline
 * Similar to Read tool's interactive summary
 */
function EditInteractiveSummary({
  input,
  result,
  isError,
}: {
  input: EditInputWithAugment;
  result: EditResult | undefined;
  isError: boolean;
}) {
  const [showModal, setShowModal] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Edit", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Edit", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Edit");

  const projectPath = useOptionalSessionMetadata()?.projectPath ?? null;
  const filePath = getEditFilePath(input, result);
  const fileName = getPatchTargetSummary(input, result);
  const fileTitle = getPatchTargetTitle(input, result, projectPath);
  const displayPaths = getPatchTargetDisplayPaths(input, result, projectPath);
  const oldString = result?.oldString ?? input.old_string;
  const newString = result?.newString ?? input.new_string;
  const originalFile = result?.originalFile;

  // Get structuredPatch - prefer result, then input augment
  const structuredPatch =
    result?.structuredPatch ?? input._structuredPatch ?? [];
  const diffHtml = input._diffHtml;
  const changeSummary = computeChangeSummary(structuredPatch);
  const fileLineRange = getPatchFileLineRange(structuredPatch);

  if (isError) {
    return (
      <span title={fileTitle}>
        {fileName}
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Edit" errors={validationErrors} />
        )}
      </span>
    );
  }

  // Show loading state if no patch yet
  if (structuredPatch.length === 0) {
    return (
      <>
        <FileDiffLinkCluster className="source-review-edit-summary">
          <ButtonBase
            className="file-link-inline"
            title={fileTitle}
            onClick={(e) => {
              e.stopPropagation();
              setShowModal(true);
            }}
          >
            {fileName}
            {showValidationWarning && validationErrors && (
              <SchemaWarning toolName="Edit" errors={validationErrors} />
            )}
          </ButtonBase>
          <SourceControlEditLink filePath={filePath} />
        </FileDiffLinkCluster>
        {showModal && (
          <EditDetailModal
            filePath={filePath}
            displayText={fileName}
            label={fileName}
            onClose={() => setShowModal(false)}
          >
            <div className="diff-modal-content">
              <div className="diff-context-controls">
                <span className="diff-context-path" title={fileTitle}>
                  {displayPaths.length > 0 ? displayPaths[0] : fileName}
                </span>
              </div>
              <div className="edit-target-paths">
                {displayPaths.length > 0 ? (
                  displayPaths.map((displayPath) => (
                    <div className="edit-target-path" key={displayPath}>
                      <FilePathDisplay displayPath={displayPath} />
                    </div>
                  ))
                ) : (
                  <div className="edit-target-path">
                    Patch target unavailable
                  </div>
                )}
              </div>
            </div>
          </EditDetailModal>
        )}
      </>
    );
  }

  return (
    <>
      <FileDiffLinkCluster className="source-review-edit-summary">
        <ButtonBase
          className="file-link-inline"
          title={fileTitle}
          onClick={(e) => {
            e.stopPropagation();
            setShowModal(true);
          }}
        >
          {fileName}
          {changeSummary && (
            <span className="file-line-count-inline">{changeSummary}</span>
          )}
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Edit" errors={validationErrors} />
          )}
        </ButtonBase>
        <SourceControlEditLink filePath={filePath} />
      </FileDiffLinkCluster>
      {showModal && (
        <EditDetailModal
          filePath={filePath}
          displayText={fileName}
          lineRange={fileLineRange}
          label={fileName}
          onClose={() => setShowModal(false)}
        >
          <DiffModalContent
            diffHtml={diffHtml}
            structuredPatch={structuredPatch}
            filePath={filePath}
            oldString={oldString ?? ""}
            newString={newString ?? ""}
            originalFile={originalFile}
          />
        </EditDetailModal>
      )}
    </>
  );
}

/**
 * Edit tool result - shows diff view with truncation and modal expand
 */
function EditToolResult({
  result,
  input,
  isError,
}: {
  result: EditResult;
  input?: EditInput;
  isError: boolean;
}) {
  const [showModal, setShowModal] = useState(false);
  const [modalSelection, setModalSelection] =
    useState<DiffSelectionSnapshot | null>(null);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );
  const handleOpen = useCallback((selection?: DiffSelectionSnapshot) => {
    setModalSelection(selection ?? null);
    setShowModal(true);
  }, []);
  const handleClose = useCallback(() => {
    setShowModal(false);
    setModalSelection(null);
  }, []);

  useEffect(() => {
    if (enabled && result) {
      const validation = validateToolResult("Edit", result);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Edit", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, result, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Edit");

  // Count total lines in all hunks
  const totalLines = useMemo(() => {
    if (!result?.structuredPatch) return 0;
    return result.structuredPatch.reduce(
      (sum, hunk) => sum + hunk.lines.length,
      0,
    );
  }, [result?.structuredPatch]);

  const isTruncated = totalLines > MAX_VISIBLE_LINES;

  // Compute change summary
  const changeSummary = useMemo(() => {
    if (!result?.structuredPatch) return null;
    const additions = result.structuredPatch
      .flatMap((h) => h.lines)
      .filter((l) => l.startsWith("+")).length;
    const deletions = result.structuredPatch
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
  }, [result?.structuredPatch]);

  if (isError) {
    const errorMessage = result?.content ?? null;

    // Classify the error for appropriate styling
    const classification = errorMessage
      ? classifyToolError(errorMessage)
      : {
          classification: "unknown" as const,
          label: "Error",
          cleanedMessage: "",
        };
    const classSuffix = getErrorClassSuffix(classification.classification);
    const isRejection = isUserRejection(classification.classification);

    // For user rejections, show the proposed diff alongside the declined badge
    const inputWithAugment = input;
    const hasProposedDiff =
      isRejection &&
      inputWithAugment?._structuredPatch &&
      inputWithAugment._structuredPatch.length > 0;
    const proposedDiffLines = hasProposedDiff
      ? (inputWithAugment._structuredPatch?.flatMap((hunk) => hunk.lines) ?? [])
      : [];
    const proposedDiffTruncated = proposedDiffLines.length > MAX_VISIBLE_LINES;

    const filePath = getEditFilePath(inputWithAugment);
    const renderMode = getEditRenderMode(
      extractEditFilePaths(inputWithAugment),
    );
    const fileName = getFileName(filePath);
    const fileLineRange = getPatchFileLineRange(
      inputWithAugment?._structuredPatch,
    );

    return (
      <>
        <div className={`edit-result edit-result-${classSuffix}`}>
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Edit" errors={validationErrors} />
          )}
          <Badge tone={classSuffix === "muted" ? "neutral" : "warning"}>
            {isRejection
              ? classification.label
              : `Edit ${classification.label.toLowerCase()}`}
          </Badge>
          {classification.userReason ? (
            <div className="edit-error-message">
              {classification.userReason}
            </div>
          ) : classification.cleanedMessage && !isRejection ? (
            <div className="edit-error-message">
              {classification.cleanedMessage}
            </div>
          ) : null}
          {hasProposedDiff && (
            <DiffTapTarget label="Show full diff" onOpen={handleOpen}>
              <DiffMathView
                sourceText={proposedDiffLines.join("\n")}
                baseFilePath={filePath}
                renderMode={renderMode}
                truncated={proposedDiffTruncated}
                hiddenLineCount={Math.max(
                  0,
                  proposedDiffLines.length - MAX_VISIBLE_LINES,
                )}
                sourceView={
                  inputWithAugment?._diffHtml ? (
                    <HighlightedDiff
                      diffHtml={inputWithAugment._diffHtml}
                      truncateLines={
                        proposedDiffTruncated ? MAX_VISIBLE_LINES : undefined
                      }
                    />
                  ) : (
                    <DiffLines lines={proposedDiffLines} />
                  )
                }
              />
            </DiffTapTarget>
          )}
        </div>
        {showModal && hasProposedDiff && inputWithAugment && (
          <EditDetailModal
            filePath={filePath}
            displayText={fileName}
            lineRange={fileLineRange}
            label={fileName}
            onClose={handleClose}
          >
            <DiffModalContent
              diffHtml={inputWithAugment._diffHtml}
              structuredPatch={inputWithAugment._structuredPatch ?? []}
              filePath={filePath}
              oldString={inputWithAugment.old_string ?? ""}
              newString={inputWithAugment.new_string ?? ""}
              selection={modalSelection}
            />
          </EditDetailModal>
        )}
      </>
    );
  }

  // An acknowledgement has no replacement body. Preserve its text instead of
  // inventing an empty before/after diff (also useful without the original input).
  if (
    result.content &&
    !result.structuredPatch?.length &&
    result.oldString === undefined &&
    result.newString === undefined &&
    input?.old_string === undefined &&
    input?.new_string === undefined
  ) {
    return <div className="edit-result">{result.content}</div>;
  }

  // Handle case where result doesn't have structuredPatch
  // Use input data as fallback when result data is missing
  if (!result?.structuredPatch || result.structuredPatch.length === 0) {
    const filePath = getEditFilePath(input, result);
    const oldString = result?.oldString || input?.old_string || "";
    const newString = result?.newString || input?.new_string || "";
    const isPlan = filePath ? isPlanFile(filePath) : false;

    return (
      <div className="edit-result">
        <div className="edit-header">
          <span className="file-path">
            {filePath ? getFileName(filePath) : "File"}
          </span>
          {isPlan && <Badge>Plan</Badge>}
          {result?.userModified && <Badge tone="info">User modified</Badge>}
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Edit" errors={validationErrors} />
          )}
        </div>
        <div className="edit-simple">
          <div className="edit-old">
            <div className="edit-label">Removed:</div>
            <pre className="code-block">
              <code>{oldString || "(empty)"}</code>
            </pre>
          </div>
          <div className="edit-new">
            <div className="edit-label">Added:</div>
            <pre className="code-block">
              <code>{newString || "(empty)"}</code>
            </pre>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="edit-result">
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Edit" errors={validationErrors} />
        )}
        {changeSummary && (
          <div className="edit-change-summary">{changeSummary}</div>
        )}
        {result.userModified && <Badge tone="info">User modified</Badge>}
        <DiffTapTarget label="Show full diff" onOpen={handleOpen}>
          <DiffMathView
            sourceText={result.structuredPatch
              .flatMap((hunk) => hunk.lines)
              .join("\n")}
            baseFilePath={result.filePath}
            renderMode={getEditRenderMode(extractEditFilePaths(input, result))}
            truncated={isTruncated}
            hiddenLineCount={Math.max(0, totalLines - MAX_VISIBLE_LINES)}
            sourceView={result.structuredPatch.map((hunk, i) => (
              <DiffHunk key={`hunk-${hunk.oldStart}-${i}`} hunk={hunk} />
            ))}
          />
        </DiffTapTarget>
      </div>
      {showModal && (
        <EditDetailModal
          filePath={result.filePath ?? ""}
          displayText={getFileName(result.filePath)}
          lineRange={getPatchFileLineRange(result.structuredPatch)}
          label={getFileName(result.filePath)}
          onClose={handleClose}
        >
          <DiffModalContent
            structuredPatch={result.structuredPatch}
            filePath={result.filePath ?? ""}
            oldString={result.oldString ?? input?.old_string ?? ""}
            newString={result.newString ?? input?.new_string ?? ""}
            originalFile={result.originalFile}
            selection={modalSelection}
          />
        </EditDetailModal>
      )}
    </>
  );
}

export const editRenderer = defineTool(toolDisplayContracts.Edit, {
  tool: "Edit",
  displayName: "Edit",

  // Codex's success text lists `kind: path` per file, which the header and
  // its tooltip already name.
  omitPartialResult(text) {
    return text.startsWith("File changes applied:\n");
  },

  renderToolUse(input) {
    return <EditToolUse input={input} />;
  },

  renderToolResult(result, isError, _context, input) {
    return <EditToolResult result={result} input={input} isError={isError} />;
  },

  getUseSummary(input) {
    return getPatchTargetSummary(input);
  },

  getResultSummary(result, isError, input) {
    if (isError) {
      const errorMessage = result?.content;
      if (errorMessage) {
        const classification = classifyToolError(errorMessage);
        return classification.label;
      }
      return "Error";
    }
    const r = result;
    return getPatchTargetSummary(input, r);
  },

  renderCollapsedPreview(input, result, isError) {
    return (
      <EditCollapsedPreview input={input} result={result} isError={isError} />
    );
  },

  renderInteractiveSummary(input, result, isError, _context) {
    return (
      <EditInteractiveSummary input={input} result={result} isError={isError} />
    );
  },
});
