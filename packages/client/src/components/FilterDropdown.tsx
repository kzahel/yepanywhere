import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import styles from "./FilterDropdown.module.css";
import { Button } from "./ui/Button";

// Breakpoint for desktop behavior (should match CSS)
const DESKTOP_BREAKPOINT = 769;

// Keep the desktop panel this far from the edge of the visible area.
const PANEL_EDGE_MARGIN = 8;
const CLIPPING_OVERFLOW = new Set(["auto", "scroll", "hidden", "clip"]);

function cx(...classNames: (string | false | undefined)[]): string {
  return classNames.filter(Boolean).join(" ");
}

interface PanelPlacement {
  above: boolean;
  maxHeight: number;
}

/**
 * Vertical extent the panel can occupy without leaving the window or any
 * clipping/scrolling ancestor. A panel that overhangs its scroll container
 * extends that container's scroll height, and the overhanging rows cannot be
 * reached by scrolling inside the panel.
 */
function visibleVerticalBounds(element: HTMLElement): {
  top: number;
  bottom: number;
} {
  let top = 0;
  let bottom = window.innerHeight;
  for (
    let node = element.parentElement;
    node && node !== document.body && node !== document.documentElement;
    node = node.parentElement
  ) {
    if (!CLIPPING_OVERFLOW.has(getComputedStyle(node).overflowY)) continue;
    const rect = node.getBoundingClientRect();
    const clipTop = rect.top + node.clientTop;
    top = Math.max(top, clipTop);
    bottom = Math.min(bottom, clipTop + node.clientHeight);
  }
  return { top, bottom };
}

function computePanelPlacement(
  trigger: HTMLElement,
  panel: HTMLElement,
): PanelPlacement {
  const triggerRect = trigger.getBoundingClientRect();
  const bounds = visibleVerticalBounds(trigger);
  // The trigger gap is a top margin below and a bottom margin above; read
  // both so the decision does not shift once the panel has flipped.
  const panelStyle = getComputedStyle(panel);
  const gap = Math.max(
    Number.parseFloat(panelStyle.marginTop) || 0,
    Number.parseFloat(panelStyle.marginBottom) || 0,
  );
  const spaceBelow = Math.max(
    0,
    bounds.bottom - triggerRect.bottom - gap - PANEL_EDGE_MARGIN,
  );
  const spaceAbove = Math.max(
    0,
    triggerRect.top - bounds.top - gap - PANEL_EDGE_MARGIN,
  );
  const naturalHeight =
    panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
  const above = naturalHeight > spaceBelow && spaceAbove > spaceBelow;
  return {
    above,
    maxHeight: Math.floor(above ? spaceAbove : spaceBelow),
  };
}

export interface FilterOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  description?: string; // Optional description shown below label
  meta?: ReactNode; // Optional trailing metadata, e.g. provider quota usage
  count?: number;
  color?: string; // For provider colors (colored dot)
  clearSelection?: false;
  dividerBefore?: boolean;
  groupLabelBefore?: string;
  disabled?: boolean;
}

export interface FilterResetOption {
  value: string;
  label: string;
  icon?: ReactNode;
  description?: string;
  meta?: ReactNode;
  count?: number;
  color?: string;
  clearSelection: true; // Option row that resets selected values
  dividerBefore?: boolean;
  groupLabelBefore?: string;
  disabled?: boolean;
}

export type FilterDropdownOption<T extends string> =
  | FilterOption<T>
  | FilterResetOption;

export interface FilterDropdownProps<T extends string> {
  label: string;
  options: FilterDropdownOption<T>[];
  selected: T[];
  onChange: (selected: T[]) => void;
  multiSelect?: boolean; // default true
  placeholder?: string; // shown when nothing selected
  placeholderContent?: ReactNode; // overrides placeholder for custom visual summaries
  triggerContent?: ReactNode; // replaces the trigger label entirely (e.g. a badge chip)
  triggerTitle?: string; // title/aria-label override for the trigger button
  align?: "left" | "right"; // dropdown alignment, default left
  /** Stretch the trigger to fill its field, e.g. a settings or form row. */
  fullWidth?: boolean;
  /** "chip" is the borderless trigger used in composer toolbars. */
  triggerVariant?: "default" | "chip";
  /** "model" top-aligns option rows for badge + description layout. */
  panelVariant?: "default" | "model";
  /** Caller-owned class for the trigger button, for caller-specific sizing. */
  triggerClassName?: string;
  /** Caller-owned class for the container and the mobile sheet. */
  className?: string;
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
  placeholderContent,
  triggerContent,
  triggerTitle,
  align = "left",
  fullWidth = false,
  triggerVariant = "default",
  panelVariant = "default",
  triggerClassName,
  className = "",
}: FilterDropdownProps<T>) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [panelPlacement, setPanelPlacement] = useState<PanelPlacement | null>(
    null,
  );
  const [isDesktop, setIsDesktop] = useState(
    () => window.innerWidth >= DESKTOP_BREAKPOINT,
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const handleButtonClick = () => {
    buttonRef.current?.blur();
    setIsOpen((prev) => !prev);
  };

  const hasClearSelectionOption = options.some(
    (option) => option.clearSelection,
  );

  const handleOptionClick = (option: FilterDropdownOption<T>) => {
    if (option.disabled) return;
    if (option.clearSelection) {
      onChange([]);
      setIsOpen(false);
      return;
    }

    const { value } = option;
    if (multiSelect) {
      if (selected.includes(value)) {
        onChange(selected.filter((v) => v !== value));
      } else {
        onChange([...selected, value]);
      }
    } else {
      // Single-select: toggle off if already selected, otherwise select
      if (selected.includes(value)) {
        onChange([]);
      } else {
        onChange([value]);
      }
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
      // Focus for Escape/keyboard handling only; scrolling the page to reveal
      // the panel would leave it scrolled after the menu closes.
      sheetRef.current?.focus({ preventScroll: true });
    }
  }, [isOpen]);

  // Fit the desktop panel into the visible space below the trigger, or above
  // it when that side has more room, so every row is reachable by scrolling
  // inside the panel. Runs before paint, so the panel never shows unplaced,
  // and again when the window resizes or the option list changes size (for
  // example, a model catalog arriving while the panel is open).
  useLayoutEffect(() => {
    if (!isOpen || !isDesktop) {
      setPanelPlacement(null);
      return;
    }
    const place = () => {
      const trigger = buttonRef.current;
      const panel = sheetRef.current;
      if (!trigger || !panel) return;
      const next = computePanelPlacement(trigger, panel);
      setPanelPlacement((prev) =>
        prev?.above === next.above && prev.maxHeight === next.maxHeight
          ? prev
          : next,
      );
    };
    place();
    window.addEventListener("resize", place);
    const optionList = sheetRef.current?.firstElementChild;
    const observer =
      optionList && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(place)
        : null;
    if (optionList) observer?.observe(optionList);
    return () => {
      window.removeEventListener("resize", place);
      observer?.disconnect();
    };
  }, [isOpen, isDesktop]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      e.preventDefault();
      e.stopPropagation();
      handleClose();
    }
  };

  const displayContent = (() => {
    if (selected.length === 0) {
      return placeholderContent ?? placeholder ?? label;
    }
    if (selected.length === 1) {
      const selectedOption = options.find((o) => o.value === selected[0]);
      return selectedOption?.label || label;
    }
    return `${label} (${selected.length})`;
  })();

  const isModelPanel = panelVariant === "model";

  const optionsContent = (
    <>
      {multiSelect && selected.length > 0 && !hasClearSelectionOption && (
        <>
          <button
            type="button"
            className={cx(styles.option, styles.clear)}
            onClick={handleClearAll}
          >
            <span className={styles.label}>{t("filterClearAll")}</span>
          </button>
          <div className={styles.divider} />
        </>
      )}

      {options.map((option) => {
        const isSelected = option.clearSelection
          ? selected.length === 0
          : selected.includes(option.value);
        const showCheckbox = multiSelect && !option.clearSelection;
        return (
          <Fragment key={option.value}>
            {(option.dividerBefore || option.groupLabelBefore) && (
              <div className={styles.divider} />
            )}
            {option.groupLabelBefore && (
              <div className={styles.groupLabel}>{option.groupLabelBefore}</div>
            )}
            <button
              type="button"
              className={cx(
                styles.option,
                isSelected && styles.selected,
                !multiSelect && styles.singleSelect,
                isModelPanel && styles.model,
              )}
              onClick={() => handleOptionClick(option)}
              disabled={option.disabled}
              aria-pressed={isSelected}
            >
              {showCheckbox && (
                <span
                  className={cx(styles.checkbox, isSelected && styles.checked)}
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
              {multiSelect && option.clearSelection && (
                <span className={styles.checkboxSpacer} aria-hidden="true" />
              )}

              {option.color && (
                <span
                  className={styles.colorDot}
                  style={{ backgroundColor: option.color }}
                  aria-hidden="true"
                />
              )}

              {option.icon && (
                <span
                  className={cx(
                    styles.optionIcon,
                    isModelPanel && styles.model,
                  )}
                  aria-hidden="true"
                >
                  {option.icon}
                </span>
              )}

              <span className={styles.labelWrapper}>
                <span className={styles.label}>{option.label}</span>
                {option.description && (
                  <span className={styles.description}>
                    {option.description}
                  </span>
                )}
              </span>

              {option.meta && (
                <span className={styles.meta}>{option.meta}</span>
              )}

              {option.count !== undefined && (
                <span className={styles.count}>{option.count}</span>
              )}
            </button>
          </Fragment>
        );
      })}
    </>
  );

  const mobileSheet =
    isOpen && !isDesktop
      ? createPortal(
          // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes the sheet; Escape is handled globally
          // biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled globally
          <div
            className={styles.overlay}
            onClick={handleOverlayClick}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div
              ref={sheetRef}
              className={cx(styles.sheet, className)}
              role="dialog"
              tabIndex={-1}
              aria-label={t("filterByLabel", { label })}
            >
              <div className={styles.header}>
                <span className={styles.title}>{label}</span>
              </div>
              <div className={styles.options}>{optionsContent}</div>
            </div>
          </div>,
          document.body,
        )
      : null;

  const desktopDropdown =
    isOpen && isDesktop ? (
      <div
        ref={sheetRef}
        className={cx(
          styles.dropdown,
          align === "right" && styles.alignRight,
          panelPlacement?.above && styles.above,
          isModelPanel && styles.model,
        )}
        style={
          panelPlacement
            ? ({
                "--filter-dropdown-available-height": `${panelPlacement.maxHeight}px`,
              } as CSSProperties)
            : undefined
        }
        role="dialog"
        tabIndex={-1}
        aria-label={t("filterByLabel", { label })}
      >
        <div className={styles.options}>{optionsContent}</div>
      </div>
    ) : null;

  return (
    <div
      className={cx(styles.container, fullWidth && styles.fullWidth, className)}
    >
      <Button
        variant={triggerVariant === "chip" ? "ghost" : "secondary"}
        ref={buttonRef}
        className={cx(
          styles.button,
          selected.length > 0 && styles.hasSelection,
          fullWidth && styles.fullWidth,
          triggerVariant === "chip" && styles.chip,
          triggerClassName,
        )}
        onClick={handleButtonClick}
        title={triggerTitle ?? t("filterByLabel", { label })}
        aria-label={triggerTitle ?? t("filterByLabel", { label })}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className={styles.buttonLabel}>
          {triggerContent ?? displayContent}
        </span>
        <svg
          className={styles.chevron}
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
      </Button>
      {desktopDropdown}
      {mobileSheet}
    </div>
  );
}
