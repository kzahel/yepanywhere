/**
 * RemoteAccessService manages SRP credentials for remote access.
 *
 * Features:
 * - Stores SRP verifier (never the password)
 * - Enables/disables remote access
 * - Follows AuthService pattern for state persistence
 *
 * State is persisted to a JSON file for durability across server restarts.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { generateVerifier } from "../crypto/srp-server.js";

const CURRENT_VERSION = 1;

export interface RemoteAccessState {
  /** Schema version for future migrations */
  version: number;
  /** Whether remote access is enabled */
  enabled: boolean;
  /** SRP credentials (undefined = not configured) */
  credentials?: {
    /** Username/identity */
    username: string;
    /** SRP salt (hex string) */
    salt: string;
    /** SRP verifier (hex string) */
    verifier: string;
    /** When credentials were created */
    createdAt: string;
  };
}

export interface RemoteAccessServiceOptions {
  /** Directory to store state (defaults to dataDir) */
  dataDir: string;
}

export class RemoteAccessService {
  private state: RemoteAccessState;
  private dataDir: string;
  private filePath: string;
  private savePromise: Promise<void> | null = null;
  private pendingSave = false;

  constructor(options: RemoteAccessServiceOptions) {
    this.dataDir = options.dataDir;
    this.filePath = path.join(this.dataDir, "remote-access.json");
    this.state = { version: CURRENT_VERSION, enabled: false };
  }

  /**
   * Initialize the service by loading state from disk.
   * Creates the data directory if it doesn't exist.
   */
  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });

      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as RemoteAccessState;

      if (parsed.version === CURRENT_VERSION) {
        this.state = parsed;
      } else {
        // Future: handle migrations
        this.state = {
          version: CURRENT_VERSION,
          enabled: parsed.enabled ?? false,
          credentials: parsed.credentials,
        };
        await this.save();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[RemoteAccessService] Failed to load state, starting fresh:",
          error,
        );
      }
      this.state = { version: CURRENT_VERSION, enabled: false };
    }
  }

  /**
   * Check if remote access is enabled and configured.
   */
  isEnabled(): boolean {
    return this.state.enabled && !!this.state.credentials;
  }

  /**
   * Check if credentials have been configured (even if disabled).
   */
  isConfigured(): boolean {
    return !!this.state.credentials;
  }

  /**
   * Get the configured username.
   */
  getUsername(): string | null {
    return this.state.credentials?.username ?? null;
  }

  /**
   * Get the SRP credentials for authentication.
   * Returns null if not configured.
   */
  getCredentials(): { salt: string; verifier: string } | null {
    if (!this.state.credentials) return null;
    return {
      salt: this.state.credentials.salt,
      verifier: this.state.credentials.verifier,
    };
  }

  /**
   * Get the current configuration state (for API responses).
   */
  getConfig(): { enabled: boolean; username: string | null } {
    return {
      enabled: this.isEnabled(),
      username: this.getUsername(),
    };
  }

  /**
   * Configure remote access with username and password.
   * Generates and stores the SRP verifier (never stores the password).
   */
  async configure(username: string, password: string): Promise<void> {
    // Validate username
    if (!username || username.length < 3) {
      throw new Error("Username must be at least 3 characters");
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      throw new Error(
        "Username can only contain letters, numbers, underscores, and hyphens",
      );
    }

    // Validate password
    if (!password || password.length < 8) {
      throw new Error("Password must be at least 8 characters");
    }

    // Generate SRP verifier
    const { salt, verifier } = await generateVerifier(username, password);

    this.state.enabled = true;
    this.state.credentials = {
      username,
      salt,
      verifier,
      createdAt: new Date().toISOString(),
    };
    await this.save();
  }

  /**
   * Enable remote access (must be configured first).
   */
  async enable(): Promise<void> {
    if (!this.state.credentials) {
      throw new Error("Must configure credentials before enabling");
    }
    this.state.enabled = true;
    await this.save();
  }

  /**
   * Disable remote access (keeps credentials for re-enabling).
   */
  async disable(): Promise<void> {
    this.state.enabled = false;
    await this.save();
  }

  /**
   * Clear all credentials and disable remote access.
   */
  async clearCredentials(): Promise<void> {
    this.state.enabled = false;
    this.state.credentials = undefined;
    await this.save();
  }

  /**
   * Save state to disk with debouncing to avoid excessive writes.
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
    const content = JSON.stringify(this.state, null, 2);
    await fs.writeFile(this.filePath, content, "utf-8");
  }
}
