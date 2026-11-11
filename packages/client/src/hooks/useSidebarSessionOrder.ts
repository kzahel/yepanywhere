import { useMemo, useSyncExternalStore } from "react";
import { useClientSummarySourceKey } from "../lib/clientSummaryStore";
import type { SessionCollectionRecord } from "../lib/clientSummaryCollections";
import { getSessionInteractionStore } from "../lib/sessionInteractionOrder";

/** One named sidebar section: a user-made category or a limited user. */
export interface SidebarSessionGroup<T> {
  name: string;
  rows: readonly T[];
}

function compareGroupNames(a: string, b: string): number {
  return (
    a.localeCompare(b, undefined, { sensitivity: "base" }) || a.localeCompare(b)
  );
}

/**
 * Sidebar chronology belongs to the user, independently of agent liveness.
 *
 * Sessions file under exactly one section, first match wins: Starred, then
 * their sidebar category, then (when `groupByCreator`) the limited user who
 * started them, then Last 24 Hours or Older.
 */
export function useSidebarSessionOrder(
  records: readonly SessionCollectionRecord[],
  starred: readonly SessionCollectionRecord[],
  categorized: readonly SessionCollectionRecord[] = [],
  groupByCreator = false,
) {
  const sourceKey = useClientSummarySourceKey();
  const store = getSessionInteractionStore(sourceKey);
  const raw = useSyncExternalStore(store.subscribe, store.read, store.read);
  return useMemo(() => {
    const interactions = new Map<string, number>(JSON.parse(raw));
    // This browser's own record of when the reader last wrote into each
    // session, and the server's record of when anyone did. The local one alone
    // would place a session by what *this* browser sent, so a session the
    // reader had answered on another device would file under older work,
    // where it was hard to find. Taking the later of the two moves a row as
    // soon as it is sent to, before the server reports the turn, while a fresh
    // browser with nothing stored still lands on the same chronology.
    const time = (record: SessionCollectionRecord) =>
      Math.max(
        interactions.get(record.id) ?? 0,
        Date.parse(record.lastHumanTurnAt ?? "") || 0,
        // Nothing has been written into it yet, or the provider does not report
        // it: fall back to when the session appeared.
        Date.parse(record.createdAt ?? "") || 0,
      );
    const order = (rows: readonly SessionCollectionRecord[]) =>
      [...rows].sort((a, b) => time(b) - time(a) || a.id.localeCompare(b.id));
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    // The categorized feed reaches past the recent page; merge it in once.
    const merged = new Map<string, SessionCollectionRecord>();
    for (const record of [...records, ...categorized]) {
      merged.set(record.id, record);
    }
    const categories = new Map<string, SessionCollectionRecord[]>();
    const creators = new Map<string, SessionCollectionRecord[]>();
    const ordinary: SessionCollectionRecord[] = [];
    for (const record of merged.values()) {
      if (record.isStarred || record.isArchived) continue;
      const group = record.sidebarCategory
        ? categories
        : groupByCreator && record.createdByUser
          ? creators
          : null;
      const key = record.sidebarCategory || record.createdByUser;
      if (group && key) {
        group.set(key, [...(group.get(key) ?? []), record]);
      } else {
        ordinary.push(record);
      }
    }
    const groups = (byName: Map<string, SessionCollectionRecord[]>) =>
      [...byName.keys()]
        .sort(compareGroupNames)
        .map((name) => ({ name, rows: order(byName.get(name) ?? []) }));
    return {
      starred: order(starred),
      categories: groups(categories),
      recent: order(ordinary.filter((record) => time(record) >= cutoff)),
      creators: groups(creators),
      older: order(ordinary.filter((record) => time(record) < cutoff)),
    };
  }, [raw, records, starred, categorized, groupByCreator]);
}
