import type { FontSize } from "./hooks/useFontSize";
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

export function getFontSizeLabel(
  size: FontSize,
  t: (key: string) => string,
): string {
  switch (size) {
    case "small":
      return t("fontSizeSmall");
    case "default":
      return t("fontSizeDefault");
    case "large":
      return t("fontSizeLarge");
    case "larger":
      return t("fontSizeLarger");
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
      icon: "🎨",
      description: t("settingsAppearanceDescription"),
    },
    {
      id: "model",
      label: t("settingsModelTitle"),
      icon: "🧠",
      description: t("settingsModelDescription"),
    },
    {
      id: "agent-context",
      label: t("settingsAgentContextTitle"),
      icon: "📋",
      description: t("settingsAgentContextDescription"),
    },
    {
      id: "notifications",
      label: t("settingsNotificationsTitle"),
      icon: "🔔",
      description: t("settingsNotificationsDescription"),
    },
    {
      id: "webhooks",
      label: t("settingsWebhooksTitle"),
      icon: "🪝",
      description: t("settingsWebhooksDescription"),
    },
    {
      id: "devices",
      label: t("settingsDevicesTitle"),
      icon: "📱",
      description: t("settingsDevicesDescription"),
    },
    {
      id: "local-access",
      label: t("settingsLocalAccessTitle"),
      icon: "🔒",
      description: t("settingsLocalAccessDescription"),
    },
    {
      id: "remote",
      label: t("settingsRemoteTitle"),
      icon: "🌐",
      description: t("settingsRemoteDescription"),
    },
    {
      id: "providers",
      label: t("settingsProvidersTitle"),
      icon: "🔌",
      description: t("settingsProvidersDescription"),
    },
    {
      id: "remote-executors",
      label: t("settingsRemoteExecutorsTitle"),
      icon: "🖥️",
      description: t("settingsRemoteExecutorsDescription"),
    },
    {
      id: "about",
      label: t("settingsAboutTitle"),
      icon: "ℹ️",
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
    icon: "🤖",
    description: t("settingsEmulatorDescription"),
  };
}

export function getDevelopmentCategory(
  t: (key: string) => string,
): SettingsCategory {
  return {
    id: "development",
    label: t("settingsDevelopmentTitle"),
    icon: "🛠️",
    description: t("settingsDevelopmentDescription"),
  };
}
