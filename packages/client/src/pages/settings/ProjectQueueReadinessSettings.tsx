import {
  type ProjectQueueReadinessCommand,
  isProjectQueueReadinessCommand,
} from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import { SettingsDocLink } from "./SettingsDocLink";
import { SettingsItem } from "./SettingsItem";
import styles from "./ProjectQueueReadinessSettings.module.css";

interface Props {
  command: ProjectQueueReadinessCommand | null;
  onSave: (command: ProjectQueueReadinessCommand | null) => Promise<void>;
}

export function ProjectQueueReadinessSettings({ command, onSave }: Props) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(command !== null);
  const [executable, setExecutable] = useState(command?.executable ?? "");
  const [args, setArgs] = useState(command?.args.join("\n") ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setEnabled(command !== null);
    setExecutable(command?.executable ?? "");
    setArgs(command?.args.join("\n") ?? "");
  }, [command]);
  const next = enabled
    ? {
        executable: executable.trim(),
        args: args === "" ? [] : args.split("\n"),
      }
    : null;
  const dirty = JSON.stringify(next) !== JSON.stringify(command);

  return (
    <SettingsItem
      label={t("projectQueueReadinessSettingTitle")}
      description={t("projectQueueReadinessSettingDescription")}
      layout="custom"
      baseClassName={styles.container}
    >
      <form
        className={styles.form}
        onSubmit={async (event) => {
          event.preventDefault();
          if (next !== null && !isProjectQueueReadinessCommand(next)) {
            setError(t("projectQueueReadinessSettingInvalid"));
            return;
          }
          setSaving(true);
          setError(null);
          try {
            await onSave(next);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setSaving(false);
          }
        }}
      >
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <strong>{t("projectQueueReadinessSettingTitle")}</strong>
        </label>
        <p className={styles.hint}>
          {t("projectQueueReadinessSettingDescription")}{" "}
          <SettingsDocLink
            doc={{
              path: "topics/project-queue.md#external-readiness-check",
              label: "external readiness check",
            }}
          />
        </p>
        {enabled && (
          <>
            <label className={styles.field}>
              {t("projectQueueReadinessExecutable")}
              <input
                value={executable}
                onChange={(event) => setExecutable(event.target.value)}
                disabled={saving}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            <label className={styles.field}>
              {t("projectQueueReadinessArguments")}
              <textarea
                value={args}
                onChange={(event) => setArgs(event.target.value)}
                disabled={saving}
                rows={3}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            <p className={styles.hint}>
              {t("projectQueueReadinessExecutionHint")}
            </p>
          </>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <Button
          variant="primary"
          type="submit"
          className={styles.save}
          disabled={!dirty || saving}
        >
          {t(
            saving
              ? "projectQueueReadinessSaving"
              : "projectQueueReadinessSave",
          )}
        </Button>
      </form>
    </SettingsItem>
  );
}
