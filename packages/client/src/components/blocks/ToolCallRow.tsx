import { toolRowStatusClasses } from "./toolRowStatusClasses";
import {
  getBashResultOutputForRichPreview,
  getHiddenCommandCount,
  isRecord,
} from "./toolRowPreviewMetrics";
import {
  clamp,
  estimatePreviewCharsPerLine,
  estimateWrappedLineCount,
  estimateDeferredPreviewHeightPx,
  useDeferredPreviewTypographyMetrics,
  isBashLikeToolName,
  canDeferRichToolRow,
} from "./toolRowPreviewMetrics";
import timelineStyles from "../TranscriptTimeline.module.css";
import toolLabelStyles from "../ToolLabel.module.css";
import codeStyles from "../renderers/CodeOutput.module.css";
import type { PreparedToolDisplay } from "../renderers/tools/defineTool";
import { RawToolDisplay, ToolDisplayBoundary } from "./ToolDisplayBoundary";
import { useI18n } from "../../i18n";
import {
  type CSSProperties,
  type MouseEvent,
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRememberedDisclosureState } from "../../contexts/RememberedDisclosureStateContext";
import { useOptionalSessionMetadata } from "../../contexts/SessionMetadataContext";
import { useOutputToolPreviewLineCount } from "../../hooks/useOutputAppearance";
import { useStableToolPreviewRendering } from "../../hooks/useStableToolPreviewRendering";
import {
  getTextTooltipAttributes,
  setElementTextTooltip,
  useTooltipMode,
} from "../../hooks/useTooltipAppearance";
import { useQuoteableTextSource } from "../../hooks/useQuoteableTextSource";
import { useSchemaValidationContext } from "../../contexts/SchemaValidationContext";
import { getDisplayBashCommandFromInput } from "../../lib/bashCommand";
import { readProjectPathLinkTargets } from "@yep-anywhere/shared/transcript/projectPathLinks";
import { PREDICTIVE_SCROLL_ROOT_MARGIN } from "../../lib/predictiveScroll";
import {
  formatCommandDuration,
  getCommandResultMeta,
  parseShellToolOutput,
} from "@yep-anywhere/shared/transcript/shellToolOutput";
import {
  getVisibilityAwareTooltipText,
  isElementFullyScrollVisible,
} from "../../lib/tooltipVisibility";
import { useToolOutputPreview } from "../../lib/toolOutputPreviews";
import { validateToolResult } from "../../lib/validateToolResult";
import type {
  ToolCallItem,
  ToolResultData,
} from "@yep-anywhere/shared/transcript/items";
import { observeViewportActivityAnimation } from "../../lib/viewportActivityAnimation";
import { ProjectPathLinkedText } from "../ProjectPathLinkedText";
import {
  getToolResultImageSourcePath,
  ToolResultMediaRows,
} from "./ToolResultMediaRows";
import { toolRegistry } from "../renderers/tools";
import { getOutputTailTooltip } from "../renderers/tools/outputPreview";
import { shellPollOutcome } from "../renderers/tools/shellPollOutcome";
import type { RenderContext } from "../renderers/types";
import { getToolSummary } from "../tools/summaries";
import { ButtonBase } from "../ui/Button";
import { ToolHeaderCopyButton } from "./ToolHeaderCopyButton";
import { HiddenContentBadge } from "../ui/HiddenContentBadge";
import { Spinner } from "../ui/Spinner";
import type { WorkflowAnnotation } from "@yep-anywhere/shared/transcript/workflowTags";
import { WorkflowOutput } from "../WorkflowOutput";
import { ToolCommentaryBoundary } from "../ToolCommentaryBoundary";
import { TimelineDisclosure } from "../TimelineDisclosure";
import styles from "./ToolCallRow.module.css";
import type { McpAppToolCall } from "@yep-anywhere/shared";
import { McpAppToolCard } from "../McpAppToolCard";
interface Props {
  id: string;
  toolName: string;
  toolInput: unknown;
  toolResult?: ToolResultData;
  workflow?: WorkflowAnnotation;
  status: ToolCallItem["status"];
  sessionProvider?: string;
  /** Tool-call start (first source-message time) — a command's start. */
  startTimestampMs?: number | null;
  /** Result arrival time; null while pending or when no result message. */
  resultTimestampMs?: number | null;
  /** The MCP App view the called tool declared. */
  mcpApp?: McpAppToolCall;
}

type DeferredPreviewStyle = CSSProperties & {
  "--tool-row-deferred-preview-height"?: string;
};

interface CommandPreview {
  text: string;
  hiddenCount: number | null;
}

interface NoOutputBashResult {
  exitCode?: number;
}

const COMMAND_PREVIEW_MAX_CHARS_PER_LINE = 220;

interface CommandElapsed {
  seconds: number;
  kind: "running" | "reported" | "approximate";
}

interface CommandElapsedParams {
  toolInput: unknown;
  structuredResult: unknown;
  status: ToolCallItem["status"];
  startTimestampMs?: number | null;
  resultTimestampMs?: number | null;
  nowMs: number;
}

/**
 * The command's elapsed time: provider-reported runtime when present, the
 * request→result message-time delta as an approximate fallback, or the
 * still-growing elapsed for pending / backgrounded-running commands.
 * Contract: topics/provider-output-contract.md § Command execution metadata.
 */
function computeCommandElapsed(
  params: CommandElapsedParams,
): CommandElapsed | null {
  const {
    toolInput,
    structuredResult,
    status,
    startTimestampMs,
    resultTimestampMs,
    nowMs,
  } = params;
  const backgroundStatus =
    toolInput && typeof toolInput === "object"
      ? (toolInput as Record<string, unknown>)._backgroundTaskStatus
      : undefined;

  if (status === "pending" || backgroundStatus === "running") {
    return typeof startTimestampMs === "number"
      ? { seconds: (nowMs - startTimestampMs) / 1000, kind: "running" }
      : null;
  }

  const meta = getCommandResultMeta(structuredResult);
  if (meta.durationSeconds !== undefined) {
    return { seconds: meta.durationSeconds, kind: "reported" };
  }
  // A backgrounded command's result message is just the launch ack, so its
  // delta is not the command's runtime.
  if (backgroundStatus !== undefined) {
    return null;
  }
  if (
    typeof startTimestampMs === "number" &&
    typeof resultTimestampMs === "number" &&
    resultTimestampMs >= startTimestampMs
  ) {
    return {
      seconds: (resultTimestampMs - startTimestampMs) / 1000,
      kind: "approximate",
    };
  }
  return null;
}

/** Tooltip for the Ran/Running label. Computed on hover so a running
 * command's elapsed time is fresh without re-rendering the row. */
function computeCommandElapsedTitle(
  params: CommandElapsedParams,
): string | null {
  const elapsed = computeCommandElapsed(params);
  if (!elapsed) {
    return null;
  }
  const duration = formatCommandDuration(elapsed.seconds);
  switch (elapsed.kind) {
    case "running":
      return `running for ${duration}`;
    case "reported":
      return `took ${duration}`;
    case "approximate":
      return `took ~${duration}`;
  }
}

function getCommandPreview(
  command: string,
  visibleLineCount: number,
): CommandPreview {
  const maxLines = clamp(Math.round(visibleLineCount), 1, 8);
  const lines = command.replace(/\r\n/g, "\n").split("\n");
  const visibleLines = lines.slice(0, maxLines);
  let hiddenChars = 0;
  const text = visibleLines
    .map((line) => {
      if (line.length <= COMMAND_PREVIEW_MAX_CHARS_PER_LINE) {
        return line;
      }
      hiddenChars += line.length - COMMAND_PREVIEW_MAX_CHARS_PER_LINE;
      return `${line.slice(0, COMMAND_PREVIEW_MAX_CHARS_PER_LINE)}...`;
    })
    .join("\n");
  const hiddenLines = Math.max(0, lines.length - visibleLines.length);

  return {
    text,
    hiddenCount: getHiddenCommandCount({ hiddenChars, hiddenLines }),
  };
}

function findNearestScrollContainer(element: HTMLElement): HTMLElement | null {
  let scrollEl = element.parentElement;
  while (scrollEl) {
    const { overflowY } = window.getComputedStyle(scrollEl);
    if (overflowY === "auto" || overflowY === "scroll") {
      return scrollEl;
    }
    scrollEl = scrollEl.parentElement;
  }
  return null;
}

function scrollExpandedToolTopIntoView(row: HTMLElement | null) {
  if (!row) {
    return;
  }

  const scrollEl = findNearestScrollContainer(row);
  if (!scrollEl) {
    return;
  }

  const scrollRect = scrollEl.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const nextTop = Math.max(
    0,
    scrollEl.scrollTop + rowRect.top - scrollRect.top - 12,
  );
  scrollEl.scrollTop = nextTop;
  scrollEl.dispatchEvent(new Event("scroll"));
}

function queueExpandedToolTopFocus(rowRef: RefObject<HTMLDivElement | null>) {
  const focusTop = () => scrollExpandedToolTopIntoView(rowRef.current);
  focusTop();
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(focusTop);
  }
  window.setTimeout(focusTop, 80);
}

function useNearViewportHydration(
  status: ToolCallItem["status"],
  deferRichContent: boolean,
): {
  rowRef: RefObject<HTMLDivElement | null>;
  shouldHydrate: boolean;
  hydrateNow: () => void;
  rowWidthPx: number | null;
} {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [rowWidthPx, setRowWidthPx] = useState<number | null>(null);
  const [shouldHydrate, setShouldHydrate] = useState(
    () =>
      !canDeferRichToolRow(status, deferRichContent) ||
      typeof window === "undefined" ||
      typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    if (!canDeferRichToolRow(status, deferRichContent)) {
      setShouldHydrate(true);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setShouldHydrate(true);
      return;
    }
    setShouldHydrate(false);
  }, [status, deferRichContent]);

  useLayoutEffect(() => {
    if (shouldHydrate || !canDeferRichToolRow(status, deferRichContent)) {
      return;
    }
    const node = rowRef.current;
    if (!node) {
      return;
    }
    const width = Math.round(node.getBoundingClientRect().width);
    if (width > 0) {
      setRowWidthPx((current) => (current === width ? current : width));
    }
  }, [shouldHydrate, status, deferRichContent]);

  useEffect(() => {
    if (shouldHydrate || !canDeferRichToolRow(status, deferRichContent)) {
      return;
    }

    const node = rowRef.current;
    if (!node) {
      setShouldHydrate(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldHydrate(true);
          observer.disconnect();
        }
      },
      { root: null, rootMargin: PREDICTIVE_SCROLL_ROOT_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [shouldHydrate, status, deferRichContent]);

  return {
    rowRef,
    shouldHydrate,
    hydrateNow: () => setShouldHydrate(true),
    rowWidthPx,
  };
}

export const ToolCallRow = memo(function ToolCallRow(rowProps: Props) {
  const props = useLiveOutputPreview(rowProps);
  const originalOutput =
    props.toolResult?.structured ?? props.toolResult?.content;
  return (
    <ToolDisplayBoundary {...props} toolResult={originalOutput}>
      <ToolCommentaryBoundary {...props}>
        {(toolInput, toolResult, workflow) => (
          <PreparedToolCallRow
            {...props}
            toolInput={toolInput}
            toolResult={toolResult}
            workflow={workflow}
            originalOutput={originalOutput}
          />
        )}
      </ToolCommentaryBoundary>
    </ToolDisplayBoundary>
  );
});

/**
 * A pending shell call shows its live output through the same
 * `_previewResult` input field providers that stream partial results set
 * themselves: a Claude call's from the preview store, a Codex call's from the
 * streaming result it holds while it runs.
 */
function useLiveOutputPreview(props: Props): Props {
  const pendingShell =
    props.status === "pending" &&
    isBashLikeToolName(props.toolName) &&
    isRecord(props.toolInput);
  const storedPreview = useToolOutputPreview(
    pendingShell ? props.id : undefined,
  );
  const preview =
    storedPreview ??
    (pendingShell && typeof props.toolResult?.content === "string"
      ? props.toolResult.content
      : undefined);
  return useMemo(
    () =>
      preview === undefined || !isRecord(props.toolInput)
        ? props
        : {
            ...props,
            toolInput: {
              ...props.toolInput,
              _previewResult: {
                stdout: preview,
                stderr: "",
                interrupted: false,
                isImage: false,
              },
            },
          },
    [props, preview],
  );
}

function PreparedToolCallRow(props: Props & { originalOutput?: unknown }) {
  const { t } = useI18n();
  const output = props.toolResult?.structured ?? props.toolResult?.content;
  const prepared = useMemo(
    () =>
      toolRegistry.prepare(props.toolName, {
        input: props.toolInput,
        result: output,
        status: props.status,
        isError: props.toolResult?.isError,
      }),
    [
      props.toolName,
      props.toolInput,
      output,
      props.status,
      props.toolResult?.isError,
    ],
  );
  const metadata = toolRegistry.metadata(props.toolName);
  const { enabled, reportValidationError } = useSchemaValidationContext();
  useEffect(() => {
    if (prepared.kind !== "raw" || !enabled || !props.toolResult?.structured)
      return;
    const validation = validateToolResult(
      metadata.tool,
      props.toolResult.structured,
    );
    if (!validation.valid && validation.errors)
      reportValidationError(metadata.tool, validation.errors);
  }, [
    prepared.kind,
    enabled,
    props.toolResult?.structured,
    metadata.tool,
    reportValidationError,
  ]);
  // Stored media has its own validated server contract and presentation.
  // Eligibility for an unrelated text preview must not hide those assets.
  if (props.toolResult?.media?.length) {
    return (
      <ToolResultMediaRows
        displayName={prepared.getDisplayName()}
        media={props.toolResult.media}
        sourcePath={getToolResultImageSourcePath(
          props.toolName,
          props.toolInput,
          props.toolResult.media.length,
        )}
        status={props.status}
      />
    );
  }
  if (prepared.kind === "raw" && metadata.registered)
    return <RawToolDisplay {...props} toolResult={output} />;
  const waitingTarget = getWaitingTarget(metadata.tool, props, output);
  if (waitingTarget) {
    return (
      <div
        className={`${styles.toolRow} ${timelineStyles.timelineItem} ${styles.waitingRow}`}
        data-tool-row
        data-timeline-item
      >
        <div
          className={`${styles.toolRowHeader} ${styles.waitingHeader}`}
          data-tool-row-header
        >
          <span className={toolLabelStyles.toolName} data-tool-name>
            {t("toolShellPollWaitingLabel")}
          </span>
          <span className={styles.waitingSummary}>
            {t("toolShellPollWaitingSummary", { target: waitingTarget })}
          </span>
        </div>
      </div>
    );
  }
  return <ToolCallRowContent {...props} prepared={prepared} />;
}

/**
 * The wait target when this call's result is the one informational wait
 * outcome. Which calls can hold a poll is this row's question; what the
 * result means belongs to the shell renderer's `shellPollOutcome`.
 */
function getWaitingTarget(
  tool: string,
  props: Props,
  result: unknown,
): string | undefined {
  if (
    (tool !== "Bash" && tool !== "WriteStdin") ||
    (props.status !== "complete" && props.status !== "error") ||
    props.workflow ||
    (isRecord(props.toolInput) &&
      (props.toolInput.chars || props.toolInput.linked_file_path))
  )
    return undefined;
  const outcome = shellPollOutcome(
    result,
    props.status === "error",
    props.toolResult?.content,
  );
  return outcome?.kind === "waiting" ? outcome.target : undefined;
}

const ToolCallRowContent = memo(function ToolCallRowContent({
  id,
  toolName,
  toolInput,
  toolResult,
  workflow,
  status,
  sessionProvider,
  startTimestampMs,
  resultTimestampMs,
  originalOutput,
  prepared,
  mcpApp,
}: Props & { originalOutput?: unknown; prepared: PreparedToolDisplay }) {
  const [summaryExpanded, setSummaryExpanded] = useRememberedDisclosureState(
    id,
    "interactive-summary",
    false,
  );
  const [bashCommandExpanded, setBashCommandExpanded] =
    useRememberedDisclosureState(id, "bash-command", false);
  const { enabled: schemaValidationEnabled, reportValidationError } =
    useSchemaValidationContext();
  const sessionMetadata = useOptionalSessionMetadata();
  const outputToolPreviewLineCount = useOutputToolPreviewLineCount();
  const deferredPreviewTypography = useDeferredPreviewTypographyMetrics();
  const tooltipMode = useTooltipMode();
  const toggleSummaryExpanded = useCallback(() => {
    setSummaryExpanded((current) => !current);
  }, [setSummaryExpanded]);

  // Create a minimal render context for tool renderers
  const renderContext: RenderContext = useMemo(
    () => ({
      isStreaming: status === "pending",
      theme: "dark",
      toolUseId: id,
      provider: sessionProvider,
      projectPath: sessionMetadata?.projectPath ?? null,
      projectPathLinks: toolResult?.projectPathLinks,
    }),
    [
      status,
      id,
      sessionProvider,
      sessionMetadata?.projectPath,
      toolResult?.projectPathLinks,
    ],
  );
  const interactiveSummaryContext: RenderContext = useMemo(
    () => ({
      ...renderContext,
      summaryExpanded,
      toggleSummaryExpanded,
    }),
    [renderContext, summaryExpanded, toggleSummaryExpanded],
  );

  // Get structured result for interactive summary
  const structuredResult = toolResult?.structured ?? toolResult?.content;
  const { stableToolPreviewRendering } = useStableToolPreviewRendering();
  const {
    rowRef,
    shouldHydrate: shouldHydrateRichContent,
    hydrateNow,
    rowWidthPx,
  } = useNearViewportHydration(status, !stableToolPreviewRendering);
  useEffect(() => {
    if (status !== "pending" || !rowRef.current) return;
    return observeViewportActivityAnimation(rowRef.current);
  }, [rowRef, status]);

  // Check if this tool renders inline (bypasses entire tool-row structure)
  const hasInlineRenderer = toolRegistry.hasInlineRenderer(toolName);
  const noOutputBashResult = getNoOutputBashResult(
    toolName,
    structuredResult,
    toolResult?.content,
    status,
  );
  const suppressCollapsedPreview = shouldSuppressBashCollapsedPreview(
    toolName,
    toolInput,
    structuredResult,
    status,
    noOutputBashResult !== null,
  );
  const rendererToolName = toolRegistry.metadata(toolName).tool;
  useEffect(() => {
    if (
      !schemaValidationEnabled ||
      shouldHydrateRichContent ||
      !structuredResult ||
      (rendererToolName === "Bash" && typeof structuredResult !== "object")
    ) {
      return;
    }
    const validation = validateToolResult(rendererToolName, structuredResult);
    if (!validation.valid && validation.errors) {
      reportValidationError(rendererToolName, validation.errors);
    }
  }, [
    rendererToolName,
    reportValidationError,
    schemaValidationEnabled,
    shouldHydrateRichContent,
    structuredResult,
  ]);
  const mayHaveCollapsedPreview =
    (prepared.kind === "partial" ||
      toolRegistry.hasCollapsedPreview(toolName)) &&
    !suppressCollapsedPreview;
  const isEditTool = rendererToolName === "Edit";
  const isReadTool = rendererToolName === "Read";
  const isBashTool = rendererToolName === "Bash";
  const bashExitCode = isBashTool
    ? getBashExitCode(structuredResult, toolResult?.content, status === "error")
    : undefined;
  const showBashExitCode = bashExitCode !== undefined && bashExitCode !== 0;
  const isGrepTool = rendererToolName === "Grep";
  const handleToolNamePointerEnter = useCallback(
    (event: React.PointerEvent<HTMLSpanElement>) => {
      if (!isBashTool) {
        return;
      }
      setElementTextTooltip(
        event.currentTarget,
        computeCommandElapsedTitle({
          toolInput,
          structuredResult,
          status,
          startTimestampMs,
          resultTimestampMs,
          nowMs: Date.now(),
        }),
        tooltipMode,
      );
    },
    [
      isBashTool,
      toolInput,
      structuredResult,
      status,
      startTimestampMs,
      resultTimestampMs,
      tooltipMode,
    ],
  );
  const canRenderInteractiveSummary =
    status === "complete" ||
    (status === "error" && rendererToolName === "WriteStdin") ||
    (status === "pending" && isEditTool);
  const mayHaveInteractiveSummary =
    canRenderInteractiveSummary && toolRegistry.hasInteractiveSummary(toolName);
  const deferredPreviewHeightPx = useMemo(
    () =>
      estimateDeferredPreviewHeightPx({
        toolName,
        toolInput,
        result: structuredResult,
        status,
        rowWidthPx,
        typography: deferredPreviewTypography,
        previewLineCount: outputToolPreviewLineCount,
      }),
    [
      toolName,
      toolInput,
      structuredResult,
      status,
      rowWidthPx,
      deferredPreviewTypography,
      outputToolPreviewLineCount,
    ],
  );

  const interactiveSummaryContent = useMemo(() => {
    if (
      !canRenderInteractiveSummary ||
      !toolRegistry.hasInteractiveSummary(toolName) ||
      !shouldHydrateRichContent
    ) {
      return null;
    }
    return prepared.renderInteractiveSummary(interactiveSummaryContext);
  }, [
    toolName,
    interactiveSummaryContext,
    prepared,
    shouldHydrateRichContent,
    canRenderInteractiveSummary,
  ]);

  const hasInteractiveSummary =
    interactiveSummaryContent !== null &&
    interactiveSummaryContent !== undefined &&
    interactiveSummaryContent !== false;

  const collapsedPreviewContent = useMemo(() => {
    if (
      suppressCollapsedPreview ||
      (prepared.kind !== "partial" &&
        !toolRegistry.hasCollapsedPreview(toolName) &&
        !workflow?.view) ||
      !shouldHydrateRichContent
    ) {
      return null;
    }
    if (
      workflow?.view &&
      toolResult &&
      (workflow.markers.length > 0 || workflow.view === "matching-lines")
    ) {
      return (
        <WorkflowOutput
          text={workflow.outputText ?? toolResult.content}
          workflow={workflow}
          original={
            <pre>
              {typeof originalOutput === "string"
                ? originalOutput
                : JSON.stringify(originalOutput, null, 2)}
            </pre>
          }
        />
      );
    }
    return prepared.renderCollapsedPreview(renderContext);
  }, [
    toolName,
    suppressCollapsedPreview,
    workflow,
    originalOutput,
    toolResult,
    renderContext,
    prepared,
    shouldHydrateRichContent,
  ]);

  const hasCollapsedPreview =
    collapsedPreviewContent !== null &&
    collapsedPreviewContent !== undefined &&
    collapsedPreviewContent !== false;
  const hasBashPreviewToggle = isBashTool && hasCollapsedPreview;
  const hasEditPreviewToggle =
    isEditTool && hasCollapsedPreview && toolResult !== undefined;
  const hasPreviewToggle = hasBashPreviewToggle || hasEditPreviewToggle;
  const hasDeferredPreviewShell =
    !shouldHydrateRichContent &&
    mayHaveCollapsedPreview &&
    deferredPreviewHeightPx !== null;
  const hasDeferredInteractiveShell =
    !shouldHydrateRichContent &&
    (mayHaveCollapsedPreview || mayHaveInteractiveSummary);
  const [previewExpanded, setPreviewExpanded] = useRememberedDisclosureState(
    id,
    "rich-preview",
    true,
  );
  // Tools with collapsed preview or interactive summary don't expand
  const isNonExpandable =
    hasInteractiveSummary || hasCollapsedPreview || hasDeferredInteractiveShell;

  // A shell poll whose whole output fits the output-preview-lines budget
  // reads inline without a click; the row stays collapsible. The budget
  // counts wrapped visual lines, not newlines: a single mega-line (a JSON
  // blob, a progress-bar dump) would otherwise pass a newline count and
  // flood the timeline.
  const isShellSessionTool = rendererToolName === "WriteStdin";
  const shellOutputFitsPreview = useMemo(() => {
    if (!isShellSessionTool || status !== "complete" || toolResult?.isError) {
      return false;
    }
    const output = parseShellToolOutput(
      typeof toolResult?.content === "string" ? toolResult.content : "",
    ).output.trim();
    if (output.length === 0) {
      return false;
    }
    const charsPerLine = estimatePreviewCharsPerLine(
      rowWidthPx,
      deferredPreviewTypography,
    );
    return (
      estimateWrappedLineCount(output, charsPerLine) <=
      outputToolPreviewLineCount
    );
  }, [
    isShellSessionTool,
    status,
    toolResult,
    outputToolPreviewLineCount,
    rowWidthPx,
    deferredPreviewTypography,
  ]);

  // Edit and TodoWrite tools are expanded by default
  const defaultExpanded =
    !isNonExpandable &&
    (toolName === "Edit" || toolName === "TodoWrite" || shellOutputFitsPreview);
  const [expanded, setExpanded, expandedInitiallyOverridden] =
    useRememberedDisclosureState(id, "tool-result", defaultExpanded);
  // A live poll completes after mount; expand it then, unless the user
  // has toggled the row themselves.
  const userToggledExpandRef = useRef(expandedInitiallyOverridden);
  useEffect(() => {
    if (shellOutputFitsPreview && !userToggledExpandRef.current) {
      setExpanded(true);
    }
  }, [setExpanded, shellOutputFitsPreview]);

  // Dot-expanded: inline full result for preview-first rows (starts collapsed).
  const [dotExpanded, setDotExpanded] = useRememberedDisclosureState(
    id,
    "inline-tool-result",
    false,
  );
  const shouldFocusExpandedTopRef = useRef(false);
  const canInlineExpandToolResult =
    isNonExpandable &&
    hasInteractiveSummary &&
    shouldHydrateRichContent &&
    isReadTool;
  const hasSummaryDotToggle = isGrepTool && mayHaveInteractiveSummary;

  // Dot button: expandable rows + preview-first rows with an inline result.
  const showDotBtn =
    !isNonExpandable ||
    canInlineExpandToolResult ||
    hasPreviewToggle ||
    hasSummaryDotToggle;

  // Header toggles dotExpanded for preview-first inline result rows.
  const hasHeaderDotToggle = canInlineExpandToolResult;
  const hasPreviewHeaderToggle = hasPreviewToggle && shouldHydrateRichContent;

  const handleDotClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    hydrateNow();
    if (hasPreviewToggle) {
      setPreviewExpanded((v) => {
        if (!v) {
          shouldFocusExpandedTopRef.current = true;
        }
        return !v;
      });
    } else if (hasSummaryDotToggle) {
      setSummaryExpanded((current) => !current);
    } else if (!isNonExpandable) {
      userToggledExpandRef.current = true;
      setExpanded((v) => {
        if (!v) {
          shouldFocusExpandedTopRef.current = true;
        }
        return !v;
      });
    } else if (canInlineExpandToolResult) {
      setDotExpanded((v) => {
        if (!v) {
          shouldFocusExpandedTopRef.current = true;
        }
        return !v;
      });
    }
  };

  const summary = useMemo(() => {
    return getToolSummary(
      toolName,
      toolInput,
      toolResult,
      status,
      {
        projectPath: sessionMetadata?.projectPath ?? null,
      },
      prepared,
    );
  }, [
    toolName,
    toolInput,
    toolResult,
    status,
    sessionMetadata?.projectPath,
    prepared,
  ]);
  const headerCommand = isBashTool
    ? getDisplayBashCommandFromInput(toolInput)
    : "";
  const commandProjectPathLinks = readProjectPathLinkTargets(
    isRecord(toolInput) ? toolInput._projectPathLinks : undefined,
  );
  const hasBashDescription =
    isBashTool &&
    isRecord(toolInput) &&
    typeof toolInput.description === "string" &&
    toolInput.description.trim().length > 0;
  const showBashCommandTarget =
    isBashTool && !hasBashDescription && headerCommand.length > 0;
  const bashCommandPreview = useMemo(
    () => getCommandPreview(headerCommand, outputToolPreviewLineCount),
    [headerCommand, outputToolPreviewLineCount],
  );
  const commandHasHiddenPreviewContent =
    !bashCommandExpanded &&
    bashCommandPreview.hiddenCount !== null &&
    bashCommandPreview.hiddenCount > 0;
  const bashCommandQuoteRef = useQuoteableTextSource<HTMLSpanElement>(
    showBashCommandTarget
      ? !noOutputBashResult && bashCommandExpanded
        ? headerCommand
        : bashCommandPreview.text
      : "",
  );

  const previousHeaderCommandRef = useRef(headerCommand);
  useEffect(() => {
    if (previousHeaderCommandRef.current === headerCommand) return;
    previousHeaderCommandRef.current = headerCommand;
    setBashCommandExpanded(false);
  }, [headerCommand, setBashCommandExpanded]);

  // The command tooltip leads with the elapsed (so-far) time — "[12.5s] cmd"
  // — refreshed on hover so a running command's elapsed stays current.
  const handleCommandTitlePointerEnter = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const commandText =
        event.currentTarget.querySelector<HTMLElement>(
          "[data-tool-summary-command-text]",
        ) ?? event.currentTarget;
      const shouldShowTooltip =
        commandHasHiddenPreviewContent ||
        !isElementFullyScrollVisible(commandText);
      if (!headerCommand || !shouldShowTooltip) {
        setElementTextTooltip(event.currentTarget, null, tooltipMode);
        return;
      }
      const elapsed = computeCommandElapsed({
        toolInput,
        structuredResult,
        status,
        startTimestampMs,
        resultTimestampMs,
        nowMs: Date.now(),
      });
      setElementTextTooltip(
        event.currentTarget,
        elapsed
          ? `[${formatCommandDuration(elapsed.seconds)}] ${headerCommand}`
          : headerCommand,
        tooltipMode,
      );
    },
    [
      headerCommand,
      toolInput,
      structuredResult,
      status,
      startTimestampMs,
      resultTimestampMs,
      commandHasHiddenPreviewContent,
      tooltipMode,
    ],
  );

  // A described command shows the description in the header, so the command
  // itself is only reachable by hover: always offer it (with elapsed), rather
  // than only when the visible text overflows.
  const handleDescribedCommandPointerEnter = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!headerCommand) {
        setElementTextTooltip(event.currentTarget, null, tooltipMode);
        return;
      }
      const elapsed = computeCommandElapsed({
        toolInput,
        structuredResult,
        status,
        startTimestampMs,
        resultTimestampMs,
        nowMs: Date.now(),
      });
      setElementTextTooltip(
        event.currentTarget,
        elapsed
          ? `[${formatCommandDuration(elapsed.seconds)}] ${headerCommand}`
          : headerCommand,
        tooltipMode,
      );
    },
    [
      headerCommand,
      toolInput,
      structuredResult,
      status,
      startTimestampMs,
      resultTimestampMs,
      tooltipMode,
    ],
  );

  // The visible preview is the first N output lines; hovering it shows the
  // tail in the tooltip — "[Ns] ..." followed by the last N lines.
  const handleOutputPreviewPointerEnter = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isBashTool) {
        return;
      }
      const output = getBashResultOutputForRichPreview(
        structuredResult,
        status === "error",
      ).trimEnd();
      const elapsed = computeCommandElapsed({
        toolInput,
        structuredResult,
        status,
        startTimestampMs,
        resultTimestampMs,
        nowMs: Date.now(),
      });
      const elapsedPrefix = elapsed
        ? `[${formatCommandDuration(elapsed.seconds)}] `
        : "";
      const tooltip = getOutputTailTooltip(
        output,
        outputToolPreviewLineCount,
        elapsedPrefix,
      );
      const outputSurface = event.currentTarget.querySelector<HTMLElement>(
        "[data-bash-preview-output]",
      );
      const visibilityTarget =
        outputSurface?.querySelector<HTMLElement>(
          "pre, [data-fixed-font-rendered__content]",
        ) ??
        outputSurface ??
        event.currentTarget;
      setElementTextTooltip(
        event.currentTarget,
        getVisibilityAwareTooltipText(
          visibilityTarget,
          `${elapsedPrefix}${output}`,
          tooltip,
        ),
        tooltipMode,
      );
    },
    [
      isBashTool,
      structuredResult,
      outputToolPreviewLineCount,
      toolInput,
      status,
      startTimestampMs,
      resultTimestampMs,
      tooltipMode,
    ],
  );

  const handleToggle = () => {
    hydrateNow();
    if (!isNonExpandable) {
      userToggledExpandRef.current = true;
      setExpanded((v) => {
        if (!v) {
          shouldFocusExpandedTopRef.current = true;
        }
        return !v;
      });
    }
  };
  const handlePreviewToggle = () => {
    setPreviewExpanded((v) => {
      if (!v) {
        shouldFocusExpandedTopRef.current = true;
      }
      return !v;
    });
  };
  const dotAriaLabel = !isNonExpandable
    ? expanded
      ? "Collapse"
      : "Expand"
    : hasPreviewToggle
      ? previewExpanded
        ? "Collapse preview"
        : "Expand preview"
      : hasSummaryDotToggle
        ? summaryExpanded
          ? "Collapse summary"
          : "Expand summary"
        : dotExpanded
          ? "Collapse inline view"
          : "Expand inline view";
  const disclosureExpanded = !isNonExpandable
    ? expanded
    : hasPreviewToggle
      ? previewExpanded
      : hasSummaryDotToggle
        ? summaryExpanded
        : dotExpanded;

  useLayoutEffect(() => {
    if (
      !shouldFocusExpandedTopRef.current ||
      (!expanded && !dotExpanded && !previewExpanded)
    ) {
      return;
    }
    shouldFocusExpandedTopRef.current = false;
    queueExpandedToolTopFocus(rowRef);
  }, [previewExpanded, expanded, dotExpanded, rowRef]);

  // Inline renderers bypass the entire tool-row structure
  if (hasInlineRenderer) {
    return (
      <div
        className={timelineStyles.timelineItem}
        data-tool-inline
        data-timeline-item
      >
        {prepared.renderInline(renderContext)}
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer/focus events only hydrate deferred rich content
    <div
      ref={rowRef}
      onPointerEnter={hydrateNow}
      onFocus={hydrateNow}
      className={`${styles.toolRow} ${timelineStyles.timelineItem} ${expanded ? `${styles.expanded}` : ""} ${toolRowStatusClasses[status] ?? ""} ${isNonExpandable ? `${styles.interactive}` : ""} ${isBashTool ? styles.ranToolRow : ""}`}
      data-tool-row
      data-timeline-item
      data-expanded={expanded || undefined}
      data-interactive={isNonExpandable || undefined}
      data-ran-tool-row={isBashTool || undefined}
      data-tool-status={status}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: interactive header has role, tabIndex, and keyboard handlers when enabled */}
      <div
        className={[
          styles.toolRowHeader,
          isNonExpandable ? `${styles["non-expandable"]}` : "",
          showBashCommandTarget ? `${styles["has-command-preview"]}` : "",
          noOutputBashResult || showBashExitCode
            ? `${styles["has-result-suffix"]}`
            : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-tool-row-header
        data-non-expandable={isNonExpandable || undefined}
        data-has-command-preview={showBashCommandTarget || undefined}
        data-has-result-suffix={
          noOutputBashResult || showBashExitCode || undefined
        }
        onClick={
          hasDeferredInteractiveShell
            ? hydrateNow
            : hasPreviewHeaderToggle
              ? handlePreviewToggle
              : hasHeaderDotToggle
                ? () =>
                    setDotExpanded((v) => {
                      if (!v) {
                        shouldFocusExpandedTopRef.current = true;
                      }
                      return !v;
                    })
                : isNonExpandable
                  ? undefined
                  : handleToggle
        }
        onKeyDown={
          hasDeferredInteractiveShell
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  hydrateNow();
                }
              }
            : hasPreviewHeaderToggle
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handlePreviewToggle();
                  }
                }
              : hasHeaderDotToggle
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setDotExpanded((v) => {
                        if (!v) {
                          shouldFocusExpandedTopRef.current = true;
                        }
                        return !v;
                      });
                    }
                  }
                : isNonExpandable
                  ? undefined
                  : (e) => e.key === "Enter" && handleToggle()
        }
        role={
          hasDeferredInteractiveShell ||
          hasPreviewHeaderToggle ||
          hasHeaderDotToggle ||
          !isNonExpandable
            ? "button"
            : "presentation"
        }
        tabIndex={
          hasDeferredInteractiveShell ||
          hasPreviewHeaderToggle ||
          hasHeaderDotToggle ||
          !isNonExpandable
            ? 0
            : undefined
        }
      >
        {status === "pending" && <Spinner size="small" label="Running" />}
        {status === "aborted" && (
          <span
            className={styles.toolAbortedIcon}
            data-tool-aborted-icon
            role="img"
            aria-label="Interrupted"
          >
            ⨯
          </span>
        )}
        {status === "incomplete" && (
          <span
            className={styles.toolIncompleteIcon}
            data-tool-incomplete-icon
            role="img"
            aria-label="Result unavailable"
          >
            ?
          </span>
        )}

        <span
          className={toolLabelStyles.toolName}
          data-tool-name
          onPointerEnter={handleToolNamePointerEnter}
        >
          <span className={styles.disclosureAnchor}>
            {showDotBtn && (
              <TimelineDisclosure
                inline
                onClick={handleDotClick}
                label={dotAriaLabel}
                expanded={disclosureExpanded}
                status={status}
              />
            )}
          </span>
          {prepared.getDisplayName()}
        </span>

        {hasInteractiveSummary && canRenderInteractiveSummary ? (
          <span
            className={`${styles.toolSummary} ${styles["interactive-summary"]}${hasSummaryDotToggle ? ` ${styles["outline-summary"]}` : ""}`}
            data-tool-summary
            data-interactive-summary
            data-outline-summary={hasSummaryDotToggle || undefined}
          >
            {interactiveSummaryContent}
          </span>
        ) : showBashCommandTarget && noOutputBashResult ? (
          <span
            className={`${styles.toolSummary} ${styles.toolSummaryCommand}`}
            data-tool-summary
            data-tool-summary-command
            {...getTextTooltipAttributes(
              commandHasHiddenPreviewContent ? headerCommand : null,
              tooltipMode,
            )}
            onPointerEnter={handleCommandTitlePointerEnter}
          >
            <span
              ref={bashCommandQuoteRef}
              className={styles.toolSummaryCommandText}
              data-tool-summary-command-text
            >
              <ProjectPathLinkedText
                text={bashCommandPreview.text}
                links={commandProjectPathLinks}
              />
            </span>
          </span>
        ) : showBashCommandTarget ? (
          // A native button cannot contain the file anchors that may appear in
          // the command. This delegated target preserves both interactions.
          <span
            className={[
              styles.toolSummary,
              styles.toolSummaryCommand,
              bashCommandExpanded ? styles.expandedCommand : "",
            ]
              .filter(Boolean)
              .join(" ")}
            data-tool-summary
            data-tool-summary-command
            {...getTextTooltipAttributes(
              commandHasHiddenPreviewContent ? headerCommand : null,
              tooltipMode,
            )}
            onPointerEnter={handleCommandTitlePointerEnter}
            aria-label={
              bashCommandExpanded ? "Collapse command" : "Show full command"
            }
            aria-expanded={bashCommandExpanded}
            onClick={(event) => {
              if ((event.target as Element | null)?.closest?.("a,button")) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              setBashCommandExpanded((current) => !current);
            }}
            onKeyDown={(event) => {
              if (
                event.target === event.currentTarget &&
                (event.key === "Enter" || event.key === " ")
              ) {
                event.preventDefault();
                event.stopPropagation();
                setBashCommandExpanded((current) => !current);
              }
            }}
            role="button"
            tabIndex={0}
          >
            <span
              ref={bashCommandQuoteRef}
              className={styles.toolSummaryCommandText}
              data-tool-summary-command-text
            >
              <ProjectPathLinkedText
                text={
                  bashCommandExpanded ? headerCommand : bashCommandPreview.text
                }
                links={commandProjectPathLinks}
              />
            </span>
          </span>
        ) : (
          <span
            className={styles.toolSummary}
            data-tool-summary
            {...(hasBashDescription && headerCommand
              ? getTextTooltipAttributes(headerCommand, tooltipMode)
              : {})}
            onPointerEnter={
              hasBashDescription && headerCommand
                ? handleDescribedCommandPointerEnter
                : undefined
            }
          >
            {summary}
            {status === "aborted" && (
              <span className={styles.toolAbortedLabel} data-tool-aborted-label>
                {" "}
                (interrupted)
              </span>
            )}
            {status === "incomplete" && (
              <span
                className={styles.toolIncompleteLabel}
                data-tool-incomplete-label
              >
                {" "}
                (result unavailable)
              </span>
            )}
          </span>
        )}

        {noOutputBashResult && (
          <span className={styles.toolResultSuffix} data-tool-result-suffix>
            (no output)
          </span>
        )}
        {showBashExitCode && (
          <span
            className={`${styles.toolResultSuffix} ${styles.toolResultSuffixRc}`}
            data-tool-result-suffix
            data-tool-result-suffix-rc
          >
            rc={bashExitCode}
          </span>
        )}

        {headerCommand && (
          <ToolHeaderCopyButton text={headerCommand} label="Copy command" />
        )}

        {showBashCommandTarget &&
          !bashCommandExpanded &&
          bashCommandPreview.hiddenCount && (
            <HiddenContentBadge
              className={styles.toolSummaryCommandMore}
              data-tool-summary-command-more
              count={bashCommandPreview.hiddenCount}
              tooltip={headerCommand}
            />
          )}
      </div>

      {/* Collapsed preview - shown when tool supports it (non-expandable) */}
      {hasCollapsedPreview && previewExpanded && (
        <div
          className={styles.toolRowCollapsedPreview}
          data-tool-row-collapsed-preview
          onPointerEnter={handleOutputPreviewPointerEnter}
        >
          {hasPreviewToggle && (
            <ToolRowCollapseStrip
              onCollapse={() => setPreviewExpanded(false)}
              ariaLabel="Collapse preview from left gutter"
            />
          )}
          {collapsedPreviewContent}
        </div>
      )}
      {hasDeferredPreviewShell && (
        <div
          className={`${styles.toolRowCollapsedPreview} ${styles.toolRowDeferredPreview}`}
          data-tool-row-collapsed-preview
          data-tool-row-deferred-preview
          style={
            {
              "--tool-row-deferred-preview-height": `${deferredPreviewHeightPx}px`,
            } as DeferredPreviewStyle
          }
          aria-hidden="true"
        >
          <div
            className={styles.toolRowDeferredPreviewBox}
            data-tool-row-deferred-preview-box
          />
        </div>
      )}

      {dotExpanded && canInlineExpandToolResult && (
        <div className={styles.toolRowContent} data-tool-row-content>
          <ToolRowCollapseStrip onCollapse={() => setDotExpanded(false)} />
          <ToolResultExpanded
            prepared={prepared}
            toolResult={toolResult}
            context={renderContext}
          />
        </div>
      )}

      {expanded && !isNonExpandable && (
        <div className={styles.toolRowContent} data-tool-row-content>
          <ToolRowCollapseStrip
            onCollapse={() => {
              userToggledExpandRef.current = true;
              setExpanded(false);
            }}
          />
          {noOutputBashResult && isBashTool ? (
            <BashNoOutputExpanded command={headerCommand} />
          ) : status === "pending" ||
            status === "aborted" ||
            status === "incomplete" ? (
            <ToolUseExpanded prepared={prepared} context={renderContext} />
          ) : (
            <ToolResultExpanded
              prepared={prepared}
              toolResult={toolResult}
              context={renderContext}
            />
          )}
        </div>
      )}

      {mcpApp && (
        <McpAppToolCard
          mcpApp={mcpApp}
          callId={id}
          toolInput={toolInput}
          toolResult={toolResult}
          status={status}
        />
      )}
    </div>
  );
});

function ToolRowCollapseStrip({
  onCollapse,
  ariaLabel = "Collapse expanded tool row",
}: {
  onCollapse: () => void;
  ariaLabel?: string;
}) {
  return (
    <ButtonBase
      className={styles.toolRowCollapseStrip}
      data-tool-row-collapse-strip
      onClick={(event) => {
        event.stopPropagation();
        onCollapse();
      }}
      aria-label={ariaLabel}
      title={ariaLabel}
    />
  );
}

function shouldSuppressBashCollapsedPreview(
  toolName: string,
  input: unknown,
  result: unknown,
  status?: ToolCallItem["status"],
  hasNoOutputBashResult = false,
): boolean {
  if (!isBashLikeToolName(toolName)) {
    return false;
  }

  if (status === "pending") {
    return !hasBashPreviewResult(input);
  }

  return result === undefined || hasNoOutputBashResult;
}

function getNoOutputBashResult(
  toolName: string,
  result: unknown,
  fallbackContent?: string,
  status?: ToolCallItem["status"],
): NoOutputBashResult | null {
  if (
    !isBashLikeToolName(toolName) ||
    (status !== "complete" && status !== "error")
  ) {
    return null;
  }
  if (result === undefined) {
    return null;
  }
  const bareExitCodeIsEnvelope = status === "error";
  if (
    getBashResultOutputForRichPreview(result, bareExitCodeIsEnvelope).trim()
      .length > 0
  ) {
    return null;
  }
  if (!isRecord(result)) {
    return {
      exitCode: getBashExitCode(
        result,
        fallbackContent,
        bareExitCodeIsEnvelope,
      ),
    };
  }
  if (result.interrupted === true || result.backgroundTaskId !== undefined) {
    return null;
  }
  return {
    exitCode: getBashExitCode(result, fallbackContent, bareExitCodeIsEnvelope),
  };
}

function getBashExitCode(
  result: unknown,
  fallbackContent?: string,
  bareExitCodeIsEnvelope = false,
): number | undefined {
  if (typeof result === "string") {
    return parseShellToolOutput(result, { bareExitCodeIsEnvelope }).exitCode;
  }

  if (isRecord(result)) {
    const direct = getNumberField(result, [
      "exitCode",
      "exit_code",
      "returnCode",
      "return_code",
      "rc",
    ]);
    if (direct !== undefined) {
      return direct;
    }
    if (typeof result.content === "string") {
      const parsed = parseShellToolOutput(result.content, {
        bareExitCodeIsEnvelope,
      }).exitCode;
      if (parsed !== undefined) {
        return parsed;
      }
    }
  }

  return fallbackContent
    ? parseShellToolOutput(fallbackContent, { bareExitCodeIsEnvelope }).exitCode
    : undefined;
}

function getNumberField(
  record: Record<string, unknown>,
  fieldNames: string[],
): number | undefined {
  for (const fieldName of fieldNames) {
    const value = record[fieldName];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
      return Number.parseInt(value, 10);
    }
  }
  return undefined;
}

function hasBashPreviewResult(input: unknown): boolean {
  return isRecord(input) && input._previewResult !== undefined;
}

function BashNoOutputExpanded({ command }: { command: string }) {
  const commandRef = useQuoteableTextSource<HTMLPreElement>(command);

  if (!command.trim()) {
    return null;
  }

  return (
    <pre
      ref={commandRef}
      className={codeStyles.codeBlock}
      data-code-block
      data-bash-no-output-command
    >
      <code>{command}</code>
    </pre>
  );
}

function ToolUseExpanded({
  prepared,
  context,
}: {
  prepared: PreparedToolDisplay;
  context: RenderContext;
}) {
  return (
    <div className={styles.toolUseExpanded} data-tool-use-expanded>
      {prepared.renderToolUse(context)}
    </div>
  );
}
function ToolResultExpanded({
  prepared,
  toolResult,
  context,
}: {
  prepared: PreparedToolDisplay;
  toolResult: ToolResultData | undefined;
  context: RenderContext;
}) {
  if (!toolResult)
    return (
      <div className={styles.toolNoResult} data-tool-no-result>
        No result data
      </div>
    );
  return (
    <div className={styles.toolResultExpanded} data-tool-result-expanded>
      {prepared.renderToolResult(context)}
    </div>
  );
}
export {
  DEFERRED_PREVIEW_HEIGHT,
  estimateDeferredPreviewHeightPx,
} from "./toolRowPreviewMetrics";
