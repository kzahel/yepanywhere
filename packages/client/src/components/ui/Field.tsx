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
 * control owns the box, border, colors, padding and type. Width defaults to
 * the container's (zero specificity, so any caller class wins).
 * `size="small"` is the compact box for dense rows and narrow numbers;
 * `mono` sets the code font for commands, paths and tokens.
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
    id: props.id ?? field?.id,
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
  ref?: Ref<HTMLInputElement>;
}

export function TextInput({
  size = "default",
  mono,
  invalid,
  unit,
  className,
  type = "text",
  ref,
  ...rest
}: TextInputProps) {
  const field = useFieldProps({ ...rest, invalid });
  const input = (
    <input
      {...rest}
      {...field}
      ref={ref}
      type={type}
      className={classes(
        styles.input,
        size,
        mono,
        unit === undefined ? className : styles.unitInput,
      )}
    />
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
  mono,
  invalid,
  className,
  ref,
  ...rest
}: TextareaProps) {
  const field = useFieldProps({ ...rest, invalid });
  return (
    <textarea
      {...rest}
      {...field}
      ref={ref}
      className={classes(styles.textarea, size, mono, className)}
    />
  );
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size">,
    SharedProps {
  ref?: Ref<HTMLSelectElement>;
}

export function Select({
  size = "default",
  mono,
  invalid,
  className,
  ref,
  children,
  ...rest
}: SelectProps) {
  const field = useFieldProps({ ...rest, invalid });
  return (
    <select
      {...rest}
      {...field}
      ref={ref}
      className={classes(styles.select, size, mono, className)}
    >
      {children}
    </select>
  );
}
