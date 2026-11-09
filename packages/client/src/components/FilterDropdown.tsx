import { Fragment, type ReactNode } from "react";
import { useI18n } from "../i18n";
import styles from "./FilterDropdown.module.css";
import { Button } from "./ui/Button";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuSeparator,
  useMenuTrigger,
} from "./ui/Menu";

function cx(...classNames: (string | false | undefined)[]): string {
  return classNames.filter(Boolean).join(" ");
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
  /** Caller-owned class for the container around the trigger. */
  className?: string;
}

interface OptionSegment<T extends string> {
  label?: string;
  options: FilterDropdownOption<T>[];
}

/**
 * Select or multi-select filter: a trigger chip that opens a shared `Menu`,
 * anchored below the trigger, or a bottom sheet on phones. Multi-select
 * options are checkboxes that keep the menu open; single-select options are
 * radios that close it. An outside press or Escape closes it.
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
  const menu = useMenuTrigger();

  const hasClearSelectionOption = options.some(
    (option) => option.clearSelection,
  );

  const handleOptionSelect = (option: FilterDropdownOption<T>) => {
    if (option.clearSelection) {
      onChange([]);
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
  const menuLabel = t("filterByLabel", { label });

  // A divider or group label starts a new run of options; a labelled run is
  // a named group.
  const segments: OptionSegment<T>[] = [];
  for (const option of options) {
    const current = segments.at(-1);
    if (!current || option.dividerBefore || option.groupLabelBefore) {
      segments.push({ label: option.groupLabelBefore, options: [option] });
    } else {
      current.options.push(option);
    }
  }

  const renderOption = (option: FilterDropdownOption<T>) => {
    const isSelected = option.clearSelection
      ? selected.length === 0
      : selected.includes(option.value);
    return (
      <MenuItem
        key={option.value}
        kind={multiSelect ? "checkbox" : "radio"}
        checked={isSelected}
        disabled={option.disabled}
        keepOpen={multiSelect && !option.clearSelection}
        description={option.description}
        // A model's provider badge leads the row, so the name and its
        // description line up after it.
        icon={
          isModelPanel && option.icon ? (
            <span className={styles.modelBadge}>{option.icon}</span>
          ) : undefined
        }
        onSelect={() => handleOptionSelect(option)}
      >
        <span className={styles.optionRow}>
          {option.color && (
            <span
              className={styles.colorDot}
              style={{ backgroundColor: option.color }}
              aria-hidden="true"
            />
          )}
          {option.icon && !isModelPanel && (
            <span className={styles.optionIcon} aria-hidden="true">
              {option.icon}
            </span>
          )}
          <span className={styles.optionLabel}>{option.label}</span>
          {option.meta && <span className={styles.meta}>{option.meta}</span>}
          {option.count !== undefined && (
            <span className={styles.count}>{option.count}</span>
          )}
        </span>
      </MenuItem>
    );
  };

  return (
    <div
      className={cx(styles.container, fullWidth && styles.fullWidth, className)}
    >
      <Button
        {...menu.triggerProps}
        variant={triggerVariant === "chip" ? "ghost" : "secondary"}
        className={cx(
          styles.button,
          selected.length > 0 && styles.hasSelection,
          fullWidth && styles.fullWidth,
          triggerVariant === "chip" && styles.chip,
          triggerClassName,
        )}
        title={triggerTitle ?? menuLabel}
        aria-label={triggerTitle ?? menuLabel}
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
      <Menu
        open={menu.open}
        onClose={menu.close}
        anchorRef={menu.anchorRef}
        placement={align === "right" ? "bottom-end" : "bottom-start"}
        phoneSheet
        maxHeight="min(60vh, 480px)"
        aria-label={menuLabel}
        className={isModelPanel ? styles.modelMenu : undefined}
      >
        {multiSelect && selected.length > 0 && !hasClearSelectionOption && (
          <>
            <MenuItem onSelect={() => onChange([])}>
              {t("filterClearAll")}
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        {segments.map((segment, index) => (
          <Fragment key={segment.options[0]?.value ?? index}>
            {index > 0 && <MenuSeparator />}
            {segment.label ? (
              <MenuGroup label={segment.label}>
                {segment.options.map(renderOption)}
              </MenuGroup>
            ) : (
              segment.options.map(renderOption)
            )}
          </Fragment>
        ))}
      </Menu>
    </div>
  );
}
