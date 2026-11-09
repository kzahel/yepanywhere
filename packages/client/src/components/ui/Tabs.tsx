/**
 * The shared tab strip (plan 182, family 5; topics/ui-design.md, "Banners,
 * badges, spinners and tabs").
 *
 * WAI-ARIA tabs: `role="tablist"` with `role="tab"` buttons carrying
 * `aria-selected`. The strip is one tab stop (the selected tab); Left and
 * Right arrows, Home and End move between tabs, skipping disabled ones, and
 * select them (`activation="manual"`: arrows move focus, Space or Enter
 * selects, for tabs whose switch is costly).
 *
 * Panels: pass the strip an `id` and wrap the visible pane in
 * `<TabPanel tabsId={id} value={tab}>`; the selected tab then points at it
 * (`aria-controls`) and the panel is labelled by its tab. Without an `id`
 * the strip still works, for tabs that swap content the caller renders.
 *
 * Two looks, one behavior: `underline` (default; tabs on a rule, the
 * selected one underlined in the accent) heads a pane, a dialog or a panel;
 * `pill` (tabs in a sunken track, the selected one raised) sits inside a
 * toolbar or page header. `layout="fill"` spreads tabs across the row in
 * equal columns whose labels wrap, `fill-phone` only on narrow screens.
 * Underline strips wrap onto a second row rather than scroll. A tab takes
 * `icon` (decorative: a state it shows, such as answered, also goes in
 * `ariaLabel`), `count` (a count badge, part of the name unless `ariaLabel`
 * replaces it) and `ariaLabel`. A caller's
 * `className` adds layout (margins, placement) to the strip only.
 */
import {
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useRef,
  useState,
} from "react";
import { Badge } from "./Badge";
import styles from "./Tabs.module.css";

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  /** Before the label: an icon or a state mark. Decorative. */
  icon?: ReactNode;
  /** A count shown after the label; hidden when zero or absent. */
  count?: number;
  disabled?: boolean;
  /** Accessible name when the label alone is not enough. */
  ariaLabel?: string;
  "data-testid"?: string;
}

export interface TabsProps<T extends string> {
  tabs: readonly TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  variant?: "underline" | "pill";
  /** `fill`: equal columns; `fill-phone`: equal columns at ≤760 px only. */
  layout?: "inline" | "fill" | "fill-phone";
  activation?: "automatic" | "manual";
  /** Base id; tabs become `<id>-tab-<value>`, panels `<id>-panel-<value>`. */
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
  "data-testid"?: string;
  ref?: Ref<HTMLDivElement>;
}

export function tabId(tabsId: string, value: string) {
  return `${tabsId}-tab-${value}`;
}

export function tabPanelId(tabsId: string, value: string) {
  return `${tabsId}-panel-${value}`;
}

const NEXT_KEYS: Record<string, 1 | -1 | "first" | "last"> = {
  ArrowRight: 1,
  ArrowLeft: -1,
  Home: "first",
  End: "last",
};

function joinClasses(...names: (string | false | null | undefined)[]) {
  return names.filter(Boolean).join(" ");
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  variant = "underline",
  layout = "inline",
  activation = "automatic",
  id,
  className,
  ref,
  ...rest
}: TabsProps<T>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [focused, setFocused] = useState<number | null>(null);
  const enabled = (index: number) => !tabs[index]?.disabled;
  const selectedIndex = tabs.findIndex((tab) => tab.value === value);
  const tabStop =
    activation === "manual" && focused !== null && enabled(focused)
      ? focused
      : selectedIndex >= 0 && enabled(selectedIndex)
        ? selectedIndex
        : tabs.findIndex((_, index) => enabled(index));

  const handleKeyDown = (event: KeyboardEvent, index: number) => {
    const step = NEXT_KEYS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const count = tabs.length;
    let next = step === "first" ? 0 : step === "last" ? count - 1 : index;
    const direction = step === "last" ? -1 : step === "first" ? 1 : step;
    if (typeof step === "number") next = (index + step + count) % count;
    for (let tries = 0; tries < count && !enabled(next); tries += 1) {
      next = (next + direction + count) % count;
    }
    const tab = tabs[next];
    if (!tab || !enabled(next)) return;
    buttons.current[next]?.focus();
    if (activation === "manual") setFocused(next);
    else if (tab.value !== value) onChange(tab.value);
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
      setFocused(null);
  };

  const pill = variant === "pill";
  return (
    <div
      {...rest}
      ref={ref}
      id={id}
      role="tablist"
      aria-orientation="horizontal"
      onBlur={activation === "manual" ? handleBlur : undefined}
      className={joinClasses(
        styles.tabs,
        pill ? styles.pillTabs : styles.underlineTabs,
        layout === "fill" && styles.fill,
        layout === "fill-phone" && styles.fillPhone,
        className,
      )}
    >
      {tabs.map((tab, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={tab.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="tab"
            id={id ? tabId(id, tab.value) : undefined}
            aria-controls={
              id && selected ? tabPanelId(id, tab.value) : undefined
            }
            aria-selected={selected}
            aria-label={tab.ariaLabel}
            disabled={tab.disabled}
            tabIndex={index === tabStop ? 0 : -1}
            data-testid={tab["data-testid"]}
            className={joinClasses(
              styles.tab,
              pill ? styles.pill : styles.underline,
              layout !== "inline" && styles.fillTab,
            )}
            onClick={() => {
              if (activation === "manual") setFocused(index);
              if (tab.value !== value) onChange(tab.value);
            }}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {tab.icon ? (
              <span className={styles.icon} aria-hidden="true">
                {tab.icon}
              </span>
            ) : null}
            <span className={styles.label}>{tab.label}</span>
            {tab.count ? (
              <Badge size="small" shape="count">
                {tab.count}
              </Badge>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  tabsId: string;
  value: string;
  children?: ReactNode;
  className?: string;
  /** A panel with no focusable content of its own gets a tab stop. */
  focusable?: boolean;
  "data-testid"?: string;
}

export function TabPanel({
  tabsId,
  value,
  children,
  className,
  focusable = false,
  "data-testid": testId,
}: TabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={tabPanelId(tabsId, value)}
      aria-labelledby={tabId(tabsId, value)}
      tabIndex={focusable ? 0 : undefined}
      className={className}
      data-testid={testId}
    >
      {children}
    </div>
  );
}
