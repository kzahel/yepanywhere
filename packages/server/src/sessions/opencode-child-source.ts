import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import {
  nativeSessionRef,
  parseNativeSessionId,
  truncateSessionTitle,
  type NativeSessionRef,
  type ProviderChildSessionSummary,
} from "@yep-anywhere/shared";
import { getProjectIdentityKey, isAbsolutePath } from "../projects/paths.js";
import type { FileChangeEvent } from "../watcher/EventBus.js";
import type { ProviderSessionWatcherSpec } from "../watcher/ProviderSessionWatcherRegistry.js";
import {
  openCodeDbReaderEnabled,
  type OpenCodeDbReader,
  type OpenCodeRelationshipSnapshot,
} from "./opencode-db-reader.js";
import { sortProviderChildSessions } from "./types.js";
import type {
  ObservedProviderChild,
  ProviderChildSource,
} from "./ProviderChildRelationshipService.js";

const stamp = (s: Stats) =>
  `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const MAX_HEADERS = 4096;
const MAX_ACTIVITY = 1024;

/** Fixed provider-owned observation; legacy JSON is frozen and demand-read. */
export function openCodeRelationshipWatcherSpec(
  databasePath: string,
): ProviderSessionWatcherSpec | undefined {
  if (!openCodeDbReaderEnabled()) return undefined;
  const files = [basename(databasePath), `${basename(databasePath)}-wal`];
  return {
    family: "opencode",
    provider: "opencode",
    watchDir: dirname(databasePath),
    recursive: false,
    watchFiles: files,
    includePaths: files,
    debounceMs: 200,
    internalOnly: true,
  };
}
interface Proof {
  path: string;
  stamp: string | null;
}
interface Row {
  id: string;
  parent?: string;
  title?: string;
  agent?: string;
  directory?: string;
  worktree?: string;
  updatedAt: string;
  proof?: Proof;
}
interface Legacy {
  rows: Map<string, Row>;
  proofs: Proof[];
  complete: boolean;
  byParent?: Map<string, string[]>;
}
const nativeId = (value: unknown): string | undefined => {
  try {
    return typeof value === "string" && value !== "." && value !== ".."
      ? parseNativeSessionId(value)
      : undefined;
  } catch {
    return undefined;
  }
};
const date = (value: unknown) =>
  typeof value === "number" && value >= 0 && value <= 8640000000000000
    ? new Date(value).toISOString()
    : new Date(0).toISOString();
const title = (v: unknown) =>
  typeof v === "string" ? truncateSessionTitle(v) : undefined;
const sourceKey = (parent: NativeSessionRef) =>
  JSON.stringify([parent.storageScope, parent.id]);
const structural = (snapshot: OpenCodeRelationshipSnapshot | undefined) =>
  snapshot &&
  hash([
    snapshot.hasParentIds,
    snapshot.rows
      .map(({ time_updated: _activity, ...row }) => row)
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
  ]);

/** Partition one shared native snapshot using the same roots as its SELECT. */
function snapshotFor(
  snapshot: OpenCodeRelationshipSnapshot,
  root: string,
  related: readonly string[],
  byId: ReadonlyMap<string, Record<string, unknown>>,
  byParent: ReadonlyMap<string, readonly string[]>,
): OpenCodeRelationshipSnapshot {
  const wanted = new Set<string>([root]);
  const pending = [root];
  for (let i = 0; i < pending.length; i++)
    for (const id of byParent.get(pending[i]!) ?? [])
      if (!wanted.has(id)) {
        wanted.add(id);
        pending.push(id);
      }
  for (const id of related) wanted.add(id);
  for (const id of [...wanted]) {
    let next = byId.get(id)?.parent_id;
    while (typeof next === "string" && next && !wanted.has(next)) {
      wanted.add(next);
      next = byId.get(next)?.parent_id;
    }
  }
  return {
    hasParentIds: snapshot.hasParentIds,
    rows: [...wanted].flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    }),
  };
}
async function proof(path: string): Promise<Proof> {
  try {
    const s = await lstat(path);
    return { path, stamp: stamp(s) };
  } catch (e) {
    if (!absent(e)) throw e;
    return { path, stamp: null };
  }
}
async function current(proofs: readonly Proof[]) {
  for (const p of proofs)
    if ((await proof(p.path)).stamp !== p.stamp) return false;
  return true;
}
async function json(
  path: string,
  proofs: Proof[],
): Promise<Record<string, unknown>> {
  const before = await lstat(path);
  if (!before.isFile() || before.size > 65536)
    throw new Error("OpenCode legacy header unavailable");
  const f = await open(
    path,
    constants.O_RDONLY |
      (process.platform === "win32"
        ? 0
        : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  );
  try {
    if (stamp(await f.stat()) !== stamp(before))
      throw new Error("OpenCode legacy header changed");
    const buffer = Buffer.alloc(before.size + 1);
    const { bytesRead } = await f.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== before.size || stamp(await f.stat()) !== stamp(before))
      throw new Error("OpenCode legacy header changed");
    const v: unknown = JSON.parse(
      buffer.subarray(0, bytesRead).toString("utf8"),
    );
    if (!v || typeof v !== "object" || Array.isArray(v))
      throw new Error("Invalid OpenCode legacy header");
    proofs.push({ path, stamp: stamp(before) });
    return v as Record<string, unknown>;
  } finally {
    await f.close();
  }
}

/** Reader-owned, bounded compact legacy headers; SQL owns accepted facts. */
export class OpenCodeChildSourceOwner {
  private legacy: Promise<Legacy> | undefined;
  // Service registration/release owns these entries (the same 128-source cap).
  private readonly active = new Map<
    string,
    {
      parent: NativeSessionRef;
      users: number;
      related: readonly string[];
      structure?: string;
      generation: number;
    }
  >();
  // Native event queues can interleave DB/WAL generations; keep four compact
  // results, never native rows. One shared probe replaces per-parent scans.
  private readonly probes = new Map<string, Promise<ReadonlySet<string>>>();
  private readonly activity = new Map<string, string>(); // MAX_ACTIVITY
  private readonly projectDirectory: Promise<string>;
  constructor(
    private readonly options: {
      owner: object;
      databasePath: string;
      storageDir: string;
      projectPath: string;
      database: OpenCodeDbReader;
      isRetired(): boolean;
      onRetire(listener: () => void): () => void;
    },
  ) {
    this.projectDirectory = realpath(options.projectPath).catch(
      () => options.projectPath,
    );
  }

  private async nativeSnapshot(
    parent: NativeSessionRef,
    related: readonly string[],
    additional: readonly string[] = [],
  ) {
    const o = this.options;
    if (
      !openCodeDbReaderEnabled() ||
      (await realpath(dirname(o.databasePath)).catch(() => null)) !==
        parent.storageScope
    )
      return undefined;
    if ((await proof(o.databasePath)).stamp === null) return undefined;
    if (
      (await realpath(o.databasePath)) !==
      join(parent.storageScope, basename(o.databasePath))
    )
      throw new Error("OpenCode native database escaped its namespace");
    return o.database.readRelationshipSnapshot(parent.id, related, additional);
  }

  private probeChanges(
    key: string,
    parent: NativeSessionRef,
  ): Promise<ReadonlySet<string>> {
    const previous = this.probes.get(key);
    if (previous) return previous;
    const work = this.readChanges(parent);
    this.probes.set(key, work);
    if (this.probes.size > 4)
      this.probes.delete(this.probes.keys().next().value!);
    return work;
  }

  private async readChanges(
    parent: NativeSessionRef,
  ): Promise<ReadonlySet<string>> {
    const active = [...this.active].filter(
      ([, a]) => a.parent.storageScope === parent.storageScope,
    );
    if (!active.length || this.options.isRetired()) return new Set();
    const related = [...new Set(active.flatMap(([, a]) => a.related))];
    const snapshot = await this.nativeSnapshot(
      parent,
      related,
      active.map(([, a]) => a.parent.id),
    );
    if (this.options.isRetired()) return new Set();
    const byId = new Map<string, Record<string, unknown>>(),
      byParent = new Map<string, string[]>();
    for (const row of snapshot?.rows ?? []) {
      if (typeof row.id !== "string") continue;
      byId.set(row.id, row);
      if (typeof row.parent_id === "string") {
        const ids = byParent.get(row.parent_id) ?? [];
        ids.push(row.id);
        byParent.set(row.parent_id, ids);
      }
    }
    const changed = new Set<string>();
    for (const [key, a] of active) {
      const version = structural(
        snapshot &&
          snapshotFor(snapshot, a.parent.id, a.related, byId, byParent),
      );
      if (version !== a.structure && this.active.get(key) === a) {
        changed.add(key);
        a.generation++;
      }
    }
    const aliases = new Map<string, { physical: string; belongs: boolean }>();
    const matches = async (path: unknown) => {
      if (typeof path !== "string" || !isAbsolutePath(path)) return false;
      let value = aliases.get(path);
      if (!value) {
        const physical = await realpath(path).catch(() => path);
        value = {
          physical,
          belongs:
            getProjectIdentityKey(physical) ===
            getProjectIdentityKey(await this.projectDirectory),
        };
        aliases.set(path, value);
      }
      return value.belongs;
    };
    const activity: Array<[string, string]> = [];
    for (const row of byId.values())
      if ((await matches(row.directory)) || (await matches(row.worktree)))
        activity.push([row.id as string, date(row.time_updated)]);
    for (const [path, a] of aliases)
      if ((await realpath(path).catch(() => path)) !== a.physical)
        throw new Error("OpenCode activity project changed");
    if (
      this.options.isRetired() ||
      (await realpath(dirname(this.options.databasePath)).catch(() => null)) !==
        parent.storageScope
    )
      return new Set();
    for (const [id, updatedAt] of activity) {
      if (!this.activity.has(id) || this.activity.get(id)! < updatedAt)
        this.activity.set(id, updatedAt);
      if (this.activity.size > MAX_ACTIVITY)
        this.activity.delete(this.activity.keys().next().value!);
    }
    return changed;
  }

  private async belongs(path: unknown): Promise<boolean> {
    if (typeof path !== "string" || !isAbsolutePath(path)) return false;
    const expected = await this.projectDirectory;
    const actual = await realpath(path).catch(() => path);
    return getProjectIdentityKey(actual) === getProjectIdentityKey(expected);
  }
  private async loadLegacy(): Promise<Legacy> {
    const rows = new Map<string, Row>(),
      proofs: Proof[] = [];
    const ambiguous = new Set<string>();
    const storageDir = join(
      await realpath(dirname(this.options.storageDir)),
      basename(this.options.storageDir),
    );
    let complete = true,
      headers = 0;
    const projectDir = join(storageDir, "project");
    proofs.push(await proof(projectDir));
    if (proofs[0]!.stamp === null) return { rows, proofs, complete };
    if (
      (await realpath(projectDir)) !==
      join(
        await realpath(dirname(this.options.storageDir)),
        basename(this.options.storageDir),
        "project",
      )
    )
      throw new Error("OpenCode legacy project escaped its native namespace");
    for (const entry of await readdir(projectDir, { withFileTypes: true })) {
      if (this.options.isRetired()) throw new Error("OpenCode reader retired");
      if (!entry.name.endsWith(".json")) continue;
      if (++headers > MAX_HEADERS) {
        complete = false;
        break;
      }
      const projectProofs: Proof[] = [];
      try {
        const project = await json(join(projectDir, entry.name), projectProofs);
        proofs.push(...projectProofs);
        const projectId = nativeId(project.id);
        if (
          !projectId ||
          `${projectId}.json` !== entry.name ||
          typeof project.worktree !== "string" ||
          project.worktree.length > 4096
        ) {
          complete = false;
          continue;
        }
        if (!(await this.belongs(project.worktree))) continue;
        const dir = join(storageDir, "session", projectId);
        proofs.push(await proof(dir));
        if (proofs.at(-1)!.stamp === null) continue;
        if ((await realpath(dir)) !== dir)
          throw new Error("OpenCode legacy session namespace changed");
        for (const file of await readdir(dir, { withFileTypes: true })) {
          if (!file.name.endsWith(".json")) continue;
          if (++headers > MAX_HEADERS) {
            complete = false;
            break;
          }
          const childProofs: Proof[] = [];
          try {
            const r = await json(join(dir, file.name), childProofs);
            const id = nativeId(r.id),
              parent =
                r.parentID == null || r.parentID === ""
                  ? undefined
                  : nativeId(r.parentID);
            if (
              !id ||
              `${id}.json` !== file.name ||
              r.projectID !== projectId ||
              (r.parentID != null && r.parentID !== "" && !parent)
            )
              throw new Error("Invalid OpenCode legacy identity");
            const time =
              r.time && typeof r.time === "object"
                ? (r.time as Record<string, unknown>)
                : {};
            if (rows.has(id) || ambiguous.has(id)) {
              rows.delete(id);
              ambiguous.add(id);
              throw new Error("Ambiguous OpenCode legacy identity");
            }
            rows.set(id, {
              id,
              parent,
              title: title(r.title),
              agent:
                typeof r.agent === "string" ? r.agent.slice(0, 256) : undefined,
              directory:
                typeof r.directory === "string" && r.directory.length <= 4096
                  ? r.directory
                  : undefined,
              worktree: project.worktree as string,
              updatedAt: date(time.updated),
              proof: childProofs[0],
            });
          } catch {
            complete = false;
            proofs.push(await proof(join(dir, file.name)));
          }
        }
      } catch {
        complete = false;
        proofs.push(await proof(join(projectDir, entry.name)));
      }
    }
    return { rows, proofs, complete };
  }
  private async legacyRows(): Promise<Legacy> {
    let value: Legacy;
    try {
      this.legacy ??= this.loadLegacy();
      value = await this.legacy;
    } catch (error) {
      this.legacy = undefined;
      throw error;
    }
    if (!(await current(value.proofs))) {
      this.legacy = this.loadLegacy();
      try {
        value = await this.legacy;
      } catch (error) {
        this.legacy = undefined;
        throw error;
      }
    }
    return value;
  }
  source(parent: NativeSessionRef): ProviderChildSource {
    const o = this.options;
    let accepted:
      | {
          version: string;
          generation: number;
          proofs: Proof[];
          dbHash?: string;
          related: string[];
          aliases: Map<string, string>;
        }
      | undefined;
    const roots = [dirname(o.databasePath), dirname(o.storageDir)];
    const check = (signal?: AbortSignal) => {
      if (signal?.aborted || o.isRetired())
        throw new Error("OpenCode child source retired");
    };
    const owns = async () =>
      (
        await Promise.all(roots.map((r) => realpath(r).catch(() => null)))
      ).includes(parent.storageScope);
    const dbRows = (related: readonly string[]) =>
      this.nativeSnapshot(parent, related);
    const eventPath = (event: FileChangeEvent) => {
      if (
        event.provider !== "opencode" ||
        (event.nativeStorageScope &&
          ![...roots, parent.storageScope].includes(event.nativeStorageScope))
      )
        return undefined;
      for (const root of [
        ...roots,
        parent.storageScope,
        ...(event.nativeStorageScope ? [event.nativeStorageScope] : []),
      ]) {
        const suffix = relative(root, event.path);
        if (
          [
            basename(o.databasePath),
            `${basename(o.databasePath)}-wal`,
          ].includes(suffix)
        )
          return suffix;
      }
      return undefined;
    };
    const observe = async (
      signal: AbortSignal,
      metadataRefresh = false,
    ): Promise<
      | import("./ProviderChildRelationshipService.js").ProviderChildObservation
      | undefined
    > => {
      check(signal);
      if (!(await owns()))
        throw new Error("OpenCode native namespace unavailable");
      const generation = this.active.get(sourceKey(parent))?.generation ?? 0;
      const legacyRoot = await realpath(roots[1]!).catch(() => null);
      let legacy: Legacy = { rows: new Map(), proofs: [], complete: true };
      if (!metadataRefresh && legacyRoot === parent.storageScope) {
        try {
          legacy = await this.legacyRows();
        } catch {
          const p = await proof(join(o.storageDir, "project")).catch(
            () => undefined,
          );
          legacy = { rows: new Map(), proofs: p ? [p] : [], complete: false };
        }
      }
      const descendants = new Set<string>([parent.id]);
      legacy.byParent ??= new Map<string, string[]>();
      const byParent = legacy.byParent;
      if (!byParent.size)
        for (const r of legacy.rows.values())
          if (r.parent) {
            const ids = byParent.get(r.parent) ?? [];
            ids.push(r.id);
            byParent.set(r.parent, ids);
          }
      const pending: string[] = [parent.id];
      for (let i = 0; i < pending.length; i++)
        for (const id of byParent.get(pending[i]!) ?? [])
          if (!descendants.has(id)) {
            descendants.add(id);
            pending.push(id);
          }
      const related = [
        ...new Set([
          ...descendants,
          ...(metadataRefresh
            ? (this.active.get(sourceKey(parent))?.related ?? [])
            : []),
        ]),
      ];
      const snapshot = await dbRows(related);
      check(signal);
      if (metadataRefresh && !snapshot?.rows.some((r) => r.id === parent.id))
        return undefined;
      const rows = new Map<string, Row>(),
        dbIds = new Set<string>();
      for (const id of related) {
        let next: string | undefined = id;
        while (next && !rows.has(next)) {
          const row = legacy.rows.get(next);
          if (!row) break;
          rows.set(next, row);
          next = row.parent;
        }
      }
      let complete =
        !metadataRefresh &&
        legacy.complete &&
        (!snapshot || snapshot.hasParentIds);
      for (const r of snapshot?.rows ?? []) {
        const id = nativeId(r.id),
          nativeParent =
            r.parent_id == null || r.parent_id === ""
              ? undefined
              : nativeId(r.parent_id);
        const historicalParent =
          id && !snapshot?.hasParentIds ? rows.get(id)?.parent : undefined;
        if (id) {
          dbIds.add(id);
          rows.delete(id);
        }
        if (
          !id ||
          (r.parent_id != null && r.parent_id !== "" && !nativeParent)
        ) {
          complete = false;
          continue;
        }
        dbIds.add(id);
        rows.set(id, {
          id,
          parent: nativeParent ?? historicalParent,
          title: title(r.title),
          agent: typeof r.agent === "string" ? r.agent : undefined,
          directory:
            typeof r.directory === "string" && r.directory.length <= 4096
              ? r.directory
              : undefined,
          worktree: typeof r.worktree === "string" ? r.worktree : undefined,
          updatedAt: date(r.time_updated),
        });
      }
      const root = rows.get(parent.id);
      if (
        !root ||
        (!(await this.belongs(root.directory)) &&
          !(await this.belongs(root.worktree)))
      )
        throw new Error("OpenCode native parent unavailable in this project");
      const proofs = [...legacy.proofs];
      const children: ObservedProviderChild[] = [];
      // Validate the whole discovered ancestry once. Native cycles are partial
      // evidence; valid siblings remain independently usable.
      const eligible = new Set<string>();
      const aliases = new Map<string, boolean>();
      const physicalAliases = new Map<string, string>();
      const matches = async (path?: string) => {
        if (!path || !isAbsolutePath(path)) return false;
        if (!aliases.has(path)) {
          const physical = await realpath(path).catch(() => path);
          physicalAliases.set(path, physical);
          aliases.set(
            path,
            isAbsolutePath(path) &&
              getProjectIdentityKey(physical) ===
                getProjectIdentityKey(await this.projectDirectory),
          );
        }
        return aliases.get(path)!;
      };
      for (const row of rows.values())
        if ((await matches(row.directory)) || (await matches(row.worktree)))
          eligible.add(row.id);
      const rootTrail: string[] = [],
        rootPositions = new Map<string, number>();
      let ancestor: string | undefined = parent.id;
      while (ancestor && rows.has(ancestor) && !rootPositions.has(ancestor)) {
        rootPositions.set(ancestor, rootTrail.length);
        rootTrail.push(ancestor);
        ancestor = rows.get(ancestor)?.parent;
      }
      const cyclic = new Set(
        ancestor && rootPositions.has(ancestor)
          ? rootTrail.slice(rootPositions.get(ancestor)!)
          : [],
      );
      const valid = new Map<string, boolean>([[parent.id, true]]);
      const validRow = async (id: string) => {
        if (valid.has(id)) return valid.get(id)!;
        const trail: string[] = [],
          seen = new Set<string>();
        let next: string | undefined = id;
        while (next && !valid.has(next)) {
          if (next === parent.id && trail.length) break;
          const row = rows.get(next);
          if (!row || !eligible.has(next) || seen.has(next)) {
            for (const key of trail) valid.set(key, false);
            return false;
          }
          seen.add(next);
          trail.push(next);
          next = row.parent;
        }
        const result = !next || next === parent.id || valid.get(next) === true;
        for (const key of trail) valid.set(key, result);
        return result;
      };
      for (const row of rows.values()) {
        check(signal);
        // The SQL snapshot includes ancestors for proof. Only accept rows in
        // this reader's established directory/worktree projection.
        if (!eligible.has(row.id) || cyclic.has(row.id)) {
          complete = false;
          continue;
        }
        if (row.proof) proofs.push(row.proof);
        if (!(await validRow(row.id))) {
          complete = false;
          continue;
        }
        const previous = this.activity.get(row.id);
        if (!previous || previous < row.updatedAt)
          this.activity.set(row.id, row.updatedAt);
        if (this.activity.size > MAX_ACTIVITY)
          this.activity.delete(this.activity.keys().next().value!);
        if (!row.parent) continue;
        if (!rows.has(row.parent) || !eligible.has(row.parent)) {
          complete = false;
          continue;
        }
        if (!descendants.has(row.id) && !dbIds.has(row.id)) continue;
        const nativeParent = nativeSessionRef(
          "opencode",
          parent.storageScope,
          parseNativeSessionId(row.parent),
        );
        const native = nativeSessionRef(
          "opencode",
          parent.storageScope,
          parseNativeSessionId(row.id),
        );
        const summary: ProviderChildSessionSummary = {
          id: row.id,
          parentSessionId: row.parent,
          updatedAt: row.updatedAt,
          ...(row.title ? { title: row.title } : {}),
          ...(row.agent ? { agentType: row.agent } : {}),
        };
        children.push({
          native,
          parent: nativeParent,
          summary,
          metadataAvailable: !!row.title,
          version: hash([
            row.id,
            row.parent,
            row.title,
            row.agent,
            dbIds.has(row.id) ? "db" : "legacy",
          ]),
        });
      }
      children.sort((a, b) => a.native.id.localeCompare(b.native.id));
      const version = hash([complete, children.map((c) => c.version)]);
      const nativeVersion = structural(snapshot);
      const active = this.active.get(sourceKey(parent));
      if (active) {
        active.related = related;
        active.structure = nativeVersion;
      }
      accepted = {
        version,
        generation,
        proofs,
        related,
        aliases: physicalAliases,
        ...(snapshot ? { dbHash: nativeVersion } : {}),
      };
      return { version, state: complete ? "complete" : "partial", children };
    };

    const source: ProviderChildSource = {
      owner: o.owner,
      ownsNativeScope: owns,
      isRetired: o.isRetired,
      onRetire: (listener) => {
        const key = sourceKey(parent);
        let active = this.active.get(key);
        if (!active) {
          if (this.active.size >= 128) return o.onRetire(listener);
          active = { parent, users: 0, related: [parent.id], generation: 0 };
          this.active.set(key, active);
        }
        active.users++;
        const release = o.onRetire(listener);
        return () => {
          release();
          if (--active.users === 0 && this.active.get(key) === active)
            this.active.delete(key);
        };
      },
      ownsFileChange: (event) => !!eventPath(event),
      fileChangeKey: () => "native-store",
      handleFileChange: async (event) => {
        if (
          !eventPath(event) ||
          !(await owns()) ||
          (await realpath(roots[0]!).catch(() => null)) !== parent.storageScope
        )
          return false;
        const key = JSON.stringify([
          event.path,
          event.changeType,
          event.timestamp,
        ]);
        return (await this.probeChanges(key, parent)).has(sourceKey(parent));
      },
      overlayActivity: (children) => {
        let changed = false;
        const next = children.map((c) => {
          const updatedAt = this.activity.get(c.id);
          if (updatedAt && updatedAt > c.updatedAt) {
            changed = true;
            return { ...c, updatedAt };
          }
          return c;
        });
        return changed ? sortProviderChildSessions(next) : children;
      },
      observe: async (signal) => {
        const result = await observe(signal);
        if (!result) throw new Error("OpenCode native parent unavailable");
        return result;
      },
      isCurrent: async (version) => {
        check();
        const p = accepted;
        if (
          !p ||
          version !== p.version ||
          p.generation !==
            (this.active.get(sourceKey(parent))?.generation ?? 0) ||
          !(await owns())
        )
          return false;
        if (!(await current(p.proofs))) {
          this.legacy = undefined;
          return false;
        }
        const snapshot = await dbRows(p.related);
        for (const [path, physical] of p.aliases)
          if ((await realpath(path).catch(() => path)) !== physical)
            return false;
        return (
          !o.isRetired() &&
          p.generation ===
            (this.active.get(sourceKey(parent))?.generation ?? 0) &&
          structural(snapshot) === p.dbHash
        );
      },
      releaseObservation: () => {
        accepted = undefined;
      },
    };
    source.refreshMetadata = (signal) => observe(signal, true);
    return source;
  }
}
