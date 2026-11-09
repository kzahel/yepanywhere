import {
  BROWSER_SETTINGS_BACKUP_VERSION,
  type BrowserSettingsBackup,
  type BrowserSettingsBackupValues,
} from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { limitedUserDefaultsApi } from "../../api/limitedUserDefaultsClient";
import { Banner } from "../../components/ui/Banner";
import { Button, IconButton } from "../../components/ui/Button";
import { TextInput } from "../../components/ui/Field";
import { useI18n } from "../../i18n";
import { portableBrowserSettings } from "../../lib/limitedUserBrowserDefaults";
import styles from "./LimitedUserBrowserDefaults.module.css";

type Operation = "fetching" | "saving" | null;

const KEY_PREFIX = "yep-anywhere-";

function formatSavedAt(savedAt: string): string {
  const date = new Date(savedAt);
  return Number.isNaN(date.getTime()) ? savedAt : date.toLocaleString();
}

/**
 * Settings → Users: the browser defaults limited users' clients take once
 * per published revision. The draft starts from what is published, loads
 * from the superuser's own saved settings, and is edited per key.
 */
export function LimitedUserBrowserDefaults() {
  const { t } = useI18n();
  const [published, setPublished] = useState<BrowserSettingsBackup | null>(
    null,
  );
  const [backup, setBackup] = useState<BrowserSettingsBackup | null>(null);
  const [draft, setDraft] = useState<BrowserSettingsBackupValues>({});
  const [dirty, setDirty] = useState(false);
  const [operation, setOperation] = useState<Operation>("fetching");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      limitedUserDefaultsApi.getLimitedUserBrowserDefaults(),
      api.getBrowserSettingsBackup(),
    ])
      .then(([defaults, own]) => {
        if (cancelled) return;
        setPublished(defaults.backup);
        setDraft(defaults.backup?.values ?? {});
        setBackup(own.backup);
      })
      .catch(() => {
        if (!cancelled) setError(t("usersBrowserDefaultsUnavailable"));
      })
      .finally(() => {
        if (!cancelled) setOperation(null);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const edit = (next: BrowserSettingsBackupValues) => {
    setDraft(next);
    setDirty(true);
  };

  const save = async () => {
    setOperation("saving");
    setError(null);
    try {
      const response =
        await limitedUserDefaultsApi.saveLimitedUserBrowserDefaults({
          version: BROWSER_SETTINGS_BACKUP_VERSION,
          values: draft,
        });
      setPublished(response.backup);
      setDirty(false);
    } catch {
      setError(t("usersBrowserDefaultsSaveFailed"));
    } finally {
      setOperation(null);
    }
  };

  const entries = Object.entries(draft).sort(([a], [b]) => a.localeCompare(b));
  const status = error
    ? null
    : operation === "fetching"
      ? t("loading")
      : published
        ? t("usersBrowserDefaultsPublishedAt", {
            time: formatSavedAt(published.savedAt),
            count: Object.keys(published.values).length,
          })
        : t("usersBrowserDefaultsNone");

  return (
    <section
      className={styles.panel}
      aria-label={t("usersBrowserDefaultsTitle")}
    >
      <h3>{t("usersBrowserDefaultsTitle")}</h3>
      <p className={styles.hint}>{t("usersBrowserDefaultsDescription")}</p>
      <div className={styles.actions}>
        <Button
          disabled={operation !== null || !backup}
          title={t("usersBrowserDefaultsLoadTooltip")}
          onClick={() => {
            if (backup) edit(portableBrowserSettings(backup.values));
          }}
        >
          {t("usersBrowserDefaultsLoad")}
        </Button>
        <Button
          variant="primary"
          disabled={operation !== null || !dirty}
          onClick={() => void save()}
        >
          {operation === "saving"
            ? t("usersBrowserDefaultsSaving")
            : t("usersBrowserDefaultsSave")}
        </Button>
      </div>
      {operation === null && !backup && !error && (
        <p className={styles.hint}>{t("usersBrowserDefaultsNoBackup")}</p>
      )}
      {/* Always mounted, so a result after a failed try is announced. */}
      <span className={styles.status} role="status">
        {status}
        {status && dirty && ` · ${t("usersBrowserDefaultsUnsaved")}`}
      </span>
      {error && (
        <Banner tone="error" compact>
          {error}
          {dirty && ` · ${t("usersBrowserDefaultsUnsaved")}`}
        </Banner>
      )}
      {entries.length > 0 && (
        <details>
          <summary className={styles.hint}>
            {t("usersBrowserDefaultsCount", { count: entries.length })}
          </summary>
          <ul className={styles.list}>
            {entries.map(([key, value]) => {
              const label = key.startsWith(KEY_PREFIX)
                ? key.slice(KEY_PREFIX.length)
                : key;
              return (
                <li key={key} className={styles.row}>
                  <label
                    className={styles.key}
                    htmlFor={`browser-default-${key}`}
                  >
                    {label}
                  </label>
                  <TextInput
                    id={`browser-default-${key}`}
                    value={value}
                    disabled={operation !== null}
                    onChange={(event) =>
                      edit({ ...draft, [key]: event.target.value })
                    }
                  />
                  <IconButton
                    disabled={operation !== null}
                    label={t("usersBrowserDefaultsRemove", { key: label })}
                    onClick={() => {
                      const { [key]: _removed, ...rest } = draft;
                      edit(rest);
                    }}
                  >
                    ×
                  </IconButton>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </section>
  );
}
