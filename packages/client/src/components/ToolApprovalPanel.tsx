import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useToolApprovalFeedbackDraft } from "../hooks/useDrafts";
import { useI18n } from "../i18n";
import { useClientSummarySourceKey } from "../lib/clientSummaryStore";
import { draftLocalKey } from "../lib/draftSyncStorage";
import { DraftSyncNotice } from "./DraftSyncNotice";
import {
  makeSecurityVisibleText,
  makeSecurityVisibleValue,
} from "../lib/securityVisibleText";
import type { InputRequest } from "../types";
import { toolRegistry } from "./renderers/tools";
import type { RenderContext } from "./renderers/types";
import { getToolSummary } from "./tools/summaries";
import { Button } from "./ui/Button";
import { TextInput } from "./ui/Field";
import { Modal } from "./ui/Modal";
import styles from "./ToolApprovalPanel.module.css";

// Tools that can be auto-approved with "accept edits" mode
const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];

// Check if this is an ExitPlanMode approval (needs custom UI)
const isExitPlanMode = (toolName: string | undefined) =>
  toolName === "ExitPlanMode";

interface Props {
  request: InputRequest;
  sessionId: string;
  onApprove: () => Promise<void>;
  onDeny: () => Promise<void>;
  onApproveAcceptEdits?: () => Promise<void>;
  onDenyWithFeedback?: (feedback: string) => Promise<void>;
  /** Whether the panel is collapsed (controlled externally) */
  collapsed?: boolean;
  /** Callback when collapse state changes */
  onCollapsedChange?: (collapsed: boolean) => void;
  projectPath?: string | null;
}

// Delay before buttons become clickable to prevent accidental clicks
const CLICK_PROTECTION_MS = 150;

export function ToolApprovalPanel({
  request,
  sessionId,
  onApprove,
  onDeny,
  onApproveAcceptEdits,
  onDenyWithFeedback,
  collapsed = false,
  onCollapsedChange,
  projectPath,
}: Props) {
  const { t } = useI18n();
  const sourceKey = useClientSummarySourceKey();
  const draftKey = draftLocalKey(sourceKey, { kind: "approval", sessionId });
  const [submitting, setSubmitting] = useState(false);
  // Prevent accidental clicks by disabling buttons briefly when panel appears
  const [armedRequestId, setArmedRequestId] = useState<string | null>(null);
  const armed = armedRequestId === request.id;
  // Show feedback panel if there's already draft text from localStorage
  const [feedback, setFeedback, clearFeedback] =
    useToolApprovalFeedbackDraft(sessionId);
  const [showFeedback, setShowFeedback] = useState(() => feedback.length > 0);
  const feedbackInputRef = useRef<HTMLInputElement>(null);

  // Reset armed state when request changes (new approval appears)
  useEffect(() => {
    setArmedRequestId(null);
    const timer = setTimeout(
      () => setArmedRequestId(request.id),
      CLICK_PROTECTION_MS,
    );
    return () => clearTimeout(timer);
  }, [request.id]);

  const isEditTool = request.toolName && EDIT_TOOLS.includes(request.toolName);

  const handleApprove = useCallback(async () => {
    setSubmitting(true);
    try {
      await onApprove();
    } finally {
      setSubmitting(false);
    }
  }, [onApprove]);

  const handleApproveAcceptEdits = useCallback(async () => {
    if (!onApproveAcceptEdits) return;
    setSubmitting(true);
    try {
      await onApproveAcceptEdits();
    } finally {
      setSubmitting(false);
    }
  }, [onApproveAcceptEdits]);

  const handleDeny = useCallback(async () => {
    setSubmitting(true);
    try {
      await onDeny();
    } finally {
      setSubmitting(false);
    }
  }, [onDeny]);

  const handleDenyWithFeedback = useCallback(async () => {
    if (!onDenyWithFeedback || !feedback.trim()) return;
    setSubmitting(true);
    try {
      await onDenyWithFeedback(feedback.trim());
      // Clear feedback draft from localStorage on successful submit
      clearFeedback();
      setShowFeedback(false);
    } finally {
      setSubmitting(false);
    }
  }, [onDenyWithFeedback, feedback, clearFeedback]);

  // Focus feedback input when shown
  useEffect(() => {
    if (showFeedback && feedbackInputRef.current) {
      feedbackInputRef.current.focus();
    }
  }, [showFeedback]);

  // Keyboard shortcuts. Bound to the panel, not the window: bare digits,
  // Enter, and Escape are ordinary composer keystrokes, so they act only
  // while focus is inside this panel.
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (submitting || !armed) return;
      // Native keyboard activation of draft-review buttons is not approval.
      if (
        e.target instanceof Element &&
        e.target.closest("[data-draft-notice]")
      )
        return;

      // Don't handle shortcuts when typing in feedback
      if (showFeedback) {
        if (e.key === "Escape") {
          e.preventDefault();
          setShowFeedback(false);
          clearFeedback();
        } else if (e.key === "Enter" && feedback.trim()) {
          e.preventDefault();
          handleDenyWithFeedback();
        }
        return;
      }

      const isPlanMode = isExitPlanMode(request.toolName);

      if (isPlanMode) {
        // ExitPlanMode: 1=auto-accept, 2=manual, 3=deny
        if (e.key === "1" && onApproveAcceptEdits) {
          e.preventDefault();
          handleApproveAcceptEdits();
        } else if (e.key === "2") {
          e.preventDefault();
          handleApprove();
        } else if (e.key === "3") {
          e.preventDefault();
          handleDeny();
        } else if (e.key === "Enter" && !e.shiftKey && onApproveAcceptEdits) {
          e.preventDefault();
          handleApproveAcceptEdits();
        } else if (e.key === "Escape") {
          e.preventDefault();
          handleDeny();
        }
      } else {
        // Standard tool approval: 1=yes, 2=yes+auto (edit tools), 2/3=no
        if (e.key === "1") {
          e.preventDefault();
          handleApprove();
        } else if (e.key === "2" && isEditTool && onApproveAcceptEdits) {
          e.preventDefault();
          handleApproveAcceptEdits();
        } else if (
          e.key === "3" ||
          (e.key === "2" && (!isEditTool || !onApproveAcceptEdits))
        ) {
          e.preventDefault();
          handleDeny();
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleApprove();
        } else if (e.key === "Escape") {
          e.preventDefault();
          handleDeny();
        }
      }
    },
    [
      handleApprove,
      handleApproveAcceptEdits,
      handleDeny,
      handleDenyWithFeedback,
      submitting,
      armed,
      showFeedback,
      feedback,
      clearFeedback,
      isEditTool,
      onApproveAcceptEdits,
      request.toolName,
    ],
  );

  const displayToolInput = useMemo(
    () => makeSecurityVisibleValue(request.toolInput),
    [request.toolInput],
  );
  const displayToolName = request.toolName
    ? makeSecurityVisibleText(request.toolName)
    : undefined;
  const summary = request.toolName
    ? getToolSummary(request.toolName, displayToolInput, undefined, "pending", {
        projectPath,
      })
    : request.prompt;
  const displaySummary = summary ? makeSecurityVisibleText(summary) : summary;

  const [showPreviewModal, setShowPreviewModal] = useState(false);

  // Only show "View details" when the approval summary text itself is too
  // long to display inline. The full tool details (diffs, etc.) are already
  // visible in the session stream above.
  const summaryText = `Allow ${displayToolName ?? ""} ${displaySummary ?? ""}?`;
  const showViewDetails = summaryText.length > 120;

  const renderContext: RenderContext = useMemo(
    () => ({
      isStreaming: true,
      theme: "dark",
      toolUseId: request.id,
      projectPath,
    }),
    [request.id, projectPath],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keyboard shortcuts for the focusable buttons inside
    <div
      className={styles.root}
      onKeyDown={handleKeyDown}
      data-draft-key={draftKey}
    >
      <DraftSyncNotice draftKey={draftKey} sessionId={sessionId} />
      {/* Floating toggle button */}
      <Button
        variant={collapsed ? "attention-outline" : "secondary"}
        elevated
        size="small"
        className={styles.toggle}
        onClick={() => onCollapsedChange?.(!collapsed)}
        aria-label={
          collapsed ? t("toolApprovalExpand") : t("toolApprovalCollapse")
        }
        aria-expanded={!collapsed}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={collapsed ? styles.chevronUp : ""}
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </Button>

      {!collapsed && (
        <div className={styles.panel}>
          <div className={styles.header}>
            {isExitPlanMode(request.toolName) ? (
              <>
                <span className={styles.title}>
                  {t("toolApprovalPlanTitle")}
                </span>
                <span className={styles.subtitle}>
                  {t("toolApprovalPlanSubtitle")}
                </span>
              </>
            ) : (
              <>
                <div className={styles.questionRow}>
                  <span className={styles.question}>
                    {t("toolApprovalAllow", {
                      tool: displayToolName ?? "",
                      summary: displaySummary ?? "",
                    })}
                  </span>
                  {showViewDetails && (
                    <Button
                      variant="link"
                      className={styles.viewDetails}
                      onClick={() => setShowPreviewModal(true)}
                    >
                      {t("toolApprovalViewDetails")}
                    </Button>
                  )}
                </div>
                {showPreviewModal && request.toolName && (
                  <Modal
                    title={t("toolApprovalDetailsTitle", {
                      tool: displayToolName ?? request.toolName,
                    })}
                    onClose={() => setShowPreviewModal(false)}
                  >
                    <div className="tool-use-expanded">
                      {toolRegistry.renderToolUse(
                        request.toolName,
                        displayToolInput,
                        renderContext,
                      )}
                    </div>
                  </Modal>
                )}
              </>
            )}
          </div>

          <div className={styles.options}>
            {isExitPlanMode(request.toolName) ? (
              <>
                <Button
                  variant="primary"
                  className={styles.option}
                  onClick={handleApproveAcceptEdits}
                  disabled={!armed || submitting || !onApproveAcceptEdits}
                >
                  <kbd className={styles.shortcut}>1</kbd>
                  <span>{t("toolApprovalYesAuto")}</span>
                </Button>
                <Button
                  className={styles.option}
                  onClick={handleApprove}
                  disabled={!armed || submitting}
                >
                  <kbd className={styles.shortcut}>2</kbd>
                  <span>{t("toolApprovalYesManual")}</span>
                </Button>
                <Button
                  className={styles.option}
                  onClick={handleDeny}
                  disabled={!armed || submitting}
                >
                  <kbd className={styles.shortcut}>3</kbd>
                  <span>{t("toolApprovalNoKeepPlanning")}</span>
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="primary"
                  className={styles.option}
                  onClick={handleApprove}
                  disabled={!armed || submitting}
                >
                  <kbd className={styles.shortcut}>1</kbd>
                  <span>{t("toolApprovalYes")}</span>
                </Button>

                {isEditTool && onApproveAcceptEdits && (
                  <Button
                    className={styles.option}
                    onClick={handleApproveAcceptEdits}
                    disabled={!armed || submitting}
                  >
                    <kbd className={styles.shortcut}>2</kbd>
                    <span>{t("toolApprovalYesDontAsk")}</span>
                  </Button>
                )}

                <Button
                  className={styles.option}
                  onClick={handleDeny}
                  disabled={!armed || submitting}
                >
                  <kbd className={styles.shortcut}>
                    {isEditTool && onApproveAcceptEdits ? "3" : "2"}
                  </kbd>
                  <span>{t("toolApprovalNo")}</span>
                </Button>
              </>
            )}

            {onDenyWithFeedback && !showFeedback && (
              <Button
                variant="ghost"
                className={styles.option}
                onClick={() => setShowFeedback(true)}
                disabled={!armed || submitting}
              >
                <span>{t("toolApprovalTellInstead")}</span>
              </Button>
            )}

            {onDenyWithFeedback && showFeedback && (
              <div className={styles.feedback}>
                <TextInput
                  ref={feedbackInputRef}
                  placeholder={t("toolApprovalFeedbackPlaceholder")}
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  disabled={!armed || submitting}
                  className={styles.feedbackInput}
                />
                <Button
                  onClick={handleDenyWithFeedback}
                  disabled={!armed || submitting || !feedback.trim()}
                >
                  {t("toolApprovalSend")}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
