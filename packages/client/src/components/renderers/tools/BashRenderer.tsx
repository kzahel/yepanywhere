import codeStyles from "../CodeOutput.module.css";
import expandStyles from "../ExpandOutput.module.css";
import { toolDisplayContracts } from "./toolDisplayContracts";
import { normalizeBashResult } from "../../../lib/bashResult";
import {
  BashModalContent,
  BashResultMetaBadges,
  renderFixedFontMathPanel,
} from "./BashOutputDetail";
import { defineTool } from "./defineTool";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ZodError } from "zod";
import { useSchemaValidationContext } from "../../../contexts/SchemaValidationContext";
import { useOptionalSessionMetadata } from "../../../contexts/SessionMetadataContext";
import { useOutputToolPreviewLineCount } from "../../../hooks/useOutputAppearance";
import { useQuoteableTextSource } from "../../../hooks/useQuoteableTextSource";
import {
  getDisplayBashCommandFromInput,
  isCodexProvider,
} from "../../../lib/bashCommand";
import { selectionIntersectsElement } from "../../../lib/domSelection";
import { validateToolResult } from "../../../lib/validateToolResult";
import { ActivityDetailModal } from "../../ActivityDetailModal";
import { ProjectPathLinkedText } from "../../ProjectPathLinkedText";
import { SchemaWarning } from "../../SchemaWarning";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { ToolOutputText } from "../../ToolOutputText";
import {
  FixedFontMathToggle,
  type RenderedMathResult,
  renderFixedFontRichContent,
} from "../../ui/FixedFontMathToggle";
import { HiddenContentBadge } from "../../ui/HiddenContentBadge";
import { InnerHtml } from "../../ui/InnerHtml";
import type { RenderContext } from "../types";
import { NestedHarnessLaunchLink } from "./NestedHarnessLaunchLink";
import {
  getHiddenOutputLineCount,
  getOutputTailTooltip,
  getPreviewLimits,
  OutputCopyButton,
  truncateOutput,
} from "./outputPreview";
import styles from "./BashRenderer.module.css";
import type { BashInput, BashResult } from "./types";

const MAX_LINES_COLLAPSED = 20;
const MAX_LINES_TOOL_USE = 12;
const RICH_PREVIEW_LINES = 20;
const RICH_PREVIEW_MAX_CHARS = 4000;
const NO_FIXED_FONT_RICH_CONTENT: RenderedMathResult = {
  html: "",
  changed: false,
};

const CODEX_NOISE_PATTERNS = [
  /^npm warn (?:unknown env config|config)\s+["']recursive["']/i,
  /^this will stop working in the next major version of npm\.?$/i,
];

/**
 * Normalize bash result - handles both structured objects and plain strings
 * SDK may return a plain string for errors instead of { stdout, stderr }
 */

function getBashCommand(input: BashInput): string {
  return getDisplayBashCommandFromInput(input);
}

function sanitizeOutputForPreview(output: string, provider?: string): string {
  const normalized = output.replace(/\r\n/g, "\n");
  if (!isCodexProvider(provider)) {
    return normalized;
  }

  const lines = normalized.split("\n");
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return false;
    }
    return !CODEX_NOISE_PATTERNS.some((pattern) => pattern.test(trimmed));
  });

  if (filtered.length === 0) {
    return normalized;
  }

  return filtered.join("\n");
}

function BashToolUse({ input }: { input: BashInput }) {
  const command = getBashCommand(input);
  const [isExpanded, setIsExpanded] = useState(false);
  const lines = command.split("\n");
  const needsCollapse = lines.length > MAX_LINES_TOOL_USE;
  const displayCommand =
    needsCollapse && !isExpanded
      ? `${lines.slice(0, MAX_LINES_TOOL_USE).join("\n")}\n...`
      : command;
  const commandRef = useQuoteableTextSource<HTMLPreElement>(displayCommand);

  return (
    <div className={styles.bashToolUse} data-bash-tool-use>
      <div
        className={styles.bashInlineSectionHeader}
        data-bash-inline-section-header
      >
        <span
          className={styles.bashInlineSectionLabel}
          data-bash-inline-section-label
        >
          Command
        </span>
        <OutputCopyButton text={command} label="Copy command" />
      </div>
      <pre ref={commandRef} className={codeStyles.codeBlock} data-code-block>
        <code>
          <ProjectPathLinkedText
            text={displayCommand}
            links={input._projectPathLinks}
          />
        </code>
      </pre>
      <NestedHarnessLaunchLink command={command} />
      {needsCollapse && (
        <Button
          variant="ghost"
          size="small"
          className={expandStyles.expandButton}
          data-expand-button
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "Show less" : `Show all ${lines.length} lines`}
        </Button>
      )}
    </div>
  );
}

/**
 * Bash tool result - shows stdout/stderr with collapse for long output
 */
function BashToolResult({
  result: rawResult,
  isError,
  input,
  projectPathLinks,
}: {
  result: BashResult | string;
  isError: boolean;
  input?: BashInput;
  projectPathLinks?: RenderContext["projectPathLinks"];
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  // Normalize result to handle both structured and string formats
  const result =
    typeof rawResult === "string"
      ? normalizeBashResult(rawResult, isError)
      : rawResult;

  useEffect(() => {
    if (enabled && rawResult && typeof rawResult === "object") {
      const validation = validateToolResult("Bash", rawResult);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Bash", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, rawResult, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Bash");

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const command = input ? getBashCommand(input) : "";
  const commandRef = useQuoteableTextSource<HTMLPreElement>(command);
  const sessionMetadata = useOptionalSessionMetadata();
  const stdoutLines = stdout.split("\n");
  const richStdout = useMemo(
    () =>
      renderFixedFontRichContent(stdout, {
        projectId: sessionMetadata?.projectId,
        projectPath: sessionMetadata?.projectPath ?? undefined,
        projectPathLinks,
      }),
    [
      stdout,
      sessionMetadata?.projectId,
      sessionMetadata?.projectPath,
      projectPathLinks,
    ],
  );
  const richStderr = useMemo(
    () =>
      renderFixedFontRichContent(stderr, {
        projectId: sessionMetadata?.projectId,
        projectPath: sessionMetadata?.projectPath ?? undefined,
        projectPathLinks,
      }),
    [
      stderr,
      sessionMetadata?.projectId,
      sessionMetadata?.projectPath,
      projectPathLinks,
    ],
  );
  const needsCollapse = stdoutLines.length > MAX_LINES_COLLAPSED;
  const displayStdout =
    needsCollapse && !isExpanded
      ? `${stdoutLines.slice(0, MAX_LINES_COLLAPSED).join("\n")}\n...`
      : stdout;
  const stdoutRenderText = richStdout.changed ? stdout : displayStdout;

  return (
    <div
      className={`${styles.bashResult} ${isError ? "bash-result-error" : ""}`}
      data-bash-result
    >
      {showValidationWarning && validationErrors && (
        <SchemaWarning toolName="Bash" errors={validationErrors} />
      )}
      {command && (
        <div
          className={`${styles.bashExpandedSection} bash-expanded-command-section`}
          data-bash-expanded-section
        >
          <div
            className={styles.bashInlineSectionHeader}
            data-bash-inline-section-header
          >
            <span
              className={styles.bashInlineSectionLabel}
              data-bash-inline-section-label
            >
              Command
            </span>
            <OutputCopyButton text={command} label="Copy command" />
          </div>
          <pre
            ref={commandRef}
            className={codeStyles.codeBlock}
            data-code-block
          >
            <code>
              <ProjectPathLinkedText
                text={command}
                links={input?._projectPathLinks}
              />
            </code>
          </pre>
          <NestedHarnessLaunchLink command={command} />
        </div>
      )}
      {result?.interrupted && <Badge tone="warning">Interrupted</Badge>}
      {result?.backgroundTaskId && (
        <Badge tone="info">Background: {result.backgroundTaskId}</Badge>
      )}
      <BashResultMetaBadges result={result} />
      {stdout && (
        <div
          className={`${styles.bashStdout} ${styles.bashExpandedSection}`}
          data-bash-stdout
          data-bash-expanded-section
        >
          <div
            className={styles.bashInlineSectionHeader}
            data-bash-inline-section-header
          >
            <span
              className={styles.bashInlineSectionLabel}
              data-bash-inline-section-label
            >
              Output
            </span>
            <OutputCopyButton text={stdout} label="Copy output" />
          </div>
          <FixedFontMathToggle
            sourceText={stdoutRenderText}
            projectPathLinks={projectPathLinks}
            precomputedRendered={
              stdoutRenderText === stdout
                ? richStdout
                : NO_FIXED_FONT_RICH_CONTENT
            }
            sourceView={
              <pre className={codeStyles.codeBlock} data-code-block>
                <ToolOutputText text={displayStdout} />
              </pre>
            }
            renderRenderedView={(html) => renderFixedFontMathPanel(html)}
          />
          {needsCollapse && (
            <Button
              variant="ghost"
              size="small"
              className={expandStyles.expandButton}
              data-expand-button
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded
                ? "Show less"
                : `Show all ${stdoutLines.length} lines`}
            </Button>
          )}
        </div>
      )}
      {stderr && (
        <div
          className={`${styles.bashStderr} ${styles.bashExpandedSection}`}
          data-bash-stderr
          data-bash-expanded-section
        >
          <div
            className={styles.bashInlineSectionHeader}
            data-bash-inline-section-header
          >
            <span
              className={styles.bashInlineSectionLabel}
              data-bash-inline-section-label
            >
              {isError ? "Error" : "Stderr"}
            </span>
            <OutputCopyButton
              text={stderr}
              label={isError ? "Copy error output" : "Copy stderr"}
            />
          </div>
          <FixedFontMathToggle
            sourceText={stderr}
            projectPathLinks={projectPathLinks}
            precomputedRendered={richStderr}
            sourceView={
              <pre
                className={`${codeStyles.codeBlock} ${codeStyles.codeBlockError}`}
                data-code-block
                data-code-block-error
              >
                <ToolOutputText text={stderr} />
              </pre>
            }
            renderRenderedView={(html) =>
              renderFixedFontMathPanel(
                html,
                `${codeStyles.codeBlock} ${codeStyles.codeBlockError}`,
              )
            }
          />
        </div>
      )}
      {!stdout && !stderr && !result?.interrupted && (
        <div className={styles.bashEmpty} data-bash-empty>
          No output
        </div>
      )}
    </div>
  );
}

/**
 * Truncate text to a maximum number of lines and characters
 */
/**
 * Collapsed preview showing command output; the command itself lives in the
 * shared "Ran ..." row header.
 */
function getPreviewResultFromInput(
  input: BashInput,
): BashResult | string | undefined {
  return input._previewResult;
}

function BashCollapsedPreview({
  input,
  result: rawResult,
  isError,
  provider,
  projectPathLinks,
}: {
  input: BashInput;
  result: BashResult | string | undefined;
  isError: boolean;
  provider?: string;
  projectPathLinks?: RenderContext["projectPathLinks"];
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const outputToolPreviewLineCount = useOutputToolPreviewLineCount();
  const { enabled, reportValidationError, isToolIgnored } =
    useSchemaValidationContext();
  const [validationErrors, setValidationErrors] = useState<ZodError | null>(
    null,
  );

  const previewResult = rawResult ?? getPreviewResultFromInput(input);
  // Normalize result to handle both structured and string formats
  const result =
    typeof previewResult === "string"
      ? normalizeBashResult(previewResult, isError)
      : previewResult;

  useEffect(() => {
    if (enabled && rawResult && typeof rawResult === "object") {
      const validation = validateToolResult("Bash", rawResult);
      if (!validation.valid && validation.errors) {
        setValidationErrors(validation.errors);
        reportValidationError("Bash", validation.errors);
      } else {
        setValidationErrors(null);
      }
    }
  }, [enabled, rawResult, reportValidationError]);

  const showValidationWarning =
    enabled && validationErrors && !isToolIgnored("Bash");
  const sessionMetadata = useOptionalSessionMetadata();
  const previewIsStderr = !!result?.stderr;
  const output = sanitizeOutputForPreview(
    (previewIsStderr ? result?.stderr : result?.stdout) || "",
    provider,
  );
  const fullRichPreview = useMemo(
    () =>
      renderFixedFontRichContent(output, {
        projectId: sessionMetadata?.projectId,
        projectPath: sessionMetadata?.projectPath ?? undefined,
        projectPathLinks,
      }),
    [
      output,
      sessionMetadata?.projectId,
      sessionMetadata?.projectPath,
      projectPathLinks,
    ],
  );
  const { text: previewText, truncated } = truncateOutput(
    output,
    fullRichPreview.changed
      ? { maxLines: RICH_PREVIEW_LINES, maxChars: RICH_PREVIEW_MAX_CHARS }
      : getPreviewLimits(outputToolPreviewLineCount),
  );
  const hiddenOutputLineCount = getHiddenOutputLineCount(
    output,
    outputToolPreviewLineCount,
  );
  const outputTailTooltip = getOutputTailTooltip(
    output,
    outputToolPreviewLineCount,
  );
  const previewRichContent = useMemo(() => {
    if (previewText === output) {
      return fullRichPreview;
    }
    if (!fullRichPreview.changed) {
      return NO_FIXED_FONT_RICH_CONTENT;
    }
    return renderFixedFontRichContent(previewText, {
      projectId: sessionMetadata?.projectId,
      projectPath: sessionMetadata?.projectPath ?? undefined,
      projectPathLinks,
    });
  }, [
    previewText,
    output,
    fullRichPreview,
    sessionMetadata?.projectId,
    sessionMetadata?.projectPath,
    projectPathLinks,
  ]);
  const hasOutput = previewText.length > 0;

  const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    if (target?.closest?.("button,a")) {
      return;
    }
    if (selectionIntersectsElement(event.currentTarget)) {
      return;
    }
    setIsModalOpen(true);
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setIsModalOpen(true);
      }
    },
    [],
  );

  const handleClose = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label="View bash command output"
        className={styles.bashCollapsedPreview}
        data-bash-collapsed-preview
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        {showValidationWarning && validationErrors && (
          <div
            className={`${styles.bashPreviewRow} ${styles.bashPreviewWarningRow}`}
            data-bash-preview-row
            data-bash-preview-warning-row
          >
            <SchemaWarning toolName="Bash" errors={validationErrors} />
          </div>
        )}
        {hasOutput && (
          <div
            className={`${styles.bashPreviewRow} ${styles.bashPreviewOutputRow}`}
            data-bash-preview-row
            data-bash-preview-output-row
          >
            <div
              className={`${styles.bashPreviewOutput} ${truncated ? "bash-preview-truncated" : ""} ${previewIsStderr ? styles.bashPreviewError : ""}`}
              data-bash-preview-output
              data-bash-preview-error={previewIsStderr || undefined}
              style={
                {
                  "--bash-preview-line-count": String(
                    outputToolPreviewLineCount,
                  ),
                } as CSSProperties
              }
            >
              <FixedFontMathToggle
                sourceText={previewText}
                projectPathLinks={projectPathLinks}
                precomputedRendered={previewRichContent}
                sourceView={
                  <pre>
                    <ToolOutputText text={previewText} compact />
                  </pre>
                }
                renderRenderedView={(html) => (
                  <pre>
                    {/* KaTeX output is trusted HTML from local rendering. */}
                    <InnerHtml
                      className={`${codeStyles.fixedFontRenderedContent} ${styles.fixedWidthOutput}`}
                      data-fixed-font-rendered__content
                      trustedHtml={html}
                    />
                  </pre>
                )}
              />
              {truncated && (
                <div
                  className={styles.bashPreviewFade}
                  data-bash-preview-fade
                />
              )}
            </div>
            <OutputCopyButton
              text={output}
              label={previewIsStderr ? "Copy stderr" : "Copy output"}
            />
            {hiddenOutputLineCount > 0 && (
              <HiddenContentBadge
                className={styles.bashPreviewMore}
                data-bash-preview-more
                count={hiddenOutputLineCount}
                tooltip={outputTailTooltip ?? output}
              />
            )}
          </div>
        )}
        {!hasOutput && result && !result.interrupted && (
          <div className={styles.bashPreviewRow} data-bash-preview-row>
            <span className={styles.bashPreviewEmpty} data-bash-preview-empty>
              No output
            </span>
          </div>
        )}
        {result?.interrupted && (
          <div className={styles.bashPreviewRow} data-bash-preview-row>
            <span
              className={styles.bashPreviewInterrupted}
              data-bash-preview-interrupted
            >
              Interrupted
            </span>
          </div>
        )}
      </div>
      {isModalOpen && (
        <ActivityDetailModal
          title={input.description || "Bash Command"}
          label={input.description || "Bash Command"}
          onClose={handleClose}
        >
          <BashModalContent
            input={input}
            result={result}
            isError={isError}
            projectPathLinks={projectPathLinks}
          />
        </ActivityDetailModal>
      )}
    </>
  );
}

export const bashRenderer = defineTool(toolDisplayContracts.Bash, {
  tool: "Bash",
  displayName: "Ran",
  pendingDisplayName: "Run",

  // A backgrounded command's tool call completes while the process keeps
  // running, so the header verb stays present-tense until completion
  // evidence arrives (see transcriptProjection/shellFolding).
  displayNameForCall(input, status) {
    if (status !== "complete") {
      return undefined;
    }
    const backgroundStatus = input._backgroundTaskStatus;
    return backgroundStatus === "running" ? "Running" : undefined;
  },

  renderToolUse(input, _context) {
    return <BashToolUse input={input} />;
  },

  renderToolResult(result, isError, context, input) {
    return (
      <BashToolResult
        result={result}
        isError={isError}
        input={input}
        projectPathLinks={context.projectPathLinks}
      />
    );
  },

  getUseSummary(input) {
    const i = input;
    const command = getBashCommand(i);
    // Show description if available, otherwise truncated command.
    // Row-level truncation is handled by CSS (.tool-summary text-overflow),
    // but we also truncate here to avoid massive strings in the approval panel.
    if (i.description) {
      return i.description;
    }
    if (!command) {
      return "Bash command";
    }
    // Truncate long commands (e.g., heredocs) - first line only, max 200 chars
    const firstLine = command.split("\n")[0] ?? command;
    if (firstLine.length > 200) {
      return `${firstLine.slice(0, 200)}...`;
    }
    if (command.includes("\n")) {
      return `${firstLine}...`;
    }
    return command;
  },

  getResultSummary(result, isError) {
    const r = result;
    if (r?.interrupted) return "Interrupted";
    if (isError || r?.stderr) return "Error";
    // Return empty string - the preview shows the output
    return "";
  },

  renderCollapsedPreview(input, result, isError, context) {
    return (
      <BashCollapsedPreview
        input={input}
        result={result}
        isError={isError}
        provider={context.provider}
        projectPathLinks={context.projectPathLinks}
      />
    );
  },
});
