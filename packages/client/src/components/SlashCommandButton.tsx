import slashStyles from "./SlashCommandButton.module.css";
import {
  getCanonicalInvocationToken,
  type SlashCommand,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { getSlashCommandMenuParts } from "../lib/slashCommands";

interface SlashCommandButtonProps {
  /** Available provider and client commands. */
  commands: SlashCommand[];
  /** Callback when a command is selected */
  onSelectCommand: (command: SlashCommand) => void;
  /** Whether the button should be disabled */
  disabled?: boolean;
}

/**
 * Button that shows available slash commands in a dropdown menu.
 * Selecting a command inserts its provider-canonical invocation token.
 */
export function SlashCommandButton({
  commands,
  onSelectCommand,
  disabled,
}: SlashCommandButtonProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{
    bottom: number;
    left: number;
  } | null>(null);
  const displayCommands = useMemo(() => {
    const preferredByName = new Map<string, SlashCommand>();
    for (const command of commands) {
      const normalizedName = command.name.trim().toLowerCase();
      const existing = preferredByName.get(normalizedName);
      if (
        !existing ||
        (existing.invocation?.kind === "skill" &&
          command.invocation?.kind !== "skill")
      ) {
        preferredByName.set(normalizedName, command);
      }
    }
    return commands.filter(
      (command) =>
        preferredByName.get(command.name.trim().toLowerCase()) === command,
    );
  }, [commands]);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Close menu on Escape
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // Close on resize so stale position doesn't persist
  useEffect(() => {
    if (!isOpen) return;
    const handleResize = () => setIsOpen(false);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [isOpen]);

  const handleToggle = useCallback(() => {
    if (!isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setMenuPos({
        bottom: window.innerHeight - rect.top + 4,
        left: rect.left,
      });
    }
    setIsOpen((prev) => !prev);
  }, [isOpen]);

  const handleCommandClick = useCallback(
    (command: SlashCommand) => {
      onSelectCommand(command);
      setIsOpen(false);
    },
    [onSelectCommand],
  );

  // Don't render if no commands available
  if (commands.length === 0) {
    return null;
  }

  return (
    <div className={slashStyles.slashCommandContainer}>
      <button
        data-slash-command-button
        ref={buttonRef}
        type="button"
        className={`${slashStyles.slashCommandButton} ${isOpen ? slashStyles.active : ""}`}
        onClick={handleToggle}
        disabled={disabled}
        title={t("slashCommandsLabel")}
        aria-label={t("slashCommandsShow")}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <span className={slashStyles.slashIcon}>/$</span>
      </button>
      {isOpen &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            className={slashStyles.slashCommandMenu}
            style={{
              position: "fixed",
              bottom: menuPos.bottom,
              left: menuPos.left,
            }}
            role="menu"
            aria-label={t("slashCommandsLabel")}
          >
            {displayCommands.map((command) => (
              <SlashCommandMenuItem
                key={`${getCanonicalInvocationToken(command)}:${command.invocation?.kind ?? "legacy"}`}
                command={command}
                onSelect={handleCommandClick}
              />
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

function SlashCommandMenuItem({
  command,
  onSelect,
}: {
  command: SlashCommand;
  onSelect: (command: SlashCommand) => void;
}) {
  const parts = getSlashCommandMenuParts(command);
  return (
    <button
      type="button"
      className={slashStyles.slashCommandItem}
      data-slash-command-item
      onClick={() => onSelect(command)}
      role="menuitem"
      aria-label={parts.label}
    >
      <span className={slashStyles.slashCommandCopy}>
        {/* shortcut + rest is one command word split for highlighting; keep it
            a single inline run so no flex gap lands inside the word. */}
        <span>
          {parts.shortcut && (
            <strong
              className={slashStyles.slashCommandShortcut}
              data-slash-command-shortcut
            >
              {parts.shortcut}
            </strong>
          )}
          {parts.rest}
        </span>
        {(command.description || command.argumentHint) && (
          <span className={slashStyles.slashCommandDetail}>
            {[command.description, command.argumentHint]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
      </span>
    </button>
  );
}
