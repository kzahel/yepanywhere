/**
 * ServerSettingsService - Manages server-wide settings that persist across restarts
 *
 * Stores settings like:
 * - serviceWorkerEnabled: Whether clients should register the service worker
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { NewSessionDefaults } from "@yep-anywhere/shared";

const CURRENT_VERSION = 1;

/** Server-wide settings */
export interface ServerSettings {
  /** Whether clients should register the service worker (for push notifications) */
  serviceWorkerEnabled: boolean;
  /** Whether remote SRP resume sessions should be persisted to disk (default: false/in-memory only) */
  persistRemoteSessionsToDisk: boolean;
  /** SSH host aliases for remote executors (from ~/.ssh/config) */
  remoteExecutors?: string[];
  /** SSH host aliases for ChromeOS device-bridge targets */
  chromeOsHosts?: string[];
  /** Allowed hostnames for host/origin validation. "*" = allow all, comma-separated = specific hosts. */
  allowedHosts?: string;
  /** Free-form instructions appended to the system prompt for all sessions */
  globalInstructions?: string;
  /** Ollama server URL for claude-ollama provider (default: http://localhost:11434) */
  ollamaUrl?: string;
  /** Custom system prompt for Ollama provider (overrides the default minimal prompt) */
  ollamaSystemPrompt?: string;
  /** Whether to use the full Claude system prompt for Ollama (for large-context models like Qwen3) */
  ollamaUseFullSystemPrompt?: boolean;
  /** Whether the device bridge (emulator/device streaming) feature is enabled */
  deviceBridgeEnabled?: boolean;
  /** Defaults applied when opening the new session form */
  newSessionDefaults?: NewSessionDefaults;
  /** Whether lifecycle webhook delivery is enabled */
  lifecycleWebhooksEnabled?: boolean;
  /** External webhook URL that receives lifecycle events */
  lifecycleWebhookUrl?: string;
  /** Optional bearer token used for lifecycle webhook delivery */
  lifecycleWebhookToken?: string;
  /** When true, include dryRun=true in lifecycle webhook payloads */
  lifecycleWebhookDryRun?: boolean;
  /** Whether new sessions should use git worktrees by default */
  worktreeEnabled?: boolean;
  /** Files to copy from original project into worktrees (e.g., [".env", "secrets.json"]) */
  worktreeCopyFiles?: string[];
  /** Directories to symlink from original project into worktrees (e.g., ["node_modules", ".venv"]) */
  worktreeSymlinkDirectories?: string[];
  /** Command to run after worktree creation (e.g., "pnpm install") */
  worktreePostCreateCommand?: string;
}

/** Default settings */
export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  serviceWorkerEnabled: true,
  persistRemoteSessionsToDisk: false,
  lifecycleWebhooksEnabled: false,
  lifecycleWebhookDryRun: true,
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
