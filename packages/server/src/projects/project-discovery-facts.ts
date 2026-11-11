import {
  captureProjectObservation,
  projectObservationCurrent,
  projectObservationEpochsCurrent,
  type ProjectDiscoveryScope,
  type ProjectObservationEpoch,
  type ProjectDiscoveryObservation,
} from "./project-discovery-observation.js";
import type { CodexSessionScanner } from "./codex-scanner.js";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import type { SqliteDatabase, SqliteStatement } from "../storage/sqlite.js";
import type { Project } from "../supervisor/types.js";
import type { EventBus, FileChangeEvent } from "../watcher/EventBus.js";
import { readCodexRolloutMetadata } from "../sessions/codex-discovery.js";
import { catalogFileVersion } from "../sessions/catalog-adapters/row.js";
import {
  canonicalizeProjectPath,
  decodeProjectId,
  getProjectIdentityKey,
  readCwdFromSessionFile,
} from "./paths.js";

/**
 * Accepted native project discovery, shared by point and collection reads.
 * SQL owns one compact row per project, not a parsed row per native session.
 * Structural/ambiguous changes require a fresh native inventory; an observed
 * append updates just its accepted project's activity. Never a request cache.
 */
export class ProjectDiscoveryFacts {
  private readonly pending = new Map<string, FileChangeEvent>(); // At most 1024 changed files; overflow invalidates.
  private work?: Promise<void>;
  private active = false;
  private observation?: ProjectDiscoveryObservation;
  private revision = 0;
  private disposed = false;
  constructor(
    private readonly options: {
      database: SqliteDatabase;
      scope: () => ProjectDiscoveryScope;
      getProviderObservationEpoch?: ProjectObservationEpoch;
      codexSessionsDir: string;
      codexScanner?: Pick<CodexSessionScanner, "invalidateCache"> | null;
      queued: () => void;
      changed: (project: Project) => void;
      eventBus?: EventBus;
      invalidate: () => void;
    },
  ) {}

  /** One operation owns its statement; batches reuse it, and idle owns none. */
  private query<T>(sql: string, use: (statement: SqliteStatement) => T): T {
    const statement = this.options.database.prepare(sql);
    try {
      return use(statement);
    } finally {
      statement.finalize();
    }
  }
  private sourceKey(): string {
    const { metadataRevision: _, ...scope } = this.options.scope();
    return JSON.stringify(scope);
  }
  private matches(): boolean {
    return (
      this.query(
        "SELECT source_key FROM project_discovery_state WHERE id=1",
        (statement) => statement.get<{ source_key: string }>()?.source_key,
      ) === this.sourceKey()
    );
  }
  private metadataCurrent(): boolean {
    return (
      !this.observation ||
      this.observation.metadataRevision ===
        (this.options.scope().metadataRevision ?? 0)
    );
  }
  checkScope(): void {
    if (
      !this.disposed &&
      this.active &&
      (!this.matches() || !this.metadataCurrent())
    )
      this.reject();
  }
  get ready(): boolean {
    return (
      !this.disposed && this.active && this.matches() && this.metadataCurrent()
    );
  }
  observationEpochChanged(proof?: ProjectDiscoveryObservation): boolean {
    return (
      !!this.observation &&
      !projectObservationEpochsCurrent(
        this.observation,
        (family, path) =>
          proof?.roots.find(
            (root) => root.family === family && root.path === path,
          )?.epoch ?? null,
      )
    );
  }
  async beginObservation(): Promise<ProjectDiscoveryObservation> {
    await this.flush();
    if (this.disposed) throw new Error("Project facts owner is disposed");
    return captureProjectObservation(
      this.options.scope(),
      this.options.getProviderObservationEpoch,
    );
  }
  async isFresh(
    timestamp: number | undefined,
    ttlMs: number,
    projectId?: string,
  ): Promise<boolean> {
    this.checkScope();
    await this.flush();
    if (!this.ready || timestamp === undefined || !this.observation)
      return false;
    const proof = this.observation,
      revision = this.revision;
    const current = await projectObservationCurrent(
      proof,
      ttlMs,
      this.options.getProviderObservationEpoch,
    );
    this.checkScope();
    if (!this.ready || revision !== this.revision) return false;
    if (current === "changed") {
      this.reject();
      return false;
    }
    if (current === "unobserved") return Date.now() - timestamp < ttlMs;
    let registrations: [string, string][];
    if (projectId !== undefined) {
      let key: string;
      try {
        key = getProjectIdentityKey(decodeProjectId(projectId as UrlProjectId));
      } catch {
        return false;
      }
      const path = proof.registrations.get(key);
      registrations = path ? [[key, path]] : [];
    } else registrations = [...proof.registrations];
    for (let index = 0; index < registrations.length; index += 8) {
      const checked = await Promise.all(
        registrations.slice(index, index + 8).map(async ([key, path]) => {
          let present = false;
          try {
            present = (await stat(path)).isDirectory();
          } catch {
            /* Legacy registration discovery excludes inaccessible directories. */
          }
          const accepted = this.query(
            "SELECT 1 AS present FROM project_discovery_facts WHERE identity_key=?",
            (statement) => !!statement.get(key),
          );
          return present === accepted;
        }),
      );
      this.checkScope();
      if (!this.ready || revision !== this.revision) return false;
      if (checked.some((current) => !current)) {
        this.reject();
        return false;
      }
    }
    if (
      !projectObservationEpochsCurrent(
        proof,
        this.options.getProviderObservationEpoch,
      )
    ) {
      this.reject();
      return false;
    }
    return true;
  }

  /** Retention can restore a stale observation; only this process's discovery certifies complete reads. */
  retained(): Project[] | undefined {
    if (this.disposed || !this.matches()) return undefined;
    const rows = this.query(
      "SELECT payload FROM project_discovery_facts ORDER BY position",
      (statement) => statement.all<{ payload: string }>(),
    );
    try {
      return rows.map((row) => parseProjectDiscoveryFact(row.payload));
    } catch {
      this.invalidate();
      return undefined;
    }
  }

  project(id: string): Project | undefined {
    if (!this.ready) return undefined;
    let key: string;
    try {
      key = getProjectIdentityKey(decodeProjectId(id as UrlProjectId));
    } catch {
      return undefined;
    }
    const row = this.query(
      "SELECT payload FROM project_discovery_facts WHERE identity_key=?",
      (statement) => statement.get<{ payload: string }>(key),
    );
    if (!row) return undefined;
    try {
      return parseProjectDiscoveryFact(row.payload);
    } catch (error) {
      this.reject();
      throw error;
    }
  }
  replace(
    projects: readonly Project[],
    proof?: ProjectDiscoveryObservation,
  ): void {
    if (this.disposed) throw new Error("Project facts owner is disposed");
    this.invalidate();
    this.options.database.transaction(() => {
      this.query("DELETE FROM project_discovery_facts", (statement) =>
        statement.run(),
      );
      this.query(
        "INSERT INTO project_discovery_state(id,source_key) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET source_key=excluded.source_key",
        (statement) => statement.run(this.sourceKey()),
      );
      this.query(
        "INSERT INTO project_discovery_facts(identity_key,project_id,position,payload) VALUES(?,?,?,?)",
        (statement) => {
          for (const [position, project] of projects.entries())
            statement.run(
              getProjectIdentityKey(project.path),
              project.id,
              position,
              JSON.stringify(project),
            );
        },
      );
    });
    this.observation = proof;
    this.active = true;
  }
  invalidate(): void {
    this.revision++;
    this.active = false;
    // Keep prior coverage evidence across structural invalidation: a new observer
    // must not certify a cached native inventory from before a gap.
    this.pending.clear();
  }

  /** One finite, bounded batch; no per-project/file timers or duplicate reader indexes. */
  observe(event: FileChangeEvent): boolean {
    if (
      !this.ready ||
      event.changeType !== "modify" ||
      event.fileType !== "session" ||
      !["claude", "codex"].includes(event.provider)
    )
      return false;
    if (this.pending.size >= 1024) {
      this.reject();
      return true;
    }
    if (event.provider === "codex")
      this.options.codexScanner?.invalidateCache(event.path);
    this.pending.set(event.path, event);
    this.options.queued();
    this.start();
    return true;
  }
  private start(): void {
    if (this.work || this.disposed || !this.active || !this.pending.size)
      return;
    this.work = Promise.resolve()
      .then(() => this.drain())
      .catch(() => this.reject())
      .finally(() => {
        this.work = undefined;
        this.start();
      });
  }
  private reject(): void {
    this.invalidate();
    if (!this.disposed) this.options.invalidate();
  }
  private async drain(): Promise<void> {
    while (!this.disposed && this.active && this.pending.size) {
      const revision = this.revision;
      const updates = new Map<string, Project>(); // At most 256 affected projects per transaction.
      for (
        let count = 0;
        count < 256 && this.active && this.pending.size;
        count++
      ) {
        const [path, event] = this.pending.entries().next().value!;
        this.pending.delete(path);
        const project = await this.append(event);
        if (project === false) {
          this.reject();
          break;
        }
        if (project) {
          const staged = updates.get(project.id);
          if (
            !staged?.lastActivity ||
            project.lastActivity! > staged.lastActivity
          )
            updates.set(project.id, project);
        }
      }
      if (!this.ready || revision !== this.revision || !updates.size) continue;
      this.options.database.transaction(() => {
        this.query(
          "UPDATE project_discovery_facts SET payload=? WHERE identity_key=?",
          (statement) => {
            for (const project of updates.values())
              statement.run(
                JSON.stringify(project),
                getProjectIdentityKey(project.path),
              );
          },
        );
      });
      for (const project of updates.values()) this.options.changed(project);
      this.options.eventBus?.emit({
        type: "projects-changed",
        collectionRefresh: true,
        projectIds: [...updates.keys()],
        timestamp: new Date().toISOString(),
      });
    }
  }
  private async append(
    event: FileChangeEvent,
  ): Promise<Project | false | undefined> {
    // The catalog's indexed file location proves accepted project membership.
    // Missing/duplicate/old-version evidence cannot certify an ordinary append.
    const revision = this.revision;
    // SQLite otherwise chooses the family-leading index without statistics,
    // turning a one-file proof into a provider-population scan.
    const rows = this.query(
      "SELECT project_id,project_key,source_version FROM session_catalog INDEXED BY session_catalog_path WHERE deleted=0 AND family=? AND location_kind='file' AND location_path=? LIMIT 2",
      (statement) =>
        statement.all<{
          project_id: string;
          project_key: string;
          source_version: string;
        }>(event.provider, event.path),
    );
    if (rows.length !== 1) return false;
    const row = rows[0]!;
    const project = this.project(row.project_id);
    if (!project || getProjectIdentityKey(project.path) !== row.project_key)
      return false;
    const before = await stat(event.path);
    const [dev, ino, size, mtime] = row.source_version.split(":").map(Number);
    if (
      dev !== before.dev ||
      ino !== before.ino ||
      !Number.isFinite(size) ||
      before.size < size! ||
      before.mtimeMs < mtime!
    )
      return false;
    const native =
      event.provider === "codex"
        ? await readCodexRolloutMetadata({
            sessionsDir: this.options.codexSessionsDir,
            filePath: event.path,
          })
        : undefined;
    const cwd =
      event.provider === "claude"
        ? await readCwdFromSessionFile(event.path)
        : native?.cwd;
    // Path-variant elections, worktree/native-directory ambiguity and changed
    // metadata stay with complete discovery, including same-inode rewrites.
    if (
      !cwd ||
      canonicalizeProjectPath(cwd) !== project.path ||
      native?.isSubagent
    )
      return false;
    const activity =
      event.provider === "claude"
        ? (await stat(dirname(event.path))).mtimeMs
        : native!.mtime;
    if (
      catalogFileVersion(await stat(event.path)) !== catalogFileVersion(before)
    )
      return false;
    if (this.disposed || !this.ready || revision !== this.revision)
      return undefined;
    const timestamp = new Date(activity).toISOString();
    if (project.lastActivity !== null && timestamp <= project.lastActivity)
      return undefined;
    project.lastActivity = timestamp;
    return project;
  }
  async flush(): Promise<void> {
    while (this.work) await this.work;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.pending.clear();
    await this.work;
    this.observation = undefined;
  }
}

/** Identity lookup shared by the legacy snapshot and SQL point-read consumer. */
export function projectInSnapshot(
  snapshot: {
    byId: ReadonlyMap<string, Project>;
    byIdentityKey: ReadonlyMap<string, Project>;
  },
  id: string,
): Project | undefined {
  const exact = snapshot.byId.get(id);
  if (exact) return exact;
  try {
    return snapshot.byIdentityKey.get(
      getProjectIdentityKey(decodeProjectId(id as UrlProjectId)),
    );
  } catch {
    return undefined;
  }
}

export function isProjectDiscoveryFact(value: unknown): value is Project {
  if (typeof value !== "object" || value === null) return false;
  const project = value as Partial<Project>;

  return (
    typeof project.id === "string" &&
    typeof project.path === "string" &&
    typeof project.name === "string" &&
    typeof project.sessionDir === "string" &&
    typeof project.sessionCount === "number" &&
    (project.sessionCountsByProvider === undefined ||
      (typeof project.sessionCountsByProvider === "object" &&
        project.sessionCountsByProvider !== null &&
        Object.values(project.sessionCountsByProvider).every(
          (count) => typeof count === "number",
        ))) &&
    typeof project.activeOwnedCount === "number" &&
    typeof project.activeExternalCount === "number" &&
    (project.lastActivity === null ||
      typeof project.lastActivity === "string") &&
    typeof project.provider === "string" &&
    (project.mergedSessionDirs === undefined ||
      (Array.isArray(project.mergedSessionDirs) &&
        project.mergedSessionDirs.every((item) => typeof item === "string"))) &&
    (project.hasCodexSessions === undefined ||
      typeof project.hasCodexSessions === "boolean") &&
    (project.hasGeminiSessions === undefined ||
      typeof project.hasGeminiSessions === "boolean")
  );
}

function parseProjectDiscoveryFact(payload: string): Project {
  const parsed: unknown = JSON.parse(payload);
  if (!isProjectDiscoveryFact(parsed))
    throw new Error("Invalid accepted project facts");
  return parsed;
}

export function cloneSessionCountsByProvider(
  counts: Project["sessionCountsByProvider"],
): Project["sessionCountsByProvider"] {
  return counts ? { ...counts } : undefined;
}

export interface ProjectSnapshot {
  projects: Project[];
  byId: Map<string, Project>;
  byIdentityKey: Map<string, Project>;
  bySessionDirSuffix: Map<string, Project>;
  timestamp: number;
}

export function projectDiscoverySnapshot(
  projects: Project[],
  timestamp: number,
  sessionDirSuffix: (path: string) => string,
): ProjectSnapshot {
  const byId = new Map<string, Project>();
  const byIdentityKey = new Map<string, Project>();
  const bySessionDirSuffix = new Map<string, Project>();

  for (const project of projects) {
    byId.set(project.id, project);
    byIdentityKey.set(getProjectIdentityKey(project.path), project);

    const primarySuffix = sessionDirSuffix(project.sessionDir);
    if (primarySuffix) {
      bySessionDirSuffix.set(primarySuffix, project);
    }

    for (const mergedDir of project.mergedSessionDirs ?? []) {
      const mergedSuffix = sessionDirSuffix(mergedDir);
      if (mergedSuffix) {
        bySessionDirSuffix.set(mergedSuffix, project);
      }
    }
  }

  return {
    projects,
    byId,
    byIdentityKey,
    bySessionDirSuffix,
    timestamp,
  };
}
