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
import { normalizeRelayUrl } from "@yep-anywhere/shared";
import { generateVerifier } from "../crypto/srp-server.js";
import {
  OWNER_READ_WRITE_FILE_MODE,
  enforceOwnerReadWriteFilePermissions,
} from "../utils/filePermissions.js";
import { createCoalescingSaver } from "../lib/coalescingSaver.js";
import { writeFileAtomically } from "../utils/writeFileAtomically.js";

const CURRENT_VERSION = 1;

export interface RelayConfig {
  /** Relay server URL (e.g., wss://relay.yepanywhere.com/ws) */
  url: string;
  /** Username for relay registration (also used as SRP identity) */
  username: string;
}

export interface RemoteAccessState {
  /** Schema version for future migrations */
  version: number;
  /** Whether remote access is enabled */
  enabled: boolean;
  /** SRP credentials (undefined = not configured) */
  credentials?: {
    /** SRP salt (hex string) */
    salt: string;
    /** SRP verifier (hex string) */
    verifier: string;
    /** When credentials were created */
    createdAt: string;
  };
  /** Relay server configuration (required for remote access - username is SRP identity) */
  relay?: RelayConfig;
}

export interface RemoteAccessServiceOptions {
  /** Directory to store state (defaults to dataDir) */
  dataDir: string;
}

export class RemoteAccessService {
  private state: RemoteAccessState;
  private dataDir: string;
  private filePath: string;
  private saver = createCoalescingSaver(() => this.doSave());
  private save = this.saver.save;

  /** Wait for saves already queued; never starts a write. */
  async waitForPendingWrites(): Promise<void> {
    await this.saver.idle();
  }

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
      await enforceOwnerReadWriteFilePermissions(
        this.filePath,
        "[RemoteAccessService]",
      );

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
        // Fail closed rather than start with remote access unconfigured,
        // which would silently discard the relay credential
        // (topics/security.md; auth.json has the same rule).
        throw new Error(
          `[RemoteAccessService] ${this.filePath} is unreadable (${error instanceof Error ? error.message : String(error)}). ` +
            "Refusing to start without its remote access credential. Restore " +
            "the file, or delete it to deliberately reset remote access.",
        );
      }
      this.state = { version: CURRENT_VERSION, enabled: false };
    }
  }

  /**
   * Check if remote access is enabled and configured.
   * Requires both credentials and relay config (relay username is SRP identity).
   */
  isEnabled(): boolean {
    return this.state.enabled && !!this.state.credentials && !!this.state.relay;
  }

  /**
   * Check if credentials have been configured (even if disabled).
   */
  isConfigured(): boolean {
    return !!this.state.credentials;
  }

  /**
   * Get the configured username (relay username is SRP identity).
   */
  getUsername(): string | null {
    return this.state.relay?.username ?? null;
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
   * Configure remote access with password.
   * Uses relay username as SRP identity (must configure relay first).
   * Generates and stores the SRP verifier (never stores the password).
   */
  async configure(password: string): Promise<void> {
    // Require relay to be configured first (relay username is SRP identity)
    if (!this.state.relay) {
      throw new Error(
        "Must configure relay first (relay username is used for authentication)",
      );
    }

    const username = this.state.relay.username;

    // Validate password
    if (!password || password.length < 8) {
      throw new Error("Password must be at least 8 characters");
    }

    // Generate SRP verifier using relay username as identity
    const { salt, verifier } = await generateVerifier(username, password);

    this.state.enabled = true;
    this.state.credentials = {
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
   * Get the relay configuration.
   */
  getRelayConfig(): RelayConfig | null {
    return this.state.relay ?? null;
  }

  /**
   * The relay the server should stay connected to: the configured relay
   * while Remote Access is enabled, else none. Disabling keeps the settings
   * for re-enabling but holds no relay connection.
   */
  getActiveRelayConfig(): RelayConfig | null {
    return this.isEnabled() ? this.getRelayConfig() : null;
  }

  /**
   * Set the relay configuration.
   */
  async setRelayConfig(config: RelayConfig): Promise<void> {
    const relayUrl = normalizeRelayUrl(config.url);

    // Validate username format (relay usernames are more restrictive)
    if (!config.username || config.username.length < 3) {
      throw new Error("Relay username must be at least 3 characters");
    }
    if (config.username.length > 32) {
      throw new Error("Relay username must be at most 32 characters");
    }
    // Relay usernames: lowercase alphanumeric with hyphens, no leading/trailing hyphen
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]{1,2}$/.test(config.username)) {
      throw new Error(
        "Relay username can only contain lowercase letters, numbers, and hyphens (no leading/trailing hyphen)",
      );
    }

    this.state.relay = {
      url: relayUrl,
      username: config.username,
    };
    await this.save();
  }

  /**
   * Clear the relay configuration.
   */
  async clearRelayConfig(): Promise<void> {
    this.state.relay = undefined;
    await this.save();
  }

  private async doSave(): Promise<void> {
    const content = JSON.stringify(this.state, null, 2);
    // Atomic: an in-place write interrupted by shutdown leaves an empty file.
    await writeFileAtomically(this.filePath, content, {
      mode: OWNER_READ_WRITE_FILE_MODE,
      durable: true,
    });
    await enforceOwnerReadWriteFilePermissions(
      this.filePath,
      "[RemoteAccessService]",
    );
  }
}
