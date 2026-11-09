import { Tabs } from "../components/ui/Tabs";
import type { MessageKey, TranslationFn } from "../i18n";
import styles from "./SourceModeTabs.module.css";

/**
 * The source-control mode selector (topic: source-review-to-session, stage 3):
 * one surface, several navigation modes that all feed the same review
 * accumulator. `changes` owns both the current working tree and explicitly
 * opened commit history, `files` is the all-files blame browser, and
 * `comments` is the pending-review list, and `reviews` is submitted history.
 */
export type SourceTab = "changes" | "files" | "comments" | "reviews";

export function SourceModeTabs({
  tab,
  tabs,
  counts,
  fileTabLabelKey,
  onSelect,
  variant = "header",
  t,
}: {
  tab: SourceTab;
  tabs: readonly SourceTab[];
  /** Optional per-tab count chip (e.g. pending review comments). */
  counts?: Partial<Record<SourceTab, number>>;
  fileTabLabelKey?: MessageKey;
  onSelect: (tab: SourceTab) => void;
  /**
   * `header` sits inline at the top-right of a wide page header. `stacked` is
   * the phone layout, where the strip becomes a full-width row of its own.
   */
  variant?: "header" | "stacked";
  t: TranslationFn;
}) {
  return (
    <Tabs
      variant="pill"
      layout={variant === "stacked" ? "fill" : "inline"}
      className={variant === "stacked" ? styles.stacked : undefined}
      value={tab}
      onChange={onSelect}
      tabs={tabs.map((key) => ({
        value: key,
        label: t(
          key === "files" && fileTabLabelKey
            ? fileTabLabelKey
            : sourceTabLabelKey(key),
        ),
        count: counts?.[key],
      }))}
    />
  );
}

function sourceTabLabelKey(tab: SourceTab): MessageKey {
  switch (tab) {
    case "changes":
      return "sourceTabChanges";
    case "files":
      return "sourceTabFiles";
    case "comments":
      return "sourceTabComments";
    case "reviews":
      return "sourceTabReviews";
  }
}
