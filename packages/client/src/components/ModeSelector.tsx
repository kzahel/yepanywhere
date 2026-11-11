import { modeSelectorStateClasses } from "./composerStateClasses";
import modeSelectorStyles from "./ModeSelector.module.css";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useI18n } from "../i18n";
import { getPermissionModeOptions } from "../lib/permissionModes";
import type { PermissionMode } from "../types";

interface ModeSelectorProps {
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  modes?: readonly PermissionMode[];
  disabled?: boolean;
  /** Whether permission mode changes are deferred until the next user turn. */
  changesApplyNextTurn?: boolean;
  /** Whether the selected mode has not reached a provider turn boundary yet. */
  modeChangePending?: boolean;
}

/**
 * Mode selector button that opens an anchored dropdown above the button.
 * Clicking outside the popup or selecting a mode closes it.
 */
export function ModeSelector({
  mode,
  onModeChange,
  modes,
  disabled,
  changesApplyNextTurn = false,
  modeChangePending = false,
}: ModeSelectorProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const handleButtonClick = () => {
    if (!disabled) {
      // Blur button to remove focus ring before sheet appears
      buttonRef.current?.blur();
      setIsOpen(true);
    }
  };

  const handleModeSelect = (
    selectedMode: PermissionMode,
    e?: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    e?.preventDefault();
    e?.stopPropagation();
    onModeChange(selectedMode);
    setIsOpen(false);
  };

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handleClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [isOpen, handleClose]);

  // Close on click outside.
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        sheetRef.current &&
        !sheetRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        handleClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, handleClose]);

  // Focus the sheet when opened for accessibility
  useEffect(() => {
    if (isOpen) {
      sheetRef.current?.focus();
    }
  }, [isOpen]);

  const modeLabels: Record<PermissionMode, string> = {
    default: t("modeDefaultLabel" as never),
    acceptEdits: t("modeAcceptEditsLabel" as never),
    plan: t("modePlanLabel" as never),
    bypassPermissions: t("modeBypassPermissionsLabel" as never),
    auto: t("modeAutoLabel" as never),
  };
  const modeOptions = modes ?? getPermissionModeOptions({ currentMode: mode });

  const displayLabel = modeLabels[mode];
  const displayDotClass = modeSelectorStateClasses[`mode-${mode}`];
  const showNextTurnTiming = changesApplyNextTurn || modeChangePending;
  const buttonTitle = showNextTurnTiming
    ? `${t("modeClickToSelect" as never)} - ${t("modeNextTurnHint" as never)}`
    : t("modeClickToSelect" as never);

  // Shared dropdown options content
  const optionsContent = (
    <>
      {showNextTurnTiming && (
        <div
          className={modeSelectorStyles["mode-selector-timing-note"]}
          role="status"
        >
          {t("modeNextTurnHint" as never)}
        </div>
      )}

      {/* Permission mode options */}
      {modeOptions.map((m) => (
        <button
          key={m}
          type="button"
          className={`${modeSelectorStyles["mode-selector-option"]} ${mode === m ? modeSelectorStyles.selected : ""}`}
          onClick={(e) => handleModeSelect(m, e)}
          aria-pressed={mode === m}
        >
          <span
            className={`${modeSelectorStyles["mode-dot"]} ${modeSelectorStateClasses[`mode-${m}`] ?? ""}`}
          />
          <span className={modeSelectorStyles["mode-selector-label"]}>
            {modeLabels[m]}
          </span>
          {mode === m && (
            <span
              className={modeSelectorStyles["mode-selector-check"]}
              aria-hidden="true"
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
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
          )}
        </button>
      ))}
    </>
  );

  const dropdown = isOpen ? (
    <div
      ref={sheetRef}
      className={modeSelectorStyles["mode-selector-dropdown"]}
      data-mode-selector-dropdown
      role="dialog"
      tabIndex={-1}
      aria-label={t("modeSelectLabel" as never)}
    >
      <div className={modeSelectorStyles["mode-selector-options"]}>
        {optionsContent}
      </div>
    </div>
  ) : null;

  return (
    <div
      className={modeSelectorStyles["mode-selector-container"]}
      data-mode-selector-container
    >
      <button
        ref={buttonRef}
        type="button"
        className={modeSelectorStyles["mode-button"]}
        data-mode-button
        onClick={handleButtonClick}
        disabled={disabled}
        title={buttonTitle}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span
          className={`${modeSelectorStyles["mode-dot"]} ${displayDotClass}`}
        />
        <span className={modeSelectorStyles["mode-button-label"]}>
          {displayLabel}
          {modeChangePending ? ` ${t("modePendingSuffix" as never)}` : null}
        </span>
      </button>
      {dropdown}
    </div>
  );
}
