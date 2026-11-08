/**
 * The shared button family (plan 182, family 1; topics/ui-design.md).
 *
 * - `Button`: a labelled button in one of six variants and two sizes.
 * - `IconButton`: an icon-only button. Its required `label` is both the
 *   accessible name and the tooltip: `data-tooltip` for TooltipLayer in
 *   themed mode, `title` in native mode (the user's tooltip setting).
 * - `ButtonBase`: an unstyled button for clickable rows, cards, disclosure
 *   arrows and chips. It resets the user-agent look, keeps the focus ring and
 *   defaults `type` to "button"; the owner supplies every other style.
 * - `buttonClassName`: the same look for an `<a>` or router `Link` that acts
 *   as a button-shaped navigation target.
 *
 * Every component passes ordinary button attributes through (including
 * `data-testid` and `aria-*`), accepts `ref` (React 19 ref-as-prop), and
 * defaults `type` to "button" so it never submits a form by accident. A
 * caller's `className` adds layout (margins, flex placement, width), not
 * colors, borders or padding: the control owns its look.
 */
import type {
  ButtonHTMLAttributes,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  Ref,
} from "react";
import { useTextTooltipAttributes } from "../../hooks/useTooltipAppearance";
import styles from "./Button.module.css";

export const BUTTON_VARIANTS = [
  "primary",
  "secondary",
  "outline",
  "ghost",
  "danger",
  "danger-outline",
] as const;
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];
export type ButtonSize = "default" | "small";

const VARIANT_CLASS: Record<ButtonVariant, string | undefined> = {
  primary: styles.primary,
  secondary: styles.secondary,
  outline: styles.outline,
  ghost: styles.ghost,
  danger: styles.danger,
  "danger-outline": styles.dangerOutline,
};

function joinClasses(...names: (string | false | null | undefined)[]) {
  return names.filter(Boolean).join(" ");
}

export function buttonClassName({
  variant = "secondary",
  size = "default",
  icon = false,
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: boolean;
  className?: string;
} = {}): string {
  return joinClasses(
    styles.button,
    VARIANT_CLASS[variant],
    size === "small" && styles.small,
    icon && styles.icon,
    className,
  );
}

type NativeButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type">;

export interface ButtonProps extends NativeButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: "button" | "submit" | "reset";
  /**
   * Work is in progress: shows a spinner, sets `aria-busy` and ignores
   * clicks while keeping focus (unlike `disabled`, which drops it).
   */
  busy?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

function BusySpinner() {
  return <span className={styles.spinner} aria-hidden="true" />;
}

function guardBusyClick(
  busy: boolean,
  onClick: ButtonProps["onClick"],
): ButtonProps["onClick"] {
  if (!busy) return onClick;
  return (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
  };
}

export function Button({
  variant = "secondary",
  size = "default",
  type = "button",
  busy = false,
  className,
  children,
  onClick,
  ref,
  ...rest
}: ButtonProps) {
  const handleClick = guardBusyClick(busy, onClick);
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={buttonClassName({ variant, size, className })}
      aria-busy={busy || undefined}
      aria-disabled={busy || rest["aria-disabled"] || undefined}
      onClick={handleClick}
    >
      {busy ? <BusySpinner /> : null}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, "children"> {
  /** Accessible name and tooltip. Required: the button has no text. */
  label: string;
  /** The icon, usually an inline SVG marked aria-hidden. */
  children: ReactNode;
}

export function IconButton({
  label,
  variant = "ghost",
  size = "default",
  type = "button",
  busy = false,
  className,
  children,
  onClick,
  ref,
  ...rest
}: IconButtonProps) {
  const handleClick = guardBusyClick(busy, onClick);
  const tooltip = useTextTooltipAttributes(label);
  return (
    <button
      {...rest}
      {...tooltip}
      ref={ref}
      type={type}
      className={buttonClassName({ variant, size, icon: true, className })}
      aria-label={label}
      aria-busy={busy || undefined}
      aria-disabled={busy || rest["aria-disabled"] || undefined}
      onClick={handleClick}
    >
      {busy ? <BusySpinner /> : children}
    </button>
  );
}

export interface ButtonBaseProps extends NativeButtonProps {
  type?: "button" | "submit" | "reset";
  ref?: Ref<HTMLButtonElement>;
}

export function ButtonBase({
  type = "button",
  className,
  ref,
  ...rest
}: ButtonBaseProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={joinClasses(styles.base, className)}
    />
  );
}
