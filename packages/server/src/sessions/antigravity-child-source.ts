import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  nativeSessionRef,
  parseNativeSessionId,
  truncateSessionTitle,
  type NativeSessionRef,
  type ProviderChildSessionSummary,
} from "@yep-anywhere/shared";
import { getProjectIdentityKey, isAbsolutePath } from "../projects/paths.js";
import { antigravitySummariesPath } from "../sdk/providers/antigravity-runtime.js";
import type { FileChangeEvent } from "../watcher/EventBus.js";
import { ANTIGRAVITY_SESSION_ID } from "./antigravity-metadata.js";
import {
  ANTIGRAVITY_RELATIONSHIP_MAX_SEEDS,
  AntigravitySummariesReader,
  normalizeAntigravitySummaryRow,
  type AntigravityRelationshipSnapshot,
  type AntigravitySummaryRawRow,
} from "./antigravity-summaries.js";
import {
  ChildActivityOverlay,
  hashProviderChildObservation,
} from "./child-source-activity.js";
import type {
  ObservedProviderChild,
  ProviderChildObservation,
  ProviderChildSource,
} from "./ProviderChildRelationshipService.js";
import { sortProviderChildSessions } from "./types.js";

const MAX_ACTIVE_SOURCES = 128;
const MAX_ACTIVITY = 1024;
const MAX_PROBES = 4;
const STAT_BATCH_SIZE = 8;

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const sourceKey = (parent: NativeSessionRef) =>
  JSON.stringify([parent.storageScope, parent.id]);

function antigravityNativeId(value: unknown): string | undefined {
  if (typeof value !== "string" || !ANTIGRAVITY_SESSION_ID.test(value)) {
    return undefined;
  }
  try {
    return parseNativeSessionId(value);
  } catch {
    return undefined;
  }
}

function cleanTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed ? truncateSessionTitle(trimmed) : undefined;
}

/**
 * Structural hash of a summaries snapshot: ignores activity/status fields so
 * ordinary timestamp ticks and running->idle transitions update the in-memory
 * activity overlay without churning SQLite relationship edges.
 */
function structuralSnapshotHash(
  snapshot: AntigravityRelationshipSnapshot | undefined,
): string | undefined {
  if (!snapshot) return undefined;
  return hash([
    snapshot.hasParentIds,
    snapshot.truncated,
    snapshot.rows
      .map(
        ({
          last_modified_time: _time,
          status: _status,
          not_fully_idle: _idle,
          killed: _killed,
          ...row
        }) => row,
      )
      .sort((a, b) =>
        String(a.conversation_id).localeCompare(String(b.conversation_id)),
      ),
  ]);
}

/** Partition a snapshot down to `rootId`, its current descendants, `related`, and ancestors. */
function partitionSnapshot(
  hasParentIds: boolean,
  rootId: string,
  related: readonly string[],
  byId: ReadonlyMap<string, AntigravitySummaryRawRow>,
  byParent: ReadonlyMap<string, readonly string[]>,
): AntigravityRelationshipSnapshot {
  const wanted = new Set<string>([rootId]);
  const pending = [rootId];
  for (let i = 0; i < pending.length; i++) {
    for (const id of byParent.get(pending[i]!) ?? []) {
      if (!wanted.has(id)) {
        wanted.add(id);
        pending.push(id);
      }
    }
  }
  for (const id of related) wanted.add(id);
  for (const id of [...wanted]) {
    let next = byId.get(id)?.parent_conversation_id;
    while (typeof next === "string" && next && !wanted.has(next)) {
      wanted.add(next);
      next = byId.get(next)?.parent_conversation_id;
    }
  }
  return {
    hasParentIds,
    truncated: false,
    rows: [...wanted].flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    }),
  };
}

function indexSnapshotRows(rows: readonly AntigravitySummaryRawRow[]): {
  byId: Map<string, AntigravitySummaryRawRow>;
  byParent: Map<string, string[]>;
} {
  const byId = new Map<string, AntigravitySummaryRawRow>();
  const byParent = new Map<string, string[]>();
  for (const row of rows) {
    if (typeof row.conversation_id !== "string" || !row.conversation_id)
      continue;
    byId.set(row.conversation_id, row);
    if (
      typeof row.parent_conversation_id === "string" &&
      row.parent_conversation_id
    ) {
      const ids = byParent.get(row.parent_conversation_id) ?? [];
      ids.push(row.conversation_id);
      byParent.set(row.parent_conversation_id, ids);
    }
  }
  return { byId, byParent };
}

/**
 * Stat `<scopeDir>/<id>.db` and `-wal` without following symlinks so running
 * subagents (whose `last_modified_time` is sentinel `0001-01-01`) report live
 * file recency safely within the physical store.
 */
async function statChildFilesMtime(
  scopeDir: string,
  id: string,
): Promise<number | undefined> {
  let latest: number | undefined;
  for (const suffix of [".db", ".db-wal"]) {
    try {
      const info = await fs.promises.lstat(join(scopeDir, `${id}${suffix}`));
      if (!info.isFile()) continue;
      if (latest === undefined || info.mtimeMs > latest) latest = info.mtimeMs;
    } catch {
      // Missing or unreadable sidecar is optional.
    }
  }
  return latest;
}

interface ParsedRow {
  id: string;
  parent?: string;
  isChild: boolean;
  cwd?: string;
  title?: string;
  agentName?: string;
  nestingDepth?: number;
  lastModifiedMs?: number;
}

interface ActiveParentEntry {
  parent: NativeSessionRef;
  users: number;
  /** Previously observed direct/nested child IDs (excludes `parent.id`). */
  previousChildIds: readonly string[];
  childIds: Set<string>;
  /** Structural hash of `parent.id` + current descendants + ancestors (no `related`). */
  structure?: string;
  generation: number;
}

type AntigravityEventMatch =
  | { kind: "summaries" }
  | { kind: "child-file"; childId: string; fileName: string };

interface SharedProbeSnapshot {
  hasParentIds: boolean;
  truncated: boolean;
  byId: Map<string, AntigravitySummaryRawRow>;
  byParent: Map<string, string[]>;
}

/**
 * Process-scoped pool sharing one read-only `AntigravitySummariesReader` and
 * coalesced companion-DB probes per physical store across all project readers.
 * Ref-counted by attached `AntigravityChildSourceOwner` instances so handles
 * close immediately when the last reader retires.
 */
class SharedPhysicalStore {
  readonly reader: AntigravitySummariesReader;
  readonly owners = new Set<AntigravityChildSourceOwner>();
  // Bounded to MAX_PROBES (4) recent coalesced WAL probes.
  private readonly probes = new Map<string, Promise<SharedProbeSnapshot>>();

  constructor(readonly scope: string) {
    this.reader = new AntigravitySummariesReader(
      antigravitySummariesPath(scope),
    );
  }

  probe(probeKey: string): Promise<SharedProbeSnapshot> {
    const existing = this.probes.get(probeKey);
    if (existing) return existing;
    const work = Promise.resolve().then(() => this.runSharedProbe());
    this.probes.set(probeKey, work);
    if (this.probes.size > MAX_PROBES) {
      this.probes.delete(this.probes.keys().next().value!);
    }
    return work;
  }

  private runSharedProbe(): SharedProbeSnapshot {
    const parentIds = new Set<string>();
    for (const owner of this.owners) {
      owner.collectActiveParentIds(this.scope, parentIds);
    }
    const allParents = [...parentIds];
    if (!allParents.length) {
      return {
        hasParentIds: true,
        truncated: false,
        byId: new Map(),
        byParent: new Map(),
      };
    }

    // Send only active parent seeds (never previously observed children) and
    // chunk by maxSeeds so ordinary child counts never exhaust the seed cap.
    // Reparented/deleted children still change the parent's partitioned
    // structural hash because they disappear from its descendant tree.
    let hasParentIds = true;
    let truncated = false;
    const mergedRows = new Map<string, AntigravitySummaryRawRow>();
    for (
      let offset = 0;
      offset < allParents.length;
      offset += ANTIGRAVITY_RELATIONSHIP_MAX_SEEDS
    ) {
      const chunk = allParents.slice(
        offset,
        offset + ANTIGRAVITY_RELATIONSHIP_MAX_SEEDS,
      );
      const snapshot = this.reader.readRelationshipSnapshot(chunk, []);
      hasParentIds &&= snapshot.hasParentIds;
      truncated ||= snapshot.truncated;
      for (const row of snapshot.rows) {
        if (typeof row.conversation_id === "string" && row.conversation_id) {
          mergedRows.set(row.conversation_id, row);
        }
      }
    }
    const { byId, byParent } = indexSnapshotRows([...mergedRows.values()]);
    return { hasParentIds, truncated, byId, byParent };
  }

  close(): void {
    this.probes.clear();
    this.reader.close();
  }
}

// Bounded by the distinct physical Antigravity stores referenced by live readers.
const sharedPhysicalStores = new Map<string, SharedPhysicalStore>();

/**
 * Reader-owned Antigravity child relationship source owner.
 * Attaches to a per-physical-store `SharedPhysicalStore` for SQLite handle and
 * companion WAL probe sharing across projects, while keeping project validation
 * and activity overlays local to this project reader.
 */
export class AntigravityChildSourceOwner {
  // Bounded by ProviderChildRelationshipService registration cap (128).
  private readonly active = new Map<string, ActiveParentEntry>();
  // Bounded to MAX_PROBES (4) per-owner evaluations of shared store probes.
  private readonly ownerProbes = new Map<
    string,
    Promise<ReadonlySet<string>>
  >();
  private readonly activity = new ChildActivityOverlay(MAX_ACTIVITY);
  // Bounded by the physical scopes this reader attached to (normally 1).
  private readonly attachedScopes = new Set<string>();

  constructor(
    private readonly options: {
      owner: object;
      sessionsDir: string;
      projectPath: string;
      isRetired(): boolean;
      onRetire(listener: () => void): () => void;
    },
  ) {}

  close(): void {
    for (const scope of this.attachedScopes) {
      const store = sharedPhysicalStores.get(scope);
      if (!store) continue;
      store.owners.delete(this);
      if (store.owners.size === 0) {
        store.close();
        sharedPhysicalStores.delete(scope);
      }
    }
    this.attachedScopes.clear();
    this.ownerProbes.clear();
    this.active.clear();
  }

  /** Called by `SharedPhysicalStore` to gather active parent seeds across projects. */
  collectActiveParentIds(scope: string, target: Set<string>): void {
    if (this.options.isRetired()) return;
    for (const entry of this.active.values()) {
      if (entry.parent.storageScope === scope) target.add(entry.parent.id);
    }
  }

  private acquireStore(scope: string): SharedPhysicalStore {
    let store = sharedPhysicalStores.get(scope);
    if (!store) {
      store = new SharedPhysicalStore(scope);
      sharedPhysicalStores.set(scope, store);
    }
    if (!this.attachedScopes.has(scope)) {
      store.owners.add(this);
      this.attachedScopes.add(scope);
    }
    return store;
  }

  private async ownsScope(storageScope: string): Promise<boolean> {
    if (this.options.isRetired()) return false;
    const physical = await fs.promises
      .realpath(this.options.sessionsDir)
      .catch(() => null);
    return !this.options.isRetired() && physical === storageScope;
  }

  private async readSnapshotForScope(
    storageScope: string,
    parentIds: readonly string[],
    relatedIds: readonly string[] = [],
  ): Promise<AntigravityRelationshipSnapshot> {
    if (!(await this.ownsScope(storageScope))) {
      throw new Error("Antigravity native namespace unavailable");
    }
    return this.acquireStore(storageScope).reader.readRelationshipSnapshot(
      parentIds,
      relatedIds,
    );
  }

  private probeChanges(
    probeKey: string,
    parent: NativeSessionRef,
  ): Promise<ReadonlySet<string>> {
    const previous = this.ownerProbes.get(probeKey);
    if (previous) return previous;
    const work = this.evaluateSharedProbe(probeKey, parent);
    this.ownerProbes.set(probeKey, work);
    if (this.ownerProbes.size > MAX_PROBES) {
      this.ownerProbes.delete(this.ownerProbes.keys().next().value!);
    }
    return work;
  }

  private async evaluateSharedProbe(
    probeKey: string,
    parent: NativeSessionRef,
  ): Promise<ReadonlySet<string>> {
    const entries = [...this.active].filter(
      ([, entry]) => entry.parent.storageScope === parent.storageScope,
    );
    if (!entries.length || !(await this.ownsScope(parent.storageScope))) {
      return new Set();
    }
    const store = this.acquireStore(parent.storageScope);
    const shared = await store.probe(probeKey);
    if (this.options.isRetired()) return new Set();

    const changed = new Set<string>();
    if (shared.truncated) {
      // A truncated shared batch cannot certify any active parent unchanged.
      for (const [key, entry] of entries) {
        if (this.active.get(key) === entry) {
          changed.add(key);
          entry.generation++;
        }
      }
      return changed;
    }

    const localRows = new Map<string, AntigravitySummaryRawRow>();
    for (const [key, entry] of entries) {
      const partition = partitionSnapshot(
        shared.hasParentIds,
        entry.parent.id,
        [],
        shared.byId,
        shared.byParent,
      );
      for (const row of partition.rows) {
        if (typeof row.conversation_id === "string" && row.conversation_id) {
          localRows.set(row.conversation_id, row);
        }
      }
      const version = structuralSnapshotHash(partition);
      if (version !== entry.structure && this.active.get(key) === entry) {
        changed.add(key);
        entry.generation++;
      }
    }

    // Update local project activity timestamps ONLY for rows in this reader's
    // own active parent partitions so cross-project stores never multiply
    // filesystem alias checks.
    const expectedProject = await fs.promises
      .realpath(this.options.projectPath)
      .catch(() => this.options.projectPath);
    const expectedKey = getProjectIdentityKey(expectedProject);
    const aliases = new Map<string, { physical: string; belongs: boolean }>([
      [this.options.projectPath, { physical: expectedProject, belongs: true }],
      [expectedProject, { physical: expectedProject, belongs: true }],
    ]);
    const matchesProject = async (cwd: string | undefined) => {
      if (!cwd || !isAbsolutePath(cwd)) return false;
      let cached = aliases.get(cwd);
      if (!cached) {
        const physical = await fs.promises.realpath(cwd).catch(() => cwd);
        cached = {
          physical,
          belongs: getProjectIdentityKey(physical) === expectedKey,
        };
        aliases.set(cwd, cached);
      }
      return cached.belongs;
    };

    const activityUpdates: Array<[string, string]> = [];
    for (const raw of localRows.values()) {
      const normalized = normalizeAntigravitySummaryRow(raw);
      if (!normalized || normalized.lastModifiedMs === undefined) continue;
      if (await matchesProject(normalized.cwd)) {
        activityUpdates.push([
          normalized.conversationId,
          new Date(normalized.lastModifiedMs).toISOString(),
        ]);
      }
    }
    const rechecked = new Set<string>();
    for (const [path, entry] of aliases) {
      if (rechecked.has(path)) continue;
      rechecked.add(path);
      if (
        (await fs.promises.realpath(path).catch(() => path)) !== entry.physical
      ) {
        throw new Error("Antigravity activity project changed");
      }
    }
    if (!(await this.ownsScope(parent.storageScope))) {
      return new Set();
    }
    for (const [id, updatedAt] of activityUpdates) {
      this.activity.remember(id, updatedAt);
    }
    return changed;
  }

  /** Direct unindexed fallback for callers that do not pass a SQL service. */
  async listDirectChildren(
    parentSessionId: string,
  ): Promise<ProviderChildSessionSummary[]> {
    if (this.options.isRetired()) return [];
    const id = antigravityNativeId(parentSessionId);
    if (!id) return [];
    const scope = await fs.promises
      .realpath(this.options.sessionsDir)
      .catch(() => null);
    if (!scope || this.options.isRetired()) return [];
    const parent = nativeSessionRef(
      "antigravity",
      scope,
      parseNativeSessionId(id),
    );
    let observation: ProviderChildObservation;
    try {
      observation = await this.observeParent(
        parent,
        new AbortController().signal,
        [],
      ).then((r) => r.observation);
    } catch {
      return [];
    }
    const direct = observation.children
      .filter((child) => child.parent?.id === id)
      .map((child) => child.summary);
    return sortProviderChildSessions(this.activity.overlay(direct));
  }

  private async observeParent(
    parent: NativeSessionRef,
    signal: AbortSignal,
    previousChildIds: readonly string[],
  ): Promise<{
    observation: ProviderChildObservation;
    dbHash: string;
    activeStructure: string;
    usedRelated: string[];
    descendantIds: Set<string>;
    aliases: Map<string, string>;
  }> {
    const check = () => {
      if (signal.aborted || this.options.isRetired()) {
        throw new Error("Antigravity child source retired");
      }
    };
    check();
    const usedRelated = [...new Set(previousChildIds)].filter(
      (id) => id !== parent.id,
    );
    const snapshot = await this.readSnapshotForScope(
      parent.storageScope,
      [parent.id],
      usedRelated,
    );
    check();

    const expectedProject = await fs.promises
      .realpath(this.options.projectPath)
      .catch(() => this.options.projectPath);
    const expectedKey = getProjectIdentityKey(expectedProject);
    const physicalAliases = new Map<string, string>([
      [this.options.projectPath, expectedProject],
    ]);
    const projectMatchCache = new Map<string, boolean>();
    const matchesProject = async (cwd: string | undefined) => {
      if (!cwd || !isAbsolutePath(cwd)) return false;
      const existing = projectMatchCache.get(cwd);
      if (existing !== undefined) return existing;
      const physical = await fs.promises.realpath(cwd).catch(() => cwd);
      physicalAliases.set(cwd, physical);
      const belongs = getProjectIdentityKey(physical) === expectedKey;
      projectMatchCache.set(cwd, belongs);
      return belongs;
    };

    let complete = snapshot.hasParentIds && !snapshot.truncated;
    const rows = new Map<string, ParsedRow>();
    for (const raw of snapshot.rows) {
      const normalized = normalizeAntigravitySummaryRow(raw);
      const id = normalized && antigravityNativeId(normalized.conversationId);
      const parentId =
        normalized?.parentConversationId !== undefined
          ? antigravityNativeId(normalized.parentConversationId)
          : undefined;
      if (!normalized || !id || (normalized.isChild && !parentId)) {
        complete = false;
        continue;
      }
      rows.set(id, {
        id,
        parent: parentId,
        isChild: normalized.isChild,
        cwd: normalized.cwd,
        title: cleanTitle(normalized.title),
        agentName: normalized.agentName,
        nestingDepth: normalized.nestingDepth,
        lastModifiedMs: normalized.lastModifiedMs,
      });
    }

    const root = rows.get(parent.id);
    if (!root || !(await matchesProject(root.cwd))) {
      throw new Error("Antigravity native parent unavailable in this project");
    }

    const eligible = new Set<string>();
    for (const row of rows.values()) {
      check();
      if (await matchesProject(row.cwd)) eligible.add(row.id);
    }

    // Walk ancestors above parent.id to detect cycles involving parent.id and
    // missing/ineligible ancestors.
    const rootTrail: string[] = [];
    const rootPositions = new Map<string, number>();
    let ancestor: string | undefined = parent.id;
    while (ancestor && rows.has(ancestor) && !rootPositions.has(ancestor)) {
      rootPositions.set(ancestor, rootTrail.length);
      rootTrail.push(ancestor);
      ancestor = rows.get(ancestor)?.parent;
    }
    if (ancestor && !rows.has(ancestor)) {
      complete = false;
    }
    const cyclic = new Set(
      ancestor && rootPositions.has(ancestor)
        ? rootTrail.slice(rootPositions.get(ancestor)!)
        : [],
    );
    if (cyclic.size > 0) complete = false;

    const relatedSet = new Set(usedRelated);
    // Classify candidate rows:
    // - Current descendants of `parent.id` with a cycle-free, project-eligible chain.
    // - Previously observed children (`relatedSet`) explicitly reparented to another
    //   valid, cycle-free, project-eligible parent so SQL supersedes the stale edge
    //   even when the destination parent has not been opened.
    const validChildren: ParsedRow[] = [];
    const descendantIds = new Set<string>();
    for (const row of rows.values()) {
      check();
      if (row.id === parent.id) continue;
      if (!row.parent) {
        if (!eligible.has(row.id)) complete = false;
        continue;
      }
      if (!eligible.has(row.id) || cyclic.has(row.id)) {
        complete = false;
        continue;
      }
      const seen = new Set<string>([row.id]);
      let cursor: string | undefined = row.parent;
      let reachesParent = false;
      let badChain = false;
      while (cursor) {
        if (cursor === parent.id) {
          reachesParent = true;
          break;
        }
        if (seen.has(cursor) || cyclic.has(cursor)) {
          badChain = true;
          break;
        }
        const parentRow = rows.get(cursor);
        if (!parentRow || !eligible.has(cursor)) {
          badChain = true;
          break;
        }
        seen.add(cursor);
        cursor = parentRow.parent;
      }
      if (badChain) {
        complete = false;
        continue;
      }
      if (reachesParent) {
        descendantIds.add(row.id);
        validChildren.push(row);
      } else if (relatedSet.has(row.id)) {
        // Explicit reparenting to another valid project-eligible parent.
        validChildren.push(row);
      }
    }

    // Stat child .db / .db-wal files in bounded batches so running subagents
    // (sentinel 0001-01-01 last_modified_time) still surface live recency.
    const fileMtimes = new Map<string, number | undefined>();
    for (let i = 0; i < validChildren.length; i += STAT_BATCH_SIZE) {
      check();
      const batch = validChildren.slice(i, i + STAT_BATCH_SIZE);
      const mtimes = await Promise.all(
        batch.map((row) => statChildFilesMtime(parent.storageScope, row.id)),
      );
      batch.forEach((row, index) => {
        fileMtimes.set(row.id, mtimes[index]);
      });
    }
    check();

    const children: ObservedProviderChild[] = [];
    for (const row of validChildren) {
      const updatedAtMs = Math.max(
        row.lastModifiedMs ?? 0,
        fileMtimes.get(row.id) ?? 0,
      );
      const updatedAt = new Date(updatedAtMs).toISOString();
      this.activity.remember(row.id, updatedAt);
      const nativeParent = nativeSessionRef(
        "antigravity",
        parent.storageScope,
        parseNativeSessionId(row.parent!),
      );
      const native = nativeSessionRef(
        "antigravity",
        parent.storageScope,
        parseNativeSessionId(row.id),
      );
      const summary: ProviderChildSessionSummary = {
        id: row.id,
        parentSessionId: row.parent!,
        updatedAt,
        ...(row.title ? { title: row.title } : {}),
        ...(row.agentName ? { agentType: row.agentName } : {}),
        ...(row.nestingDepth !== undefined && row.nestingDepth > 0
          ? { spawnDepth: row.nestingDepth }
          : {}),
      };
      children.push({
        native,
        parent: nativeParent,
        summary,
        metadataAvailable: !!row.title || !!row.agentName,
        version: hash([
          row.id,
          row.parent,
          row.title,
          row.agentName,
          row.nestingDepth,
        ]),
      });
    }

    children.sort((a, b) => a.native.id.localeCompare(b.native.id));
    const state = complete ? "complete" : "partial";
    const version = hashProviderChildObservation(state, children);
    const dbHash = structuralSnapshotHash(snapshot)!;
    let activeStructure = dbHash;
    if (!snapshot.truncated) {
      const { byId, byParent } = indexSnapshotRows(snapshot.rows);
      activeStructure = structuralSnapshotHash(
        partitionSnapshot(snapshot.hasParentIds, parent.id, [], byId, byParent),
      )!;
    }
    return {
      observation: { version, state, children },
      dbHash,
      activeStructure,
      usedRelated,
      descendantIds,
      aliases: physicalAliases,
    };
  }

  source(parent: NativeSessionRef): ProviderChildSource {
    const o = this.options;
    const key = sourceKey(parent);
    let accepted:
      | {
          version: string;
          generation: number;
          dbHash: string;
          activeStructure: string;
          related: string[];
          descendantIds: Set<string>;
          aliases: Map<string, string>;
        }
      | undefined;

    const check = (signal?: AbortSignal) => {
      if (signal?.aborted || o.isRetired()) {
        throw new Error("Antigravity child source retired");
      }
    };
    const owns = () => this.ownsScope(parent.storageScope);

    const matchEvent = (
      event: FileChangeEvent,
    ): AntigravityEventMatch | undefined => {
      if (event.provider !== "antigravity") return undefined;
      const roots = [o.sessionsDir, parent.storageScope];
      if (
        event.nativeStorageScope &&
        !roots.includes(event.nativeStorageScope)
      ) {
        return undefined;
      }
      const candidateRoots = [
        ...roots,
        ...(event.nativeStorageScope ? [event.nativeStorageScope] : []),
      ];
      for (const root of candidateRoots) {
        const summariesDir = dirname(root);
        const relSummary = relative(summariesDir, event.path);
        if (
          relSummary === "conversation_summaries.db" ||
          relSummary === "conversation_summaries.db-wal"
        ) {
          return { kind: "summaries" };
        }
        const relConv = relative(root, event.path);
        if (!relConv || relConv.includes("/") || relConv.includes("\\")) {
          continue;
        }
        const match = /^([^.]+)\.(db|db-wal)$/.exec(relConv);
        if (!match) continue;
        const childId = antigravityNativeId(match[1]);
        if (childId && this.active.get(key)?.childIds.has(childId)) {
          return { kind: "child-file", childId, fileName: basename(relConv) };
        }
      }
      return undefined;
    };

    const runObserve = async (
      signal: AbortSignal,
      previousChildren?: () => readonly string[],
    ): Promise<ProviderChildObservation> => {
      const activeEntry = this.active.get(key);
      const generation = activeEntry?.generation ?? 0;
      // Seed reconciliation from durable SQL outgoing edges (when available,
      // surviving restarts and failed-isCurrent retries) merged with any
      // in-memory prior children, without discarding pending corrections until
      // isCurrent() approves publication.
      const priorIds = new Set<string>(activeEntry?.previousChildIds ?? []);
      if (previousChildren) {
        for (const id of previousChildren()) priorIds.add(id);
      }
      const result = await this.observeParent(parent, signal, [...priorIds]);
      accepted = {
        version: result.observation.version,
        generation,
        dbHash: result.dbHash,
        activeStructure: result.activeStructure,
        related: result.usedRelated,
        descendantIds: result.descendantIds,
        aliases: result.aliases,
      };
      return result.observation;
    };

    const source: ProviderChildSource = {
      owner: o.owner,
      ownsNativeScope: owns,
      isRetired: o.isRetired,
      onRetire: (listener) => {
        let entry = this.active.get(key);
        if (!entry) {
          if (this.active.size >= MAX_ACTIVE_SOURCES) {
            return o.onRetire(listener);
          }
          entry = {
            parent,
            users: 0,
            previousChildIds: [],
            childIds: new Set(),
            generation: 0,
          };
          this.active.set(key, entry);
        }
        entry.users++;
        const release = o.onRetire(listener);
        return () => {
          release();
          if (--entry.users === 0 && this.active.get(key) === entry) {
            this.active.delete(key);
          }
        };
      },
      ownsFileChange: (event) => !!matchEvent(event),
      fileChangeKey: (event) => {
        const matched = matchEvent(event);
        if (!matched) return event.path;
        return matched.kind === "summaries"
          ? "summaries-store"
          : `child:${matched.childId}`;
      },
      handleFileChange: async (event) => {
        const matched = matchEvent(event);
        if (!matched || !(await owns())) return false;
        if (matched.kind === "child-file") {
          if (!this.active.get(key)?.childIds.has(matched.childId)) {
            return false;
          }
          try {
            const info = await fs.promises.lstat(
              join(parent.storageScope, matched.fileName),
            );
            if (info.isFile()) {
              this.activity.remember(
                matched.childId,
                new Date(info.mtimeMs).toISOString(),
              );
            }
          } catch {
            // Sidecar may disappear after WAL checkpoint.
          }
          return false;
        }
        const probeKey = JSON.stringify([
          basename(event.path),
          event.changeType,
          event.timestamp,
        ]);
        return (await this.probeChanges(probeKey, parent)).has(key);
      },
      overlayActivity: (children) => this.activity.overlay(children),
      observe: (signal, _previousMetadata, previousChildren) =>
        runObserve(signal, previousChildren),
      refreshMetadata: (signal, _previousMetadata, previousChildren) =>
        runObserve(signal, previousChildren),
      isCurrent: async (version) => {
        check();
        const proof = accepted;
        if (
          !proof ||
          version !== proof.version ||
          proof.generation !== (this.active.get(key)?.generation ?? 0) ||
          !(await owns())
        ) {
          return false;
        }
        // Complete all async alias and scope checks BEFORE the final synchronous
        // SQLite structural read so no native mutation can slip between them.
        for (const [path, physical] of proof.aliases) {
          if (
            (await fs.promises.realpath(path).catch(() => path)) !== physical
          ) {
            return false;
          }
        }
        if (
          o.isRetired() ||
          proof.generation !== (this.active.get(key)?.generation ?? 0) ||
          !(await owns())
        ) {
          return false;
        }
        const snapshot = this.acquireStore(
          parent.storageScope,
        ).reader.readRelationshipSnapshot([parent.id], proof.related);
        const current =
          !o.isRetired() &&
          proof.generation === (this.active.get(key)?.generation ?? 0) &&
          structuralSnapshotHash(snapshot) === proof.dbHash;
        if (current) {
          // Only advance tracked children/structure once isCurrent() approves
          // publication, so a failed retry never drops pending reparent moves.
          const currentActive = this.active.get(key);
          if (currentActive) {
            currentActive.previousChildIds = [...proof.descendantIds];
            currentActive.childIds = proof.descendantIds;
            currentActive.structure = proof.activeStructure;
          }
        }
        return current;
      },
      releaseObservation: () => {
        accepted = undefined;
      },
    };
    return source;
  }
}
