/**
 * The shared button family (plan 182, family 1; topics/ui-design.md).
 *
 * - `Button`: a labelled button in a shared variant and size.
 * - `IconButton`: an icon-only button. Its required `label` is the
 *   accessible name and, unless `tooltip` says more, the tooltip:
 *   `data-tooltip` for TooltipLayer in themed mode, `title` in native mode
 *   (the user's tooltip setting).
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
import { Spinner } from "./Spinner";

export const BUTTON_VARIANTS = [
  "primary",
  "secondary",
  "outline",
  "ghost",
  "link",
  "success-outline",
  "attention-outline",
  "danger",
  "danger-outline",
] as const;
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];
/**
 * `dense` is for controls inside dense rows (transcript tool rows, code
 * lines, hover-revealed copy actions): 22 px drawn, with a larger invisible
 * hit area on coarse pointers so the row keeps its height. `large` keeps
 * header navigation/menu targets at 36 px with a mouse and 44 px on touch.
 */
export type ButtonSize = "default" | "small" | "dense" | "large";

const VARIANT_CLASS: Record<ButtonVariant, string | undefined> = {
  primary: styles.primary,
  secondary: styles.secondary,
  outline: styles.outline,
  ghost: styles.ghost,
  link: styles.link,
  "success-outline": styles.successOutline,
  "attention-outline": styles.attentionOutline,
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
  elevated = false,
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: boolean;
  elevated?: boolean;
  className?: string;
} = {}): string {
  return joinClasses(
    styles.button,
    VARIANT_CLASS[variant],
    size === "small" && styles.small,
    size === "large" && styles.large,
    size === "dense" && styles.dense,
    icon && styles.icon,
    elevated && styles.elevated,
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
  /** Opaque surface and shadow for actions floating above content. */
  elevated?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

function BusySpinner() {
  return <Spinner size="small" />;
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
  elevated = false,
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
      className={buttonClassName({ variant, size, elevated, className })}
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
  /**
   * Tooltip text when it says more than the name, such as a gesture hint or
   * a state ("Reload: the file changed on disk"). Defaults to `label`.
   */
  tooltip?: string;
  /** The icon, usually an inline SVG marked aria-hidden. */
  children: ReactNode;
}

export function IconButton({
  label,
  tooltip,
  variant = "ghost",
  size = "default",
  type = "button",
  busy = false,
  elevated = false,
  className,
  children,
  onClick,
  ref,
  ...rest
}: IconButtonProps) {
  const handleClick = guardBusyClick(busy, onClick);
  const tooltipAttributes = useTextTooltipAttributes(tooltip ?? label);
  return (
    <button
      {...rest}
      {...tooltipAttributes}
      ref={ref}
      type={type}
      className={buttonClassName({
        variant,
        size,
        icon: true,
        elevated,
        className,
      })}
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
