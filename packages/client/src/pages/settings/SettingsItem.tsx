import {
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import {
  renderSettingsSearchHighlight,
  SettingsSearchScopeProvider,
  useSettingsJumpTarget,
  useSettingsSearchScope,
} from "./SettingsSearchContext";
import {
  SettingsCaption,
  type SettingsDoc,
  SettingsDocLink,
} from "./SettingsDocLink";
import styles from "./SettingsItem.module.css";
import { settingsItemSlug, settingsTextMatches } from "./settingsSearchMatch";

export interface SettingsItemProps {
  /**
   * Stable jump/search id. Defaults to a slug of `label`; pass explicitly
   * when the label is dynamic or duplicated within the pane.
   */
  id?: string;
  /**
   * Row element tag. Use "label" for click-anywhere-toggles rows that wrap
   * their checkbox (the search jump link stays safe inside a label: clicks
   * on interactive descendants do not activate the labeled control).
   */
  as?: "div" | "label" | "form";
  /** Native tooltip on the row container (rarely needed). */
  title?: string;
  /** Plain-text row title; searchable and rendered bold. */
  label: string;
  /** Plain-text row description; searchable and rendered under the title. */
  description?: string;
  /** Let long descriptions span the row below title + control on narrow panes. */
  descriptionLayout?: "default" | "full-width-on-narrow";
  /** Extra search-only terms (synonyms, old names); never rendered. */
  keywords?: string[];
  /**
   * Documentation linked after the description; see `SettingsDoc`. Custom
   * `info` gets the link on its own line; a `custom` layout renders
   * `SettingsDocLink` itself.
   */
  doc?: SettingsDoc;
  /**
   * Current value as display text (e.g. the selected option's label).
   * Matched only when the user enables the search "match values" toggle;
   * never rendered by this component.
   */
  valueText?: string;
  /** Extra classes appended to `settings-item` (e.g. width modifiers). */
  className?: string;
  /**
   * Base class for a custom row shape. Defaults to `settings-item`; use the
   * owning shared primitive when the setting already has one.
   */
  baseClassName?: string;
  /**
   * `custom` keeps the caller's complete row contents instead of injecting
   * the standard info/control columns. Search and jump behavior still apply.
   */
  layout?: "standard" | "custom";
  /** Native attributes for custom row containers. */
  containerProps?: Omit<
    HTMLAttributes<HTMLElement>,
    "children" | "className" | "title"
  >;
  /**
   * Custom info-block body for rows whose info is richer than
   * bold-label + description. `label`/`description` still drive search
   * matching, but custom info is rendered as-is (no highlighting).
   */
  info?: ReactNode;
  /** The row's control(s), rendered as siblings of the info block. */
  children?: ReactNode;
  /**
   * Row-owned trailing content (hints, warnings) rendered after the row
   * container. In search results it appears only when the row matched.
   */
  after?: ReactNode;
  /**
   * When false, the row is omitted from settings search results (including
   * section-wide matches). Use for convenience clones of a control that
   * already has a primary searchable home elsewhere. Default true.
   */
  searchable?: boolean;
}

const JUMP_FLASH_DURATION_MS = 1800;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * One settings row: info block (label + description) plus its control.
 * Renders today's `.settings-item` markup unchanged in normal panes; inside
 * the settings search results it filters itself against the query,
 * highlights matched substrings, and offers a jump link to its home pane.
 */
export function SettingsItem({
  id,
  as: RowElement = "div",
  title,
  label,
  description,
  descriptionLayout = "default",
  keywords,
  doc,
  valueText,
  className,
  baseClassName = "settings-item",
  layout = "standard",
  containerProps,
  info,
  children,
  after,
  searchable = true,
}: SettingsItemProps) {
  const { t } = useI18n();
  const scope = useSettingsSearchScope();
  const jump = useSettingsJumpTarget();
  const resolvedId = id ?? settingsItemSlug(label);
  const ref = useRef<HTMLElement | null>(null);
  const setRef = useCallback((element: HTMLElement | null) => {
    ref.current = element;
  }, []);
  const [flash, setFlash] = useState(false);

  const jumpTargetsThisRow = !scope && jump?.target === resolvedId;
  const consume = jump?.consume;
  useEffect(() => {
    if (!jumpTargetsThisRow || !consume) return;
    consume();
    ref.current?.scrollIntoView({
      block: "center",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    setFlash(true);
  }, [jumpTargetsThisRow, consume]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(false), JUMP_FLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  // Convenience clones stay out of search entirely so only the primary row hits.
  if (scope && !searchable) return null;

  const matched = scope
    ? scope.sectionMatched ||
      settingsTextMatches(scope.query, [
        label,
        description,
        ...(keywords ?? []),
        ...(scope.matchValues && valueText ? [valueText] : []),
      ])
    : false;
  if (scope && !matched) return null;

  const infoBody = info ? (
    <>
      {info}
      {doc && (
        <p>
          <SettingsDocLink doc={doc} />
        </p>
      )}
    </>
  ) : (
    <>
      <strong>
        {scope ? renderSettingsSearchHighlight(label, scope.query) : label}
      </strong>
      {(description || doc) && (
        <p>
          <SettingsCaption
            text={
              scope && description
                ? renderSettingsSearchHighlight(description, scope.query)
                : description
            }
            doc={doc}
          />
        </p>
      )}
    </>
  );

  const originLabel = scope
    ? scope.sectionTitle
      ? `${scope.categoryLabel} › ${scope.sectionTitle}`
      : scope.categoryLabel
    : null;

  const itemClassName = [
    baseClassName,
    className,
    descriptionLayout === "full-width-on-narrow"
      ? styles.descriptionFullWidthOnNarrow
      : null,
    layout === "custom" ? "settings-item--custom-layout" : null,
    scope ? "settings-search-match" : null,
    flash ? "settings-item--jump-flash" : null,
  ]
    .filter(Boolean)
    .join(" ");

  const origin = scope && originLabel && (
    <Button
      variant="link"
      className="settings-search-origin"
      aria-label={t("settingsSearchJumpTo", { location: originLabel })}
      onClick={() => scope.jumpToItem(resolvedId)}
    >
      {originLabel} ›
    </Button>
  );

  const row = (
    <>
      <RowElement
        {...containerProps}
        onClick={(event) => {
          containerProps?.onClick?.(event);
          if (
            !scope ||
            event.defaultPrevented ||
            RowElement === "label" ||
            window.getSelection()?.isCollapsed === false
          ) {
            return;
          }
          const target = event.target;
          if (
            !(target instanceof Element) ||
            target.closest("[data-settings-item]") !== event.currentTarget ||
            target.closest(
              "a, button, input, select, textarea, label, summary, [role=button], [role=switch], [role=checkbox], [role=combobox], [role=slider], [role=textbox], [contenteditable]:not([contenteditable=false])",
            )
          ) {
            return;
          }
          scope.jumpToItem(resolvedId);
        }}
        className={itemClassName}
        data-settings-item={resolvedId}
        data-description-layout={
          descriptionLayout === "default" ? undefined : descriptionLayout
        }
        title={title}
        ref={setRef}
      >
        {layout === "custom" ? (
          <>
            {children}
            {origin}
          </>
        ) : (
          <>
            <div className="settings-item-info">
              {infoBody}
              {RowElement !== "label" && origin}
            </div>
            {children}
            {RowElement === "label" && origin}
          </>
        )}
      </RowElement>
      {after}
    </>
  );

  if (scope && matched && !scope.sectionMatched) {
    return (
      <SettingsSearchScopeProvider value={{ ...scope, sectionMatched: true }}>
        {row}
      </SettingsSearchScopeProvider>
    );
  }
  return row;
}
