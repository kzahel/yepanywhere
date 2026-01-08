import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Breakpoint for desktop behavior (should match CSS)
const DESKTOP_BREAKPOINT = 769;

export interface FilterOption<T extends string> {
  value: T;
  label: string;
  count?: number;
  color?: string; // For provider colors (colored dot)
}

export interface FilterDropdownProps<T extends string> {
  label: string;
  options: FilterOption<T>[];
  selected: T[];
  onChange: (selected: T[]) => void;
  multiSelect?: boolean; // default true
  placeholder?: string; // shown when nothing selected
}

/**
 * Filter dropdown that opens a bottom sheet (mobile) or dropdown (desktop).
 * Supports multi-select with checkboxes and optional colored dots.
 * Clicking outside the popup or pressing Escape closes it.
 */
export function FilterDropdown<T extends string>({
  label,
  options,
  selected,
  onChange,
  multiSelect = true,
  placeholder,
}: FilterDropdownProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(
    () => window.innerWidth >= DESKTOP_BREAKPOINT,
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const handleButtonClick = () => {
    buttonRef.current?.blur();
    setIsOpen(true);
  };

  const handleOptionClick = (value: T) => {
    if (multiSelect) {
      if (selected.includes(value)) {
        onChange(selected.filter((v) => v !== value));
      } else {
        onChange([...selected, value]);
      }
    } else {
      onChange([value]);
      setIsOpen(false);
    }
  };

  const handleClearAll = () => {
    onChange([]);
  };

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setIsDesktop(window.innerWidth >= DESKTOP_BREAKPOINT);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

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

  useEffect(() => {
    if (!isOpen || !isDesktop) return;
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
  }, [isOpen, isDesktop, handleClose]);

  useEffect(() => {
    if (isOpen && !isDesktop) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [isOpen, isDesktop]);

  useEffect(() => {
    if (isOpen) {
      sheetRef.current?.focus();
    }
  }, [isOpen]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      e.preventDefault();
      e.stopPropagation();
      handleClose();
    }
  };

  // For single-select, show the selected option's label; for multi-select, show count
  const displayText = (() => {
    if (selected.length === 0) {
      return placeholder || label;
    }
    if (!multiSelect && selected.length === 1) {
      const selectedOption = options.find((o) => o.value === selected[0]);
      return selectedOption?.label || label;
    }
    return `${label} (${selected.length})`;
  })();

  const optionsContent = (
    <>
      {multiSelect && selected.length > 0 && (
        <>
          <button
            type="button"
            className="filter-dropdown-option filter-dropdown-clear"
            onClick={handleClearAll}
          >
            <span className="filter-dropdown-label">Clear all</span>
          </button>
          <div className="filter-dropdown-divider" />
        </>
      )}

      {options.map((option) => {
        const isSelected = selected.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            className={`filter-dropdown-option ${isSelected ? "selected" : ""} ${!multiSelect ? "single-select" : ""}`}
            onClick={() => handleOptionClick(option.value)}
            aria-pressed={isSelected}
          >
            {multiSelect && (
              <span
                className={`filter-dropdown-checkbox ${isSelected ? "checked" : ""}`}
                aria-hidden="true"
              >
                {isSelected && (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </span>
            )}

            {option.color && (
              <span
                className="filter-dropdown-color-dot"
                style={{ backgroundColor: option.color }}
                aria-hidden="true"
              />
            )}

            <span className="filter-dropdown-label">{option.label}</span>

            {option.count !== undefined && (
              <span className="filter-dropdown-count">{option.count}</span>
            )}
          </button>
        );
      })}
    </>
  );

  const mobileSheet =
    isOpen && !isDesktop
      ? createPortal(
          // biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled globally
          <div
            className="filter-dropdown-overlay"
            onClick={handleOverlayClick}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div
              ref={sheetRef}
              className="filter-dropdown-sheet"
              tabIndex={-1}
              aria-label={`Filter by ${label}`}
            >
              <div className="filter-dropdown-header">
                <span className="filter-dropdown-title">{label}</span>
              </div>
              <div className="filter-dropdown-options">{optionsContent}</div>
            </div>
          </div>,
          document.body,
        )
      : null;

  const desktopDropdown =
    isOpen && isDesktop ? (
      <div
        ref={sheetRef}
        className="filter-dropdown-dropdown"
        tabIndex={-1}
        aria-label={`Filter by ${label}`}
      >
        <div className="filter-dropdown-options">{optionsContent}</div>
      </div>
    ) : null;

  return (
    <div className="filter-dropdown-container">
      <button
        ref={buttonRef}
        type="button"
        className={`filter-dropdown-button ${selected.length > 0 ? "has-selection" : ""}`}
        onClick={handleButtonClick}
        title={`Filter by ${label}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        {displayText}
        <svg
          className="filter-dropdown-chevron"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {desktopDropdown}
      {mobileSheet}
    </div>
  );
}
