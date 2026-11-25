import { UI_KEYS } from "../lib/storageKeys";

const DEFAULT_SECTION_EXPANSION = {
  projectQueue: true,
  starred: true,
  recentDay: true,
  older: true,
};

/** A fixed sidebar section whose open state the reader can toggle. */
export type SidebarSectionKey = keyof typeof DEFAULT_SECTION_EXPANSION;
/** Which sidebar sections are open, as saved in this browser. */
export type SidebarSectionExpansion = Record<SidebarSectionKey, boolean> & {
  /** Named sections (`category:…`, `user:…`) the reader closed; others open. */
  collapsedGroups?: readonly string[];
};

function getLocalStorage(): Storage | null {
  return typeof window !== "undefined" && window.localStorage
    ? window.localStorage
    : null;
}

/** Load the sidebar section expansion this browser saved, or the defaults. */
export function loadSidebarSectionExpansion(): SidebarSectionExpansion {
  const storage = getLocalStorage();
  if (!storage) {
    return DEFAULT_SECTION_EXPANSION;
  }

  try {
    const raw = storage.getItem(UI_KEYS.sidebarSectionExpansion);
    if (!raw) {
      return DEFAULT_SECTION_EXPANSION;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return DEFAULT_SECTION_EXPANSION;
    }
    const value = parsed as Partial<
      Record<SidebarSectionKey | "collapsedGroups", unknown>
    >;
    const collapsedGroups = Array.isArray(value.collapsedGroups)
      ? value.collapsedGroups.filter(
          (key): key is string => typeof key === "string",
        )
      : [];
    return {
      collapsedGroups,
      projectQueue:
        typeof value.projectQueue === "boolean"
          ? value.projectQueue
          : DEFAULT_SECTION_EXPANSION.projectQueue,
      starred:
        typeof value.starred === "boolean"
          ? value.starred
          : DEFAULT_SECTION_EXPANSION.starred,
      recentDay:
        typeof value.recentDay === "boolean"
          ? value.recentDay
          : DEFAULT_SECTION_EXPANSION.recentDay,
      older:
        typeof value.older === "boolean"
          ? value.older
          : DEFAULT_SECTION_EXPANSION.older,
    };
  } catch {
    return DEFAULT_SECTION_EXPANSION;
  }
}

/** Save the sidebar section expansion for this browser; best effort. */
export function saveSidebarSectionExpansion(
  expansion: SidebarSectionExpansion,
): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(UI_KEYS.sidebarSectionExpansion, JSON.stringify(expansion));
  } catch {
    // localStorage is a UI convenience; in-memory state still applies.
  }
}
