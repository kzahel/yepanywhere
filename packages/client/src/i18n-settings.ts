import type { SidebarSpacing } from "./hooks/useSidebarSpacing";
import type {
  OutputFixedFont,
  OutputProseFont,
} from "./hooks/useOutputAppearance";
import type { TabSize } from "./hooks/useTabSize";
import type { Theme } from "./hooks/useTheme";
import type { Locale } from "./i18n";
import type { SettingsCategory } from "./pages/settings/types";

export function getThemeLabel(
  theme: Theme,
  t: (key: string) => string,
): string {
  switch (theme) {
    case "auto":
      return t("themeAuto");
    case "light":
      return t("themeLight");
    case "dark":
      return t("themeDark");
    case "verydark":
      return t("themeVerydark");
  }
}

export function getSidebarSpacingLabel(
  spacing: SidebarSpacing,
  t: (key: string) => string,
): string {
  switch (spacing) {
    case "compact":
      return t("sidebarSpacingCompact");
    case "comfortable":
      return t("sidebarSpacingComfortable");
  }
}

export function getOutputProseFontLabel(
  font: OutputProseFont,
  t: (key: string) => string,
): string {
  switch (font) {
    case "system":
      return t("outputProseFontSystem");
    case "inter":
      return t("outputProseFontInter");
    case "alegreya-sans":
      return t("outputProseFontAlegreyaSans");
    case "source-serif-4":
      return t("outputProseFontSourceSerif4");
  }
}

export function getOutputFixedFontLabel(
  font: OutputFixedFont,
  t: (key: string) => string,
): string {
  switch (font) {
    case "system":
      return t("outputFixedFontSystem");
    case "iosevka":
      return t("outputFixedFontIosevka");
    case "ibm-plex-mono":
      return t("outputFixedFontIbmPlexMono");
    case "fira-mono":
      return t("outputFixedFontFiraMono");
  }
}

export function getTabSizeLabel(size: TabSize): string {
  return size;
}

export function getLocaleLabel(
  locale: Locale,
  t: (key: string) => string,
): string {
  switch (locale) {
    case "en":
      return t("localeNameEn");
    case "zh-CN":
      return t("localeNameZhCn");
    case "es":
      return t("localeNameEs");
    case "fr":
      return t("localeNameFr");
    case "de":
      return t("localeNameDe");
    case "ja":
      return t("localeNameJa");
  }
}

export function getSettingsCategories(
  t: (key: string) => string,
): SettingsCategory[] {
  return [
    {
      id: "appearance",
      label: t("settingsAppearanceTitle"),
      description: t("settingsAppearanceDescription"),
    },
    {
      id: "performance",
      label: t("settingsPerformanceTitle"),
      description: t("settingsPerformanceDescription"),
    },
    {
      id: "toolbar",
      label: t("settingsToolbarTitle"),
      description: t("settingsToolbarDescription"),
    },
    {
      id: "model",
      label: t("settingsModelTitle"),
      description: t("settingsModelDescription"),
    },
    {
      id: "message-delivery",
      label: t("settingsMessageDeliveryTitle"),
      description: t("settingsMessageDeliveryDescription"),
    },
    {
      id: "source-control",
      label: t("settingsSourceControlTitle"),
      description: t("settingsSourceControlDescription"),
    },
    {
      id: "issues",
      label: t("issuesTitle"),
      description: t("issuesSettingsDescription"),
    },
    {
      id: "storage",
      label: t("settingsStorageTitle"),
      description: t("settingsStorageDescription"),
    },
    {
      id: "computer-control",
      label: t("computerTitle"),
      description: t("computerDescription"),
    },
    {
      id: "agent-context",
      label: t("settingsAgentContextTitle"),
      description: t("settingsAgentContextDescription"),
    },
    {
      id: "notifications",
      label: t("settingsNotificationsTitle"),
      description: t("settingsNotificationsDescription"),
    },
    {
      id: "webhooks",
      label: t("settingsWebhooksTitle"),
      description: t("settingsWebhooksDescription"),
    },
    {
      id: "devices",
      label: t("settingsDevicesTitle"),
      description: t("settingsDevicesDescription"),
    },
    {
      id: "local-access",
      label: t("settingsLocalAccessTitle"),
      description: t("settingsLocalAccessDescription"),
    },
    {
      id: "remote",
      label: t("settingsRemoteTitle"),
      description: t("settingsRemoteDescription"),
    },
    {
      id: "providers",
      label: t("settingsProvidersTitle"),
      description: t("settingsProvidersDescription"),
    },
    {
      id: "cache-miss-billing",
      label: t("settingsCacheMissBillingTitle"),
      description: t("settingsCacheMissBillingDescription"),
    },
    {
      id: "speech",
      label: t("settingsSpeechTitle"),
      description: t("settingsSpeechDescription"),
    },
    {
      id: "remote-executors",
      label: t("settingsRemoteExecutorsTitle"),
      description: t("settingsRemoteExecutorsDescription"),
    },
    {
      id: "environment",
      label: t("settingsEnvironmentTitle"),
      description: t("settingsEnvironmentDescription"),
    },
    {
      id: "development",
      label: t("settingsDevelopmentTitle"),
      description: t("settingsDevelopmentDescription"),
    },
    {
      id: "about",
      label: t("settingsAboutTitle"),
      description: t("settingsAboutDescription"),
    },
  ];
}

export function getEmulatorCategory(
  t: (key: string) => string,
): SettingsCategory {
  return {
    id: "emulator",
    label: t("settingsEmulatorTitle"),
    description: t("settingsEmulatorDescription"),
  };
}
