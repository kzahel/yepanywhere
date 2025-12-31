import { type KeyboardEvent, useCallback, useEffect } from "react";
import { ENTER_SENDS_MESSAGE } from "../constants";
import {
  type DraftControls,
  useDraftPersistence,
} from "../hooks/useDraftPersistence";
import type { PermissionMode } from "../types";

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
}: Props) {
  const [text, setText, controls] = useDraftPersistence(draftKey);

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
      {!collapsed && (
        <div className="message-input-toolbar">
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
          <div className="message-input-actions">
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
