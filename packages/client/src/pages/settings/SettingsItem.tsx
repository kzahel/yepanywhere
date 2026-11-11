import rowsStyles from "./SettingsRows.module.css";
import type { HTMLAttributes, ReactNode } from "react";
import { IconButton } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import {
  renderSettingsSearchHighlight,
  SettingsSearchScopeProvider,
  useSettingsSearchScope,
} from "./SettingsSearchContext";
import {
  SettingsCaption,
  type SettingsDoc,
  SettingsDocLink,
} from "./SettingsDocLink";
import styles from "./SettingsItem.module.css";
import { useSettingsJumpFlash } from "./useSettingsJumpFlash";
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
   * When false, omit this convenience clone from settings search results.
   * The same control must have a primary searchable home elsewhere.
   */
  searchable?: boolean;
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
  baseClassName = rowsStyles.item,
  layout = "standard",
  containerProps,
  info,
  children,
  after,
  searchable = true,
}: SettingsItemProps) {
  const { t } = useI18n();
  const scope = useSettingsSearchScope();
  const resolvedId = id ?? settingsItemSlug(label);
  const { ref, flash } = useSettingsJumpFlash(resolvedId, !!scope);

  // Convenience clones stay out of search entirely so only the primary row hits.
  if (scope && !searchable) return null;

  const matched = scope
    ? settingsTextMatches(scope.query, [
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
    scope ? rowsStyles.searchMatch : null,
    flash ? rowsStyles.itemJumpFlash : null,
  ]
    .filter(Boolean)
    .join(" ");

  const origin = scope && originLabel && (
    <IconButton
      size="small"
      data-settings-origin
      label={t("settingsSearchJumpTo", {
        location: `${originLabel} › ${label}`,
      })}
      onClick={() => scope.jumpToItem(resolvedId)}
    >
      ›
    </IconButton>
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
        data-settings-search-match={scope ? "" : undefined}
        data-settings-jump-flash={flash ? "" : undefined}
        data-description-layout={
          descriptionLayout === "default" ? undefined : descriptionLayout
        }
        title={title}
        ref={ref}
      >
        {layout === "custom" ? (
          <>
            {children}
            {origin}
          </>
        ) : (
          <>
            <div className={rowsStyles.itemInfo} data-settings-info>
              {infoBody}
            </div>
            {children}
            {origin}
          </>
        )}
      </RowElement>
      {scope && after ? (
        <div className={rowsStyles.searchAfter}>{after}</div>
      ) : (
        after
      )}
    </>
  );

  if (scope && matched && !scope.rowMatched) {
    return (
      <SettingsSearchScopeProvider value={{ ...scope, rowMatched: true }}>
        {row}
      </SettingsSearchScopeProvider>
    );
  }
  return row;
}
