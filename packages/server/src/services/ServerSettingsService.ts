/**
 * ServerSettingsService - Manages server-wide settings that persist across restarts
 *
 * Stores settings like:
 * - serviceWorkerEnabled: Whether clients should register the service worker
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

const CURRENT_VERSION = 1;

/** Server-wide settings */
export interface ServerSettings {
  /** Whether clients should register the service worker (for push notifications) */
  serviceWorkerEnabled: boolean;
}

/** Default settings */
export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  serviceWorkerEnabled: true,
};

/** Stored state with version for migrations */
interface SettingsState {
  version: number;
  settings: ServerSettings;
}

export interface ServerSettingsServiceOptions {
  dataDir: string;
}

export class ServerSettingsService {
  private state: SettingsState;
  private dataDir: string;
  private filePath: string;
  private initialized = false;
  private savePromise: Promise<void> | null = null;
  private pendingSave = false;

  constructor(options: ServerSettingsServiceOptions) {
    this.dataDir = options.dataDir;
    this.filePath = path.join(this.dataDir, "server-settings.json");
    this.state = {
      version: CURRENT_VERSION,
      settings: DEFAULT_SERVER_SETTINGS,
    };
  }

  /**
   * Initialize the service by loading state from disk.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.dataDir, { recursive: true });

      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as SettingsState;

      if (parsed.version === CURRENT_VERSION) {
        // Merge with defaults in case new settings were added
        this.state = {
          version: CURRENT_VERSION,
          settings: { ...DEFAULT_SERVER_SETTINGS, ...parsed.settings },
        };
      } else {
        // Future: handle migrations
        this.state = {
          version: CURRENT_VERSION,
          settings: { ...DEFAULT_SERVER_SETTINGS, ...parsed.settings },
        };
        await this.save();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[ServerSettingsService] Failed to load settings, using defaults:",
          error,
        );
      }
      this.state = {
        version: CURRENT_VERSION,
        settings: DEFAULT_SERVER_SETTINGS,
      };
    }

    this.initialized = true;
  }

  /**
   * Get all settings.
   */
  getSettings(): ServerSettings {
    this.ensureInitialized();
    return { ...this.state.settings };
  }

  /**
   * Get a specific setting.
   */
  getSetting<K extends keyof ServerSettings>(key: K): ServerSettings[K] {
    this.ensureInitialized();
    return this.state.settings[key];
  }

  /**
   * Update settings.
   */
  async updateSettings(
    updates: Partial<ServerSettings>,
  ): Promise<ServerSettings> {
    this.ensureInitialized();

    this.state.settings = {
      ...this.state.settings,
      ...updates,
    };

    await this.save();
    return { ...this.state.settings };
  }

  /**
   * Ensure service is initialized.
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "ServerSettingsService not initialized. Call initialize() first.",
      );
    }
  }

  /**
   * Save state to disk with debouncing.
   */
  private async save(): Promise<void> {
    if (this.savePromise) {
      this.pendingSave = true;
      return;
    }

    this.savePromise = this.doSave();
    await this.savePromise;
    this.savePromise = null;

    if (this.pendingSave) {
      this.pendingSave = false;
      await this.save();
    }
  }

  private async doSave(): Promise<void> {
    try {
      const content = JSON.stringify(this.state, null, 2);
      await fs.writeFile(this.filePath, content, "utf-8");
    } catch (error) {
      console.error("[ServerSettingsService] Failed to save settings:", error);
      throw error;
    }
  }
}
