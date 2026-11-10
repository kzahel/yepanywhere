import rowsStyles from "./SettingsRows.module.css";
import { type FormEventHandler, type ReactNode, useMemo } from "react";
import { SettingsCaption, type SettingsDoc } from "./SettingsDocLink";
import {
  renderSettingsSearchHighlight,
  SettingsSearchScopeProvider,
  useSettingsSearchScope,
} from "./SettingsSearchContext";
import { settingsTextMatches } from "./settingsSearchMatch";

export interface SettingsSectionProps {
  /** Section heading; searchable, rendered as the section `<h2>`. */
  title?: string;
  /** Section lede; searchable, rendered as `.settings-section-description`. */
  description?: string;
  /** Extra search-only terms; never rendered. */
  keywords?: string[];
  /** Documentation linked after the description; see `SettingsDoc`. */
  doc?: SettingsDoc;
  /** Extra classes appended to `settings-section`. */
  className?: string;
  /** One explicit-save group; native Enter submission keeps actions with fields. */
  onSubmit?: FormEventHandler<HTMLElement>;
  children?: ReactNode;
}

/**
 * One settings section: optional `<h2>` + description ahead of its groups
 * and rows. In search results, a title/description match surfaces the whole
 * section operable (child rows stop filtering); otherwise children filter
 * individually and CSS hides the section when nothing inside matched.
 */
export function SettingsSection({
  title,
  description,
  keywords,
  doc,
  className,
  onSubmit,
  children,
}: SettingsSectionProps) {
  const scope = useSettingsSearchScope();
  const sectionMatched = scope
    ? scope.sectionMatched ||
      settingsTextMatches(scope.query, [
        title,
        description,
        ...(keywords ?? []),
      ])
    : false;

  const childScope = useMemo(
    () =>
      scope
        ? {
            ...scope,
            sectionMatched,
            sectionTitle: title ?? scope.sectionTitle,
          }
        : null,
    [scope, sectionMatched, title],
  );

  const sectionClassName = [
    rowsStyles.section,
    className,
    scope && sectionMatched ? rowsStyles.searchSectionMatch : null,
  ]
    .filter(Boolean)
    .join(" ");

  const SectionElement = onSubmit ? "form" : "section";
  const body = (
    <SectionElement
      className={sectionClassName}
      data-settings-section-match={scope && sectionMatched ? "" : undefined}
      onSubmit={onSubmit}
      noValidate={onSubmit ? true : undefined}
    >
      {title && (
        <h2>
          {scope ? renderSettingsSearchHighlight(title, scope.query) : title}
        </h2>
      )}
      {(description || doc) && (
        <p className={rowsStyles.sectionDescription}>
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
      {children}
    </SectionElement>
  );

  if (!childScope) return body;
  return (
    <SettingsSearchScopeProvider value={childScope}>
      {body}
    </SettingsSearchScopeProvider>
  );
}
