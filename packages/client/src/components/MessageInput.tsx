import { type KeyboardEvent, useState } from "react";
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
}

export function MessageInput({
  onSend,
  disabled,
  placeholder,
  mode = "default",
  onModeChange,
}: Props) {
  const [text, setText] = useState("");

  const handleSubmit = () => {
    if (text.trim() && !disabled) {
      onSend(text.trim());
      setText("");
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.shiftKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
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
        <button
          type="button"
          onClick={handleSubmit}
          disabled={disabled || !text.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
