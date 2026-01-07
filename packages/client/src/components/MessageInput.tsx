import type { UploadedFile } from "@yep-anywhere/shared";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ENTER_SENDS_MESSAGE } from "../constants";
import {
  type DraftControls,
  useDraftPersistence,
} from "../hooks/useDraftPersistence";
import type { ContextUsage, PermissionMode } from "../types";
import { MessageInputToolbar } from "./MessageInputToolbar";
import type { VoiceInputButtonRef } from "./VoiceInputButton";

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

interface Props {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  mode?: PermissionMode;
  onModeChange?: (mode: PermissionMode) => void;
  isModePending?: boolean;
  isHeld?: boolean;
  onHoldChange?: (held: boolean) => void;
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
  /** Whether the provider supports permission modes (default: true) */
  supportsPermissionMode?: boolean;
  /** Whether the provider supports thinking toggle (default: true) */
  supportsThinkingToggle?: boolean;
}

export function MessageInput({
  onSend,
  disabled,
  placeholder,
  mode = "default",
  onModeChange,
  isModePending,
  isHeld,
  onHoldChange,
  isRunning,
  isThinking,
  onStop,
  draftKey,
  collapsed: externalCollapsed,
  onDraftControlsReady,
  contextUsage,
  projectId,
  sessionId,
  attachments = [],
  onAttach,
  onRemoveAttachment,
  uploadProgress = [],
  supportsPermissionMode = true,
  supportsThinkingToggle = true,
}: Props) {
  const [text, setText, controls] = useDraftPersistence(draftKey);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const voiceButtonRef = useRef<VoiceInputButtonRef>(null);
  // User-controlled collapse state (independent of external collapse from approval panel)
  const [userCollapsed, setUserCollapsed] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");

  // Combined display text: committed text + interim transcript
  const displayText = interimTranscript
    ? text + (text.trimEnd() ? " " : "") + interimTranscript
    : text;

  // Panel is collapsed if user collapsed it OR if externally collapsed (approval panel showing)
  const collapsed = userCollapsed || externalCollapsed;

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
    // Stop voice recording and get any pending interim text
    const pendingVoice = voiceButtonRef.current?.stopAndFinalize() ?? "";

    // Combine committed text with any pending voice text
    let finalText = text.trimEnd();
    if (pendingVoice) {
      finalText = finalText ? `${finalText} ${pendingVoice}` : pendingVoice;
    }

    const hasContent = finalText.trim() || attachments.length > 0;
    if (hasContent && !disabled) {
      const message = finalText.trim();
      // Clear input state but keep localStorage for failure recovery
      controls.clearInput();
      setInterimTranscript("");
      onSend(message);
      // Refocus the textarea so user can continue typing
      textareaRef.current?.focus();
    }
  }, [text, disabled, controls, onSend, attachments.length]);

  const handleKeyDown = (e: KeyboardEvent) => {
    // Ctrl+Space toggles voice input
    if (e.key === " " && e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (voiceButtonRef.current?.isAvailable) {
        voiceButtonRef.current.toggle();
      }
      return;
    }

    if (e.key === "Enter") {
      // On mobile (touch devices), Enter adds newline - must use send button
      // On desktop, Enter sends message, Shift/Ctrl+Enter adds newline
      const isMobile = window.matchMedia("(pointer: coarse)").matches;

      // If voice recording is active, Enter submits (on any device)
      if (voiceButtonRef.current?.isListening) {
        e.preventDefault();
        handleSubmit();
        return;
      }

      if (isMobile) {
        // Mobile: Enter always adds newline, send button required
        // Allow default behavior (newline)
        return;
      }

      if (ENTER_SENDS_MESSAGE) {
        // Desktop: Enter sends, Ctrl+Enter adds newline
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

  const handlePaste = (e: ClipboardEvent) => {
    if (!canAttach || !onAttach) return;

    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length > 0) {
      // Prevent default only if we have files to handle
      // This allows text paste to still work normally
      e.preventDefault();
      onAttach(files);
    }
  };

  // Voice input handlers
  const handleVoiceTranscript = useCallback(
    (transcript: string) => {
      // Append transcript to existing text with space separator
      // Trim the transcript since mobile speech API includes leading/trailing spaces
      const trimmedTranscript = transcript.trim();
      if (!trimmedTranscript) return;

      const trimmedText = text.trimEnd();
      if (trimmedText) {
        setText(`${trimmedText} ${trimmedTranscript}`);
      } else {
        setText(trimmedTranscript);
      }
      setInterimTranscript("");
    },
    [text, setText],
  );

  const handleInterimTranscript = useCallback((transcript: string) => {
    setInterimTranscript(transcript);
  }, []);

  return (
    <div className="message-input-wrapper">
      {/* Floating toggle button - only show when user can control collapse (not externally collapsed) */}
      {!externalCollapsed && (
        <button
          type="button"
          className="message-input-toggle"
          onClick={() => setUserCollapsed(!userCollapsed)}
          aria-label={
            userCollapsed ? "Expand message input" : "Collapse message input"
          }
          aria-expanded={!userCollapsed}
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
            className={userCollapsed ? "chevron-up" : "chevron-down"}
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}
      <div
        className={`message-input ${collapsed ? "message-input-collapsed" : ""} ${interimTranscript ? "voice-recording" : ""}`}
      >
        <textarea
          ref={textareaRef}
          value={displayText}
          onChange={(e) => {
            // If user edits while recording, only update committed text
            // This clears interim since they're now typing
            setInterimTranscript("");
            setText(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            externalCollapsed
              ? "Continue typing while responding above..."
              : placeholder
          }
          disabled={disabled}
          rows={collapsed ? 1 : 3}
        />

        {/* Attachment chips - show below textarea when not collapsed */}
        {!collapsed &&
          (attachments.length > 0 || uploadProgress.length > 0) && (
            <div className="attachment-list">
              {attachments.map((file) => (
                <div key={file.id} className="attachment-chip">
                  <span className="attachment-name" title={file.path}>
                    {file.originalName}
                  </span>
                  <span className="attachment-size">
                    {formatSize(file.size)}
                  </span>
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
                <div
                  key={progress.fileId}
                  className="attachment-chip uploading"
                >
                  <span className="attachment-name">{progress.fileName}</span>
                  <span className="attachment-progress">
                    {progress.percent}%
                  </span>
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
          <MessageInputToolbar
            mode={mode}
            onModeChange={onModeChange}
            isModePending={isModePending}
            isHeld={isHeld}
            onHoldChange={onHoldChange}
            supportsPermissionMode={supportsPermissionMode}
            supportsThinkingToggle={supportsThinkingToggle}
            canAttach={canAttach}
            attachmentCount={attachments.length}
            onAttachClick={() => fileInputRef.current?.click()}
            voiceButtonRef={voiceButtonRef}
            onVoiceTranscript={handleVoiceTranscript}
            onInterimTranscript={handleInterimTranscript}
            onListeningStart={() => textareaRef.current?.focus()}
            voiceDisabled={disabled}
            contextUsage={contextUsage}
            isRunning={isRunning}
            isThinking={isThinking}
            onStop={onStop}
            onSend={handleSubmit}
            canSend={!!(text.trim() || attachments.length > 0)}
            disabled={disabled}
          />
        )}
      </div>
    </div>
  );
}
