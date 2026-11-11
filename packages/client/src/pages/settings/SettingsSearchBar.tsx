import { useCallback, useState } from "react";
import { IconButton } from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/Checkbox";
import { TextInput } from "../../components/ui/Field";
import { useTextTooltipAttributes } from "../../hooks/useTooltipAppearance";
import { useI18n } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import styles from "./SettingsSearchBar.module.css";

/**
 * Browser-local, default-off preference: settings search also matches each
 * row's declared current-value text. Standard settings search matches only
 * labels/descriptions, so widening to values is an explicit opt-in.
 */
export function useSettingsSearchMatchValues(): [
  boolean,
  (value: boolean) => void,
] {
  const [matchValues, setMatchValuesState] = useState(
    () => localStorage.getItem(UI_KEYS.settingsSearchMatchValues) === "true",
  );
  const setMatchValues = useCallback((value: boolean) => {
    setMatchValuesState(value);
    localStorage.setItem(UI_KEYS.settingsSearchMatchValues, String(value));
  }, []);
  return [matchValues, setMatchValues];
}

export interface SettingsSearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  matchValues: boolean;
  onMatchValuesChange: (value: boolean) => void;
}

/** Search field above the settings navigation, with an adjacent
 * match-values toggle shown only while a query is active. */
export function SettingsSearchBar({
  query,
  onQueryChange,
  matchValues,
  onMatchValuesChange,
}: SettingsSearchBarProps) {
  const { t } = useI18n();
  const matchValuesTooltip = useTextTooltipAttributes(
    t("settingsSearchMatchValuesTooltip"),
  );
  const searching = query.trim() !== "";
  return (
    <form
      className={styles.bar}
      role="search"
      autoComplete="off"
      onSubmit={(event) => event.preventDefault()}
    >
      <TextInput
        type="search"
        hideNativeSearchClear
        name="settings-search"
        autoComplete="off"
        className={styles.inputWrap}
        trailing={
          query !== "" ? (
            <IconButton
              size="small"
              label={t("settingsSearchClear")}
              onClick={() => onQueryChange("")}
            >
              ×
            </IconButton>
          ) : null
        }
        placeholder={t("settingsSearchPlaceholder")}
        aria-label={t("settingsSearchPlaceholder")}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query !== "") {
            event.stopPropagation();
            onQueryChange("");
          }
        }}
      />
      {searching && (
        <span className={styles.valuesToggle} {...matchValuesTooltip}>
          <Checkbox
            label={t("settingsSearchMatchValues")}
            checked={matchValues}
            onCheckedChange={onMatchValuesChange}
          />
        </span>
      )}
    </form>
  );
}
