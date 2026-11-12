import type { SqliteDatabase, SqliteStatement } from "../storage/sqlite.js";
import type {
  RelationshipCheckpoint,
  RelationshipEvidence,
  RelationshipMetadata,
  RelationshipResource,
  SessionRelationshipType,
  StoredRelationship,
} from "./SessionRelationshipStore.js";

/** Four lazy statements owned by the relationship store; all row maps are request-local. */
export class RelationshipBatchReader {
  private disposed = false;
  private readonly statements = new Map<string, SqliteStatement>();
  constructor(
    private readonly database: SqliteDatabase,
    private readonly key: (resource: RelationshipResource) => string,
    private readonly decode: (key: string) => RelationshipResource,
  ) {}
  private statement(name: string, sql: string) {
    if (this.disposed) throw new Error("Relationship batch reader is disposed");
    let statement = this.statements.get(name);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(name, statement);
    }
    return statement;
  }
  pages(
    parents: readonly { resource: RelationshipResource; after?: string }[],
    direction: "outgoing" | "incoming",
    type: SessionRelationshipType,
    limit: number,
  ) {
    const result = new Map<
      string,
      { edges: StoredRelationship[]; next: string | null }
    >();
    if (!parents.length) return result;
    const endpoint = direction === "outgoing" ? "source" : "target";
    // Each correlated seek has its own LIMIT; a prolific parent cannot starve peers.
    const rows = this.statement(
      direction,
      `SELECT json_extract(input.value,'$.key') AS key,
      (SELECT json_group_array(json_object('id',id,'type',type,'source',source,'target',target)) FROM
        (SELECT id,type,source,target FROM session_relationship_edges
         WHERE active=1 AND ${endpoint}=json_extract(input.value,'$.key')
         AND id>json_extract(input.value,'$.after') AND type=? ORDER BY id LIMIT ?)) AS items
      FROM json_each(?) AS input`,
    ).all<{ key: string; items: string }>(
      type,
      limit + 1,
      JSON.stringify(
        parents.map(({ resource, after }) => ({
          key: this.key(resource),
          after: after ?? "",
        })),
      ),
    );
    for (const row of rows) {
      const items = JSON.parse(row.items) as {
        id: string;
        type: SessionRelationshipType;
        source: string;
        target: string;
      }[];
      result.set(row.key, {
        edges: items.slice(0, limit).map((edge) => ({
          ...edge,
          source: this.decode(edge.source),
          target: this.decode(edge.target),
        })),
        next: items.length > limit ? items[limit - 1]!.id : null,
      });
    }
    return result;
  }
  evidence(ids: readonly string[]) {
    const result = new Map<string, RelationshipEvidence[]>();
    if (!ids.length) return result;
    const rows = this.statement(
      "evidence",
      `SELECT input.value AS id,
      (SELECT json_group_array(json_object('producer',producer,'sourceKey',source_key,
        'recordKey',record_key,'sourceVersion',source_version,'extractorVersion',extractor_version,
        'trust',trust,'state',state,'metadata',metadata,'observedAt',observed_at)) FROM
        (SELECT * FROM session_relationship_evidence WHERE edge_id=input.value AND state='active'
         ORDER BY producer,source_key,record_key LIMIT 20)) AS items
      FROM json_each(?) AS input`,
    ).all<{ id: string; items: string }>(JSON.stringify(ids));
    for (const row of rows) {
      const items = JSON.parse(row.items) as (Omit<
        RelationshipEvidence,
        "metadata"
      > & { metadata: string })[];
      result.set(
        row.id,
        items.map((entry) => ({
          ...entry,
          metadata: JSON.parse(entry.metadata) as RelationshipMetadata,
        })),
      );
    }
    return result;
  }
  checkpoints(producer: string, resources: readonly RelationshipResource[]) {
    const result = new Map<string, RelationshipCheckpoint>();
    if (!resources.length) return result;
    const rows = this.statement(
      "checkpoints",
      `SELECT input.value AS key,c.revision,c.source_version,c.extractor_version,c.state,c.cursor
      FROM json_each(?) AS input CROSS JOIN session_relationship_checkpoints AS c
      ON c.source_key=input.value AND c.producer=?`,
    ).all<{
      key: string;
      revision: number;
      source_version: string;
      extractor_version: number;
      state: "partial" | "complete";
      cursor: string;
    }>(JSON.stringify(resources.map(this.key)), producer);
    for (const row of rows)
      result.set(row.key, {
        revision: row.revision,
        sourceVersion: row.source_version,
        extractorVersion: row.extractor_version,
        state: row.state,
        cursor: row.cursor,
      });
    return result;
  }
  dispose() {
    this.disposed = true;
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
  }
}
