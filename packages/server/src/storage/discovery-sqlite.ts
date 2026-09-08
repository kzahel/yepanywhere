import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SqliteStatus } from "@yep-anywhere/shared";
import {
  loadSqliteDriver,
  type SqliteDatabase,
  type SqliteDriver,
} from "./sqlite.js";

export type SqliteMode = "off" | "auto";

export function parseSqliteMode(value: string | undefined): SqliteMode {
  if (value === undefined || value === "off") return "off";
  if (value === "auto") return "auto";
  throw new Error("YEP_SQLITE must be one of: off, auto");
}

export interface DiscoveryMigration {
  version: number;
  sql: string;
}

// YA discovery file identity (ASCII YADI). Version 1 reserves the format;
// domain tables belong to the feature migrations that introduce their use.
const APPLICATION_ID = 0x59414449;
const MIGRATIONS: readonly DiscoveryMigration[] = [{ version: 1, sql: "" }];

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
  migrations: readonly DiscoveryMigration[] = MIGRATIONS,
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

/** One optional connection per Hono generation, owned below the YA data dir. */
export class DiscoverySqliteService {
  private database: SqliteDatabase | undefined;
  private state: SqliteStatus["state"] = "disabled";
  private readonly onError: ((error: unknown) => void) | undefined;

  constructor(options: {
    dataDir: string;
    mode: SqliteMode;
    loadDriver?: () => SqliteDriver | undefined;
    onError?: (error: unknown) => void;
  }) {
    this.onError = options.onError;
    if (options.mode === "off") return;
    try {
      const driver = (options.loadDriver ?? loadSqliteDriver)();
      if (!driver) {
        this.state = "unsupported";
        return;
      }
      mkdirSync(options.dataDir, { recursive: true });
      this.database = driver.open(join(options.dataDir, "discovery.sqlite"));
      // A short, bounded wait also applies while obtaining the migration lock.
      this.database.exec("PRAGMA busy_timeout = 250");
      this.database.exec("PRAGMA foreign_keys = ON");
      migrateDiscoveryDatabase(this.database);
      this.state = "ready";
    } catch (error) {
      this.state = "error";
      try {
        this.database?.close();
      } catch {
        // Preserve the initialization error; optional teardown must not abort boot.
      } finally {
        this.database = undefined;
        options.onError?.(error);
      }
    }
  }

  getStatus(): SqliteStatus {
    return { state: this.state };
  }

  /** Consumers must still gate their own feature contract before using this. */
  getDatabase(): SqliteDatabase | undefined {
    return this.database;
  }

  close(): void {
    try {
      this.database?.close();
      if (this.state === "ready") this.state = "disabled";
    } catch (error) {
      this.state = "error";
      this.onError?.(error);
    } finally {
      this.database = undefined;
    }
  }
}
