import { useCallback, useEffect, useRef, useState } from "react";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import type { InputRequest } from "../types";
import { getToolSummary } from "./tools/summaries";

// Tools that can be auto-approved with "accept edits" mode
const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];

// Check if this is an ExitPlanMode approval (needs custom UI)
const isExitPlanMode = (toolName: string | undefined) =>
  toolName === "ExitPlanMode";

interface Props {
  request: InputRequest;
  onApprove: () => Promise<void>;
  onDeny: () => Promise<void>;
  onApproveAcceptEdits?: () => Promise<void>;
  onDenyWithFeedback?: (feedback: string) => Promise<void>;
  draftKey?: string;
}

export function ToolApprovalPanel({
  request,
  onApprove,
  onDeny,
  onApproveAcceptEdits,
  onDenyWithFeedback,
  draftKey,
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const feedbackInputRef = useRef<HTMLInputElement>(null);
  const continueTypingRef = useRef<HTMLTextAreaElement>(null);

  // Draft persistence for continue-typing input
  const [draftValue, setDraftValue] = useDraftPersistence(draftKey || "");

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
    } finally {
      setSubmitting(false);
      setFeedback("");
      setShowFeedback(false);
    }
  }, [onDenyWithFeedback, feedback]);

  // Focus feedback input when shown
  useEffect(() => {
    if (showFeedback && feedbackInputRef.current) {
      feedbackInputRef.current.focus();
    }
  }, [showFeedback]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (submitting) return;

      // Don't handle shortcuts when typing in feedback
      if (showFeedback) {
        if (e.key === "Escape") {
          e.preventDefault();
          setShowFeedback(false);
          setFeedback("");
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
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    handleApprove,
    handleApproveAcceptEdits,
    handleDeny,
    handleDenyWithFeedback,
    submitting,
    showFeedback,
    feedback,
    isEditTool,
    onApproveAcceptEdits,
    request.toolName,
  ]);

  const summary = request.toolName
    ? getToolSummary(request.toolName, request.toolInput, undefined, "pending")
    : request.prompt;

  return (
    <div className="tool-approval-wrapper">
      {/* Floating toggle button */}
      <button
        type="button"
        className={`tool-approval-toggle ${collapsed ? "has-pending" : ""}`}
        onClick={() => setCollapsed(!collapsed)}
        aria-label={
          collapsed ? "Expand approval panel" : "Collapse approval panel"
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
          className={collapsed ? "chevron-up" : "chevron-down"}
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Collapsed indicator bar */}
      {collapsed && (
        <button
          type="button"
          className="tool-approval-collapsed-bar"
          onClick={() => setCollapsed(false)}
        >
          <span className="tool-approval-collapsed-indicator" />
          <span className="tool-approval-collapsed-text">
            Waiting for approval
          </span>
        </button>
      )}

      {!collapsed && (
        <div className="tool-approval-panel">
          <div className="tool-approval-header">
            {isExitPlanMode(request.toolName) ? (
              <>
                <span className="tool-approval-title">Accept this plan?</span>
                <span className="tool-approval-subtitle">
                  Review the plan above and decide whether to proceed
                </span>
              </>
            ) : (
              <span className="tool-approval-question">
                Allow{" "}
                <span className="tool-approval-name">{request.toolName}</span>{" "}
                {summary}?
              </span>
            )}
          </div>

          <div className="tool-approval-options">
            {isExitPlanMode(request.toolName) ? (
              <>
                <button
                  type="button"
                  className="tool-approval-option primary"
                  onClick={handleApproveAcceptEdits}
                  disabled={submitting || !onApproveAcceptEdits}
                >
                  <kbd>1</kbd>
                  <span>Yes, and auto-accept</span>
                </button>
                <button
                  type="button"
                  className="tool-approval-option"
                  onClick={handleApprove}
                  disabled={submitting}
                >
                  <kbd>2</kbd>
                  <span>Yes, and manually approve edits</span>
                </button>
                <button
                  type="button"
                  className="tool-approval-option"
                  onClick={handleDeny}
                  disabled={submitting}
                >
                  <kbd>3</kbd>
                  <span>No, keep planning</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="tool-approval-option primary"
                  onClick={handleApprove}
                  disabled={submitting}
                >
                  <kbd>1</kbd>
                  <span>Yes</span>
                </button>

                {isEditTool && onApproveAcceptEdits && (
                  <button
                    type="button"
                    className="tool-approval-option"
                    onClick={handleApproveAcceptEdits}
                    disabled={submitting}
                  >
                    <kbd>2</kbd>
                    <span>Yes, and don't ask again</span>
                  </button>
                )}

                <button
                  type="button"
                  className="tool-approval-option"
                  onClick={handleDeny}
                  disabled={submitting}
                >
                  <kbd>{isEditTool && onApproveAcceptEdits ? "3" : "2"}</kbd>
                  <span>No</span>
                </button>
              </>
            )}

            {onDenyWithFeedback && !showFeedback && (
              <button
                type="button"
                className="tool-approval-option feedback-toggle"
                onClick={() => setShowFeedback(true)}
                disabled={submitting}
              >
                <span>Tell Claude what to do instead</span>
              </button>
            )}

            {onDenyWithFeedback && showFeedback && (
              <div className="tool-approval-feedback">
                <input
                  ref={feedbackInputRef}
                  type="text"
                  placeholder="Tell Claude what to do instead..."
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  disabled={submitting}
                  className="tool-approval-feedback-input"
                />
                <button
                  type="button"
                  className="tool-approval-feedback-submit"
                  onClick={handleDenyWithFeedback}
                  disabled={submitting || !feedback.trim()}
                >
                  Send
                </button>
              </div>
            )}
          </div>

          {draftKey && (
            <div className="tool-approval-continue-typing">
              <textarea
                ref={continueTypingRef}
                className="tool-approval-continue-input"
                placeholder="Continue typing..."
                value={draftValue}
                onChange={(e) => setDraftValue(e.target.value)}
                rows={1}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
