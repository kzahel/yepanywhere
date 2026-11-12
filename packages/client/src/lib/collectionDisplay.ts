import type {
  CollectionUpdate,
  CollectionView,
} from "@yep-anywhere/shared/collection-updates";

/** Compare a query's observable metadata; retain all raw fields in the decoded view. */
export function collectionDisplayChanged(
  before: CollectionView | undefined,
  next: CollectionView,
  update: CollectionUpdate,
  loadingPresentation = false,
): boolean {
  if (
    !before ||
    update.base === null ||
    update.upserts.length ||
    update.removed.length ||
    update.groups !== undefined
  )
    return true;
  const old = before.meta.catalog;
  const current = next.meta.catalog;
  // Unknown shapes and lineage changes must retain full publication semantics.
  if (
    !old ||
    !current ||
    typeof old !== "object" ||
    typeof current !== "object" ||
    Array.isArray(old) ||
    Array.isArray(current)
  )
    return true;
  const previous = old as Record<string, unknown>;
  const catalog = current as Record<string, unknown>;
  if (
    typeof previous.catalogEpoch !== "string" ||
    !previous.catalogEpoch ||
    previous.catalogEpoch !== catalog.catalogEpoch ||
    !Number.isSafeInteger(previous.catalogGeneration) ||
    !Number.isSafeInteger(catalog.catalogGeneration) ||
    (catalog.catalogGeneration as number) <
      (previous.catalogGeneration as number)
  )
    return true;
  const same = (a: unknown, b: unknown) =>
    a === b || JSON.stringify(a) === JSON.stringify(b);
  const keys = Object.keys(next.meta);
  if (keys.length !== Object.keys(before.meta).length) return true;
  for (const key of keys) {
    if (!Object.hasOwn(before.meta, key)) return true;
    if (key !== "catalog") {
      if (!same(before.meta[key], next.meta[key])) return true;
      continue;
    }
    const fields = Object.keys(catalog);
    if (fields.length !== Object.keys(previous).length) return true;
    for (const field of fields)
      if (
        !Object.hasOwn(previous, field) ||
        (field !== "catalogGeneration" &&
          !(
            loadingPresentation &&
            field === "refreshing" &&
            previous.complete === true &&
            catalog.complete === true &&
            typeof previous.refreshing === "boolean" &&
            typeof catalog.refreshing === "boolean"
          ) &&
          !same(previous[field], catalog[field]))
      )
        return true;
  }
  return false;
}
