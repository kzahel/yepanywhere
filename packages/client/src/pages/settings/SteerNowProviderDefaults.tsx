import {
  type ClientDefaults,
  DEFAULT_STEER_NOW_ENABLED,
  type ProviderInfo,
  type ProviderName,
  SERVER_CAPABILITIES,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useProviders } from "../../hooks/useProviders";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import { providerSupportsSteerNow } from "../../lib/providerCapabilities";
import { SettingsItem } from "./SettingsItem";
import styles from "./SteerNowProviderDefaults.module.css";

type SteerNowOverrides = NonNullable<
  ClientDefaults["steerNowDefaultByProvider"]
>;

const DOC =
  "topics/steer-queue-provider-differences.md#levels-of-soon-urgency-ladder-short-of-hard-interrupt";

/** Server support for per-provider overrides; absent servers get no writes. */
export function useSupportsSteerNowProviderDefaults(): boolean {
  const { version } = useVersion();
  return serverHasCapability(
    version,
    SERVER_CAPABILITIES.providerSteerNowDefaults.name,
  );
}

/**
 * One provider's three-way Steer now default: inherit the global default
 * (stored as an absent key), or force on/off. The Message delivery pane and
 * the provider's own settings row render this same control.
 */
export function SteerNowProviderDefaultRow({
  provider,
  globalDefault,
  searchable = true,
}: {
  provider: Pick<ProviderInfo, "name" | "displayName">;
  /** Shown value of the global default, which may be an unsaved draft. */
  globalDefault?: boolean;
  searchable?: boolean;
}) {
  const { t } = useI18n();
  const { settings, updateSettings } = useServerSettings();
  const overrides: SteerNowOverrides =
    settings?.clientDefaults?.steerNowDefaultByProvider ?? {};
  const inherited =
    globalDefault ??
    settings?.clientDefaults?.steerNowDefault ??
    DEFAULT_STEER_NOW_ENABLED;
  const own = overrides[provider.name];
  const title = t("providerSteerNowDefaultTitle", {
    provider: provider.displayName,
  });
  const save = (choice: string) => {
    const next: SteerNowOverrides = { ...overrides };
    if (choice === "inherit") delete next[provider.name];
    else next[provider.name] = choice === "on";
    void updateSettings({
      clientDefaults: { steerNowDefaultByProvider: next },
    }).catch(() => {
      // surfaced via the hook's error state
    });
  };
  return (
    <SettingsItem
      id={`steer-now-default-${provider.name}`}
      label={title}
      description={t("providerSteerNowDefaultDescription")}
      descriptionLayout="full-width-on-narrow"
      doc={DOC}
      searchable={searchable}
    >
      <select
        className="settings-select"
        value={own === undefined ? "inherit" : own ? "on" : "off"}
        aria-label={title}
        onChange={(event) => save(event.target.value)}
      >
        <option value="inherit">
          {t("providerSteerNowDefaultInherit", {
            value: inherited
              ? t("providerSteerNowDefaultOn")
              : t("providerSteerNowDefaultOff"),
          })}
        </option>
        <option value="on">{t("providerSteerNowDefaultOn")}</option>
        <option value="off">{t("providerSteerNowDefaultOff")}</option>
      </select>
    </SettingsItem>
  );
}

/** Providers whose composer offers the "now" toggle. */
export function useSteerNowProviders(): ProviderInfo[] {
  const { providers } = useProviders();
  return providers.filter(providerSupportsSteerNow);
}

/**
 * The provider-settings copy of a row whose searchable home is Message
 * delivery; renders nothing when the provider or server lacks support.
 */
export function ProviderSteerNowDefault({ name }: { name: string }) {
  const supported = useSupportsSteerNowProviderDefaults();
  const provider = useSteerNowProviders().find((p) => p.name === name);
  if (!supported || !provider) return null;
  return <SteerNowProviderDefaultRow provider={provider} searchable={false} />;
}

/** Disclosure under the global default; opens when any override is set. */
export function SteerNowProviderOverrides({
  globalDefault,
}: {
  globalDefault: boolean;
}) {
  const { t } = useI18n();
  const { settings } = useServerSettings();
  const providers = useSteerNowProviders();
  if (providers.length === 0) return null;
  const overridden = providers.filter(
    (provider) =>
      settings?.clientDefaults?.steerNowDefaultByProvider?.[
        provider.name as ProviderName
      ] !== undefined,
  ).length;
  return (
    <details className={styles.overrides} open={overridden > 0}>
      <summary className="settings-hint">
        {t("providerSteerNowDefaultOverrides")}
        {overridden > 0 ? ` (${overridden})` : ""}
      </summary>
      {providers.map((provider) => (
        <SteerNowProviderDefaultRow
          key={provider.name}
          provider={provider}
          globalDefault={globalDefault}
        />
      ))}
    </details>
  );
}
