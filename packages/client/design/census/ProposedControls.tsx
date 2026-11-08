/**
 * Census prototypes of the proposed canonical controls. They exist so the
 * census can show each proposal beside the legacy variants it would absorb;
 * the chosen API moves into src/components/ui/ in plan 182's family slices.
 * Buttons have moved: the census renders src/components/ui/Button.tsx.
 */
import { type KeyboardEvent, useRef, useState } from "react";
import styles from "./proposed.module.css";

export function ProposedSwitch({
  label,
  initial = false,
  disabled = false,
}: {
  label: string;
  initial?: boolean;
  disabled?: boolean;
}) {
  const [checked, setChecked] = useState(initial);
  return (
    <span className={styles.switchRow}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={styles.switch}
        disabled={disabled}
        onClick={() => setChecked((value) => !value)}
      />
      <span aria-hidden="true">{label}</span>
    </span>
  );
}

/** Radio-group semantics: one tab stop, arrow keys move the selection. */
export function ProposedSegmented({
  label,
  options,
  initial,
  disabled = false,
}: {
  label: string;
  options: readonly string[];
  initial: string;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (event: KeyboardEvent, index: number) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    setValue(options[next] ?? value);
    buttons.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={styles.segmented}>
      {options.map((option, index) => (
        <button
          key={option}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={option === value}
          tabIndex={option === value ? 0 : -1}
          className={styles.segment}
          disabled={disabled}
          onClick={() => setValue(option)}
          onKeyDown={(event) => move(event, index)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
