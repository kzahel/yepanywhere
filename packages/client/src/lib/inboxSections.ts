import type { InboxItem } from "../api/inbox";
import type { InboxTier } from "./inboxTiers";

/**
 * The sections Inbox surfaces show. Background is not a server tier: it is
 * the Active rows whose turn ended while provider work holds them, split out
 * on the client so every surface splits alike.
 */
export type InboxSection = InboxTier | "background";

type PhasedRow = Pick<InboxItem, "providerPhase">;

function isBackgroundHeld(item: PhasedRow): boolean {
  return item.providerPhase?.phase === "background";
}

/** Server tiers regrouped into sections; no row is dropped or duplicated. */
export function splitInboxSections<T extends PhasedRow>(
  tiers: Readonly<Record<InboxTier, T[]>>,
): Record<InboxSection, T[]> {
  return {
    needsAttention: tiers.needsAttention,
    active: tiers.active.filter((item) => !isBackgroundHeld(item)),
    background: tiers.active.filter(isBackgroundHeld),
    recentActivity: tiers.recentActivity,
    unread8h: tiers.unread8h,
    unread24h: tiers.unread24h,
  };
}
