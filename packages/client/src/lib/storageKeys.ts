/**
 * Centralized localStorage key definitions.
 *
 * Keys are split into two categories:
 * - UI_KEYS: Visual preferences that are global to the browser
 * - SERVER_SCOPED_KEYS: Settings that need to be scoped by server installId
 *
 * When accessing via yepanywhere.com/remote, users may connect to different
 * servers. Server-scoped settings ensure each server has independent config.
 */

// ============================================================================
// Global Install ID (set once on connection, used for key scoping)
// ============================================================================

let currentInstallId: string | undefined;

/** Set the current server's install ID (called once on connection) */
export function setCurrentInstallId(installId: string): void {
  const prevInstallId = currentInstallId;
  currentInstallId = installId;

  // Run migration if this is a new install ID
  if (prevInstallId !== installId) {
    const migrated = migrateLegacySettings(installId);
    if (migrated) {
      console.log(
        "[storageKeys] Migrated legacy localStorage keys to scoped keys",
      );
    }
  }
}

/** Get the current server's install ID (undefined if not yet set) */
export function getCurrentInstallId(): string | undefined {
  return currentInstallId;
}

// ============================================================================
// UI Preferences (global to browser, not scoped by server)
// ============================================================================

export const UI_KEYS = {
  theme: "yep-anywhere-theme",
  fontSize: "yep-anywhere-font-size",
  sidebarWidth: "yep-anywhere-sidebar-width",
  sidebarExpanded: "yep-anywhere-sidebar-expanded",
  funPhrases: "yep-anywhere-fun-phrases-enabled",
  streamingEnabled: "yep-anywhere-streaming-enabled",
  developerMode: "yep-anywhere-developer-mode",
  schemaValidation: "yep-anywhere-schema-validation",
} as const;

// ============================================================================
// Server-Scoped Settings (prefixed with installId)
// ============================================================================

/** Base key names for server-scoped settings (installId prefix added at runtime) */
export const SERVER_SCOPED_KEYS = {
  model: "model",
  thinkingLevel: "thinking-level",
  thinkingEnabled: "thinking-enabled",
  voiceInputEnabled: "voice-input-enabled",
  browserProfileId: "browser-profile-id",
  notifyInApp: "notify-in-app",
  recentProject: "recent-project",
  beadsProject: "beads-project",
} as const;

/** Build a server-scoped storage key */
export function serverKey(
  installId: string,
  key: (typeof SERVER_SCOPED_KEYS)[keyof typeof SERVER_SCOPED_KEYS],
): string {
  return `yep-anywhere-${installId}-${key}`;
}

/**
 * Get a server-scoped value from localStorage.
 * Falls back to unscoped key if installId is not yet available.
 */
export function getServerScoped(
  key: keyof typeof SERVER_SCOPED_KEYS,
  legacyKey?: string,
): string | null {
  const installId = currentInstallId;
  if (installId) {
    const scopedKey = serverKey(installId, SERVER_SCOPED_KEYS[key]);
    return localStorage.getItem(scopedKey);
  }
  // Fallback to legacy key if available
  if (legacyKey) {
    return localStorage.getItem(legacyKey);
  }
  return null;
}

/**
 * Set a server-scoped value in localStorage.
 * Falls back to unscoped key if installId is not yet available.
 */
export function setServerScoped(
  key: keyof typeof SERVER_SCOPED_KEYS,
  value: string,
  legacyKey?: string,
): void {
  const installId = currentInstallId;
  if (installId) {
    const scopedKey = serverKey(installId, SERVER_SCOPED_KEYS[key]);
    localStorage.setItem(scopedKey, value);
  } else if (legacyKey) {
    // Fallback to legacy key
    localStorage.setItem(legacyKey, value);
  }
}

/**
 * Remove a server-scoped value from localStorage.
 */
export function removeServerScoped(
  key: keyof typeof SERVER_SCOPED_KEYS,
  legacyKey?: string,
): void {
  const installId = currentInstallId;
  if (installId) {
    const scopedKey = serverKey(installId, SERVER_SCOPED_KEYS[key]);
    localStorage.removeItem(scopedKey);
  }
  // Also remove legacy key if present
  if (legacyKey) {
    localStorage.removeItem(legacyKey);
  }
}

// ============================================================================
// Dynamic Key Builders (for session/project-specific keys)
// ============================================================================

export const KEY_BUILDERS = {
  /** Draft message for an existing session */
  draftMessage: (installId: string, sessionId: string) =>
    `yep-anywhere-${installId}-draft-${sessionId}`,

  /** Draft for a new session in a project */
  newSessionDraft: (installId: string, projectId: string) =>
    `yep-anywhere-${installId}-new-session-draft-${projectId}`,

  /** FAB draft content */
  fabDraft: (installId: string) => `yep-anywhere-${installId}-fab-draft`,

  /** FAB prefill content */
  fabPrefill: (installId: string) => `yep-anywhere-${installId}-fab-prefill`,
} as const;

// ============================================================================
// Special Keys (not scoped, handle their own structure)
// ============================================================================

/** Remote connection credentials - stored per wsUrl internally */
export const REMOTE_CREDENTIALS_KEY = "yep-anywhere-remote-credentials";

// ============================================================================
// Legacy Key Mappings (for migration from old unscoped keys)
// ============================================================================

/** Old unscoped keys that need migration to server-scoped versions */
export const LEGACY_KEYS = {
  model: "yep-anywhere-model",
  thinkingLevel: "yep-anywhere-thinking-level",
  thinkingEnabled: "yep-anywhere-thinking-enabled",
  voiceInputEnabled: "yep-anywhere-voice-input-enabled",
  browserProfileId: "yep-anywhere-device-id",
  notifyInApp: "yep-anywhere-notify-in-app",
  recentProject: "yep-anywhere-recent-project",
  beadsProject: "beads-selected-project", // note: old key had different name
  // Draft keys had different prefixes
  draftMessagePrefix: "draft-message-",
  newSessionDraftPrefix: "draft-new-session-",
  fabDraft: "fab-draft",
  fabPrefill: "fab-prefill",
} as const;

/** Keys that need renaming (old name -> new name in UI_KEYS) */
export const UI_KEY_RENAMES = {
  "sidebar-expanded": UI_KEYS.sidebarExpanded,
} as const;

// ============================================================================
// Migration Helper
// ============================================================================

/**
 * Migrate legacy unscoped settings to server-scoped keys.
 * Call this once when the installId becomes available.
 * Returns true if any migrations were performed.
 */
export function migrateLegacySettings(installId: string): boolean {
  let migrated = false;

  // Migrate server-scoped keys
  const scopedMigrations: Array<{
    legacy: string;
    scoped: keyof typeof SERVER_SCOPED_KEYS;
  }> = [
    { legacy: LEGACY_KEYS.model, scoped: "model" },
    { legacy: LEGACY_KEYS.thinkingLevel, scoped: "thinkingLevel" },
    { legacy: LEGACY_KEYS.thinkingEnabled, scoped: "thinkingEnabled" },
    { legacy: LEGACY_KEYS.voiceInputEnabled, scoped: "voiceInputEnabled" },
    { legacy: LEGACY_KEYS.browserProfileId, scoped: "browserProfileId" },
    { legacy: LEGACY_KEYS.notifyInApp, scoped: "notifyInApp" },
    { legacy: LEGACY_KEYS.recentProject, scoped: "recentProject" },
    { legacy: LEGACY_KEYS.beadsProject, scoped: "beadsProject" },
  ];

  for (const { legacy, scoped } of scopedMigrations) {
    const value = localStorage.getItem(legacy);
    if (value !== null) {
      const newKey = serverKey(installId, SERVER_SCOPED_KEYS[scoped]);
      // Only migrate if new key doesn't already exist
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, value);
        migrated = true;
      }
      // Remove legacy key after migration
      localStorage.removeItem(legacy);
    }
  }

  // Migrate UI key renames
  for (const [oldKey, newKey] of Object.entries(UI_KEY_RENAMES)) {
    const value = localStorage.getItem(oldKey);
    if (value !== null) {
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, value);
        migrated = true;
      }
      localStorage.removeItem(oldKey);
    }
  }

  // Migrate FAB keys
  const fabMigrations: Array<{
    legacy: string;
    builder: "fabDraft" | "fabPrefill";
  }> = [
    { legacy: LEGACY_KEYS.fabDraft, builder: "fabDraft" },
    { legacy: LEGACY_KEYS.fabPrefill, builder: "fabPrefill" },
  ];

  for (const { legacy, builder } of fabMigrations) {
    const value = localStorage.getItem(legacy);
    if (value !== null) {
      const newKey = KEY_BUILDERS[builder](installId);
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, value);
        migrated = true;
      }
      localStorage.removeItem(legacy);
    }
  }

  // Migrate draft keys (draft-message-* and draft-new-session-*)
  const allKeys = Object.keys(localStorage);
  for (const key of allKeys) {
    if (key.startsWith(LEGACY_KEYS.draftMessagePrefix)) {
      const sessionId = key.slice(LEGACY_KEYS.draftMessagePrefix.length);
      const value = localStorage.getItem(key);
      if (value !== null) {
        const newKey = KEY_BUILDERS.draftMessage(installId, sessionId);
        if (localStorage.getItem(newKey) === null) {
          localStorage.setItem(newKey, value);
          migrated = true;
        }
        localStorage.removeItem(key);
      }
    } else if (key.startsWith(LEGACY_KEYS.newSessionDraftPrefix)) {
      const projectId = key.slice(LEGACY_KEYS.newSessionDraftPrefix.length);
      const value = localStorage.getItem(key);
      if (value !== null) {
        const newKey = KEY_BUILDERS.newSessionDraft(installId, projectId);
        if (localStorage.getItem(newKey) === null) {
          localStorage.setItem(newKey, value);
          migrated = true;
        }
        localStorage.removeItem(key);
      }
    }
  }

  return migrated;
}
