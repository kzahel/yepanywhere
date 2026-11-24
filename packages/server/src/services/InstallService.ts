/**
 * InstallService manages a unique installation identifier for this yepanywhere instance.
 * The install ID is used by the relay server to verify username ownership - if an
 * installation disconnects and reconnects, it can reclaim its username using the same ID.
 *
 * State is persisted to a JSON file for durability across server restarts.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProviderName } from "@yep-anywhere/shared";
import {
  type ProviderCatalogFamily,
  normalizeProviderCatalogFamilies,
  providerCatalogFamily,
} from "../sessions/provider-catalog-family.js";

export interface InstallState {
  /** Schema version for future migrations */
  version: number;
  /** Unique installation identifier (crypto.randomUUID()) */
  installId: string;
  /** ISO timestamp when this install was first created */
  createdAt: string;
  /** Native provider stores this install has successfully used. */
  catalogFamilies: ProviderCatalogFamily[];
  /** Whether legacy YA session metadata has seeded catalog eligibility. */
  catalogMetadataMigrationComplete: boolean;
}

const CURRENT_VERSION = 2;

export interface InstallServiceOptions {
  /** Directory to store install state (defaults to ~/.yep-anywhere) */
  dataDir?: string;
  discoverCopilotSessions?: boolean;
}

export class InstallService {
  private state: InstallState | null = null;
  private dataDir: string;
  private filePath: string;
  private readonly discoverCopilotSessions: boolean;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: InstallServiceOptions = {}) {
    this.discoverCopilotSessions = options.discoverCopilotSessions ?? false;
    this.dataDir =
      options.dataDir ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".yep-anywhere",
      );
    this.filePath = path.join(this.dataDir, "install.json");
  }

  /**
   * Initialize the service by loading or creating state from disk.
   * Creates the data directory and file if they don't exist.
   */
  async initialize(): Promise<void> {
    console.log(`[InstallService] Initializing from: ${this.filePath}`);
    try {
      // Ensure data directory exists
      await fs.mkdir(this.dataDir, { recursive: true });

      // Try to load existing state
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as Partial<InstallState>;

      // Validate required fields
      if (
        typeof parsed.installId === "string" &&
        parsed.installId.length > 0 &&
        typeof parsed.createdAt === "string"
      ) {
        console.log(
          `[InstallService] Loaded existing install ID: ${parsed.installId}`,
        );

        // Handle migrations if needed
        const catalogFamilies = normalizeProviderCatalogFamilies(
          parsed.catalogFamilies ?? [],
        );
        const catalogMetadataMigrationComplete =
          parsed.catalogMetadataMigrationComplete === true;
        this.state = {
          version: CURRENT_VERSION,
          installId: parsed.installId,
          createdAt: parsed.createdAt,
          catalogFamilies,
          catalogMetadataMigrationComplete,
        };
        if (
          parsed.version !== CURRENT_VERSION ||
          JSON.stringify(parsed.catalogFamilies ?? []) !==
            JSON.stringify(catalogFamilies) ||
          parsed.catalogMetadataMigrationComplete !==
            catalogMetadataMigrationComplete
        ) {
          await this.save();
        }
      } else {
        // Invalid state, regenerate
        console.warn(
          "[InstallService] Invalid state found, generating new install ID",
        );
        await this.generateNew();
      }
    } catch (error) {
      if (this.state) {
        throw error;
      }
      // File doesn't exist or is invalid - generate new
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[InstallService] Failed to load state, generating new install ID:",
          error,
        );
      }
      await this.generateNew();
    }
  }

  /**
   * Generate a new installation ID and persist it.
   */
  private async generateNew(): Promise<void> {
    this.state = {
      version: CURRENT_VERSION,
      installId: randomUUID(),
      createdAt: new Date().toISOString(),
      catalogFamilies: [],
      catalogMetadataMigrationComplete: false,
    };
    console.log(
      `[InstallService] Generated new install ID: ${this.state.installId}`,
    );
    await this.save();
  }

  /**
   * Get the unique installation identifier.
   * @throws Error if the service has not been initialized
   */
  getInstallId(): string {
    if (!this.state) {
      throw new Error(
        "InstallService not initialized. Call initialize() first.",
      );
    }
    return this.state.installId;
  }

  /**
   * Get the creation timestamp.
   * @throws Error if the service has not been initialized
   */
  getCreatedAt(): string {
    if (!this.state) {
      throw new Error(
        "InstallService not initialized. Call initialize() first.",
      );
    }
    return this.state.createdAt;
  }

  getCatalogFamilies(): ProviderCatalogFamily[] {
    if (!this.state) {
      throw new Error(
        "InstallService not initialized. Call initialize() first.",
      );
    }
    const families = this.state.catalogFamilies.filter(
      (family) => family !== "copilot",
    );
    return this.discoverCopilotSessions ? [...families, "copilot"] : families;
  }

  needsCatalogMetadataMigration(): boolean {
    if (!this.state) {
      throw new Error(
        "InstallService not initialized. Call initialize() first.",
      );
    }
    return !this.state.catalogMetadataMigrationComplete;
  }

  async recordSuccessfulProviders(
    providers: Iterable<ProviderName>,
  ): Promise<ProviderCatalogFamily[]> {
    const families = normalizeProviderCatalogFamilies(
      [...providers].map(providerCatalogFamily),
    );
    return this.updateCatalogFamilies(families, false);
  }

  async completeCatalogMetadataMigration(
    providers: Iterable<ProviderName>,
  ): Promise<ProviderCatalogFamily[]> {
    const families = normalizeProviderCatalogFamilies(
      [...providers].map(providerCatalogFamily),
    );
    return this.updateCatalogFamilies(families, true);
  }

  private async updateCatalogFamilies(
    requested: readonly ProviderCatalogFamily[],
    completeMetadataMigration: boolean,
  ): Promise<ProviderCatalogFamily[]> {
    return this.enqueueMutation(async () => {
      if (!this.state) {
        throw new Error(
          "InstallService not initialized. Call initialize() first.",
        );
      }
      const current = this.state;
      const additions = requested.filter(
        (family) => !current.catalogFamilies.includes(family),
      );
      const migrationChanges =
        completeMetadataMigration && !current.catalogMetadataMigrationComplete;
      if (additions.length === 0 && !migrationChanges) return [];

      const previous = current;
      this.state = {
        ...previous,
        catalogFamilies: normalizeProviderCatalogFamilies([
          ...previous.catalogFamilies,
          ...additions,
        ]),
        catalogMetadataMigrationComplete:
          previous.catalogMetadataMigrationComplete ||
          completeMetadataMigration,
      };
      try {
        await this.save();
      } catch (error) {
        this.state = previous;
        throw error;
      }
      return additions;
    });
  }

  /**
   * Save state to disk.
   */
  private async save(): Promise<void> {
    if (!this.state) {
      throw new Error("Cannot save: no state to persist");
    }
    try {
      const content = JSON.stringify(this.state, null, 2);
      const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporaryPath, content, "utf-8");
        await fs.rename(temporaryPath, this.filePath);
      } catch (error) {
        await fs.unlink(temporaryPath).catch(() => {});
        throw error;
      }
    } catch (error) {
      console.error("[InstallService] Failed to save state:", error);
      throw error;
    }
  }

  /**
   * Get the file path for testing purposes.
   */
  getFilePath(): string {
    return this.filePath;
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(mutation, mutation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
