import type { ReactNode } from "react";
import { CommittedRangeInput } from "./CommittedRangeInput";
import { TextInput } from "./Field";
import styles from "./RangeNumberRow.module.css";

interface RangeNumberRowProps {
  id: string;
  label: ReactNode;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  /** Accessible name for the numeric input (the range input uses the label). */
  numberAriaLabel: string;
  /** Short unit rendered immediately after the exact numeric input. */
  unit?: ReactNode;
  hint?: ReactNode;
  onCommit: (value: number) => void;
  /** Interaction hook fired on focus/pointer-down of either input. */
  onActivate?: () => void;
}

/**
 * The standard settings duration/number control: a slider paired with an
 * exact numeric input, plus an optional explanatory hint underneath.
 */
export function RangeNumberRow({
  id,
  label,
  min,
  max,
  step,
  value,
  disabled = false,
  numberAriaLabel,
  unit,
  hint,
  onCommit,
  onActivate,
}: RangeNumberRowProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={styles.row}>
      <label htmlFor={id}>{label}</label>
      <CommittedRangeInput
        id={id}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onFocus={onActivate}
        onPointerDown={onActivate}
        onCommit={onCommit}
        aria-describedby={hintId}
      />
      <TextInput
        type="number"
        size="small"
        unit={unit || undefined}
        className={unit ? undefined : styles.number}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onFocus={onActivate}
        onPointerDown={onActivate}
        onChange={(event) => onCommit(Number(event.target.value))}
        aria-describedby={hintId}
        aria-label={numberAriaLabel}
      />
      {hint && (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      )}
    </div>
  );
}
