/** Private provider-owned fence, captured from the rows actually written by a copy. */
export interface ClaudeCopyBoundary {
  kind: "claude-rows";
  entries: number;
  anchor: { index: number; uuid: string };
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 1024 &&
  ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

export function isClaudeCopyBoundary(
  value: unknown,
): value is ClaudeCopyBoundary {
  const b = object(value),
    a = object(b?.anchor);
  return (
    b?.kind === "claude-rows" &&
    Number.isSafeInteger(b.entries) &&
    (b.entries as number) > 0 &&
    !!a &&
    Number.isSafeInteger(a.index) &&
    (a.index as number) >= 0 &&
    (a.index as number) < (b.entries as number) &&
    (b.entries as number) - (a.index as number) <= 256 &&
    uuid(a.uuid)
  );
}

/** No new read: callers supply the exact parsed rows they just copied. */
export function captureClaudeCopyBoundary(
  rows: readonly unknown[],
): ClaudeCopyBoundary | undefined {
  for (
    let index = rows.length - 1;
    index >= Math.max(0, rows.length - 256);
    index--
  ) {
    const id = object(rows[index])?.uuid;
    if (uuid(id))
      return {
        kind: "claude-rows",
        entries: rows.length,
        anchor: { index, uuid: id },
      };
  }
  return undefined;
}

/** A tail window, truncated/replaced prefix or missing native fence stays unknown. */
export function matchesClaudeCopyBoundary(
  boundary: unknown,
  rows: readonly unknown[],
  committed: number,
): boundary is ClaudeCopyBoundary {
  return (
    isClaudeCopyBoundary(boundary) &&
    boundary.entries <= committed &&
    object(rows[boundary.anchor.index])?.uuid === boundary.anchor.uuid
  );
}
