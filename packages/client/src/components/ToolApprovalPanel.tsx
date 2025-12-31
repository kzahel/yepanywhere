import { useCallback, useEffect, useRef, useState } from "react";
import type { InputRequest } from "../types";
import { getToolSummary } from "./tools/summaries";

// Tools that can be auto-approved with "accept edits" mode
const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];

interface Props {
  request: InputRequest;
  onApprove: () => Promise<void>;
  onDeny: () => Promise<void>;
  onApproveAcceptEdits?: () => Promise<void>;
  onDenyWithFeedback?: (feedback: string) => Promise<void>;
}

export function ToolApprovalPanel({
  request,
  onApprove,
  onDeny,
  onApproveAcceptEdits,
  onDenyWithFeedback,
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");
  const feedbackInputRef = useRef<HTMLInputElement>(null);

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
  ]);

  const summary = request.toolName
    ? getToolSummary(request.toolName, request.toolInput, undefined, "pending")
    : request.prompt;

  return (
    <div className="tool-approval-panel">
      <div className="tool-approval-header">
        <span className="tool-approval-question">
          Allow <span className="tool-approval-name">{request.toolName}</span>{" "}
          {summary}?
        </span>
      </div>

      <div className="tool-approval-options">
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
    </div>
  );
}
