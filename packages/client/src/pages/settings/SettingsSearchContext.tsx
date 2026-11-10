import rowsStyles from "./SettingsRows.module.css";
import { Fragment, type ReactNode, createContext, useContext } from "react";
import { splitSettingsMatchSegments } from "./settingsSearchMatch";

/**
 * Settings search scope: present only while a pane is mounted inside the
 * search results view. Each SettingsItem consults it to decide whether to
 * render (filtering) and how to mark matched substrings (highlighting).
 * Absent (null) in normal pane rendering, where rows render untouched.
 */
export interface SettingsSearchScope {
  /** Raw (trimmed) query the user typed; token-AND substring semantics. */
  query: string;
  /** When true, rows also match against their declared valueText. */
  matchValues: boolean;
  /**
   * True inside a SettingsSection whose own title/description matched: all
   * child rows render (whole-section result) instead of filtering per row.
   */
  sectionMatched: boolean;
  /** Title of the nearest enclosing SettingsSection, for jump-link labels. */
  sectionTitle?: string;
  /** Label of the category pane this scope wraps, for jump-link labels. */
  categoryLabel: string;
  /** Navigate out of search to this row's spot in its category pane. */
  jumpToItem: (itemId: string) => void;
}

const SettingsSearchScopeContext = createContext<SettingsSearchScope | null>(
  null,
);

export const SettingsSearchScopeProvider = SettingsSearchScopeContext.Provider;

export function useSettingsSearchScope(): SettingsSearchScope | null {
  return useContext(SettingsSearchScopeContext);
}

/**
 * One-shot jump target delivered through navigation state when a search
 * result's jump link opens a category pane: the SettingsItem whose id
 * matches scrolls itself into view and flashes, then consumes the target.
 */
export interface SettingsJumpTarget {
  target: string | null;
  consume: () => void;
}

const SettingsJumpTargetContext = createContext<SettingsJumpTarget | null>(
  null,
);

export const SettingsJumpTargetProvider = SettingsJumpTargetContext.Provider;

export function useSettingsJumpTarget(): SettingsJumpTarget | null {
  return useContext(SettingsJumpTargetContext);
}

/**
 * Render `text` with query-token occurrences wrapped in a subtle mark.
 * Outside search scope callers should pass the plain string instead.
 */
export function renderSettingsSearchHighlight(
  text: string,
  query: string,
): ReactNode {
  const segments = splitSettingsMatchSegments(text, query);
  if (!segments.some((segment) => segment.match)) return text;
  return segments.map((segment, index) =>
    segment.match ? (
      <mark key={index} className={rowsStyles.searchMark}>
        {segment.text}
      </mark>
    ) : (
      <Fragment key={index}>{segment.text}</Fragment>
    ),
  );
}

/**
 * Wrapper for pane content that is not a settings row (previews, status
 * blocks, bulk-action forms): hidden while search filtering is active,
 * shown again when the enclosing section matched as a whole.
 */
export function HideInSettingsSearch({ children }: { children: ReactNode }) {
  const scope = useSettingsSearchScope();
  if (scope && !scope.sectionMatched) return null;
  return <>{children}</>;
}
