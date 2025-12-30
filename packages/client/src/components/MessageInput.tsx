import { type KeyboardEvent, useState } from "react";
import { ENTER_SENDS_MESSAGE } from "../constants";
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
  isRunning?: boolean;
  isThinking?: boolean;
  onStop?: () => void;
}

export function MessageInput({
  onSend,
  disabled,
  placeholder,
  mode = "default",
  onModeChange,
  isRunning,
  isThinking,
  onStop,
}: Props) {
  const [text, setText] = useState("");

  const handleSubmit = () => {
    if (text.trim() && !disabled) {
      onSend(text.trim());
      setText("");
    }
  };

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
    <div className="message-input">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={3}
      />
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
        </button>
        <div className="message-input-actions">
          {isRunning && onStop && (
            <button
              type="button"
              onClick={onStop}
              className="stop-button"
              disabled={!isThinking}
            >
              Stop
            </button>
          )}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={disabled || !text.trim()}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
