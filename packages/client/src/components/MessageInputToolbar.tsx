import type { UploadedFile } from "@yep-anywhere/shared";
import type { RefObject } from "react";
import { useModelSettings } from "../hooks/useModelSettings";
import type { ContextUsage, PermissionMode } from "../types";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import { ModeSelector } from "./ModeSelector";
import { VoiceInputButton, type VoiceInputButtonRef } from "./VoiceInputButton";

export interface MessageInputToolbarProps {
  // Mode selector
  mode?: PermissionMode;
  onModeChange?: (mode: PermissionMode) => void;
  isModePending?: boolean;
  isHeld?: boolean;
  onHoldChange?: (held: boolean) => void;

  // Provider capability flags (default to true for backwards compatibility)
  supportsPermissionMode?: boolean;
  supportsThinkingToggle?: boolean;

  // Attachments
  canAttach?: boolean;
  attachmentCount?: number;
  onAttachClick?: () => void;

  // Voice input
  voiceButtonRef?: RefObject<VoiceInputButtonRef | null>;
  onVoiceTranscript?: (transcript: string) => void;
  onInterimTranscript?: (transcript: string) => void;
  onListeningStart?: () => void;
  voiceDisabled?: boolean;

  // Context usage
  contextUsage?: ContextUsage;

  // Actions
  isRunning?: boolean;
  isThinking?: boolean;
  onStop?: () => void;
  onSend?: () => void;
  canSend?: boolean;
  disabled?: boolean;

  // Pending approval indicator
  pendingApproval?: {
    type: "tool-approval" | "user-question";
    onExpand: () => void;
  };
}

export function MessageInputToolbar({
  mode = "default",
  onModeChange,
  isModePending,
  isHeld,
  onHoldChange,
  supportsPermissionMode = true,
  supportsThinkingToggle = true,
  canAttach,
  attachmentCount = 0,
  onAttachClick,
  voiceButtonRef,
  onVoiceTranscript,
  onInterimTranscript,
  onListeningStart,
  voiceDisabled,
  contextUsage,
  isRunning,
  isThinking,
  onStop,
  onSend,
  canSend,
  disabled,
  pendingApproval,
}: MessageInputToolbarProps) {
  const { thinkingEnabled, toggleThinking, thinkingLevel } = useModelSettings();

  return (
    <div className="message-input-toolbar">
      <div className="message-input-left">
        {onModeChange && supportsPermissionMode && (
          <ModeSelector
            mode={mode}
            onModeChange={onModeChange}
            isModePending={isModePending}
            isHeld={isHeld}
            onHoldChange={onHoldChange}
          />
        )}
        <button
          type="button"
          className="attach-button"
          onClick={onAttachClick}
          disabled={!canAttach}
          title={
            canAttach
              ? "Attach files"
              : "Send a message first to enable attachments"
          }
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
          {attachmentCount > 0 && (
            <span className="attach-count">{attachmentCount}</span>
          )}
        </button>
        {supportsThinkingToggle && (
          <button
            type="button"
            className={`thinking-toggle-button ${thinkingEnabled ? "active" : ""}`}
            onClick={toggleThinking}
            title={
              thinkingEnabled
                ? `Extended thinking: ${thinkingLevel}`
                : "Enable extended thinking"
            }
            aria-pressed={thinkingEnabled}
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
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </button>
        )}
        {voiceButtonRef && onVoiceTranscript && onInterimTranscript && (
          <VoiceInputButton
            ref={voiceButtonRef}
            onTranscript={onVoiceTranscript}
            onInterimTranscript={onInterimTranscript}
            onListeningStart={onListeningStart}
            disabled={voiceDisabled}
          />
        )}
      </div>
      <div className="message-input-actions">
        {/* Pending approval indicator */}
        {pendingApproval && (
          <button
            type="button"
            className={`pending-approval-indicator ${pendingApproval.type}`}
            onClick={pendingApproval.onExpand}
            title={
              pendingApproval.type === "tool-approval"
                ? "Expand tool approval"
                : "Expand question"
            }
          >
            <span className="pending-approval-dot" />
            <span className="pending-approval-text">
              {pendingApproval.type === "tool-approval"
                ? "Approval"
                : "Question"}
            </span>
          </button>
        )}
        <ContextUsageIndicator usage={contextUsage} size={16} />
        {/* Show stop button when thinking and nothing to send, otherwise show send */}
        {isRunning && onStop && isThinking && !canSend ? (
          <button
            type="button"
            onClick={onStop}
            className="stop-button"
            aria-label="Stop"
          >
            <span className="stop-icon" />
          </button>
        ) : onSend ? (
          <button
            type="button"
            onClick={onSend}
            disabled={disabled || !canSend}
            className="send-button"
            aria-label="Send"
          >
            <span className="send-icon">↑</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
