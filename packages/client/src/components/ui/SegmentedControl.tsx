/**
 * The shared one-of-many picker (plan 182, family 3; topics/ui-design.md,
 * "Switches and segmented controls").
 *
 * A radio group: the container is `role="radiogroup"`, each option a
 * `role="radio"` button with `aria-checked`. The group is one tab stop (the
 * selected option, or the first enabled one when nothing is selected);
 * arrow keys, Home and End move focus and select, skipping disabled
 * options, as in the WAI-ARIA radio group pattern.
 *
 * Two looks, one behavior:
 * - `segmented` (default): options inside one track, the selected one
 *   filled. For short labels: sizes, modes, views (Source/Preview).
 * - `cards`: each option a bordered card, the selected one outlined in the
 *   accent. For options with an icon, a swatch or a description.
 *
 * `layout` is `inline` (hug the content and wrap), `fill` (span the row,
 * equal widths) or `stack` (one option per row, full width).
 *
 * Name the group with `aria-label` or `aria-labelledby`. An option whose
 * label is not text (an icon, a swatch) needs `ariaLabel`. `tooltip` shows
 * through TooltipLayer like IconButton's. A caller's `className` adds layout
 * to the group only; an option's `className` hooks it for content styling
 * (a font preview), not for its frame.
 */
import { type KeyboardEvent, type ReactNode, type Ref, useRef } from "react";
import { useTextTooltipAttributes } from "../../hooks/useTooltipAppearance";
import styles from "./SegmentedControl.module.css";

export type SegmentedValue = string | number;

export interface SegmentedOption<T extends SegmentedValue> {
  value: T;
  label: ReactNode;
  /** Shown before the label: an icon, a status dot, a swatch. */
  icon?: ReactNode;
  /** A second line under the label (cards look). */
  description?: ReactNode;
  disabled?: boolean;
  /** Accessible name when `label` is not text. */
  ariaLabel?: string;
  /** Tooltip text, shown through TooltipLayer or `title` per the setting. */
  tooltip?: string;
  /** Content styling hook for this option (not its frame). */
  className?: string;
  "data-testid"?: string;
}

export interface SegmentedControlProps<T extends SegmentedValue> {
  options: readonly SegmentedOption<T>[];
  /** The selected value; `null`/`undefined` selects nothing. */
  value: T | null | undefined;
  onChange: (value: T) => void;
  variant?: "segmented" | "cards";
  layout?: "inline" | "fill" | "stack";
  size?: "default" | "small";
  disabled?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  id?: string;
  className?: string;
  "data-testid"?: string;
  ref?: Ref<HTMLDivElement>;
}

function joinClasses(...names: (string | false | null | undefined)[]) {
  return names.filter(Boolean).join(" ");
}

const NEXT_KEYS: Record<string, 1 | -1 | "first" | "last"> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
  Home: "first",
  End: "last",
};

export function SegmentedControl<T extends SegmentedValue>({
  options,
  value,
  onChange,
  variant = "segmented",
  layout = "inline",
  size = "default",
  disabled = false,
  className,
  ref,
  ...rest
}: SegmentedControlProps<T>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = (index: number) => !disabled && !options[index]?.disabled;
  const selectedIndex = options.findIndex((option) => option.value === value);
  const tabStop =
    selectedIndex >= 0 && enabled(selectedIndex)
      ? selectedIndex
      : options.findIndex((_, index) => enabled(index));

  const cards = variant === "cards";
  const optionClass = joinClasses(
    cards ? styles.card : styles.segment,
    size === "small" && (cards ? styles.cardSmall : styles.segmentSmall),
    layout === "fill" && styles.fillOption,
    layout === "stack" && styles.stackOption,
  );

  const handleKeyDown = (event: KeyboardEvent, index: number) => {
    const step = NEXT_KEYS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const count = options.length;
    let next = step === "first" ? 0 : step === "last" ? count - 1 : index;
    const direction = step === "last" ? -1 : step === "first" ? 1 : step;
    if (typeof step === "number") next = (index + step + count) % count;
    for (let tries = 0; tries < count && !enabled(next); tries += 1) {
      next = (next + direction + count) % count;
    }
    const option = options[next];
    if (!option || !enabled(next)) return;
    buttons.current[next]?.focus();
    if (option.value !== value) onChange(option.value);
  };

  return (
    <div
      {...rest}
      ref={ref}
      role="radiogroup"
      aria-disabled={disabled || undefined}
      className={joinClasses(
        styles.group,
        cards ? styles.cards : styles.segmented,
        layout === "fill" && styles.fill,
        layout === "stack" && styles.stack,
        className,
      )}
    >
      {options.map((option, index) => (
        <Segment
          key={String(option.value)}
          option={option}
          className={optionClass}
          checked={index === selectedIndex}
          disabled={!enabled(index)}
          tabIndex={index === tabStop ? 0 : -1}
          buttonRef={(element) => {
            buttons.current[index] = element;
          }}
          onSelect={() => {
            if (option.value !== value) onChange(option.value);
          }}
          onKeyDown={(event) => handleKeyDown(event, index)}
        />
      ))}
    </div>
  );
}

function Segment<T extends SegmentedValue>({
  option,
  className,
  checked,
  disabled,
  tabIndex,
  buttonRef,
  onSelect,
  onKeyDown,
}: {
  option: SegmentedOption<T>;
  className: string;
  checked: boolean;
  disabled: boolean;
  tabIndex: number;
  buttonRef: (element: HTMLButtonElement | null) => void;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
}) {
  const tooltipAttributes = useTextTooltipAttributes(option.tooltip);
  return (
    <button
      {...tooltipAttributes}
      ref={buttonRef}
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={option.ariaLabel}
      tabIndex={tabIndex}
      disabled={disabled}
      data-testid={option["data-testid"]}
      className={joinClasses(styles.option, className, option.className)}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      {option.icon ? (
        <span className={styles.icon} aria-hidden="true">
          {option.icon}
        </span>
      ) : null}
      {option.description ? (
        <span className={styles.text}>
          <span className={styles.label}>{option.label}</span>
          <span className={styles.description}>{option.description}</span>
        </span>
      ) : (
        <span className={styles.label}>{option.label}</span>
      )}
    </button>
  );
}
