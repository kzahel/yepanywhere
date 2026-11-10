import rowsStyles from "./SettingsRows.module.css";
import layoutStyles from "./SettingsLayout.module.css";
import {
  memo,
  startTransition,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ButtonBase } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import { SettingsCategoryItem } from "./SettingsCategoryItem";
import { SettingsPane } from "./SettingsPane";
import { SettingsPaneTitleProvider } from "./SettingsPaneTitleContext";
import {
  type SettingsSearchScope,
  SettingsSearchScopeProvider,
} from "./SettingsSearchContext";
import {
  type SettingsUndoRegistration,
  SettingsUndoProvider,
} from "./SettingsUndoContext";
import { settingsTextMatches } from "./settingsSearchMatch";
import type { SettingsCategory } from "./types";

const noopSetPaneTitle = (_title: string | null) => {};
const noopSetUndoRegistration = (
  _registration: SettingsUndoRegistration | null,
) => {};

/**
 * Memoized pane mount: the pane re-renders only when its component changes,
 * not on every keystroke — per-row filtering flows through the search scope
 * context, so only SettingsItem/SettingsSection consumers recompute.
 */
const SettingsSearchPaneMount = memo(function SettingsSearchPaneMount({
  Component,
}: {
  Component: React.ComponentType;
}) {
  return (
    <SettingsPaneTitleProvider value={noopSetPaneTitle}>
      <SettingsUndoProvider value={noopSetUndoRegistration}>
        <Component />
      </SettingsUndoProvider>
    </SettingsPaneTitleProvider>
  );
});

export interface SettingsSearchResultsProps {
  categories: SettingsCategory[];
  components: Record<string, React.ComponentType>;
  /** Trimmed, non-empty query (deferred value — may trail the input). */
  query: string;
  matchValues: boolean;
  /** Open a category pane at a specific row (from a result's jump link). */
  onJumpToItem: (categoryId: string, itemId: string) => void;
  /** Open a category pane at the top (category-level result). */
  onOpenCategory: (categoryId: string) => void;
}

/**
 * Live-filtered settings search results: matching categories first, then
 * every category pane mounted for real — matched rows stay operable in
 * place — grouped under a clickable category heading. Panes and sections
 * with no match are hidden by the settings-search CSS rules.
 */
// Urgent query edits must not revisit the pane tree while the deferred query
// is unchanged, including panes still waiting for their lazy module.
export const SettingsSearchResults = memo(function SettingsSearchResults({
  categories,
  components,
  query,
  matchValues,
  onJumpToItem,
  onOpenCategory,
}: SettingsSearchResultsProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [hasIncompletePanes, setHasIncompletePanes] = useState(true);
  const [mountedCategoryCount, setMountedCategoryCount] = useState(1);

  // Cold search used to acquire every lazy pane at once: their module/style
  // arrivals and mount effects formed a single burst during the next keys.
  // Admit one category per frame and let urgent input preempt its render.
  useEffect(() => {
    if (mountedCategoryCount >= categories.length) return;
    const frame = requestAnimationFrame(() => {
      startTransition(() => setMountedCategoryCount((count) => count + 1));
    });
    return () => cancelAnimationFrame(frame);
  }, [mountedCategoryCount, categories.length]);
  const acquiringPanes = mountedCategoryCount < categories.length;

  const categoryMatches = categories.filter((category) =>
    settingsTextMatches(query, [category.label, category.description]),
  );

  // Row matching happens inside each pane. Recount committed results after a
  // query change and when async panes add or remove rows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: query/matchValues are intentional recount triggers (body reads only the rendered DOM).
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const recount = () => {
      setHasIncompletePanes(
        container.querySelectorAll("[data-settings-pane]").length !==
          container.querySelectorAll("[data-settings-pane-ready]").length,
      );
      setMatchCount(
        container.querySelectorAll(
          "[data-settings-item][data-settings-search-match]",
        ).length,
      );
    };
    recount();
    const observer = new MutationObserver(recount);
    observer.observe(container, {
      attributes: true,
      attributeFilter: ["class", "data-settings-item"],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [query, matchValues, mountedCategoryCount]);

  const hasResults =
    categoryMatches.length > 0 || matchCount === null || matchCount > 0;

  return (
    <div
      className={rowsStyles.searchResults}
      data-settings-search-results
      aria-busy={acquiringPanes || hasIncompletePanes}
    >
      {categoryMatches.length > 0 && (
        <div className="settings-search-category-matches">
          <h3 className={rowsStyles.searchHeading}>
            {t("settingsSearchCategoriesHeading")}
          </h3>
          <div className={layoutStyles.categoryList}>
            {categoryMatches.map((category) => (
              <SettingsCategoryItem
                key={category.id}
                category={category}
                isActive={false}
                onClick={() => onOpenCategory(category.id)}
                highlightQuery={query}
              />
            ))}
          </div>
        </div>
      )}
      <div ref={containerRef}>
        {categories.slice(0, mountedCategoryCount).map((category) => {
          const Component = components[category.id];
          if (!Component) return null;
          return (
            <SettingsPane key={category.id} label={category.label}>
              <SettingsSearchPane
                category={category}
                Component={Component}
                query={query}
                matchValues={matchValues}
                onJumpToItem={onJumpToItem}
                onOpenCategory={onOpenCategory}
              />
            </SettingsPane>
          );
        })}
      </div>
      {!hasResults && !acquiringPanes && !hasIncompletePanes && (
        <p className={rowsStyles.searchNoResults} data-settings-search-empty>
          {t("settingsSearchNoResults", { query })}
        </p>
      )}
      <span className={rowsStyles.searchLiveCount} aria-live="polite">
        {t("settingsSearchResultCount", {
          count: (matchCount ?? 0) + categoryMatches.length,
        })}
      </span>
    </div>
  );
});

interface SettingsSearchPaneProps {
  category: SettingsCategory;
  Component: React.ComponentType;
  query: string;
  matchValues: boolean;
  onJumpToItem: (categoryId: string, itemId: string) => void;
  onOpenCategory: (categoryId: string) => void;
}

function SettingsSearchPane({
  category,
  Component,
  query,
  matchValues,
  onJumpToItem,
  onOpenCategory,
}: SettingsSearchPaneProps) {
  const scope = useMemo<SettingsSearchScope>(
    () => ({
      query,
      matchValues,
      sectionMatched: false,
      categoryLabel: category.label,
      jumpToItem: (itemId: string) => onJumpToItem(category.id, itemId),
    }),
    [query, matchValues, category.id, category.label, onJumpToItem],
  );

  return (
    <section className={rowsStyles.searchPane} data-category={category.id}>
      <h3 className={rowsStyles.searchPaneTitle}>
        <ButtonBase
          className={rowsStyles.searchPaneLink}
          onClick={() => onOpenCategory(category.id)}
        >
          {category.label} ›
        </ButtonBase>
      </h3>
      <SettingsSearchScopeProvider value={scope}>
        <SettingsSearchPaneMount Component={Component} />
      </SettingsSearchScopeProvider>
    </section>
  );
}
