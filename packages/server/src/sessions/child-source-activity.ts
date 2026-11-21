import { createHash } from "node:crypto";
import type { ProviderChildSessionSummary } from "@yep-anywhere/shared";
import type { ObservedProviderChild } from "./ProviderChildRelationshipService.js";
import { sortProviderChildSessions } from "./types.js";

const DEFAULT_MAX_ACTIVITY = 1024;

/**
 * Bounded per-source activity overlay shared by provider child sources.
 * Stores only the latest observed ISO timestamp per child id so ordinary
 * transcript writes update recency without churning structural SQLite edges.
 */
export class ChildActivityOverlay {
  // Bounded by maxEntries (default 1024); insertion-order FIFO eviction on cap.
  private readonly timestamps = new Map<string, string>();

  constructor(private readonly maxEntries = DEFAULT_MAX_ACTIVITY) {}

  remember(id: string, updatedAt: string): void {
    const previous = this.timestamps.get(id);
    if (previous && previous >= updatedAt) return;
    this.timestamps.set(id, updatedAt);
    if (this.timestamps.size > this.maxEntries) {
      const oldest = this.timestamps.keys().next().value;
      if (oldest !== undefined) this.timestamps.delete(oldest);
    }
  }

  get(id: string): string | undefined {
    return this.timestamps.get(id);
  }

  /**
   * Returns the original array when no child timestamp advanced, avoiding
   * unnecessary downstream allocations and React churn.
   */
  overlay(
    children: ProviderChildSessionSummary[],
  ): ProviderChildSessionSummary[] {
    let changed = false;
    const next = children.map((child) => {
      const updatedAt = this.timestamps.get(child.id);
      if (!updatedAt || updatedAt <= child.updatedAt) return child;
      changed = true;
      return { ...child, updatedAt };
    });
    return changed ? sortProviderChildSessions(next) : children;
  }
}

/**
 * Structural version hash over observed children, deliberately excluding
 * `updatedAt` activity so pure activity bumps never trigger SQLite rewrites.
 */
export function hashProviderChildObservation(
  state: "partial" | "complete",
  children: readonly ObservedProviderChild[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        state,
        children: children.map(
          ({
            native,
            parent,
            version,
            metadataAvailable,
            summary: { updatedAt: _activity, ...summary },
          }) => ({
            native,
            ...(parent ? { parent } : {}),
            ...(version !== undefined ? { version } : {}),
            ...(metadataAvailable !== undefined ? { metadataAvailable } : {}),
            summary,
          }),
        ),
      }),
    )
    .digest("hex");
}
