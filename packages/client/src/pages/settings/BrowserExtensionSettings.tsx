import { useEffect, useState } from "react";
import {
  FilterDropdown,
  type FilterOption,
} from "../../components/FilterDropdown";
import { Button } from "../../components/ui/Button";
import { getChrome } from "../../extension/chrome";
import { activeHosts, defaultHost } from "../../extension/savedHosts";
import {
  DEFAULT_EXTENSION_SETTINGS,
  type ExtensionSettings,
  loadExtensionSettings,
  subscribeExtensionSettings,
  updateExtensionSettings,
} from "../../extension/settings";
import { useI18n } from "../../i18n";
import { loadSavedHosts } from "../../lib/hostStorage";
import styles from "./BrowserExtensionSettings.module.css";
import { SettingsItem } from "./SettingsItem";
import { SettingsSection } from "./SettingsSection";

/** Granted optional host origins, as host names (`https://github.com/*` → `github.com`). */
function useGrantedSites(): string[] {
  const [sites, setSites] = useState<string[]>([]);
  useEffect(() => {
    const chrome = getChrome();
    if (!chrome) return;
    const load = () =>
      void chrome.permissions
        .getAll()
        .then((granted) =>
          setSites(
            (granted.origins ?? [])
              .map((origin) => origin.match(/^https?:\/\/([^/]+)\/\*$/)?.[1])
              .filter((site): site is string => !!site && !site.includes("*")),
          ),
        );
    load();
    chrome.permissions.onAdded.addListener(load);
    chrome.permissions.onRemoved.addListener(load);
    return () => {
      chrome.permissions.onAdded.removeListener(load);
      chrome.permissions.onRemoved.removeListener(load);
    };
  }, []);
  return sites;
}

function Toggle({
  id,
  label,
  checked,
  onChange,
}: {
  id?: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <span className="toggle-switch">
      <input
        id={id}
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-slider" />
    </span>
  );
}

/** One choice from a few, in the dropdown the rest of the app uses. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: FilterOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <FilterDropdown<T>
      label={label}
      triggerTitle={label}
      multiSelect={false}
      align="right"
      options={options}
      selected={[value]}
      onChange={(values) => {
        if (values[0]) onChange(values[0]);
      }}
    />
  );
}

/**
 * Settings of the Chrome extension this page runs in (docs/tactical/151
 * step 10). Shown only on the extension's own origin; values live in
 * `chrome.storage.local`, so no host request is made here.
 */
export function BrowserExtensionSettings() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<ExtensionSettings>(
    DEFAULT_EXTENSION_SETTINGS,
  );
  const [allowlist, setAllowlist] = useState("");
  const [newSite, setNewSite] = useState("");
  const [siteError, setSiteError] = useState("");
  const sites = useGrantedSites();
  const hosts = loadSavedHosts().hosts.filter(
    (host) => host.mode === "relay" && host.relayUsername,
  );
  const active = new Set(activeHosts(hosts, settings).map((host) => host.id));
  const fallbackDefault = defaultHost(hosts, settings)?.id;

  useEffect(() => {
    void loadExtensionSettings().then((loaded) => {
      setSettings(loaded);
      setAllowlist(loaded.lookupAllowlist.join("\n"));
    });
    return subscribeExtensionSettings(setSettings);
  }, []);

  const update = (change: Partial<ExtensionSettings>) => {
    setSettings((current) => ({ ...current, ...change }));
    void updateExtensionSettings(change);
  };

  const setActive = (hostId: string, on: boolean) => {
    const ids = hosts
      .map((host) => host.id)
      .filter((id) => (id === hostId ? on : active.has(id)));
    update({ activeHostIds: ids });
  };

  const grantSite = () => {
    const chrome = getChrome();
    const site = newSite
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .toLowerCase();
    if (!chrome || !/^[a-z0-9.-]+(:\d+)?$/.test(site) || !site.includes(".")) {
      setSiteError(t("extensionSettingsInvalidSite"));
      return;
    }
    setSiteError("");
    void chrome.permissions
      .request({ origins: [`https://${site}/*`] })
      .then((granted) => {
        if (granted) setNewSite("");
      });
  };

  return (
    <>
      <p className={styles.lede}>{t("extensionSettingsLede")}</p>
      <SettingsSection
        title={t("extensionSettingsHostsTitle")}
        description={t("extensionSettingsHostsDescription")}
      >
        {hosts.length === 0 ? (
          <p className={styles.hint}>{t("extensionSettingsNoHosts")}</p>
        ) : (
          <ul className={styles.hostList}>
            {hosts.map((host) => (
              <li key={host.id} className={styles.hostRow}>
                <span className={styles.hostName}>
                  <strong>{host.displayName}</strong>
                  <span>relay · {host.relayUsername}</span>
                </span>
                <label
                  className={styles.inlineControl}
                  htmlFor={`extension-host-${host.id}`}
                >
                  <Toggle
                    id={`extension-host-${host.id}`}
                    label={t("extensionSettingsHostUse", {
                      host: host.displayName,
                    })}
                    checked={active.has(host.id)}
                    onChange={(on) => setActive(host.id, on)}
                  />
                  {t("extensionSettingsHostActive")}
                </label>
                <label className={styles.inlineControl}>
                  <input
                    type="radio"
                    name="extension-default-host"
                    checked={fallbackDefault === host.id}
                    disabled={!active.has(host.id)}
                    onChange={() => update({ defaultHostId: host.id })}
                  />
                  {t("extensionSettingsHostDefault")}
                </label>
              </li>
            ))}
          </ul>
        )}
        <p className={styles.hint}>{t("extensionSettingsDefaultHint")}</p>
      </SettingsSection>

      <SettingsSection
        title={t("extensionSettingsLookupTitle")}
        description={t("extensionSettingsLookupDescription")}
        doc="site/src/content/docs/chrome-extension.md#optional-automatic-lookup-and-badges"
      >
        <SettingsItem
          label={t("extensionSettingsAutomatic")}
          description={t("extensionSettingsAutomaticDescription")}
        >
          <Toggle
            label={t("extensionSettingsAutomatic")}
            checked={settings.automaticLookup}
            onChange={(automaticLookup) => update({ automaticLookup })}
          />
        </SettingsItem>
        <ul className={styles.siteList}>
          {sites.length === 0 && (
            <li className={styles.hint}>{t("extensionSettingsNoSites")}</li>
          )}
          {sites.map((site) => (
            <li key={site}>
              <span>
                <strong>{site}</strong>
                <span>{t("extensionSettingsSiteGranted")}</span>
              </span>
              <Button
                onClick={() =>
                  void getChrome()?.permissions.remove({
                    origins: [`https://${site}/*`],
                  })
                }
              >
                {t("extensionSettingsRemoveAccess")}
              </Button>
            </li>
          ))}
          <li className={styles.addSite}>
            <input
              aria-label={t("extensionSettingsAddSite")}
              placeholder="github.com"
              value={newSite}
              onChange={(event) => setNewSite(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") grantSite();
              }}
            />
            <Button disabled={!newSite.trim()} onClick={grantSite}>
              {t("extensionSettingsGrantAccess")}
            </Button>
          </li>
        </ul>
        {siteError && (
          <p className={styles.error} role="alert">
            {siteError}
          </p>
        )}
        <label className={styles.allowlist}>
          <span>
            <strong>{t("extensionSettingsAllowlist")}</strong>
            <span>{t("extensionSettingsAllowlistDescription")}</span>
          </span>
          <textarea
            rows={4}
            value={allowlist}
            onChange={(event) => setAllowlist(event.target.value)}
            onBlur={() =>
              update({
                lookupAllowlist: allowlist
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
              })
            }
          />
        </label>
        <SettingsItem
          label={t("extensionSettingsCollapseMerged")}
          description={t("extensionSettingsCollapseMergedHelp")}
        >
          <Toggle
            label={t("extensionSettingsCollapseMerged")}
            checked={settings.collapseMergedPrs}
            onChange={(collapseMergedPrs) => update({ collapseMergedPrs })}
          />
        </SettingsItem>
        <SettingsItem
          label={t("extensionSettingsIncludeDismissed")}
          description={t("extensionSettingsIncludeDismissedDescription")}
        >
          <Toggle
            label={t("extensionSettingsIncludeDismissed")}
            checked={settings.includeDismissed}
            onChange={(includeDismissed) => update({ includeDismissed })}
          />
        </SettingsItem>
      </SettingsSection>

      <SettingsSection title={t("extensionSettingsToolbarTitle")}>
        <SettingsItem label={t("extensionSettingsToolbarButton")}>
          <Choice
            label={t("extensionSettingsToolbarButton")}
            value={settings.toolbarAction}
            options={[
              {
                value: "side-panel",
                label: t("extensionSettingsToolbarSidePanel"),
              },
              { value: "app-tab", label: t("extensionSettingsToolbarAppTab") },
            ]}
            onChange={(toolbarAction) => update({ toolbarAction })}
          />
        </SettingsItem>
        <SettingsItem
          label={t("extensionSettingsBadge")}
          description={t("extensionSettingsBadgeDescription")}
        >
          <Choice
            label={t("extensionSettingsBadge")}
            value={settings.badge}
            options={[
              { value: "page", label: t("extensionSettingsBadgePage") },
              { value: "off", label: t("extensionSettingsBadgeOff") },
            ]}
            onChange={(badge) => update({ badge })}
          />
        </SettingsItem>
        <SettingsItem label={t("extensionSettingsFallback")}>
          <Choice
            label={t("extensionSettingsFallback")}
            value={settings.panelFallback}
            options={[
              {
                value: "attention",
                label: t("extensionSettingsFallbackAttention"),
              },
              { value: "recent", label: t("extensionSettingsFallbackRecent") },
              { value: "none", label: t("extensionSettingsFallbackNone") },
            ]}
            onChange={(panelFallback) => update({ panelFallback })}
          />
        </SettingsItem>
        <SettingsItem label={t("extensionSettingsOpenIn")}>
          <Choice
            label={t("extensionSettingsOpenIn")}
            value={settings.openSessionsIn}
            options={[
              {
                value: "existing-tab",
                label: t("extensionSettingsOpenInExisting"),
              },
              { value: "new-tab", label: t("extensionSettingsOpenInNew") },
            ]}
            onChange={(openSessionsIn) => update({ openSessionsIn })}
          />
        </SettingsItem>
        <SettingsItem
          label={t("extensionSettingsAppWindow")}
          description={t("extensionSettingsAppWindowDescription")}
        >
          <Choice
            label={t("extensionSettingsAppWindow")}
            value={settings.appWindow}
            options={[
              { value: "tab", label: t("extensionSettingsAppWindowTab") },
              { value: "popup", label: t("extensionSettingsAppWindowPopup") },
            ]}
            onChange={(appWindow) => update({ appWindow })}
          />
        </SettingsItem>
      </SettingsSection>
    </>
  );
}
