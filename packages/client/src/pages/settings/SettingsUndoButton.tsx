import { useEffect } from "react";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import type { SettingsUndoRegistration } from "./SettingsUndoContext";

const SETTINGS_UNDO_SHORTCUT = "Ctrl+Z / ⌘Z";
const TEXT_INPUT_TYPES = new Set([
  "date",
  "datetime-local",
  "email",
  "month",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "time",
  "url",
  "week",
]);

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) {
    return true;
  }
  return (
    target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)
  );
}

interface SettingsUndoButtonProps {
  registration: SettingsUndoRegistration | null;
  paneTitle: string;
}

export function SettingsUndoButton({
  registration,
  paneTitle,
}: SettingsUndoButtonProps) {
  const { t } = useI18n();
  const canUndo = registration?.canUndo ?? false;
  const tooltip = t("settingsUndoSnapshotTooltip", {
    page: paneTitle,
    shortcut: SETTINGS_UNDO_SHORTCUT,
  });

  useEffect(() => {
    if (!canUndo || !registration) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        event.shiftKey ||
        (!event.ctrlKey && !event.metaKey) ||
        event.key.toLowerCase() !== "z" ||
        isTextEditingTarget(event.target)
      ) {
        return;
      }

      event.preventDefault();
      void registration.undo();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canUndo, registration]);

  return (
    <Button
      onClick={() => void registration?.undo()}
      title={canUndo ? tooltip : undefined}
      aria-label={canUndo ? tooltip : t("settingsUndoChanges")}
      disabled={!canUndo}
      aria-hidden={!canUndo}
      tabIndex={canUndo ? 0 : -1}
      style={{ visibility: canUndo ? "visible" : "hidden" }}
    >
      {t("settingsUndoChanges")}
    </Button>
  );
}
