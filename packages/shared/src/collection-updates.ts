/** Bounded query views; native sessions and canonical collection routes stay authoritative. */
export const COLLECTION_UPDATE_GROUPS = [
  "sessions",
  "needsAttention",
  "active",
  "recentActivity",
  "unread8h",
  "unread24h",
] as const;
export interface CollectionView {
  rows: Array<[string, Record<string, unknown>]>;
  groups: Record<string, string[]>;
  meta: Record<string, unknown>;
}
export interface CollectionUpdate {
  query: string;
  revision: number;
  base: number | null;
  upserts: CollectionView["rows"];
  removed: string[];
  groups?: CollectionView["groups"];
  meta?: CollectionView["meta"];
}
export function collectionView(body: Record<string, unknown>): CollectionView {
  const rows = new Map<string, Record<string, unknown>>();
  const groups: Record<string, string[]> = {};
  const meta = { ...body };
  for (const group of COLLECTION_UPDATE_GROUPS) {
    if (!Array.isArray(body[group])) continue;
    groups[group] = (body[group] as Record<string, unknown>[]).map((row) => {
      const id = group === "sessions" ? row.id : row.sessionId;
      if (typeof id !== "string")
        throw new Error("Invalid collection row identity");
      rows.set(id, row);
      return id;
    });
    delete meta[group];
  }
  return { rows: [...rows], groups, meta };
}
export function diffCollectionView(
  query: string,
  revision: number,
  before: CollectionView | undefined,
  next: CollectionView,
): CollectionUpdate | undefined {
  const old = new Map(before?.rows);
  const current = new Map(next.rows);
  const upserts = next.rows.filter(
    ([id, row]) => JSON.stringify(old.get(id)) !== JSON.stringify(row),
  );
  const removed = [...old.keys()].filter((id) => !current.has(id));
  const groups =
    JSON.stringify(before?.groups) === JSON.stringify(next.groups)
      ? undefined
      : next.groups;
  const meta =
    JSON.stringify(before?.meta) === JSON.stringify(next.meta)
      ? undefined
      : next.meta;
  if (before && !upserts.length && !removed.length && !groups && !meta) return;
  return {
    query,
    revision,
    base: before ? revision - 1 : null,
    upserts,
    removed,
    ...(groups ? { groups } : {}),
    ...(meta ? { meta } : {}),
  };
}
export function applyCollectionUpdate(
  previous: { revision: number; view: CollectionView } | undefined,
  update: CollectionUpdate,
): { revision: number; view: CollectionView; body: Record<string, unknown> } {
  if (
    !Number.isSafeInteger(update.revision) ||
    update.revision <= 0 ||
    (previous !== undefined && update.revision <= previous.revision) ||
    (update.base !== null && update.base !== previous?.revision) ||
    (update.base !== null && update.revision !== update.base + 1) ||
    !Array.isArray(update.upserts) ||
    !Array.isArray(update.removed) ||
    (update.base === null && (!update.groups || !update.meta))
  )
    throw new Error("Collection update needs a replacement snapshot");
  const rows = new Map(update.base === null ? [] : previous?.view.rows);
  for (const id of update.removed) rows.delete(id);
  for (const [id, row] of update.upserts) {
    if (
      typeof id !== "string" ||
      !row ||
      typeof row !== "object" ||
      Array.isArray(row)
    )
      throw new Error("Invalid collection update row");
    rows.set(id, row);
  }
  const groups = update.groups ?? previous!.view.groups;
  const meta = update.meta ?? previous!.view.meta;
  const body = { ...meta };
  for (const [group, ids] of Object.entries(groups)) {
    if (
      !(COLLECTION_UPDATE_GROUPS as readonly string[]).includes(group) ||
      !Array.isArray(ids) ||
      ids.length > 500 ||
      new Set(ids).size !== ids.length
    )
      throw new Error("Invalid collection update membership");
    body[group] = ids.map((id) => {
      const row = rows.get(id);
      if (!row) throw new Error("Missing collection update row");
      return row;
    });
  }
  if (rows.size > 500) throw new Error("Oversized collection update");
  return {
    revision: update.revision,
    view: { rows: [...rows], groups, meta },
    body,
  };
}
