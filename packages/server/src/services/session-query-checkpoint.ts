import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../storage/sqlite.js";
import type { SessionCatalogToken } from "./SessionCatalogService.js";

export interface QueryCheckpoint {
  format: 1;
  signature: string;
  revision: number;
  token: SessionCatalogToken;
  nextOrdinal: number;
  nextControlOrdinal: number;
  names: [string, string][];
}
const TABLES = {
  rows: "id,project_id,updated_ms,archived,automatic,starred,categorized,unread,attention,active,live,provider,executor,ordinal,native_key,parent_json,name_json,option_visible,search_json,item",
  sources: "key,public_id,project_id,project_path,ordinal,unstable",
  projects: "project_id,project_path",
};

/** One replaceable durable checkpoint; TEMP working owners remain isolated.
 * Mirroring invalidates before each mutation and writes only changed rows.
 * A superseded owner can keep serving its working index, but cannot certify
 * or overwrite the newer owner's checkpoint. No statements survive a call.
 */
export class SessionQueryCheckpoint {
  private readonly owner = randomUUID();
  constructor(
    private readonly db: SqliteDatabase,
    private readonly prefix: string,
  ) {}
  revision(): number {
    const statement = this.db.prepare(
      "SELECT revision FROM collection_checkpoint WHERE id=1",
    );
    try {
      return statement.get<{ revision: number }>()!.revision;
    } finally {
      statement.finalize();
    }
  }
  claim(signature: string): QueryCheckpoint | undefined {
    return this.db.transaction(() => {
      const statement = this.db.prepare(
        "SELECT valid,revision,snapshot FROM collection_checkpoint WHERE id=1",
      );
      let restored: QueryCheckpoint | undefined;
      try {
        const state = statement.get<{
          valid: number;
          revision: number;
          snapshot: string | null;
        }>()!;
        if (state.valid && state.snapshot) {
          try {
            const saved = JSON.parse(state.snapshot) as QueryCheckpoint;
            if (
              saved.format === 1 &&
              saved.signature === signature &&
              saved.revision === state.revision &&
              Number.isSafeInteger(saved.nextOrdinal) &&
              Number.isSafeInteger(saved.nextControlOrdinal) &&
              typeof saved.token?.catalogEpoch === "string" &&
              Number.isSafeInteger(saved.token.catalogGeneration) &&
              Array.isArray(saved.names) &&
              saved.names.every(
                (entry) =>
                  Array.isArray(entry) &&
                  entry.length === 2 &&
                  entry.every((value) => typeof value === "string"),
              )
            )
              restored = saved;
          } catch {
            /* Derived state can always rebuild. */
          }
        }
      } finally {
        statement.finalize();
      }
      const claim = this.db.prepare(
        "UPDATE collection_checkpoint SET owner=?,valid=? WHERE id=1",
      );
      try {
        claim.run(this.owner, Number(!!restored));
      } finally {
        claim.finalize();
      }
      if (restored)
        for (const table of Object.keys(TABLES))
          this.db.exec(
            `INSERT INTO ${this.prefix}_${table} SELECT * FROM collection_cache_${table}`,
          );
      else
        for (const table of Object.keys(TABLES))
          this.db.exec(`DELETE FROM collection_cache_${table}`);
      this.mirrors(true);
      return restored;
    });
  }
  beginReplacement() {
    const invalidate = this.db.prepare(
      "UPDATE collection_checkpoint SET valid=0 WHERE id=1 AND owner=? AND valid=1",
    );
    try {
      invalidate.run(this.owner);
    } finally {
      invalidate.finalize();
    }
    this.mirrors(false);
  }
  finishReplacement() {
    this.db.transaction(() => {
      const state = this.db.prepare(
        "SELECT owner FROM collection_checkpoint WHERE id=1",
      );
      let owned = false;
      try {
        owned = state.get<{ owner: string }>()?.owner === this.owner;
      } finally {
        state.finalize();
      }
      if (owned)
        for (const table of Object.keys(TABLES)) {
          this.db.exec(
            `DELETE FROM collection_cache_${table}; INSERT INTO collection_cache_${table} SELECT * FROM ${this.prefix}_${table}`,
          );
        }
      this.mirrors(true);
    });
  }
  private mirrors(enabled: boolean) {
    for (const [table, columns] of Object.entries(TABLES)) {
      const key = columns.split(",")[0]!;
      const condition = `(SELECT owner FROM collection_checkpoint WHERE id=1)='${this.owner}'`;
      for (const op of ["INSERT", "UPDATE", "DELETE"]) {
        if (!enabled) {
          this.db.exec(
            `DROP TRIGGER IF EXISTS ${this.prefix}_mirror_${table}_${op}`,
          );
          continue;
        }
        this.db.exec(`CREATE TEMP TRIGGER ${this.prefix}_mirror_${table}_${op} AFTER ${op} ON ${this.prefix}_${table} WHEN ${condition} BEGIN
            UPDATE collection_checkpoint SET valid=0 WHERE id=1 AND valid=1;
            ${
              op === "DELETE"
                ? `DELETE FROM collection_cache_${table} WHERE ${key}=OLD.${key};`
                : `INSERT INTO collection_cache_${table} VALUES(${columns
                    .split(",")
                    .map((c) => `NEW.${c}`)
                    .join(",")}) ON CONFLICT(${key}) DO UPDATE SET ${columns
                    .split(",")
                    .slice(1)
                    .map((c) => `${c}=excluded.${c}`)
                    .join(",")};`
            }
          END;`);
      }
    }
  }
  save(snapshot: QueryCheckpoint, stable: boolean) {
    const json = JSON.stringify(snapshot);
    const statement =
      this.db.prepare(`UPDATE collection_checkpoint SET snapshot=?,valid=?
      WHERE id=1 AND owner=? AND (snapshot IS NOT ? OR valid<>?)`);
    try {
      statement.run(json, Number(stable), this.owner, json, Number(stable));
    } finally {
      statement.finalize();
    }
  }
}
