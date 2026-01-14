export interface SettingsCategory {
  id: string;
  label: string;
  icon: string;
  description: string;
}

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: "appearance",
    label: "Appearance",
    icon: "🎨",
    description: "Theme, font size, streaming",
  },
  {
    id: "model",
    label: "Model",
    icon: "🧠",
    description: "Claude model and thinking settings",
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: "🔔",
    description: "Push notification preferences",
  },
  {
    id: "devices",
    label: "Devices",
    icon: "📱",
    description: "Browser profiles and connection origins",
  },
  {
    id: "local-access",
    label: "Local Access",
    icon: "🔒",
    description: "Network binding and authentication",
  },
  {
    id: "remote",
    label: "Remote Access",
    icon: "🌐",
    description: "Relay server configuration",
  },
  {
    id: "providers",
    label: "Providers",
    icon: "🔌",
    description: "AI provider integrations",
  },
  {
    id: "remote-executors",
    label: "Remote Executors",
    icon: "🖥️",
    description: "Run sessions on remote machines",
  },
  {
    id: "about",
    label: "About",
    icon: "ℹ️",
    description: "Version and support",
  },
];

// Development category added conditionally
export const DEV_CATEGORY: SettingsCategory = {
  id: "development",
  label: "Development",
  icon: "🛠️",
  description: "Developer tools and debugging",
};
