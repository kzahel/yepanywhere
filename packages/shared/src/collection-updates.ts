/** Bounded query views; native sessions and canonical collection routes stay authoritative. */
export const COLLECTION_UPDATE_GROUPS = [
  "sessions",
  "needsAttention",
  "active",
  "recentActivity",
  "unread8h",
  "unread24h",
  "projects",
  "items",
  "recoveredSessionQueues",
  "projectStatuses",
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
  /** Opt-in field replacements; initial/recovery frames still carry complete metadata. */
  metaFields?: { set: CollectionView["meta"]; removed: string[] };
}
export function collectionView(
  body: Record<string, unknown>,
  query = "/sessions",
): CollectionView {
  const rows = new Map<string, Record<string, unknown>>();
  const groups: Record<string, string[]> = {};
  const meta = { ...body };
  const path = new URL(query, "http://collection.invalid").pathname;
  const selected =
    path === "/projects"
      ? ["projects"]
      : path === "/project-queue"
        ? ["items", "recoveredSessionQueues", "projectStatuses"]
        : COLLECTION_UPDATE_GROUPS.slice(0, 6);
  for (const group of selected) {
    const isStatuses = group === "projectStatuses";
    const value = body[group];
    if (
      isStatuses
        ? !value || typeof value !== "object" || Array.isArray(value)
        : !Array.isArray(value)
    )
      continue;
    const entries = isStatuses
      ? Object.entries(value as Record<string, Record<string, unknown>>)
      : (value as Record<string, unknown>[]).map((row) => ["", row] as const);
    groups[group] = entries.map(([statusId, row]) => {
      const id = isStatuses
        ? statusId
        : ["sessions", "projects", "items", "recoveredSessionQueues"].includes(
              group,
            )
          ? row.id
          : row.sessionId;
      if (typeof id !== "string")
        throw new Error("Invalid collection row identity");
      const key = [
        "projects",
        "items",
        "recoveredSessionQueues",
        "projectStatuses",
      ].includes(group)
        ? group + ":" + id
        : id;
      rows.set(key, row);
      return key;
    });
    delete meta[group];
  }
  if (rows.size > 500) throw new Error("Oversized collection update");
  return { rows: [...rows], groups, meta };
}
export function diffCollectionView(
  query: string,
  revision: number,
  before: CollectionView | undefined,
  next: CollectionView,
  metadataFields = false,
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
  const metaFields =
    meta && before && metadataFields
      ? {
          set: Object.fromEntries(
            Object.entries(next.meta).filter(
              ([key, value]) =>
                !Object.hasOwn(before.meta, key) ||
                JSON.stringify(before.meta[key]) !== JSON.stringify(value),
            ),
          ),
          removed: Object.keys(before.meta).filter(
            (key) => !Object.hasOwn(next.meta, key),
          ),
        }
      : undefined;
  if (before && !upserts.length && !removed.length && !groups && !meta) return;
  return {
    query,
    revision,
    base: before ? revision - 1 : null,
    upserts,
    removed,
    ...(groups ? { groups } : {}),
    ...(metaFields ? { metaFields } : meta ? { meta } : {}),
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
  const fields = update.metaFields;
  if (
    fields !== undefined &&
    (update.base === null ||
      update.meta !== undefined ||
      !fields ||
      typeof fields !== "object" ||
      !fields.set ||
      typeof fields.set !== "object" ||
      Array.isArray(fields.set) ||
      !Array.isArray(fields.removed) ||
      fields.removed.some(
        (key) => typeof key !== "string" || Object.hasOwn(fields.set, key),
      ) ||
      new Set(fields.removed).size !== fields.removed.length)
  )
    throw new Error("Invalid collection metadata fields");
  const meta = fields
    ? { ...previous!.view.meta, ...fields.set }
    : (update.meta ?? previous!.view.meta);
  for (const key of fields?.removed ?? []) delete meta[key];
  const body = { ...meta };
  for (const [group, ids] of Object.entries(groups)) {
    if (
      !(COLLECTION_UPDATE_GROUPS as readonly string[]).includes(group) ||
      !Array.isArray(ids) ||
      ids.length > 500 ||
      new Set(ids).size !== ids.length
    )
      throw new Error("Invalid collection update membership");
    const members = ids.map((id) => {
      const row = rows.get(id);
      if (!row) throw new Error("Missing collection update row");
      return row;
    });
    body[group] =
      group === "projectStatuses"
        ? Object.fromEntries(
            ids.map((id, n) => [
              id.slice("projectStatuses:".length),
              members[n],
            ]),
          )
        : members;
  }
  if (rows.size > 500) throw new Error("Oversized collection update");
  return {
    revision: update.revision,
    view: { rows: [...rows], groups, meta },
    body,
  };
}
