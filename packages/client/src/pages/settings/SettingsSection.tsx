import rowsStyles from "./SettingsRows.module.css";
import { type FormEventHandler, type ReactNode, useMemo } from "react";
import { Button } from "../../components/ui/Button";
import { SettingsCaption, type SettingsDoc } from "./SettingsDocLink";
import {
  renderSettingsSearchHighlight,
  SettingsSearchScopeProvider,
  useSettingsSearchScope,
} from "./SettingsSearchContext";
import { settingsItemSlug, settingsTextMatches } from "./settingsSearchMatch";
import { useSettingsJumpFlash } from "./useSettingsJumpFlash";

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
 * and rows. Search filters every row independently. Matching named sections
 * offer navigation to the complete editor without revealing unrelated rows.
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
  const sectionId = `section-${settingsItemSlug(title ?? "")}`;
  const { ref, flash } = useSettingsJumpFlash(sectionId, !!scope);
  const sectionMatched = !!(
    scope &&
    title &&
    settingsTextMatches(scope.query, [title, description, ...(keywords ?? [])])
  );

  const childScope = useMemo(
    () =>
      scope
        ? {
            ...scope,
            sectionTitle: title ?? scope.sectionTitle,
          }
        : null,
    [scope, title],
  );

  const sectionClassName = [
    rowsStyles.section,
    className,
    flash ? rowsStyles.itemJumpFlash : null,
  ]
    .filter(Boolean)
    .join(" ");

  const SectionElement = onSubmit ? "form" : "section";
  const body = (
    <SectionElement
      className={sectionClassName}
      data-settings-section-link={sectionMatched ? "" : undefined}
      data-settings-jump-flash={flash ? "" : undefined}
      ref={ref}
      onSubmit={onSubmit}
      noValidate={onSubmit ? true : undefined}
    >
      {title && (
        <h2>
          {scope ? (
            <Button
              variant="link"
              data-settings-section-origin
              onClick={() => scope.jumpToItem(sectionId)}
            >
              {renderSettingsSearchHighlight(title, scope.query)} ›
            </Button>
          ) : (
            title
          )}
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
      {scope ? (
        <div className={rowsStyles.searchSectionContent}>{children}</div>
      ) : (
        children
      )}
    </SectionElement>
  );

  if (!childScope) return body;
  return (
    <SettingsSearchScopeProvider value={childScope}>
      {body}
    </SettingsSearchScopeProvider>
  );
}
