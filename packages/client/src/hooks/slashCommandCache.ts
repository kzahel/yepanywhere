import { getCurrentInstallId } from "../lib/storageKeys";

const LEGACY_PREFIX = "yep-anywhere-slash-commands-";

function getLegacyStorageKey(provider: string): string {
  return `${LEGACY_PREFIX}${provider}`;
}

function getScopedStorageKey(provider: string, installId: string): string {
  return `yep-anywhere-${installId}-slash-commands-${provider}`;
}

function readStoredCommands(storageKey: string): string[] | null {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return null;
  }
}

export function getCachedSlashCommands(provider?: string): string[] {
  if (
    !provider ||
    typeof window === "undefined" ||
    typeof localStorage?.getItem !== "function"
  ) {
    return [];
  }

  const installId = getCurrentInstallId();
  const scopedKey = installId ? getScopedStorageKey(provider, installId) : null;
  if (scopedKey) {
    const scopedCommands = readStoredCommands(scopedKey);
    if (scopedCommands) {
      return scopedCommands;
    }
  }

  try {
    const legacyCommands = readStoredCommands(getLegacyStorageKey(provider));
    if (!legacyCommands) return [];

    if (scopedKey) {
      localStorage.setItem(scopedKey, JSON.stringify(legacyCommands));
      localStorage.removeItem(getLegacyStorageKey(provider));
    }

    return legacyCommands;
  } catch {
    return [];
  }
}

export function setCachedSlashCommands(
  provider: string | undefined,
  commands: string[],
): void {
  if (
    !provider ||
    typeof window === "undefined" ||
    typeof localStorage?.setItem !== "function"
  ) {
    return;
  }

  try {
    const installId = getCurrentInstallId();
    const storageKey = installId
      ? getScopedStorageKey(provider, installId)
      : getLegacyStorageKey(provider);
    localStorage.setItem(storageKey, JSON.stringify(commands));
    if (installId) {
      localStorage.removeItem(getLegacyStorageKey(provider));
    }
  } catch {
    // Ignore localStorage failures.
  }
}
