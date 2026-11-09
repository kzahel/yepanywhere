/**
 * The shared on/off switch (plan 182, family 3; topics/ui-design.md,
 * "Switches and segmented controls").
 *
 * A native checkbox with `role="switch"`, drawn as a 44×24 track: Space
 * toggles it, forms and labels work as for any checkbox, and assistive
 * technology announces "switch, on/off". The input covers the track (and,
 * on coarse pointers, a 44 px tall area around it), so a tap anywhere on the
 * track toggles it without a wrapping label.
 *
 * Name it with `label` (visible text beside the track; clicking it toggles)
 * or, when the row's own text names it (a settings row), `aria-label` or
 * `aria-labelledby`. A caller's `className` adds layout to the root only.
 */
import type { ChangeEvent, InputHTMLAttributes, ReactNode, Ref } from "react";
import styles from "./Switch.module.css";

type NativeInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  | "type"
  | "role"
  | "checked"
  | "defaultChecked"
  | "onChange"
  | "size"
  | "children"
  | "className"
  | "style"
>;

export interface SwitchProps extends NativeInputProps {
  checked: boolean;
  /** Called with the new state; the event is there for callers that need it. */
  onCheckedChange?: (
    checked: boolean,
    event: ChangeEvent<HTMLInputElement>,
  ) => void;
  /** Visible text beside the track. Without it, pass `aria-label`. */
  label?: ReactNode;
  /** Where `label` sits relative to the track. */
  labelPosition?: "start" | "end";
  /** Layout for the root element (margins, flex placement). */
  className?: string;
  ref?: Ref<HTMLInputElement>;
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  labelPosition = "end",
  className,
  disabled,
  ref,
  ...rest
}: SwitchProps) {
  const control = (
    <span className={styles.control}>
      <input
        {...rest}
        ref={ref}
        type="checkbox"
        role="switch"
        aria-checked={checked}
        className={styles.input}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange?.(event.target.checked, event)}
      />
      <span className={styles.track} aria-hidden="true" />
    </span>
  );
  const rootClass = [styles.root, disabled && styles.disabled, className]
    .filter(Boolean)
    .join(" ");
  if (label === undefined || label === null || label === false) {
    return <span className={rootClass}>{control}</span>;
  }
  const text = <span className={styles.label}>{label}</span>;
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the input is inside, in {control}.
    <label className={rootClass}>
      {labelPosition === "start" ? text : null}
      {control}
      {labelPosition === "end" ? text : null}
    </label>
  );
}
