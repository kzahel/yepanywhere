import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const DESKTOP_BREAKPOINT = 769;
const SLASH_COMMAND_LABEL = "Slash commands";

interface SlashCommandButtonProps {
  /** Available slash commands (without the "/" prefix) */
  commands: string[];
  /** Callback when a command is selected */
  onSelectCommand: (command: string) => void;
  /** Whether the button should be disabled */
  disabled?: boolean;
}

/**
 * Button that shows available slash commands in a dropdown menu.
 * Selecting a command inserts "/{command}" into the message input.
 */
export function SlashCommandButton({
  commands,
  onSelectCommand,
  disabled,
}: SlashCommandButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(
    () => window.innerWidth >= DESKTOP_BREAKPOINT,
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    buttonRef.current?.blur();
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setIsDesktop(window.innerWidth >= DESKTOP_BREAKPOINT);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Close menu when clicking outside
  useEffect(() => {
    if (!isOpen || !isDesktop) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        handleClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [handleClose, isDesktop, isOpen]);

  // Close menu on Escape
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
        buttonRef.current?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [handleClose, isOpen]);

  // Mobile bottom sheet should prevent background scrolling while open.
  useEffect(() => {
    if (isOpen && !isDesktop) {
      const previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = previousOverflow;
      };
    }
  }, [isDesktop, isOpen]);

  useEffect(() => {
    if (isOpen) {
      menuRef.current?.focus();
    }
  }, [isOpen]);

  const handleCommandClick = useCallback(
    (command: string) => {
      onSelectCommand(`/${command}`);
      handleClose();
    },
    [handleClose, onSelectCommand],
  );

  const handleToggle = useCallback(() => {
    if (disabled) return;

    if (isOpen) {
      handleClose();
      buttonRef.current?.focus();
      return;
    }

    buttonRef.current?.blur();
    setIsOpen(true);
  }, [disabled, handleClose, isOpen]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      e.preventDefault();
      e.stopPropagation();
      handleClose();
    }
  };

  // Don't render if no commands available
  if (commands.length === 0) {
    return null;
  }

  const commandItems = commands.map((command) => (
    <button
      key={command}
      type="button"
      className="slash-command-item"
      onClick={() => handleCommandClick(command)}
      role="menuitem"
    >
      /{command}
    </button>
  ));

  const desktopMenu =
    isOpen && isDesktop ? (
      <div
        ref={menuRef}
        className="slash-command-menu"
        role="menu"
        aria-label={SLASH_COMMAND_LABEL}
        tabIndex={-1}
      >
        {commandItems}
      </div>
    ) : null;

  const mobileSheet =
    isOpen && !isDesktop
      ? createPortal(
          // biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled globally
          <div
            className="slash-command-overlay"
            onClick={handleOverlayClick}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div
              ref={menuRef}
              className="slash-command-sheet"
              role="menu"
              aria-label={SLASH_COMMAND_LABEL}
              tabIndex={-1}
            >
              <div className="slash-command-header">
                <span className="slash-command-title">
                  {SLASH_COMMAND_LABEL}
                </span>
              </div>
              <div className="slash-command-sheet-list">{commandItems}</div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="slash-command-container">
      <button
        ref={buttonRef}
        type="button"
        className={`slash-command-button ${isOpen ? "active" : ""}`}
        onClick={handleToggle}
        disabled={disabled}
        title={SLASH_COMMAND_LABEL}
        aria-label="Show slash commands"
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <span className="slash-icon">/</span>
      </button>
      {desktopMenu}
      {mobileSheet}
    </div>
  );
}
