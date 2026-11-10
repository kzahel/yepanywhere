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
      className={`settings-category-item ${isActive ? "active" : ""}`}
      aria-current={isActive ? "page" : undefined}
      onClick={onClick}
    >
      <SettingsCategoryIcon id={category.id} active={isActive} />
      <div className="settings-category-text">
        <span className="settings-category-label">
          {highlightQuery
            ? renderSettingsSearchHighlight(category.label, highlightQuery)
            : category.label}
        </span>
        <span className="settings-category-description">
          {highlightQuery
            ? renderSettingsSearchHighlight(
                category.description,
                highlightQuery,
              )
            : category.description}
        </span>
      </div>
      <span className="settings-category-chevron">›</span>
    </SelectableCard>
  );
}
