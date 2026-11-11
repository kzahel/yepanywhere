/**
 * The shared text fields (plan 182, family 4; topics/ui-design.md,
 * "Fields").
 *
 * - `Field`: a label above one control, with an optional hint and error
 *   below. It names the control (`<label htmlFor>`), links the hint and
 *   error through `aria-describedby`, and marks the control
 *   `aria-invalid` while `error` is set and `required` when asked. The
 *   control inside picks these up from context, so a caller writes
 *   `<Field label="URL" hint="…"><TextInput value=… /></Field>`.
 * - `TextInput`: a single-line `<input>` (text, password, url, email,
 *   search, number, …). `unit` puts a muted unit after a narrow number box.
 * - `Textarea`: a multi-line field that grows only when dragged.
 * - `Select`: a native `<select>` drawn as a field with a chevron.
 *
 * All of them are plain elements with no state of their own: the caller's
 * `value`/`onChange` (or `defaultValue`) reach the element untouched, so a
 * keystroke costs nothing beyond the caller's own render (AGENTS.md, the
 * 100 ms typing rule). They take `ref` and every native attribute. A
 * caller's `className` adds layout (width, margins, flex placement); the
 * control owns the box, border, colors, padding and type. Inputs and
 * textareas fill the container and selects size to their options, at zero
 * specificity, so any caller class wins.
 * `size="small"` is the compact box for dense rows and narrow numbers;
 * `mono` sets the code font for commands, paths and tokens. A Textarea is
 * three rows tall unless `rows` says otherwise.
 */
import {
  createContext,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useContext,
  useId,
} from "react";
import styles from "./Field.module.css";

interface FieldContextValue {
  id: string;
  describedBy?: string;
  invalid: boolean;
  required?: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export interface FieldProps {
  label: ReactNode;
  /** Help under the control, linked through aria-describedby. */
  hint?: ReactNode;
  /** Error under the control; also marks it aria-invalid. */
  error?: ReactNode;
  /** Marks the control required and the label with an asterisk. */
  required?: boolean;
  /** The control's id; generated when omitted. */
  id?: string;
  /** Layout for the root (grid span, margins). */
  className?: string;
  children: ReactNode;
}

export function Field({
  label,
  hint,
  error,
  required,
  id,
  className,
  children,
}: FieldProps) {
  const generated = useId();
  const controlId = id ?? `field-${generated}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className ? `${styles.field} ${className}` : styles.field}>
      <label className={styles.label} htmlFor={controlId}>
        {label}
        {required ? (
          <span className={styles.required} aria-hidden="true">
            {" *"}
          </span>
        ) : null}
      </label>
      <FieldContext.Provider
        value={{
          id: controlId,
          describedBy,
          invalid: Boolean(error),
          required,
        }}
      >
        {children}
      </FieldContext.Provider>
      {hint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

type ControlSize = "default" | "small";

interface SharedProps {
  size?: ControlSize;
  /** Keep compact mouse geometry, with a 44px control on coarse pointers. */
  touchTarget?: "large";
  /** The code font, for commands, paths, tokens and ids. */
  mono?: boolean;
  /** Marks the control aria-invalid (a Field with an error does this). */
  invalid?: boolean;
}

/** Merge the enclosing Field's id, descriptions and state into props. */
function useFieldProps(props: {
  id?: string;
  required?: boolean;
  invalid?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: InputHTMLAttributes<HTMLInputElement>["aria-invalid"];
}) {
  const field = useContext(FieldContext);
  const describedBy =
    [props["aria-describedby"], field?.describedBy].filter(Boolean).join(" ") ||
    undefined;
  const invalid =
    props.invalid ||
    field?.invalid ||
    props["aria-invalid"] === true ||
    props["aria-invalid"] === "true";
  return {
    // Inside a Field the Field's id wins, so its label always names it.
    id: field?.id ?? props.id,
    required: props.required ?? field?.required,
    "aria-describedby": describedBy,
    "aria-invalid": invalid ? true : props["aria-invalid"],
  };
}

function classes(
  base: string | undefined,
  size: ControlSize,
  mono: boolean | undefined,
  className: string | undefined,
) {
  return [
    base,
    size === "small" && styles.small,
    mono && styles.mono,
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size">,
    SharedProps {
  /** A unit after the box (`px`, `s`, `%`); the box narrows to a number. */
  unit?: ReactNode;
  /** With a unit or slots, `className` lays out the wrapper; this sizes the input. */
  inputClassName?: string;
  /** Decorative content before the input, excluded from its accessible name. */
  leading?: ReactNode;
  /** A clear action, shortcut, or other content after the input. */
  trailing?: ReactNode;
  /** Suppress the browser's search clear only when a replacement is supplied. */
  hideNativeSearchClear?: boolean;
  ref?: Ref<HTMLInputElement>;
}

export function TextInput(props: TextInputProps) {
  const {
    size = "default",
    touchTarget,
    mono,
    invalid,
    unit,
    inputClassName,
    leading,
    trailing,
    hideNativeSearchClear,
    className,
    type = "text",
    ref,
    ...rest
  } = props;
  const field = useFieldProps({ ...rest, invalid });
  // A disappearing action must never replace the focused input DOM node.
  const adorned = "leading" in props || "trailing" in props;
  const input = (
    <input
      {...rest}
      {...field}
      ref={ref}
      type={type}
      className={
        classes(
          styles.input,
          size,
          mono,
          adorned
            ? [styles.adornedInput, inputClassName].filter(Boolean).join(" ")
            : unit === undefined
              ? className
              : [styles.unitInput, inputClassName].filter(Boolean).join(" "),
        ) +
        (touchTarget ? ` ${styles.largeTouch}` : "") +
        (hideNativeSearchClear ? ` ${styles.hideNativeSearchClear}` : "")
      }
    />
  );
  if (adorned)
    return (
      <span
        className={
          classes(styles.adorned, size, mono, className) +
          (touchTarget ? ` ${styles.largeTouch}` : "")
        }
        data-disabled={rest.disabled || undefined}
        data-invalid={field["aria-invalid"] || undefined}
        data-readonly={rest.readOnly || undefined}
      >
        {leading != null && (
          <span className={styles.leading} aria-hidden="true">
            {leading}
          </span>
        )}
        {input}
        {unit != null && <span className={styles.unitText}>{unit}</span>}
        {trailing != null && (
          <span className={styles.trailing}>{trailing}</span>
        )}
      </span>
    );
  if (unit === undefined) return input;
  return (
    <span className={className ? `${styles.unit} ${className}` : styles.unit}>
      {input}
      <span className={styles.unitText}>{unit}</span>
    </span>
  );
}

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement>,
    SharedProps {
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({
  size = "default",
  touchTarget,
  mono,
  invalid,
  className,
  rows = 3,
  ref,
  ...rest
}: TextareaProps) {
  const field = useFieldProps({ ...rest, invalid });
  return (
    <textarea
      {...rest}
      rows={rows}
      {...field}
      ref={ref}
      className={
        classes(styles.textarea, size, mono, className) +
        (touchTarget ? ` ${styles.largeTouch}` : "")
      }
    />
  );
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size">,
    SharedProps {
  ref?: Ref<HTMLSelectElement>;
  /** Decorative icon before the selected value. */
  leading?: ReactNode;
}

export function Select(props: SelectProps) {
  const {
    size = "default",
    touchTarget,
    mono,
    invalid,
    className,
    ref,
    children,
    leading,
    ...rest
  } = props;
  const field = useFieldProps({ ...rest, invalid });
  const select = (
    <select
      {...rest}
      {...field}
      ref={ref}
      className={
        classes(
          styles.select,
          size,
          mono,
          !("leading" in props)
            ? className
            : leading == null
              ? undefined
              : styles.selectWithLeading,
        ) + (touchTarget ? ` ${styles.largeTouch}` : "")
      }
    >
      {children}
    </select>
  );
  return !("leading" in props) ? (
    select
  ) : (
    <span
      className={[styles.selectShell, className].filter(Boolean).join(" ")}
      data-disabled={rest.disabled || undefined}
    >
      <span className={styles.selectLeading} aria-hidden="true">
        {leading}
      </span>
      {select}
    </span>
  );
}
