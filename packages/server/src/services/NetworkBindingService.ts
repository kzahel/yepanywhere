/**
 * NetworkBindingService manages network binding configuration.
 *
 * Features:
 * - Configures localhost port (can change at runtime)
 * - Optionally enables a second network socket on a selected interface
 * - Detects available network interfaces
 * - Supports CLI overrides (--port, --host)
 * - Follows RemoteAccessService pattern for state persistence
 *
 * State is persisted to a JSON file for durability across server restarts.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CURRENT_VERSION = 1;
const DEFAULT_PORT = 3400;

export interface NetworkInterface {
  /** Interface name (e.g., "eth0", "wlan0") */
  name: string;
  /** IP address */
  address: string;
  /** IPv4 or IPv6 */
  family: "IPv4" | "IPv6";
  /** Whether this is a loopback/internal interface */
  internal: boolean;
  /** Human-readable display name */
  displayName: string;
}

export interface NetworkBindingState {
  /** Schema version for future migrations */
  version: number;
  /** Port for localhost socket */
  localhostPort: number;
  /** Network socket configuration */
  network: {
    /** Whether network socket is enabled */
    enabled: boolean;
    /** Host/interface to bind to (null = disabled) */
    host: string | null;
    /** Port for network socket (null = same as localhost) */
    port: number | null;
  };
}

export interface NetworkBindingServiceOptions {
  /** Directory to store state */
  dataDir: string;
  /** CLI port override (if --port was specified) */
  cliPortOverride?: number;
  /** CLI host override (if --host was specified) */
  cliHostOverride?: string;
  /** Default port if not configured */
  defaultPort?: number;
}

export class NetworkBindingService {
  private state: NetworkBindingState;
  private dataDir: string;
  private filePath: string;
  private savePromise: Promise<void> | null = null;
  private pendingSave = false;

  /** CLI override for port (takes precedence over saved settings) */
  readonly cliPortOverride: number | null;
  /** CLI override for host (takes precedence over saved settings) */
  readonly cliHostOverride: string | null;
  /** Default port to use when not configured */
  private readonly defaultPort: number;

  constructor(options: NetworkBindingServiceOptions) {
    this.dataDir = options.dataDir;
    this.filePath = path.join(this.dataDir, "network-binding.json");
    this.cliPortOverride = options.cliPortOverride ?? null;
    this.cliHostOverride = options.cliHostOverride ?? null;
    this.defaultPort = options.defaultPort ?? DEFAULT_PORT;

    // Initialize with defaults
    this.state = {
      version: CURRENT_VERSION,
      localhostPort: this.defaultPort,
      network: {
        enabled: false,
        host: null,
        port: null,
      },
    };
  }

  /**
   * Initialize the service by loading state from disk.
   * Creates the data directory if it doesn't exist.
   */
  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });

      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as NetworkBindingState;

      if (parsed.version === CURRENT_VERSION) {
        this.state = parsed;
      } else {
        // Future: handle migrations
        this.state = {
          version: CURRENT_VERSION,
          localhostPort: parsed.localhostPort ?? this.defaultPort,
          network: parsed.network ?? { enabled: false, host: null, port: null },
        };
        await this.save();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[NetworkBindingService] Failed to load state, starting fresh:",
          error,
        );
      }
      // Keep default state
    }
  }

  /**
   * Get available network interfaces (excluding loopback).
   */
  getInterfaces(): NetworkInterface[] {
    const interfaces: NetworkInterface[] = [];
    const networkInterfaces = os.networkInterfaces();

    for (const [name, addrs] of Object.entries(networkInterfaces)) {
      if (!addrs) continue;

      for (const addr of addrs) {
        // Skip internal/loopback interfaces
        if (addr.internal) continue;

        // Skip link-local IPv6 addresses (fe80::)
        if (addr.family === "IPv6" && addr.address.startsWith("fe80:"))
          continue;

        interfaces.push({
          name,
          address: addr.address,
          family: addr.family as "IPv4" | "IPv6",
          internal: addr.internal,
          displayName: `${name} (${addr.address})`,
        });
      }
    }

    // Sort: IPv4 first, then by name
    interfaces.sort((a, b) => {
      if (a.family !== b.family) {
        return a.family === "IPv4" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return interfaces;
  }

  /**
   * Get the effective localhost port (CLI override > saved > default).
   */
  getLocalhostPort(): number {
    return this.cliPortOverride ?? this.state.localhostPort;
  }

  /**
   * Check if localhost port is overridden by CLI.
   */
  isLocalhostPortOverridden(): boolean {
    return this.cliPortOverride !== null;
  }

  /**
   * Get network socket configuration.
   */
  getNetworkConfig(): {
    enabled: boolean;
    host: string | null;
    port: number | null;
  } {
    // If CLI host override is set, treat it as the network binding
    if (this.cliHostOverride !== null) {
      return {
        enabled: true,
        host: this.cliHostOverride,
        port: this.cliPortOverride,
      };
    }
    return { ...this.state.network };
  }

  /**
   * Check if network config is overridden by CLI.
   */
  isNetworkOverridden(): boolean {
    return this.cliHostOverride !== null;
  }

  /**
   * Get full binding state for API response.
   */
  getBindingState(): {
    localhost: { port: number; overriddenByCli: boolean };
    network: {
      enabled: boolean;
      host: string | null;
      port: number | null;
      overriddenByCli: boolean;
    };
    interfaces: NetworkInterface[];
  } {
    const networkConfig = this.getNetworkConfig();
    return {
      localhost: {
        port: this.getLocalhostPort(),
        overriddenByCli: this.isLocalhostPortOverridden(),
      },
      network: {
        ...networkConfig,
        overriddenByCli: this.isNetworkOverridden(),
      },
      interfaces: this.getInterfaces(),
    };
  }

  /**
   * Update localhost port (only if not CLI-overridden).
   * @returns true if updated, false if CLI-overridden
   */
  async setLocalhostPort(port: number): Promise<boolean> {
    if (this.cliPortOverride !== null) {
      return false;
    }

    // Validate port
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Port must be an integer between 1 and 65535");
    }

    this.state.localhostPort = port;
    await this.save();
    return true;
  }

  /**
   * Update network socket configuration (only if not CLI-overridden).
   * @returns true if updated, false if CLI-overridden
   */
  async setNetworkConfig(config: {
    enabled: boolean;
    host?: string | null;
    port?: number | null;
  }): Promise<boolean> {
    if (this.cliHostOverride !== null) {
      return false;
    }

    // Validate host if provided
    if (config.host !== null && config.host !== undefined) {
      // Basic IP validation (IPv4 or IPv6 or 0.0.0.0)
      const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
      const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
      if (
        config.host !== "0.0.0.0" &&
        config.host !== "::" &&
        !ipv4Regex.test(config.host) &&
        !ipv6Regex.test(config.host)
      ) {
        throw new Error("Invalid IP address format");
      }
    }

    // Validate port if provided
    if (config.port !== null && config.port !== undefined) {
      if (
        !Number.isInteger(config.port) ||
        config.port < 1 ||
        config.port > 65535
      ) {
        throw new Error("Port must be an integer between 1 and 65535");
      }
    }

    this.state.network = {
      enabled: config.enabled,
      host: config.host ?? this.state.network.host,
      port: config.port !== undefined ? config.port : this.state.network.port,
    };

    // If disabling, clear host
    if (!config.enabled) {
      this.state.network.host = null;
    }

    await this.save();
    return true;
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
