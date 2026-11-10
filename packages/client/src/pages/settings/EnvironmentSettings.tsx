import rowsStyles from "./SettingsRows.module.css";
import { useEffect, useMemo, useState } from "react";
import { api, type EnvSettingEntry } from "../../api/client";
import { Badge } from "../../components/ui/Badge";
import { Banner } from "../../components/ui/Banner";
import { Select } from "../../components/ui/Field";
import { useI18n } from "../../i18n";
import styles from "./EnvironmentSettings.module.css";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import {
  HideInSettingsSearch,
  useSettingsSearchScope,
} from "./SettingsSearchContext";
import { SettingsSection } from "./SettingsSection";

interface EnvGroup {
  group: string;
  entries: EnvSettingEntry[];
}

/** Preserve server registry order; group by `group` as groups first appear. */
function groupEntries(entries: EnvSettingEntry[]): EnvGroup[] {
  const groups: EnvGroup[] = [];
  const byName = new Map<string, EnvGroup>();
  for (const entry of entries) {
    let group = byName.get(entry.group);
    if (!group) {
      group = { group: entry.group, entries: [] };
      byName.set(entry.group, group);
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

export function EnvironmentSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("environmentSectionTitle"));
  const [entries, setEntries] = useState<EnvSettingEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const searchScope = useSettingsSearchScope();

  useEffect(() => {
    let cancelled = false;
    api
      .getEnvSettings()
      .then((report) => {
        if (!cancelled) setEntries(report.entries);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleEntries = useMemo(
    () => entries?.filter((entry) => searchScope || showAll || entry.set) ?? [],
    [entries, searchScope, showAll],
  );
  const groups = useMemo(() => groupEntries(visibleEntries), [visibleEntries]);
  const setCount = entries?.filter((entry) => entry.set).length ?? 0;

  return (
    <SettingsSection
      description={t("environmentSectionDescription")}
      doc={{
        path: "topics/ya-env-vars.md",
        label: "YA environment variables",
      }}
    >
      <HideInSettingsSearch>
        {error && <Banner tone="error">{t("environmentLoadError")}</Banner>}
        {!error && entries === null && <p>{t("environmentLoading")}</p>}

        {!error && entries && (
          <div className={styles.filter}>
            <label htmlFor="environment-show">
              {t("environmentShowLabel")}
            </label>
            <Select
              id="environment-show"
              className={styles.filterSelect}
              value={showAll ? "all" : "set"}
              onChange={(event) => setShowAll(event.target.value === "all")}
            >
              <option value="set">
                {t("environmentShowSet", { count: setCount })}
              </option>
              <option value="all">
                {t("environmentShowAll", { count: entries.length })}
              </option>
            </Select>
          </div>
        )}

        {!error && entries && !showAll && groups.length === 0 && (
          <p className={rowsStyles.empty}>{t("environmentEmptySet")}</p>
        )}
      </HideInSettingsSearch>
      {groups.map((group) => (
        <div
          key={group.group}
          className={`${rowsStyles.group} ${styles.group}`}
          data-settings-group
        >
          <HideInSettingsSearch>
            <h3 className={styles.groupTitle}>{group.group}</h3>
          </HideInSettingsSearch>
          {group.entries.map((entry) => (
            <EnvVarRow key={entry.name} entry={entry} />
          ))}
        </div>
      ))}
    </SettingsSection>
  );
}

function EnvVarRow({ entry }: { entry: EnvSettingEntry }) {
  const { t } = useI18n();
  return (
    <SettingsItem
      label={entry.name}
      description={entry.description}
      keywords={[entry.group, entry.note].filter(
        (value): value is string => !!value,
      )}
      layout="custom"
      baseClassName={styles.row}
      className={entry.set ? undefined : styles.unset}
    >
      <div className={styles.head}>
        <code className={styles.name}>{entry.name}</code>
        {entry.secret && <Badge>{t("environmentSecretBadge")}</Badge>}
        <EnvVarValue entry={entry} />
      </div>
      <p className={styles.description}>{entry.description}</p>
      {entry.note && <p className={styles.note}>{entry.note}</p>}
    </SettingsItem>
  );
}

function EnvVarValue({ entry }: { entry: EnvSettingEntry }) {
  const { t } = useI18n();
  if (!entry.set) {
    return (
      <span className={`${styles.value} ${styles.valueUnset}`}>
        {t("environmentValueNotSet")}
      </span>
    );
  }
  if (entry.value === "") {
    return (
      <span className={`${styles.value} ${styles.valueUnset}`}>
        {t("environmentValueEmpty")}
      </span>
    );
  }
  return <code className={styles.value}>{entry.value}</code>;
}
