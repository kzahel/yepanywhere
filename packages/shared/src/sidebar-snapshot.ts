import type { RetainedSessionCollectionState } from "./retained-session-collections.js";

export const SIDEBAR_SESSION_FEEDS = [
  "recent",
  "starred",
  "categorized",
] as const;
export type SidebarSessionFeed = (typeof SIDEBAR_SESSION_FEEDS)[number];
export type SidebarSessionLimits = Record<SidebarSessionFeed, number>;
/** A complete replacement of three independently bounded session windows. */
export interface SidebarSessionSnapshot<Row> {
  rows: Row[];
  windows: Record<SidebarSessionFeed, { ids: string[]; hasMore: boolean }>;
  catalog: RetainedSessionCollectionState;
  nextTransitionAt?: number;
}

/** A timestamp and canonical identity preserve pages through timestamp ties. */
export function sidebarSessionCursor(
  row: { updatedAt?: string; id: string } | undefined,
  identity = true,
): string | undefined {
  return row?.updatedAt
    ? identity
      ? JSON.stringify([row.updatedAt, row.id])
      : row.updatedAt
    : undefined;
}
