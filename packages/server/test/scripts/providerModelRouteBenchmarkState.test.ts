import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  persistedMetadataIncludesProvider,
  readOptionalBooleanSetting,
  readOptionalStringSetting,
  readPersistedServerSettings,
} from "../../scripts/benchmark-provider-model-route.js";
import type { ServerSettings } from "../../src/services/ServerSettingsService.js";
import {
  loadSqliteDriver,
  type SqliteDatabase,
} from "../../src/storage/sqlite.js";
import {
  closeTestDiscoveryDatabases,
  openTestDiscoveryDatabase,
  writeStoredMetadata,
} from "../utils/session-metadata-database.js";

describe("provider model route benchmark state", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ya-provider-benchmark-"));
  });

  function markImported(database: SqliteDatabase) {
    database.exec(
      "INSERT INTO session_metadata_import (id, imported_at, source) VALUES (1, '2026-10-11T00:00:00.000Z', 'none')",
    );
  }

  /** A migrated database whose one-time JSON import has run. */
  function importedDatabase() {
    const database = openTestDiscoveryDatabase(dataDir);
    markImported(database);
    return database;
  }

  afterEach(async () => {
    closeTestDiscoveryDatabases();
    await rm(dataDir, { recursive: true });
  });

  it("uses defaults only when persisted files are absent", async () => {
    await expect(readPersistedServerSettings(dataDir)).resolves.toEqual({});
    await expect(
      persistedMetadataIncludesProvider(dataDir, "claude-ollama"),
    ).resolves.toBe(false);
  });

  it("rejects unsupported settings versions and malformed provider fields", async () => {
    await writeFile(
      join(dataDir, "server-settings.json"),
      JSON.stringify({ version: 3, settings: {} }),
    );
    await expect(readPersistedServerSettings(dataDir)).rejects.toThrow(
      "settings are unreadable",
    );

    const malformed = {
      claudeGatewayUrl: 42,
      ollamaUseFullSystemPrompt: "yes",
    } as unknown as Partial<ServerSettings>;
    expect(() =>
      readOptionalStringSetting(malformed, "claudeGatewayUrl"),
    ).toThrow("settings are invalid");
    expect(() =>
      readOptionalBooleanSetting(malformed, "ollamaUseFullSystemPrompt"),
    ).toThrow("settings are invalid");
  });

  it("rejects missing or malformed metadata records", async () => {
    loadSqliteDriver()?.open(join(dataDir, "discovery.sqlite")).close();
    await expect(
      persistedMetadataIncludesProvider(dataDir, "claude-ollama"),
    ).rejects.toThrow("metadata is unreadable");

    // Migrated, but the server has not yet run the one-time JSON import.
    const database = openTestDiscoveryDatabase(dataDir);
    await expect(
      persistedMetadataIncludesProvider(dataDir, "claude-ollama"),
    ).rejects.toThrow("metadata is unreadable");
    markImported(database);
    await expect(
      persistedMetadataIncludesProvider(dataDir, "claude-ollama"),
    ).resolves.toBe(false);
    database
      .prepare("INSERT INTO session_metadata (session_id, extra) VALUES (?, ?)")
      .run("broken", "42");
    await expect(
      persistedMetadataIncludesProvider(dataDir, "claude-ollama"),
    ).rejects.toThrow("metadata is unreadable");
  });

  it("recognizes a provider only from valid metadata", async () => {
    writeStoredMetadata(importedDatabase(), {
      claude: { provider: "claude" },
      ollama: { provider: "claude-ollama" },
    });

    await expect(
      persistedMetadataIncludesProvider(dataDir, "claude-ollama"),
    ).resolves.toBe(true);
    await expect(
      persistedMetadataIncludesProvider(dataDir, "codex"),
    ).resolves.toBe(false);
  });
});
