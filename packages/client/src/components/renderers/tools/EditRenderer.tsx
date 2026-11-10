import diffStyles from "../DiffOutput.module.css";
import {
  MAX_VISIBLE_LINES,
  type FileLineRange,
  type EditInputWithAugment,
  extractEditFilePaths,
  getEditFilePath,
  getEditRenderMode,
  SourceControlEditLink,
  getFileName,
  getPatchTargetSummary,
  getPatchTargetTitle,
  getPatchTargetDisplayPaths,
  isPlanFile,
  computeChangeSummary,
  getPatchFileLineRange,
  DiffMathView,
  useRestoreDiffSelection,
  DiffTapTarget,
  DiffLines,
  HighlightedDiff,
  DiffHunk,
  RawPatchPreview,
  RawPatchModalContent,
} from "./EditDiffPresentation";
import codeStyles from "../CodeOutput.module.css";
import styles from "./EditRenderer.module.css";
import pathStyles from "../../FilePathLink.module.css";
import diffControlsStyles from "../../DiffContextControls.module.css";
import { FileActionButton } from "../../ui/FileActionButton";
import { toolDisplayContracts } from "./toolDisplayContracts";
import { defineTool } from "./defineTool";
import {
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
import { makeDisplayPath } from "../../../lib/text";
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
import type { DiffSelectionSnapshot } from "./editSelectionTransfer";
import { Button } from "../../ui/Button";
import {
  CHANGED_DIFF_LINE_SELECTOR,
  UnifiedDiff,
} from "../../../pages/UnifiedDiff";
import type { EditInput, EditResult, PatchHunk } from "./types";
/**
 * Edit tool use - shows file path and diff preview
 * Reads augment data directly from input._structuredPatch and input._diffHtml.
 */
const resultErrorStyles: Record<string, string | undefined> = {
  error: styles.editResultError,
  warning: styles.editResultWarning,
  muted: styles.editResultMuted,
};
const collapsedErrorStyles: Record<string, string | undefined> = {
  error: styles.editCollapsedError,
  warning: styles.editCollapsedWarning,
  muted: styles.editCollapsedMuted,
};

function EditToolUse({ input }: { input: EditInputWithAugment }) {
  // Show loading state if augment data not yet available
  if (!input._structuredPatch || input._structuredPatch.length === 0) {
    if (input._rawPatch) {
      return (
        <div className={styles.editResult} data-edit-result>
          <RawPatchPreview
            rawPatch={input._rawPatch}
            baseFilePath={getEditFilePath(input)}
          />
        </div>
      );
    }
    return (
      <div className={styles.editResult} data-edit-result>
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
    <div className={styles.editResult} data-edit-result>
      {changeSummary && (
        <div className={styles.editChangeSummary} data-edit-change-summary>
          {changeSummary}
        </div>
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
      content?.closest<HTMLElement>("[data-modal-content]") ?? content;
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
    <div
      className={diffStyles.diffModalContent}
      data-diff-modal-content
      ref={contentRef}
    >
      <div className={diffControlsStyles.controls} data-diff-context-controls>
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
          <span className={diffControlsStyles.path} data-diff-context-path>
            {displayPath}
          </span>
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
        {error && <span className={diffControlsStyles.error}>{error}</span>}
      </div>

      {fullContextFile ? (
        <DiffMathView
          sourceText={fullContextFile.content}
          diffAware={false}
          baseFilePath={displayPath}
          initialMode={selection?.renderMode}
          sourceView={
            <pre className={codeStyles.codeBlock} data-code-block>
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
    <span className={codeStyles.filePath} data-file-path title={filePath}>
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
        <div
          className={`${styles.editCollapsedPreview} ${collapsedErrorStyles[classSuffix]}`}
          data-edit-collapsed-preview
          data-edit-collapsed-error={classSuffix === "error" || undefined}
          data-edit-collapsed-warning={classSuffix === "warning" || undefined}
          data-edit-collapsed-muted={classSuffix === "muted" || undefined}
          data-edit-error={classSuffix}
        >
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Edit" errors={validationErrors} />
          )}
          <Badge tone={classSuffix === "muted" ? "neutral" : "warning"}>
            {isRejection
              ? classification.label
              : `Edit ${classification.label.toLowerCase()}`}
          </Badge>
          {classification.userReason ? (
            <span className={styles.editErrorMessage} data-edit-error-message>
              {classification.userReason}
            </span>
          ) : classification.cleanedMessage && !isRejection ? (
            <span className={styles.editErrorMessage} data-edit-error-message>
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
          <div
            className={styles.editCollapsedPreview}
            data-edit-collapsed-preview
          >
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
        <div
          className={styles.editCollapsedPreview}
          data-edit-collapsed-preview
        >
          <div className="edit-loading">Computing diff...</div>
        </div>
      );
    }

    return (
      <div className={styles.editCollapsedPreview} data-edit-collapsed-preview>
        <span>Patch preview unavailable</span>
      </div>
    );
  }

  const diffLines = structuredPatch.flatMap((hunk) => hunk.lines);
  const isTruncated = diffLines.length > MAX_VISIBLE_LINES;

  return (
    <>
      <div className={styles.editCollapsedPreview} data-edit-collapsed-preview>
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
        <FileDiffLinkCluster
          className={styles.sourceReviewEditSummary}
          data-source-review-edit-summary
        >
          <FileActionButton
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
          </FileActionButton>
          <SourceControlEditLink filePath={filePath} />
        </FileDiffLinkCluster>
        {showModal && (
          <EditDetailModal
            filePath={filePath}
            displayText={fileName}
            label={fileName}
            onClose={() => setShowModal(false)}
          >
            <div
              className={diffStyles.diffModalContent}
              data-diff-modal-content
            >
              <div
                className={diffControlsStyles.controls}
                data-diff-context-controls
              >
                <span
                  className={diffControlsStyles.path}
                  data-diff-context-path
                  title={fileTitle}
                >
                  {displayPaths.length > 0 ? displayPaths[0] : fileName}
                </span>
              </div>
              <div className={styles.editTargetPaths} data-edit-target-paths>
                {displayPaths.length > 0 ? (
                  displayPaths.map((displayPath) => (
                    <div
                      className={styles.editTargetPath}
                      data-edit-target-path
                      key={displayPath}
                    >
                      <FilePathDisplay displayPath={displayPath} />
                    </div>
                  ))
                ) : (
                  <div className={styles.editTargetPath} data-edit-target-path>
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
      <FileDiffLinkCluster
        className={styles.sourceReviewEditSummary}
        data-source-review-edit-summary
      >
        <FileActionButton
          title={fileTitle}
          onClick={(e) => {
            e.stopPropagation();
            setShowModal(true);
          }}
        >
          {fileName}
          {changeSummary && (
            <span
              className={pathStyles.fileLineCountInline}
              data-file-line-count-inline
            >
              {changeSummary}
            </span>
          )}
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Edit" errors={validationErrors} />
          )}
        </FileActionButton>
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
        <div
          className={`${styles.editResult} ${resultErrorStyles[classSuffix]}`}
          data-edit-result
          data-edit-result-error={classSuffix === "error" || undefined}
          data-edit-result-warning={classSuffix === "warning" || undefined}
          data-edit-result-muted={classSuffix === "muted" || undefined}
          data-edit-error={classSuffix}
        >
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Edit" errors={validationErrors} />
          )}
          <Badge tone={classSuffix === "muted" ? "neutral" : "warning"}>
            {isRejection
              ? classification.label
              : `Edit ${classification.label.toLowerCase()}`}
          </Badge>
          {classification.userReason ? (
            <div className={styles.editErrorMessage} data-edit-error-message>
              {classification.userReason}
            </div>
          ) : classification.cleanedMessage && !isRejection ? (
            <div className={styles.editErrorMessage} data-edit-error-message>
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
    return (
      <div className={styles.editResult} data-edit-result>
        {result.content}
      </div>
    );
  }

  // Handle case where result doesn't have structuredPatch
  // Use input data as fallback when result data is missing
  if (!result?.structuredPatch || result.structuredPatch.length === 0) {
    const filePath = getEditFilePath(input, result);
    const oldString = result?.oldString || input?.old_string || "";
    const newString = result?.newString || input?.new_string || "";
    const isPlan = filePath ? isPlanFile(filePath) : false;

    return (
      <div className={styles.editResult} data-edit-result>
        <div className={styles.editHeader} data-edit-header>
          <span className={codeStyles.filePath} data-file-path>
            {filePath ? getFileName(filePath) : "File"}
          </span>
          {isPlan && <Badge>Plan</Badge>}
          {result?.userModified && <Badge tone="info">User modified</Badge>}
          {showValidationWarning && validationErrors && (
            <SchemaWarning toolName="Edit" errors={validationErrors} />
          )}
        </div>
        <div className={styles.editSimple} data-edit-simple>
          <div className="edit-old">
            <div className={styles.editLabel} data-edit-label>
              Removed:
            </div>
            <pre className={codeStyles.codeBlock} data-code-block>
              <code>{oldString || "(empty)"}</code>
            </pre>
          </div>
          <div className="edit-new">
            <div className={styles.editLabel} data-edit-label>
              Added:
            </div>
            <pre className={codeStyles.codeBlock} data-code-block>
              <code>{newString || "(empty)"}</code>
            </pre>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className={styles.editResult} data-edit-result>
        {showValidationWarning && validationErrors && (
          <SchemaWarning toolName="Edit" errors={validationErrors} />
        )}
        {changeSummary && (
          <div className={styles.editChangeSummary} data-edit-change-summary>
            {changeSummary}
          </div>
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
