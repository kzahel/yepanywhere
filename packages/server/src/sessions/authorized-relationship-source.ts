import type { SqliteDatabase, SqliteStatement } from "../storage/sqlite.js";
import {
  decodeRelationshipResource,
  relationshipResourceKey,
  type SessionRelationshipStore,
  type SessionRelationshipType,
} from "./SessionRelationshipStore.js";
import type { RelationshipQuerySource } from "./session-relationship-query.js";

const authorizedSource = Symbol("authorizedRelationshipSource");
/** Public adapters accept this nominal source, never the bare graph index. */
export type AuthorizedRelationshipQuerySource = RelationshipQuerySource & {
  readonly [authorizedSource]: true;
};

export interface RelationshipReadScope {
  /** Resolved by the existing authenticator/grant owner, never query JSON. */
  serverId: string;
  projects: "all" | readonly string[];
  /** Creator receipts retain their separate operator-authority boundary. */
  creators: boolean;
}

const identityJoin = (resource: "source" | "target", alias: "s" | "t") => `
 LEFT JOIN session_identities ${alias} ON (
   (json_extract(e.${resource}, '$[0]') = 'session'
     AND ${alias}.session_id = json_extract(e.${resource}, '$[2]'))
   OR (json_extract(e.${resource}, '$[0]') = 'native'
     AND ${alias}.native_family = json_extract(e.${resource}, '$[2]')
     AND ${alias}.native_scope = json_extract(e.${resource}, '$[3]')
     AND ${alias}.native_id = json_extract(e.${resource}, '$[4]')))
 LEFT JOIN session_metadata ${alias}m ON ${alias}m.session_id = ${alias}.session_id
 LEFT JOIN session_creations ${alias}c ON ${alias}c.session_id = ${alias}.session_id`;
const visible = (alias: "s" | "t") => `(${alias}.session_id IS NOT NULL
 AND coalesce(${alias}c.deleted, 0) = 0 AND (
 p.all_projects = 1 OR coalesce(${alias}m.working_project_id,
 json_extract(${alias}m.extra, '$.workingProjectId'), ${alias}.project_id)
 IN (SELECT value FROM json_each(p.projects))))`;
const child = `(e.type = 'provider_child'
 AND t.session_id IS NULL
 AND json_extract(e.source, '$[0]') = 'native'
 AND json_extract(e.target, '$[0]') = 'native'
 AND json_extract(e.target, '$[2]') = s.native_family
 AND EXISTS (SELECT 1 FROM session_relationship_evidence v
   WHERE v.edge_id = e.id AND v.state = 'active' AND v.trust = 'provider-observed')
 AND NOT EXISTS (SELECT 1 FROM session_relationship_edges other
   WHERE other.target = e.target AND other.active = 1 AND other.type = 'provider_child'
   AND other.source != e.source))`;
const branch = (side: "source" | "target") => `
 SELECT e.id, e.type, e.source, e.target
 FROM session_relationship_edges e INDEXED BY session_relationship_${side === "source" ? "outgoing" : "incoming"}
 CROSS JOIN p
 ${identityJoin("source", "s")}
 ${identityJoin("target", "t")}
 WHERE e.active = 1
 AND e.${side} = (SELECT resource FROM p WHERE direction != '${side === "source" ? "incoming" : "outgoing"}')
 AND e.id > (SELECT after FROM p)
 AND (p.type IS NULL OR e.type = p.type)
 AND (p.creators = 1 OR e.type != 'created_session')
 AND json_extract(e.source, '$[1]') = p.server_id
 AND json_extract(e.target, '$[1]') = p.server_id
 AND ${visible("s")} AND (${visible("t")} OR ${child})
 ORDER BY e.id LIMIT (SELECT take FROM p)`;

/**
 * SQL visibility precedes LIMIT: hidden projects cannot consume a public page
 * or turn the page-work bound into a hidden-row-count side channel. Uses the
 * existing identity and metadata owners, not another grant/identity registry.
 * One lazily prepared statement per profile source, released on disposal.
 * Native unbound children remain exact-parent read-only handles; other
 * unresolved/remote endpoints wait for their existing identity owners.
 */
export class AuthorizedRelationshipSource {
  #statement: SqliteStatement | undefined;
  #disposed = false;
  constructor(
    private readonly database: SqliteDatabase,
    private readonly store: () => SessionRelationshipStore,
  ) {}

  /** Request-local policy; the profile owner retains no request/principal. */
  scoped(
    scope: () => RelationshipReadScope,
  ): AuthorizedRelationshipQuerySource {
    return {
      [authorizedSource]: true,
      list: (input) => this.list(input, scope()),
      evidence: (...args) => this.store().evidence(...args),
    };
  }

  private list(
    input: Parameters<SessionRelationshipStore["list"]>[0],
    scope: RelationshipReadScope,
  ) {
    if (this.#disposed) throw new Error("Relationship source is disposed");
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new Error("Invalid relationship batch size");
    this.#statement ??= this.database.prepare(`
      WITH p AS (SELECT ? AS resource, ? AS after, ? AS direction, ? AS type,
        ? AS server_id, ? AS all_projects, ? AS projects, ? AS creators, ? AS take),
      outgoing AS (${branch("source")}), incoming AS (${branch("target")})
      SELECT * FROM (SELECT * FROM outgoing UNION SELECT * FROM incoming)
      ORDER BY id LIMIT (SELECT take FROM p)`);
    const rows = this.#statement.all<{
      id: string;
      type: SessionRelationshipType;
      source: string;
      target: string;
    }>(
      relationshipResourceKey(input.resource),
      input.after ?? "",
      input.direction ?? "both",
      input.type ?? null,
      scope.serverId,
      scope.projects === "all" ? 1 : 0,
      JSON.stringify(scope.projects === "all" ? [] : scope.projects),
      scope.creators ? 1 : 0,
      limit + 1,
    );
    return {
      edges: rows.slice(0, limit).map((row) => ({
        id: row.id,
        type: row.type,
        source: decodeRelationshipResource(row.source),
        target: decodeRelationshipResource(row.target),
      })),
      next: rows.length > limit ? rows[limit - 1]!.id : null,
    };
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#statement?.finalize();
    this.#statement = undefined;
  }
}
