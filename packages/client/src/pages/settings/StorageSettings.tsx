import { useCallback, useMemo } from "react";
import {
  type SegmentedOption,
  SegmentedControl,
} from "../../components/ui/SegmentedControl";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";
import styles from "./StorageSettings.module.css";

type StorageOption<T extends string> = SegmentedOption<T> & { label: string };

/** A stacked card group whose change saves; the default carries a badge. */
function StorageChoices<T extends string>({
  label,
  options,
  defaultValue,
  value,
  onChange,
}: {
  label: string;
  options: StorageOption<T>[];
  defaultValue: T;
  value: T;
  onChange: (value: T) => void;
}) {
  const { t } = useI18n();
  return (
    <SegmentedControl
      aria-label={label}
      variant="cards"
      layout="stack"
      activation="manual"
      value={value}
      onChange={onChange}
      options={options.map((option) => ({
        ...option,
        ariaLabel: option.label,
        label: (
          <span className={styles.choiceHeading}>
            <span>{option.label}</span>
            {option.value === defaultValue && (
              <span className={styles.defaultBadge}>
                {t("storageChoiceDefault")}
              </span>
            )}
          </span>
        ),
      }))}
    />
  );
}

export function StorageSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("storageSettingsTitle"));

  const { settings, isLoading, error, updateSettings } = useServerSettings();
  const projectLocation = settings?.projectDirectoryStorage ?? "app-data";
  const mediaPreservation =
    settings?.toolResultMediaPreservation ?? "on-demand";

  const undoState = useMemo(
    () => (settings ? { projectLocation, mediaPreservation } : null),
    [mediaPreservation, projectLocation, settings],
  );
  const restoreUndoState = useCallback(
    (snapshot: NonNullable<typeof undoState>) => {
      void updateSettings({
        projectDirectoryStorage: snapshot.projectLocation,
        toolResultMediaPreservation: snapshot.mediaPreservation,
      }).catch(() => {
        // The hook keeps the actionable error visible in this pane.
      });
    },
    [updateSettings],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

  if (isLoading) {
    return <SettingsSection description={t("storageSettingsLoading")} />;
  }

  return (
    <SettingsSection
      description={t("storageSettingsDescription")}
      keywords={[".yep", ".attachments", "YEP_DATA_DIR"]}
      doc="topics/storage-settings.md"
    >
      <div className="settings-group">
        <SettingsItem
          id="project-data-location"
          className={styles.setting}
          label={t("projectDataLocationTitle")}
          description={t("projectDataLocationDescription")}
          keywords={[".yep", ".attachments", "YEP_DATA_DIR"]}
          valueText={
            projectLocation === "project"
              ? t("projectDataLocationProject")
              : t("projectDataLocationAppData")
          }
        >
          <StorageChoices
            label={t("projectDataLocationTitle")}
            defaultValue="app-data"
            value={projectLocation}
            options={[
              {
                value: "app-data",
                label: t("projectDataLocationAppData"),
                description: t("projectDataLocationAppDataDescription"),
              },
              {
                value: "project",
                label: t("projectDataLocationProject"),
                description: t("projectDataLocationProjectDescription"),
              },
            ]}
            onChange={(next) => {
              void updateSettings({ projectDirectoryStorage: next }).catch(
                () => {
                  // The hook keeps the actionable error visible in this pane.
                },
              );
            }}
          />
        </SettingsItem>

        <SettingsItem
          id="tool-result-images"
          className={styles.setting}
          label={t("toolResultImagesStorageTitle")}
          description={t("toolResultImagesStorageDescription")}
          keywords={["tool results", "image", "preserve", "storage"]}
          valueText={
            mediaPreservation === "preserve"
              ? t("toolResultImagesPreserve")
              : t("toolResultImagesOnDemand")
          }
        >
          <StorageChoices
            label={t("toolResultImagesStorageTitle")}
            defaultValue="on-demand"
            value={mediaPreservation}
            options={[
              {
                value: "on-demand",
                label: t("toolResultImagesOnDemand"),
                description: t("toolResultImagesOnDemandDescription"),
              },
              {
                value: "preserve",
                label: t("toolResultImagesPreserve"),
                description: t("toolResultImagesPreserveDescription"),
              },
            ]}
            onChange={(next) => {
              void updateSettings({ toolResultMediaPreservation: next }).catch(
                () => {
                  // The hook keeps the actionable error visible in this pane.
                },
              );
            }}
          />
        </SettingsItem>
      </div>
      {error && <p className="settings-warning">{error}</p>}
    </SettingsSection>
  );
}
