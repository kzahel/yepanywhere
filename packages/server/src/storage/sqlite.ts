import { createRequire } from "node:module";

/** Positional parameters only; integer values must fit JavaScript's safe range. */
export type SqliteValue = string | number | null | Uint8Array;
export type SqliteRow = Record<string, SqliteValue>;

export interface SqliteStatement {
  get(...parameters: SqliteValue[]): SqliteRow | undefined;
  all(...parameters: SqliteValue[]): SqliteRow[];
  run(...parameters: SqliteValue[]): void;
  /** Release the prepared statement when its caller is finished. */
  finalize(): void;
}

interface NativeStatement {
  get(...parameters: SqliteValue[]): SqliteRow | null | undefined;
  all(...parameters: SqliteValue[]): SqliteRow[];
  run(...parameters: SqliteValue[]): unknown;
  finalize?(): void;
}

interface NativeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  close(): void;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  /** Synchronous callbacks only. Nested transactions are not supported. */
  transaction<T>(operation: () => T): T;
  close(): void;
}

export interface SqliteDriver {
  open(path: string): SqliteDatabase;
}

function wrapDatabase(native: NativeDatabase): SqliteDatabase {
  let closed = false;
  let inTransaction = false;
  // Bun 1.3.14 close(false) leaves prepare() statements alive and close(true)
  // throws while they exist. Finalize them explicitly before releasing the file.
  const statements = new Set<NativeStatement>();
  return {
    exec: (sql) => native.exec(sql),
    prepare(sql) {
      let statement: NativeStatement | undefined = native.prepare(sql);
      if (statement.finalize) statements.add(statement);
      const active = () => {
        if (closed || !statement) throw new Error("SQLite statement is closed");
        return statement;
      };
      return {
        get: (...parameters) => active().get(...parameters) ?? undefined,
        all: (...parameters) => active().all(...parameters),
        run: (...parameters) => {
          active().run(...parameters);
        },
        finalize() {
          if (!statement) return;
          if (!closed) statement.finalize?.();
          statements.delete(statement);
          statement = undefined;
        },
      };
    },
    transaction(operation) {
      if (inTransaction) throw new Error("Nested SQLite transaction");
      native.exec("BEGIN IMMEDIATE");
      inTransaction = true;
      try {
        const result = operation();
        if (
          result !== null &&
          (typeof result === "object" || typeof result === "function") &&
          "then" in result
        ) {
          throw new Error("SQLite transactions require synchronous callbacks");
        }
        native.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          native.exec("ROLLBACK");
        } catch {
          // SQLite can already have rolled back (e.g. ON CONFLICT ROLLBACK).
          // Preserve the operation/commit error rather than masking its cause.
        }
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    close() {
      if (closed) return;
      for (const statement of statements) statement.finalize?.();
      statements.clear();
      native.close();
      closed = true;
    },
  };
}

/**
 * No SQLite import at module evaluation, and no third-party native dependency.
 * createRequire also avoids older Vite builtin-resolution tables. Bun must be
 * selected first: desktop's pinned runtime does not implement node:sqlite.
 * Node's experimental-module notice, where applicable, is intentionally intact.
 */
export function loadSqliteDriver(): SqliteDriver | undefined {
  const requireBuiltin = createRequire(import.meta.url);
  try {
    if (process.versions.bun) {
      const { Database } = requireBuiltin("bun:sqlite") as {
        Database: new (
          path: string,
          options: { create: boolean; strict: boolean },
        ) => NativeDatabase;
      };
      if (typeof Database !== "function") return undefined;
      return {
        open: (path) =>
          wrapDatabase(new Database(path, { create: true, strict: true })),
      };
    }
    const { DatabaseSync } = requireBuiltin("node:sqlite") as {
      DatabaseSync: new (path: string) => NativeDatabase;
    };
    if (typeof DatabaseSync !== "function") return undefined;
    return { open: (path) => wrapDatabase(new DatabaseSync(path)) };
  } catch {
    return undefined;
  }
}
