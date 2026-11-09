import { SESSION_RELATIONSHIPS_SCHEMA } from "./migrations/026-session-relationships.js";
import { RELATIONSHIP_PENDING_SCHEMA } from "./migrations/027-relationship-pending.js";
import { SESSION_CATALOG_SCHEMA } from "./migrations/028-session-catalog.js";
import { ISSUE_JOB_CATALOG_KEY_SCHEMA } from "./migrations/029-issue-job-catalog-key.js";
import { ANTIGRAVITY_NATIVE_ALLOCATIONS_SCHEMA } from "./migrations/024-antigravity-native-allocations.js";
import { SESSION_SUMMARY_INDEX_SCHEMA } from "./migrations/025-session-summary-index.js";
import { CREATION_INPUT_EXPECTATION_SCHEMA } from "./migrations/023-creation-input-expectation.js";
import { CREATION_ATTACHMENT_CAPACITY_SCHEMA } from "./migrations/022-creation-attachment-capacity.js";
import { SESSION_CREATION_INPUT_SCHEMA } from "./migrations/021-session-creation-input.js";
import { NATIVE_SESSION_ALLOCATIONS_SCHEMA } from "./migrations/020-native-session-allocations.js";
import { SESSION_CREATION_GENERATION_SCHEMA } from "./migrations/019-session-creation-generation.js";
import { SESSION_CREATIONS_SCHEMA } from "./migrations/018-session-creations.js";
import { AGENT_API_RECEIPTS_SCHEMA } from "./migrations/014-agent-api-receipts.js";
import { SESSION_IDENTITIES_SCHEMA } from "./migrations/017-session-identities.js";
import { PEER_OUTBOUND_SCHEMA } from "./migrations/015-peer-outbound.js";
import { PEER_RECEIPT_OBSERVATION_SCHEMA } from "./migrations/016-peer-receipt-observation.js";
import { PUBLIC_SERVER_IDENTITY_SCHEMA } from "./migrations/013-public-server-identity.js";
import { ISSUE_STATUS_SCHEMA } from "./migrations/011-issue-status.js";
import { ISSUE_CONTENT_SCHEMA } from "./migrations/012-issue-content.js";
import { DRAFT_SCHEMA } from "./migrations/008-drafts.js";
import { DRAFT_CHANGES_SCHEMA } from "./migrations/009-draft-changes.js";
import { SESSION_METADATA_SCHEMA } from "./migrations/010-session-metadata.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SqliteStatus } from "@yep-anywhere/shared";
import { networkFilesystemName } from "../lib/filesystemKind.js";
import {
  SPEECH_VOCABULARY_SCHEMA,
  SPEECH_VOCABULARY_SET_SCHEMA,
} from "./migrations/002-003-vocabulary.js";
import {
  loadSqliteDriver,
  type SqliteDatabase,
  type SqliteDriver,
} from "./sqlite.js";

import { ISSUE_RESOLUTION_SCHEMA } from "./migrations/005-issue-resolution.js";
import { ISSUE_SCHEMA } from "./migrations/004-issues.js";
import { ISSUE_CONFIRMATION_SCHEMA } from "./migrations/006-issue-confirmation.js";

import { JIRA_PROJECT_SCHEMA } from "./migrations/007-jira-projects.js";

export interface DiscoveryMigration {
  version: number;
  sql: string;
}

// YA discovery file identity (ASCII YADI). Version 1 reserves the format;
// domain tables belong to the feature migrations that introduce their use.
const APPLICATION_ID = 0x59414449;
export const DISCOVERY_MIGRATIONS: readonly DiscoveryMigration[] = [
  { version: 1, sql: "" },
  { version: 2, sql: SPEECH_VOCABULARY_SCHEMA },
  { version: 3, sql: SPEECH_VOCABULARY_SET_SCHEMA },
  { version: 4, sql: ISSUE_SCHEMA },
  { version: 5, sql: ISSUE_RESOLUTION_SCHEMA },
  { version: 6, sql: ISSUE_CONFIRMATION_SCHEMA },
  { version: 7, sql: JIRA_PROJECT_SCHEMA },
  { version: 8, sql: DRAFT_SCHEMA },
  { version: 9, sql: DRAFT_CHANGES_SCHEMA },
  { version: 10, sql: SESSION_METADATA_SCHEMA },
  { version: 11, sql: ISSUE_STATUS_SCHEMA },
  { version: 12, sql: ISSUE_CONTENT_SCHEMA },
  { version: 13, sql: PUBLIC_SERVER_IDENTITY_SCHEMA },
  { version: 14, sql: AGENT_API_RECEIPTS_SCHEMA },
  { version: 15, sql: PEER_OUTBOUND_SCHEMA },
  { version: 16, sql: PEER_RECEIPT_OBSERVATION_SCHEMA },
  { version: 17, sql: SESSION_IDENTITIES_SCHEMA },
  { version: 18, sql: SESSION_CREATIONS_SCHEMA },
  { version: 19, sql: SESSION_CREATION_GENERATION_SCHEMA },
  { version: 20, sql: NATIVE_SESSION_ALLOCATIONS_SCHEMA },
  { version: 21, sql: SESSION_CREATION_INPUT_SCHEMA },
  { version: 22, sql: CREATION_ATTACHMENT_CAPACITY_SCHEMA },
  { version: 23, sql: CREATION_INPUT_EXPECTATION_SCHEMA },
  { version: 24, sql: ANTIGRAVITY_NATIVE_ALLOCATIONS_SCHEMA },
  { version: 25, sql: SESSION_SUMMARY_INDEX_SCHEMA },
  { version: 26, sql: SESSION_RELATIONSHIPS_SCHEMA },
  { version: 27, sql: RELATIONSHIP_PENDING_SCHEMA },
  { version: 28, sql: SESSION_CATALOG_SCHEMA },
  { version: 29, sql: ISSUE_JOB_CATALOG_KEY_SCHEMA },
];

/** Construct fixtures with the actual historical schema, never a parallel SQL copy. */
export function discoveryMigrationPrefix(
  version: number,
): readonly DiscoveryMigration[] {
  if (
    !Number.isInteger(version) ||
    version < 1 ||
    version > DISCOVERY_MIGRATIONS.length
  ) {
    throw new Error("Invalid discovery migration prefix");
  }
  return DISCOVERY_MIGRATIONS.slice(0, version);
}

function readRow(database: SqliteDatabase, sql: string) {
  const statement = database.prepare(sql);
  try {
    return statement.get();
  } finally {
    statement.finalize();
  }
}

export function migrateDiscoveryDatabase(
  database: SqliteDatabase,
  migrations: readonly DiscoveryMigration[] = DISCOVERY_MIGRATIONS,
): void {
  if (
    migrations.length === 0 ||
    migrations.some((migration, index) => migration.version !== index + 1)
  ) {
    throw new Error("Discovery migrations must be consecutive from version 1");
  }
  database.transaction(() => {
    const applicationId = readRow(
      database,
      "PRAGMA application_id",
    )?.application_id;
    const version = readRow(database, "PRAGMA user_version")?.user_version;
    if (
      typeof version !== "number" ||
      version < 0 ||
      version > migrations.length
    ) {
      throw new Error("Discovery database has a newer or invalid schema");
    }
    if (applicationId !== APPLICATION_ID) {
      const table = readRow(database, "SELECT name FROM sqlite_schema LIMIT 1");
      if (applicationId !== 0 || version !== 0 || table) {
        throw new Error("Database is not a YA discovery database");
      }
    }
    for (const migration of migrations) {
      if (migration.version <= version) continue;
      if (migration.sql) database.exec(migration.sql);
      database.exec(`PRAGMA user_version = ${migration.version}`);
    }
    database.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
  });
}

/**
 * Thrown when YA's required SQLite database cannot be opened. The server does
 * not start without it, so the message names what the operator must fix.
 */
export class DiscoveryStorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DiscoveryStorageError";
  }
}

/**
 * Open YA's required SQLite database below the data directory, or throw a
 * {@link DiscoveryStorageError}. There is no degraded mode: session metadata
 * lives here (topics/required-sqlite.md).
 */
export function openDiscoveryDatabase(options: {
  dataDir: string;
  loadDriver?: () => SqliteDriver | undefined;
  /** Injected by tests; production probes the real data directory. */
  probeNetworkFilesystem?: (dir: string) => string | undefined;
}): SqliteDatabase {
  const path = join(options.dataDir, "discovery.sqlite");
  const driver = (options.loadDriver ?? loadSqliteDriver)();
  if (!driver) {
    throw new DiscoveryStorageError(
      `Cannot open ${path}: this runtime has no built-in SQLite (node:sqlite or bun:sqlite). Run YA on a supported Node or Bun release.`,
    );
  }
  try {
    mkdirSync(options.dataDir, { recursive: true });
  } catch (error) {
    throw new DiscoveryStorageError(
      `Cannot create the data directory ${options.dataDir}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  // Both adapters are synchronous and SQLite takes an advisory lock per
  // transaction, so on a share every one of those locks is a network round
  // trip taken on the event loop. A busy server spends most of each second
  // in uninterruptible sleep and stops answering requests at all.
  const network = (options.probeNetworkFilesystem ?? networkFilesystemName)(
    options.dataDir,
  );
  if (network) {
    throw new DiscoveryStorageError(
      `Refusing to open ${path}: the data directory is on ${network}, where every SQLite lock is a network round trip that stalls the server. Set YEP_DATA_DIR to a directory on local disk.`,
    );
  }
  let database: SqliteDatabase | undefined;
  try {
    database = driver.open(path);
    // A short, bounded wait also applies while obtaining the migration lock.
    database.exec("PRAGMA busy_timeout = 250");
    // In rollback-journal mode a transaction larger than the page cache
    // spills pages mid-transaction, which needs the exclusive lock. While an
    // outside reader holds a shared lock, each spill waits out the busy
    // timeout and the transaction carries on, so it blocks the event loop
    // for as long as the reader stays. Without spilling, it fails at COMMIT
    // within the busy timeout instead, at the cost of holding its pages.
    database.exec("PRAGMA cache_spill = OFF");
    database.exec("PRAGMA foreign_keys = ON");
    migrateDiscoveryDatabase(database);
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Report the open failure; a failed close of a half-open handle adds nothing.
    }
    throw new DiscoveryStorageError(
      `Cannot open ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The required database connection for one server, owned below the YA data dir. */
export class DiscoverySqliteService {
  private database: SqliteDatabase | undefined;

  /** Throws {@link DiscoveryStorageError} when the database cannot be opened. */
  constructor(options: Parameters<typeof openDiscoveryDatabase>[0]) {
    this.database = openDiscoveryDatabase(options);
  }

  getStatus(): SqliteStatus {
    return { state: this.database ? "ready" : "disabled" };
  }

  getDatabase(): SqliteDatabase {
    if (!this.database) throw new Error("Discovery database is closed");
    return this.database;
  }

  close(): void {
    const database = this.database;
    this.database = undefined;
    try {
      database?.close();
    } catch (error) {
      console.warn("[DiscoverySqlite] Close failed:", error);
    }
  }
}
