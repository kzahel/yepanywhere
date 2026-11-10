import rowsStyles from "./SettingsRows.module.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Banner } from "../../components/ui/Banner";
import { Button } from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/Checkbox";
import { TextInput } from "../../components/ui/Field";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useI18n } from "../../i18n";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { HideInSettingsSearch } from "./SettingsSearchContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

const MAX_URL_LENGTH = 2000;
const MAX_TOKEN_LENGTH = 5000;

export function LifecycleWebhooksSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("lifecycleWebhooksTitle"));
  const { settings, isLoading, error, updateSettings } = useServerSettings();
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasDraftEdits, setHasDraftEdits] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // True once the form mirrors loaded settings; gates the undo baseline so
  // it snapshots the open-time values, not the pre-load defaults.
  const [formSynced, setFormSynced] = useState(false);

  const serverEnabled = settings?.lifecycleWebhooksEnabled ?? false;
  const serverUrl = settings?.lifecycleWebhookUrl ?? "";
  const serverToken = settings?.lifecycleWebhookToken ?? "";
  const serverDryRun = settings?.lifecycleWebhookDryRun ?? true;
  const normalizedUrl = url.trim();
  const normalizedToken = token.trim();
  const hasChanges =
    enabled !== serverEnabled ||
    normalizedUrl !== serverUrl ||
    normalizedToken !== serverToken ||
    dryRun !== serverDryRun;

  useEffect(() => {
    if (!settings) return;
    if (hasDraftEdits || isSaving) return;
    setEnabled(serverEnabled);
    setUrl(serverUrl);
    setToken(serverToken);
    setDryRun(serverDryRun);
    setFormSynced(true);
  }, [
    hasDraftEdits,
    isSaving,
    serverDryRun,
    serverEnabled,
    serverToken,
    serverUrl,
    settings,
  ]);

  // Header undo covers shown form values (saved or not), back to open-time.
  const undoState = useMemo(
    () => (formSynced ? { enabled, url, token, dryRun } : null),
    [formSynced, enabled, url, token, dryRun],
  );
  const restoreUndoState = useCallback(
    (snapshot: NonNullable<typeof undoState>) => {
      setEnabled(snapshot.enabled);
      setUrl(snapshot.url);
      setToken(snapshot.token);
      setDryRun(snapshot.dryRun);
      setHasDraftEdits(false);
      setSaveError(null);
      void updateSettings({
        lifecycleWebhooksEnabled: snapshot.enabled,
        lifecycleWebhookUrl: snapshot.url.trim() || undefined,
        lifecycleWebhookToken: snapshot.token.trim() || undefined,
        lifecycleWebhookDryRun: snapshot.dryRun,
      }).catch(() => {
        // surfaced via the hook's error state
      });
    },
    [updateSettings],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await updateSettings({
        lifecycleWebhooksEnabled: enabled,
        lifecycleWebhookUrl: normalizedUrl || undefined,
        lifecycleWebhookToken: normalizedToken || undefined,
        lifecycleWebhookDryRun: dryRun,
      });
      setEnabled(enabled);
      setUrl(normalizedUrl);
      setToken(normalizedToken);
      setDryRun(dryRun);
      setHasDraftEdits(false);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : t("lifecycleWebhooksSaveFailed"),
      );
    } finally {
      setIsSaving(false);
    }
  }, [dryRun, enabled, normalizedToken, normalizedUrl, t, updateSettings]);

  if (isLoading) {
    return <SettingsSection description={t("lifecycleWebhooksLoading")} />;
  }

  return (
    <SettingsSection
      description={t("lifecycleWebhooksDescription")}
      doc={{
        path: "docs/project/webhook-automation-spec.md",
        label: "lifecycle webhooks",
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (hasChanges && !isSaving) void handleSave();
      }}
      keywords={[
        t("lifecycleWebhooksEnableTitle"),
        t("lifecycleWebhooksEnableDescription"),
        t("lifecycleWebhooksUrlTitle"),
        t("lifecycleWebhooksUrlDescription"),
        t("lifecycleWebhooksTokenTitle"),
        t("lifecycleWebhooksTokenDescription"),
        t("lifecycleWebhooksDryRunTitle"),
        t("lifecycleWebhooksDryRunDescription"),
      ]}
    >
      <div className={rowsStyles.group} data-settings-group>
        <SettingsItem
          as="label"
          label={t("lifecycleWebhooksEnableTitle")}
          description={t("lifecycleWebhooksEnableDescription")}
          layout="custom"
        >
          <div className={rowsStyles.itemInfo} data-settings-info>
            <strong>{t("lifecycleWebhooksEnableTitle")}</strong>
            <p>{t("lifecycleWebhooksEnableDescription")}</p>
          </div>
          <Checkbox
            aria-label={t("lifecycleWebhooksEnableTitle")}
            checked={enabled}
            onCheckedChange={(checked) => {
              setEnabled(checked);
              setHasDraftEdits(true);
              setSaveError(null);
            }}
          />
        </SettingsItem>

        <SettingsItem
          label={t("lifecycleWebhooksUrlTitle")}
          description={t("lifecycleWebhooksUrlDescription")}
          layout="custom"
          containerProps={{
            style: { flexDirection: "column", alignItems: "stretch" },
          }}
        >
          <div className={rowsStyles.itemInfo} data-settings-info>
            <strong>{t("lifecycleWebhooksUrlTitle")}</strong>
            <p>{t("lifecycleWebhooksUrlDescription")}</p>
          </div>
          <TextInput
            aria-label={t("lifecycleWebhooksUrlTitle")}
            autoComplete="off"
            type="url"
            id="lifecycle-webhook-url"
            name="yep-lifecycle-webhook-url"
            value={url}
            onChange={(e) => {
              const value = e.target.value.slice(0, MAX_URL_LENGTH);
              setUrl(value);
              setHasDraftEdits(true);
              setSaveError(null);
            }}
            placeholder="https://example.com/hooks/yep"
            spellCheck={false}
          />
        </SettingsItem>

        <SettingsItem
          label={t("lifecycleWebhooksTokenTitle")}
          description={t("lifecycleWebhooksTokenDescription")}
          layout="custom"
          containerProps={{
            style: { flexDirection: "column", alignItems: "stretch" },
          }}
        >
          <div className={rowsStyles.itemInfo} data-settings-info>
            <strong>{t("lifecycleWebhooksTokenTitle")}</strong>
            <p>{t("lifecycleWebhooksTokenDescription")}</p>
          </div>
          <TextInput
            aria-label={t("lifecycleWebhooksTokenTitle")}
            autoComplete="new-password"
            type="password"
            id="lifecycle-webhook-token"
            name="yep-lifecycle-webhook-token"
            value={token}
            onChange={(e) => {
              const value = e.target.value.slice(0, MAX_TOKEN_LENGTH);
              setToken(value);
              setHasDraftEdits(true);
              setSaveError(null);
            }}
            placeholder={t("lifecycleWebhooksTokenPlaceholder")}
            spellCheck={false}
          />
        </SettingsItem>

        <SettingsItem
          as="label"
          label={t("lifecycleWebhooksDryRunTitle")}
          description={t("lifecycleWebhooksDryRunDescription")}
          layout="custom"
        >
          <div className={rowsStyles.itemInfo} data-settings-info>
            <strong>{t("lifecycleWebhooksDryRunTitle")}</strong>
            <p>{t("lifecycleWebhooksDryRunDescription")}</p>
          </div>
          <Checkbox
            aria-label={t("lifecycleWebhooksDryRunTitle")}
            checked={dryRun}
            onCheckedChange={(checked) => {
              setDryRun(checked);
              setHasDraftEdits(true);
              setSaveError(null);
            }}
          />
        </SettingsItem>

        <div
          className={rowsStyles.item}
          style={{ justifyContent: "flex-end", gap: "var(--space-2)" }}
        >
          <Button
            variant="primary"
            type="submit"
            disabled={!hasChanges || isSaving}
          >
            {isSaving ? t("providersSaving") : t("providersSave")}
          </Button>
        </div>

        <HideInSettingsSearch>
          {(saveError || error) && (
            <Banner tone="error">{saveError || error}</Banner>
          )}
        </HideInSettingsSearch>
      </div>
    </SettingsSection>
  );
}
