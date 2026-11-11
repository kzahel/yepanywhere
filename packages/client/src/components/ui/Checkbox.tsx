/**
 * The shared checkbox and radio (plan 182, family 4; topics/ui-design.md,
 * "Fields").
 *
 * Native inputs in the accent color, with an optional label (clicking it
 * toggles) and a muted description line linked through
 * `aria-describedby`. A checkbox picks several independent things (a
 * selection, a filter, an "also do this" beside a form); one setting on or
 * off that applies at once is a `Switch`, and one of several values a
 * `SegmentedControl`. `Radio` is for a choice whose options are spread
 * across separate rows or cards (a default among listed services), where a
 * SegmentedControl cannot hold them; it shares a `name`.
 *
 * Without `label`, pass `aria-label` or `aria-labelledby`. A caller's
 * `className` adds layout to the root only. `indeterminate` shows a mixed
 * state (a select-all box over a partial selection).
 */
import {
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  useCallback,
  useId,
} from "react";
import styles from "./Checkbox.module.css";

type NativeInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "checked" | "onChange" | "size" | "children" | "className" | "style"
>;

interface ChoiceProps extends NativeInputProps {
  /** Row spacing, selectable option surface, or compact toolbar alignment. */
  variant?: "default" | "row" | "option" | "toolbar";
  /** A 44px labelled touch row, preserving mouse density. */
  touchTarget?: "large";
  checked?: boolean;
  /** Called with the new state; the event is there for callers that need it. */
  onCheckedChange?: (
    checked: boolean,
    event: ChangeEvent<HTMLInputElement>,
  ) => void;
  /** Visible text beside the box. Without it, pass `aria-label`. */
  label?: ReactNode;
  /** A muted second line under the label. */
  description?: ReactNode;
  /** Layout for the root element (margins, flex placement). */
  className?: string;
  ref?: Ref<HTMLInputElement>;
}

export interface CheckboxProps extends ChoiceProps {
  /** Shows a mixed state; the checked value is unchanged. */
  indeterminate?: boolean;
}

function Choice({
  type,
  checked,
  onCheckedChange,
  label,
  description,
  variant = "default",
  touchTarget,
  className,
  disabled,
  indeterminate,
  ref,
  ...rest
}: CheckboxProps & { type: "checkbox" | "radio" }) {
  const generated = useId();
  const hasLabel = label !== undefined && label !== null && label !== false;
  const descriptionId = description ? `${generated}-description` : undefined;
  // The label element wraps the description too; name the box from the
  // label text alone so the description stays a description.
  const labelId =
    hasLabel && description && !rest["aria-label"] && !rest["aria-labelledby"]
      ? `${generated}-label`
      : undefined;
  const setRef = useCallback(
    (node: HTMLInputElement | null) => {
      if (node) node.indeterminate = Boolean(indeterminate);
      if (typeof ref === "function") return ref(node);
      if (ref) ref.current = node;
    },
    [ref, indeterminate],
  );
  const input = (
    <input
      {...rest}
      ref={setRef}
      type={type}
      className={styles.box}
      checked={checked}
      disabled={disabled}
      aria-labelledby={labelId ?? rest["aria-labelledby"]}
      aria-describedby={
        [rest["aria-describedby"], descriptionId].filter(Boolean).join(" ") ||
        undefined
      }
      onChange={(event) => onCheckedChange?.(event.target.checked, event)}
    />
  );
  const variants = {
    default: undefined,
    row: styles.row,
    option: styles.option,
    toolbar: styles.toolbar,
  };
  const rootClass = [
    styles.root,
    variants[variant],
    touchTarget && styles.largeTouch,
    disabled && styles.disabled,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  if (!hasLabel && !description)
    return <span className={`${rootClass} ${styles.bare}`}>{input}</span>;
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the input is inside.
    <label className={rootClass}>
      {input}
      <span className={styles.text}>
        {hasLabel ? (
          <span id={labelId} className={styles.label}>
            {label}
          </span>
        ) : null}
        {description ? (
          <span id={descriptionId} className={styles.description}>
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export function Checkbox(props: CheckboxProps) {
  return <Choice {...props} type="checkbox" />;
}

export type RadioProps = ChoiceProps;

export function Radio(props: RadioProps) {
  return <Choice {...props} type="radio" />;
}
