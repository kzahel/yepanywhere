import type { ProviderName } from "@yep-anywhere/shared";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { SessionCreationProjection } from "../sessions/SessionCreationStore.js";
import type { SqliteDatabase, SqliteStatement } from "../storage/sqlite.js";

export interface ProjectCardGroup {
  provider: ProviderName;
  updatedAt: string | null;
  sessionCount: number;
  sessionCountsByProvider: Partial<Record<ProviderName, number>>;
}

/** Before usable native facts exist, saved creations alone still have project cards. */
export function savedProjectCardGroups(
  metadata: SessionMetadataService,
  projectId?: string,
) {
  const result = new Map<string, ProjectCardGroup>();
  for (const row of metadata.creations.listProjections()) {
    const project =
      metadata.getMetadata(row.sessionId)?.workingProjectId ?? row.projectId;
    if (projectId !== undefined && project !== projectId) continue;
    const group: ProjectCardGroup = result.get(project) ?? {
      provider: row.provider,
      updatedAt: null,
      sessionCount: 0,
      sessionCountsByProvider: {},
    };
    if (!row.deleted) {
      group.sessionCount++;
      group.sessionCountsByProvider[row.provider] =
        (group.sessionCountsByProvider[row.provider] ?? 0) + 1;
      if (!group.updatedAt || row.updatedAt > group.updatedAt)
        group.updatedAt = row.updatedAt;
    }
    result.set(project, group);
  }
  return result;
}

interface Member {
  project: string;
  provider: ProviderName | null;
  control: SessionCreationProjection | undefined;
}

/** Legacy aliases can name the same public id in several projects. Within a
 * project, the last accepted native source supplies its provider. */
export function projectCardMembership(
  sources: readonly {
    project_id: string | null;
    card_provider: ProviderName | null;
  }[],
  control: SessionCreationProjection | undefined,
  workingProject: string | undefined,
): Member[] {
  const members = new Map<string, Member>();
  if (control) {
    const project = workingProject ?? control.projectId;
    members.set(project, {
      project,
      provider: control.deleted ? null : control.provider,
      control,
    });
  }
  if (!control || (!control.deleted && control.nativeBound)) {
    for (const source of sources) {
      const project = workingProject ?? source.project_id;
      if (!project || !source.card_provider) continue;
      members.set(project, {
        project,
        provider: source.card_provider,
        control: members.get(project)?.control,
      });
    }
  }
  return [...members.values()];
}

/** One compact fact per published (public id, project) plus saved creations.
 * Only the facts are checkpointed. Project/provider totals are derived on restore. */
export class ProjectCardCounts {
  constructor(
    private readonly prefix: string,
    db: SqliteDatabase,
    private readonly prepare: (sql: string) => SqliteStatement,
  ) {
    const p = prefix;
    db.exec(`CREATE TEMP TABLE ${p}_cards(key TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      project_id TEXT NOT NULL, provider TEXT, control_provider TEXT, control_order INTEGER, control_updated TEXT);
      CREATE INDEX ${p}_card_session ON ${p}_cards(session_id);
      CREATE INDEX ${p}_card_first ON ${p}_cards(project_id,control_order) WHERE control_order IS NOT NULL;
      CREATE INDEX ${p}_card_latest ON ${p}_cards(project_id,control_updated DESC) WHERE control_updated IS NOT NULL;
      CREATE TEMP TABLE ${p}_card_totals(project_id TEXT,provider TEXT,members INTEGER,controls INTEGER,
        PRIMARY KEY(project_id,provider));
      CREATE TEMP TRIGGER ${p}_card_insert AFTER INSERT ON ${p}_cards BEGIN
        INSERT INTO ${p}_card_totals VALUES(NEW.project_id,COALESCE(NEW.provider,''),NEW.provider IS NOT NULL,NEW.control_provider IS NOT NULL)
        ON CONFLICT(project_id,provider) DO UPDATE SET members=members+excluded.members,controls=controls+excluded.controls;
      END;
      CREATE TEMP TRIGGER ${p}_card_delete AFTER DELETE ON ${p}_cards BEGIN
        UPDATE ${p}_card_totals SET members=members-(OLD.provider IS NOT NULL),controls=controls-(OLD.control_provider IS NOT NULL)
          WHERE project_id=OLD.project_id AND provider=COALESCE(OLD.provider,'');
        DELETE FROM ${p}_card_totals WHERE project_id=OLD.project_id AND provider=COALESCE(OLD.provider,'') AND members=0 AND controls=0;
      END;`);
  }

  replace(id: string, members: readonly Member[]) {
    const rows = this.prepare(
      `SELECT key,project_id,provider,control_provider,control_order,control_updated FROM ${this.prefix}_cards WHERE session_id=?`,
    ).all<{
      key: string;
      project_id: string;
      provider: string | null;
      control_provider: string | null;
      control_order: number | null;
      control_updated: string | null;
    }>(id);
    const old = new Map(rows.map((row) => [row.project_id, row]));
    const remove = (key: string) =>
      this.prepare(`DELETE FROM ${this.prefix}_cards WHERE key=?`).run(key);
    for (const { project, provider, control } of members) {
      const row = old.get(project);
      old.delete(project);
      const first = control?.provider ?? null,
        order = control?.order ?? null,
        updated = control && !control.deleted ? control.updatedAt : null;
      if (
        row &&
        row.provider === provider &&
        row.control_provider === first &&
        row.control_order === order &&
        row.control_updated === updated
      )
        continue;
      if (row) remove(row.key);
      this.prepare(
        `INSERT INTO ${this.prefix}_cards VALUES(?,?,?,?,?,?,?)`,
      ).run(
        JSON.stringify([id, project]),
        id,
        project,
        provider,
        first,
        order,
        updated,
      );
    }
    for (const row of old.values()) remove(row.key);
  }

  read(project?: string): Map<string, ProjectCardGroup> {
    const p = this.prefix;
    const rows = this.prepare(`WITH managed AS (
      SELECT project_id FROM ${p}_card_totals ${project === undefined ? "" : "WHERE project_id=?"}
      GROUP BY project_id HAVING SUM(controls)>0)
      SELECT t.*, (SELECT control_provider FROM ${p}_cards WHERE project_id=m.project_id AND control_order IS NOT NULL ORDER BY control_order LIMIT 1) AS first,
        (SELECT control_updated FROM ${p}_cards WHERE project_id=m.project_id AND control_updated IS NOT NULL ORDER BY control_updated DESC LIMIT 1) AS latest
      FROM managed m JOIN ${p}_card_totals t ON t.project_id=m.project_id`).all<{
      project_id: string;
      provider: ProviderName;
      members: number;
      first: ProviderName;
      latest: string | null;
    }>(...(project === undefined ? [] : [project]));
    const result = new Map<string, ProjectCardGroup>();
    for (const row of rows) {
      const group: ProjectCardGroup = result.get(row.project_id) ?? {
        provider: row.first,
        updatedAt: row.latest,
        sessionCount: 0,
        sessionCountsByProvider: {},
      };
      if (row.members)
        group.sessionCountsByProvider[row.provider] = row.members;
      group.sessionCount += row.members;
      result.set(row.project_id, group);
    }
    return result;
  }
}
