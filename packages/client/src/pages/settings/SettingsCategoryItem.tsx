import categoryStyles from "./SettingsCategoryItem.module.css";
import { SelectableCard } from "../../components/ui/SelectableCard";

import { SettingsCategoryIcon } from "./SettingsCategoryIcons";
import { renderSettingsSearchHighlight } from "./SettingsSearchContext";
import type { SettingsCategory } from "./types";

export interface SettingsCategoryItemProps {
  category: SettingsCategory;
  isActive: boolean;
  onClick: () => void;
  /** When set, highlight query-token matches in the label/description. */
  highlightQuery?: string;
}

export function SettingsCategoryItem({
  category,
  isActive,
  onClick,
  highlightQuery,
}: SettingsCategoryItemProps) {
  return (
    <SelectableCard
      size="compact"
      className={categoryStyles.item}
      aria-current={isActive ? "page" : undefined}
      onClick={onClick}
    >
      <SettingsCategoryIcon id={category.id} active={isActive} />
      <div className={categoryStyles.text}>
        <span className={categoryStyles.label} data-settings-category-label>
          {highlightQuery
            ? renderSettingsSearchHighlight(category.label, highlightQuery)
            : category.label}
        </span>
        <span className={categoryStyles.description}>
          {highlightQuery
            ? renderSettingsSearchHighlight(
                category.description,
                highlightQuery,
              )
            : category.description}
        </span>
      </div>
      <span className={categoryStyles.chevron} data-settings-category-chevron>
        ›
      </span>
    </SelectableCard>
  );
}
