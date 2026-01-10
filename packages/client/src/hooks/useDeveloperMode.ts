import { useCallback, useSyncExternalStore } from "react";

const DEV_MODE_KEY = "yep-anywhere-developer-mode";

interface DeveloperModeSettings {
  holdModeEnabled: boolean;
}

const DEFAULT_SETTINGS: DeveloperModeSettings = {
  holdModeEnabled: false,
};

function loadSettings(): DeveloperModeSettings {
  const stored = localStorage.getItem(DEV_MODE_KEY);
  if (!stored) return DEFAULT_SETTINGS;
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: DeveloperModeSettings) {
  localStorage.setItem(DEV_MODE_KEY, JSON.stringify(settings));
}

// Simple external store for cross-component sync
let currentSettings = loadSettings();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentSettings;
}

function updateSettings(newSettings: DeveloperModeSettings) {
  currentSettings = newSettings;
  saveSettings(newSettings);
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Hook to manage developer mode settings.
 * Settings are persisted to localStorage and synced across components.
 */
export function useDeveloperMode() {
  const settings = useSyncExternalStore(subscribe, getSnapshot);

  const setHoldModeEnabled = useCallback((enabled: boolean) => {
    updateSettings({ ...currentSettings, holdModeEnabled: enabled });
  }, []);

  return {
    holdModeEnabled: settings.holdModeEnabled,
    setHoldModeEnabled,
  };
}
