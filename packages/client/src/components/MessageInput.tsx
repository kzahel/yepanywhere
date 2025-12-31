import type { UploadedFile } from "@claude-anywhere/shared";
import { type KeyboardEvent, useCallback, useEffect, useRef } from "react";
import { ENTER_SENDS_MESSAGE } from "../constants";
import {
  type DraftControls,
  useDraftPersistence,
} from "../hooks/useDraftPersistence";
import type { ContextUsage, PermissionMode } from "../types";
import { ContextUsageIndicator } from "./ContextUsageIndicator";

/** Progress info for an in-flight upload */
export interface UploadProgress {
  fileId: string;
  fileName: string;
  bytesUploaded: number;
  totalBytes: number;
  percent: number;
}

/** Format file size in human-readable form */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const MODE_ORDER: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

const MODE_LABELS: Record<PermissionMode, string> = {
  default: "Ask before edits",
  acceptEdits: "Edit automatically",
  plan: "Plan mode",
  bypassPermissions: "Bypass permissions",
};

interface Props {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  mode?: PermissionMode;
  onModeChange?: (mode: PermissionMode) => void;
  isModePending?: boolean;
  isRunning?: boolean;
  isThinking?: boolean;
  onStop?: () => void;
  draftKey: string; // localStorage key for draft persistence
  /** Collapse to single-line but keep visible and focusable (for when approval panel is showing) */
  collapsed?: boolean;
  /** Callback to receive draft controls for success/failure handling */
  onDraftControlsReady?: (controls: DraftControls) => void;
  /** Context usage for displaying usage indicator */
  contextUsage?: ContextUsage;
  /** Project ID for uploads (required to enable attach button) */
  projectId?: string;
  /** Session ID for uploads (required to enable attach button) */
  sessionId?: string;
  /** Completed file attachments */
  attachments?: UploadedFile[];
  /** Callback when user selects files to attach */
  onAttach?: (files: File[]) => void;
  /** Callback when user removes an attachment */
  onRemoveAttachment?: (id: string) => void;
  /** Progress info for in-flight uploads */
  uploadProgress?: UploadProgress[];
}

export function MessageInput({
  onSend,
  disabled,
  placeholder,
  mode = "default",
  onModeChange,
  isModePending,
  isRunning,
  isThinking,
  onStop,
  draftKey,
  collapsed,
  onDraftControlsReady,
  contextUsage,
  projectId,
  sessionId,
  attachments = [],
  onAttach,
  onRemoveAttachment,
  uploadProgress = [],
}: Props) {
  const [text, setText, controls] = useDraftPersistence(draftKey);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canAttach = !!(projectId && sessionId && onAttach);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files?.length && onAttach) {
      onAttach(Array.from(files));
      e.target.value = ""; // Reset for re-selection
    }
  };

  // Provide controls to parent via callback
  useEffect(() => {
    onDraftControlsReady?.(controls);
  }, [controls, onDraftControlsReady]);

  const handleSubmit = useCallback(() => {
    if (text.trim() && !disabled) {
      const message = text.trim();
      // Clear input state but keep localStorage for failure recovery
      controls.clearInput();
      onSend(message);
    }
  }, [text, disabled, controls, onSend]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      if (ENTER_SENDS_MESSAGE) {
        // Enter sends, Ctrl+Enter adds newline
        if (e.ctrlKey || e.shiftKey) {
          // Allow default behavior (newline)
          return;
        }
        e.preventDefault();
        handleSubmit();
      } else {
        // Ctrl+Enter sends, Enter adds newline
        if (e.ctrlKey || e.shiftKey) {
          e.preventDefault();
          handleSubmit();
        }
      }
    }
  };

  const handleModeClick = () => {
    if (!onModeChange) return;
    const currentIndex = MODE_ORDER.indexOf(mode);
    const nextIndex = (currentIndex + 1) % MODE_ORDER.length;
    const nextMode = MODE_ORDER[nextIndex];
    if (nextMode) {
      onModeChange(nextMode);
    }
  };

  return (
    <div
      className={`message-input ${collapsed ? "message-input-collapsed" : ""}`}
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={
          collapsed ? "Continue typing while responding above..." : placeholder
        }
        disabled={disabled}
        rows={collapsed ? 1 : 3}
      />

      {/* Attachment chips - show below textarea when not collapsed */}
      {!collapsed && (attachments.length > 0 || uploadProgress.length > 0) && (
        <div className="attachment-list">
          {attachments.map((file) => (
            <div key={file.id} className="attachment-chip">
              <span className="attachment-name" title={file.path}>
                {file.originalName}
              </span>
              <span className="attachment-size">{formatSize(file.size)}</span>
              <button
                type="button"
                className="attachment-remove"
                onClick={() => onRemoveAttachment?.(file.id)}
                aria-label={`Remove ${file.originalName}`}
              >
                x
              </button>
            </div>
          ))}
          {uploadProgress.map((progress) => (
            <div key={progress.fileId} className="attachment-chip uploading">
              <span className="attachment-name">{progress.fileName}</span>
              <span className="attachment-progress">{progress.percent}%</span>
            </div>
          ))}
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={handleFileSelect}
      />

      {!collapsed && (
        <div className="message-input-toolbar">
          <div className="message-input-left">
            <button
              type="button"
              className="mode-button"
              onClick={handleModeClick}
              disabled={!onModeChange}
              title="Click to cycle through permission modes"
            >
              <span className={`mode-dot mode-${mode}`} />
              {MODE_LABELS[mode]}
              {isModePending && (
                <span className="mode-pending-hint">(set on next message)</span>
              )}
            </button>
            <button
              type="button"
              className="attach-button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!canAttach}
              title={
                canAttach
                  ? "Attach files"
                  : "Send a message first to enable attachments"
              }
            >
              <span className="attach-icon">+</span>
              {attachments.length > 0 && (
                <span className="attach-count">{attachments.length}</span>
              )}
            </button>
          </div>
          <div className="message-input-actions">
            <ContextUsageIndicator usage={contextUsage} size={16} />
            {isRunning && onStop && isThinking && (
              <button
                type="button"
                onClick={onStop}
                className="stop-button"
                aria-label="Stop"
              >
                <span className="stop-icon" />
              </button>
            )}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={disabled || !text.trim()}
              className="send-button"
              aria-label="Send"
            >
              <span className="send-icon">↑</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
