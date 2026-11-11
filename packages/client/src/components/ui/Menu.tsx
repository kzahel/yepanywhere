/**
 * The shared action menu (plan 182, family 2): a `Popover` holding
 * `role="menu"` with roving focus.
 *
 * - Opening from the keyboard focuses the first enabled item (a pointer
 *   open leaves focus alone until an arrow key); ArrowUp/ArrowDown wrap,
 *   Home/End jump, a printable key jumps to the next item starting with it,
 *   Tab closes and moves on from the trigger. Keys typed in a field inside
 *   the menu stay with the field.
 * - `MenuItem` runs `onSelect` and closes the menu, unless `keepOpen` or the
 *   handler calls `event.preventDefault()`. `checked` makes it a
 *   `menuitemradio` (`kind="radio"`) or `menuitemcheckbox`. Disabled items
 *   stay focusable (`aria-disabled`) so their tooltip still explains why.
 * - `selection` on `Menu` says how checked items look: a leading dot or
 *   check (`mark`, the default) or a tinted row (`highlight`).
 * - `useMenuTrigger` wires a trigger button: ref, `aria-haspopup`,
 *   `aria-expanded`, toggle on click, and ArrowDown to open.
 */
import {
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTextTooltipAttributes } from "../../hooks/useTooltipAppearance";
import styles from "./Menu.module.css";
import { Popover, type PopoverCloseReason, type PopoverProps } from "./Popover";

export type MenuCloseReason = PopoverCloseReason | "tab";

/**
 * How a checked item shows that it is checked: `mark` puts a dot (radio) or
 * check (checkbox) in a leading column; `highlight` tints the row instead,
 * as a select's list does, for rows that already lead with their own dots
 * or badges.
 */
export type MenuSelectionStyle = "mark" | "highlight";

interface MenuContextValue {
  close: (reason: MenuCloseReason) => void;
  selection: MenuSelectionStyle;
}

const MenuContext = createContext<MenuContextValue | null>(null);

const ITEM_SELECTOR =
  '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest("input, textarea, select") !== null)
  );
}

/**
 * Whether the latest input was a key. A menu opened by pointer leaves focus
 * where it was, as menus here always did: moving it would take it from the
 * composer (collapsing its layout, or a phone's keyboard) for a click.
 */
let keyboardModality = false;
if (typeof document !== "undefined") {
  const fromKeyboard = () => {
    keyboardModality = true;
  };
  document.addEventListener("keydown", fromKeyboard, true);
  document.addEventListener(
    "pointerdown",
    () => {
      keyboardModality = false;
    },
    true,
  );
  // A click with no pointer detail came from Enter, Space or assistive
  // technology.
  document.addEventListener(
    "click",
    (event) => {
      if (event.detail === 0) fromKeyboard();
    },
    true,
  );
}

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
}

function isEnabled(item: HTMLElement): boolean {
  return item.getAttribute("aria-disabled") !== "true";
}

export interface MenuProps
  extends Omit<PopoverProps, "onClose" | "role" | "surface"> {
  onClose: (reason: MenuCloseReason) => void;
  /** Focus the first enabled item on open. Default true. */
  autoFocus?: boolean;
  /** How checked items are shown. Default `mark`. */
  selection?: MenuSelectionStyle;
}

export function Menu({
  open,
  onClose,
  autoFocus = true,
  selection = "mark",
  onKeyDown,
  className,
  children,
  ...popover
}: MenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const context = useMemo<MenuContextValue>(
    () => ({ close: (reason) => onCloseRef.current(reason), selection }),
    [selection],
  );

  useLayoutEffect(() => {
    if (!open || !autoFocus || !keyboardModality) return;
    const items = menuItems(menuRef.current).filter(isEnabled);
    // A one-of-several menu opens on its current choice.
    const checked = items.find(
      (item) =>
        item.getAttribute("role") === "menuitemradio" &&
        item.getAttribute("aria-checked") === "true",
    );
    (checked ?? items[0])?.focus({ preventScroll: true });
  }, [open, autoFocus]);

  // Opened by pointer, the menu does not hold focus; the first arrow key
  // (outside a text field) brings it in.
  useLayoutEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const menuElement = menuRef.current;
      if (!menuElement || menuElement.contains(document.activeElement)) return;
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      if (isEditable(event.target)) return;
      const items = menuItems(menuElement).filter(isEnabled);
      const item =
        event.key === "ArrowUp" || event.key === "End"
          ? items.at(-1)
          : items[0];
      if (!item) return;
      event.preventDefault();
      item.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Tab") {
      onCloseRef.current("tab");
      return;
    }
    if (isEditable(event.target)) return;
    const items = menuItems(menuRef.current);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (index: number) => {
      const count = items.length;
      items[((index % count) + count) % count]?.focus({ preventScroll: true });
    };
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(current < 0 ? 0 : current + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        focusAt(current < 0 ? items.length - 1 : current - 1);
        return;
      case "Home":
        event.preventDefault();
        focusAt(0);
        return;
      case "End":
        event.preventDefault();
        focusAt(items.length - 1);
        return;
    }
    if (
      event.key.length === 1 &&
      event.key !== " " &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const key = event.key.toLocaleLowerCase();
      for (let step = 1; step <= items.length; step += 1) {
        const index = (Math.max(current, 0) + step) % items.length;
        // The label, not the check glyph or a leading badge.
        const item = items[index];
        const text = (
          item?.querySelector("[data-menu-label]")?.textContent ??
          item?.textContent
        )
          ?.trim()
          .toLocaleLowerCase();
        if (text?.startsWith(key)) {
          event.preventDefault();
          focusAt(index);
          return;
        }
      }
    }
  };

  return (
    <Popover
      {...popover}
      ref={menuRef}
      open={open}
      onClose={onClose}
      role="menu"
      className={[styles.menu, className].filter(Boolean).join(" ")}
      onKeyDown={handleKeyDown}
    >
      <MenuContext.Provider value={context}>{children}</MenuContext.Provider>
    </Popover>
  );
}

export interface MenuItemProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onSelect" | "type"> {
  onSelect?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Leading glyph, decorative. */
  icon?: ReactNode;
  /** A second, muted line under the label. */
  description?: ReactNode;
  /** Trailing hint, such as a keyboard shortcut. */
  shortcut?: ReactNode;
  /** `danger` for destructive actions. */
  tone?: "default" | "danger";
  /** Makes the item checkable; `kind` says whether it is one of several. */
  checked?: boolean;
  kind?: "radio" | "checkbox";
  /** Tooltip text; for a disabled item, why it is disabled. */
  tooltip?: string;
  /** Keep the menu open after selecting (toggles, disclosures). */
  keepOpen?: boolean;
  ref?: RefObject<HTMLButtonElement | null>;
}

export function MenuItem({
  onSelect,
  icon,
  description,
  shortcut,
  tone = "default",
  checked,
  kind = "checkbox",
  tooltip,
  keepOpen = false,
  disabled = false,
  className,
  children,
  onClick,
  ...rest
}: MenuItemProps) {
  const menu = useContext(MenuContext);
  const tooltipAttributes = useTextTooltipAttributes(tooltip);
  const descriptionId = useId();
  const checkable = checked !== undefined;
  const highlight = checkable && menu?.selection === "highlight";
  const role = checkable
    ? kind === "radio"
      ? "menuitemradio"
      : "menuitemcheckbox"
    : "menuitem";
  return (
    <button
      {...tooltipAttributes}
      {...rest}
      type="button"
      role={role}
      tabIndex={-1}
      {...(checkable ? { "aria-checked": checked } : {})}
      aria-disabled={disabled || undefined}
      aria-describedby={
        description
          ? [rest["aria-describedby"], descriptionId].filter(Boolean).join(" ")
          : rest["aria-describedby"]
      }
      className={[
        styles.item,
        tone === "danger" ? styles.danger : undefined,
        highlight && checked ? styles.selected : undefined,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
        onSelect?.(event);
        if (!keepOpen && !event.defaultPrevented) menu?.close("select");
      }}
    >
      {checkable && !highlight ? (
        <span className={styles.check} aria-hidden="true">
          {checked ? (kind === "radio" ? "●" : "✓") : ""}
        </span>
      ) : null}
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className={styles.text}>
        <span className={styles.label} data-menu-label>
          {children}
        </span>
        {description ? (
          <span id={descriptionId} className={styles.description}>
            {description}
          </span>
        ) : null}
      </span>
      {shortcut ? (
        <span className={styles.shortcut} aria-hidden="true">
          {shortcut}
        </span>
      ) : null}
    </button>
  );
}

export interface MenuLinkItemProps
  extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  icon?: ReactNode;
  description?: ReactNode;
  shortcut?: ReactNode;
  tooltip?: string;
  /**
   * A plain click (no modifier, main button). Call `event.preventDefault()`
   * to navigate in-app instead of following `href`. The menu closes after
   * it; a modifier or middle click opens the link the browser's way and
   * leaves the menu open.
   */
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>) => void;
  ref?: RefObject<HTMLAnchorElement | null>;
}

/**
 * A menu item that is a link: it keeps the browser's link affordances
 * (copy link, open in a new tab, the URL preview).
 */
export function MenuLinkItem({
  icon,
  description,
  shortcut,
  tooltip,
  onNavigate,
  className,
  children,
  onClick,
  ...rest
}: MenuLinkItemProps) {
  const menu = useContext(MenuContext);
  const tooltipAttributes = useTextTooltipAttributes(tooltip);
  const descriptionId = useId();
  return (
    <a
      {...tooltipAttributes}
      {...rest}
      role="menuitem"
      tabIndex={-1}
      aria-describedby={
        description
          ? [rest["aria-describedby"], descriptionId].filter(Boolean).join(" ")
          : rest["aria-describedby"]
      }
      className={[styles.item, className].filter(Boolean).join(" ")}
      onKeyDown={(event) => {
        rest.onKeyDown?.(event);
        // Space activates a menu item, link or not.
        if (event.key === " " && !event.defaultPrevented) {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}
      // biome-ignore lint/a11y/useValidAnchor: a real href; the click only closes the menu or routes in-app
      onClick={(event) => {
        onClick?.(event);
        const modified =
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey;
        if (modified) return;
        onNavigate?.(event);
        menu?.close("select");
      }}
    >
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className={styles.text}>
        <span className={styles.label} data-menu-label>
          {children}
        </span>
        {description ? (
          <span id={descriptionId} className={styles.description}>
            {description}
          </span>
        ) : null}
      </span>
      {shortcut ? (
        <span className={styles.shortcut} aria-hidden="true">
          {shortcut}
        </span>
      ) : null}
    </a>
  );
}

export function MenuSeparator() {
  return <div role="separator" className={styles.separator} />;
}

export function MenuGroup({
  label,
  children,
}: {
  /** Visible heading that names the group. */
  label?: ReactNode;
  children: ReactNode;
}) {
  const labelId = useId();
  return (
    <div
      role="group"
      aria-labelledby={label ? labelId : undefined}
      className={styles.group}
    >
      {label ? (
        <div id={labelId} className={styles.groupLabel}>
          {label}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/**
 * Open state and trigger wiring for a menu. Spread `triggerProps` on the
 * trigger button and pass `anchorRef`, `open` and `onClose` to `Menu`.
 */
export function useMenuTrigger<T extends HTMLElement = HTMLButtonElement>({
  onOpenChange,
}: {
  onOpenChange?: (open: boolean) => void;
} = {}) {
  const [open, setOpenState] = useState(false);
  const openRef = useRef(false);
  const anchorRef = useRef<T | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const setOpen = useCallback((next: boolean) => {
    if (openRef.current === next) return;
    openRef.current = next;
    setOpenState(next);
    onOpenChangeRef.current?.(next);
  }, []);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const triggerProps = {
    ref: anchorRef,
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    onClick: () => setOpen(!open),
    onKeyDown: (event: KeyboardEvent<T>) => {
      if (event.key === "ArrowDown" && !open) {
        event.preventDefault();
        setOpen(true);
      }
    },
  };
  return { open, setOpen, close, anchorRef, triggerProps };
}
