/**
 * Whether a session belongs to a named sidebar section — a user-made
 * category, the API client that created it, or the limited user who started
 * it — rather than only to the time-ordered lists. The sidebar's categorized
 * feed selects these so a section lists its sessions however old they are,
 * not just those on the loaded recent page.
 */
export function isNamedSidebarSession(item: {
  sidebarCategory?: string;
  apiClient?: string;
  createdByUser?: string;
}): boolean {
  return Boolean(item.sidebarCategory || item.apiClient || item.createdByUser);
}

/**
 * Changes when the selection above changes, so a saved collection checkpoint
 * whose stored flags used an older rule is rebuilt rather than reused.
 */
export const NAMED_SIDEBAR_SESSION_RULE = "named-sections-v1";
