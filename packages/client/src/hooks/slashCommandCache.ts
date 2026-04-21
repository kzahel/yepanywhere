import { getCurrentInstallId } from "../lib/storageKeys";

const LEGACY_PREFIX = "yep-anywhere-slash-commands-";

function getLegacyStorageKey(provider: string): string {
  return `${LEGACY_PREFIX}${provider}`;
}

function getScopedStorageKey(provider: string, installId: string): string {
  return `yep-anywhere-${installId}-slash-commands-${provider}`;
}

function getProjectScopedStorageKey(
  provider: string,
  installId: string,
  projectId: string,
): string {
  return `yep-anywhere-${installId}-slash-commands-${provider}-${projectId}`;
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

export function getCachedSlashCommands(
  provider?: string,
  projectId?: string,
): string[] {
  if (
    !provider ||
    typeof window === "undefined" ||
    typeof localStorage?.getItem !== "function"
  ) {
    return [];
  }

  const installId = getCurrentInstallId();
  const projectScopedKey =
    installId && projectId
      ? getProjectScopedStorageKey(provider, installId, projectId)
      : null;
  const scopedKey = installId ? getScopedStorageKey(provider, installId) : null;

  if (projectScopedKey) {
    const projectScopedCommands = readStoredCommands(projectScopedKey);
    if (projectScopedCommands) {
      return projectScopedCommands;
    }
  }

  if (scopedKey) {
    const scopedCommands = readStoredCommands(scopedKey);
    if (scopedCommands) {
      if (projectScopedKey) {
        localStorage.setItem(projectScopedKey, JSON.stringify(scopedCommands));
      }
      return scopedCommands;
    }
  }

  try {
    const legacyCommands = readStoredCommands(getLegacyStorageKey(provider));
    if (!legacyCommands) return [];

    if (projectScopedKey) {
      localStorage.setItem(projectScopedKey, JSON.stringify(legacyCommands));
    }
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
  projectId: string | undefined,
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
    const storageKeys = new Set<string>();
    if (installId) {
      storageKeys.add(getScopedStorageKey(provider, installId));
      if (projectId) {
        storageKeys.add(
          getProjectScopedStorageKey(provider, installId, projectId),
        );
      }
    } else {
      storageKeys.add(getLegacyStorageKey(provider));
    }

    for (const storageKey of storageKeys) {
      localStorage.setItem(storageKey, JSON.stringify(commands));
    }
    if (installId) {
      localStorage.removeItem(getLegacyStorageKey(provider));
    }
  } catch {
    // Ignore localStorage failures.
  }
}
