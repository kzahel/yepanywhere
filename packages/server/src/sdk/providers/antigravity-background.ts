import {
  normalizeProviderWorkItems,
  PROVIDER_WORK_ITEM_LIMIT,
  type ProviderWorkItem,
} from "@yep-anywhere/shared";
import {
  type AntigravityChildStatus,
  type AntigravitySummaryRow,
  isAntigravityChildRunning,
} from "../../sessions/antigravity-summaries.js";
import type { ProviderRetentionSnapshot } from "../types.js";
import { AntigravityRootActivity } from "./antigravity-root-activity.js";
import type { AntigravityUpdate } from "./antigravity-runtime.js";

const DEFAULT_PROVISIONAL_SUBAGENT_GRACE_MS = 30_000;

/** ACP task edges are scoped to the live root session and end with its owner. */
export class AntigravityBackground {
  private readonly active = new Map<
    string,
    {
      item: ProviderWorkItem;
      detached: boolean;
      daemon: boolean;
      subagentId?: string;
      seenInSummaries?: boolean;
      trackedAtMs?: number;
    }
  >();
  private lastUpdatedAt?: Date;
  private root?: AntigravityRootActivity;

  constructor(private readonly changed?: () => void) {}

  trackRoot(): void {
    this.root ??= new AntigravityRootActivity();
  }

  stopTrackingRoot(): boolean {
    const wasPending = this.hasUnsettledRoot();
    this.root = undefined;
    if (wasPending) this.lastUpdatedAt = new Date();
    return wasPending;
  }

  hasUnsettledRoot(): boolean {
    const reply = this.root?.snapshot;
    return !!reply && reply.status !== "settled";
  }

  needsSummaryObservation(): boolean {
    return this.hasUnsettledRoot() || this.hasActiveSubagents();
  }

  reconcileRoot(read: () => AntigravitySummaryRow | undefined): boolean {
    const state = this.root?.snapshot;
    if (!state || state.status === "settled" || !this.root?.reconcile(read()))
      return false;
    this.lastUpdatedAt = new Date();
    return true;
  }

  observe(update: AntigravityUpdate, inTurn: boolean): void {
    const id = update.toolCallId;
    if (
      !inTurn &&
      update.status !== "completed" &&
      update.status !== "failed" &&
      this.root?.observe(update)
    )
      this.publish();
    if (
      !id ||
      (update.sessionUpdate !== "tool_call" &&
        update.sessionUpdate !== "tool_call_update")
    )
      return;
    if (update.status === "completed" || update.status === "failed") {
      const work = this.active.get(id);
      if (!work) return;
      if (!inTurn && work.detached && !work.daemon) this.root?.expectReply();
      this.active.delete(id);
      this.publish();
      return;
    }
    if (
      this.active.has(id) ||
      update.status !== "in_progress" ||
      this.active.size >= PROVIDER_WORK_ITEM_LIMIT
    )
      return;
    const { kind, title, name } = update;
    const schedule =
      name === "schedule" ||
      title === "Run schedule" ||
      title === "Running schedule";
    if (!schedule && kind !== "execute") return;
    const raw = update.rawInput as
      | { IsDaemon?: boolean; CommandLine?: string; CronExpression?: string }
      | undefined;
    const [item] =
      normalizeProviderWorkItems([
        {
          id,
          kind: schedule ? "cron" : "shell",
          label: title ?? (schedule ? "Scheduled wake" : "Command"),
          source: "antigravity-acp-tool-call",
          providerType: name ?? kind,
          command: raw?.CommandLine,
          schedule: raw?.CronExpression,
          startedAt: new Date().toISOString(),
        },
      ]) ?? [];
    if (!item) return;
    this.active.set(id, {
      item,
      detached: schedule || !inTurn,
      daemon: raw?.IsDaemon === true,
    });
    this.publish();
  }

  /**
   * Track a native `invoke_subagent` child conversation so the parent `agy acp`
   * owner stays retained in `background` state until the child settles.
   */
  trackSubagent(
    childId: string,
    label: string,
    typeName: string | undefined,
    inTurn: boolean,
    options: {
      seenInSummaries?: boolean;
      nowMs?: number;
      notify?: boolean;
    } = {},
  ): boolean {
    const key = `subagent:${childId}`;
    const existing = this.active.get(key);
    if (existing) {
      if (options.seenInSummaries && !existing.seenInSummaries) {
        existing.seenInSummaries = true;
      }
      return false;
    }
    if (this.active.size >= PROVIDER_WORK_ITEM_LIMIT) {
      return false;
    }
    const nowMs = options.nowMs ?? Date.now();
    const [item] =
      normalizeProviderWorkItems([
        {
          id: childId,
          kind: "subagent",
          label: label || typeName || "Subagent",
          source: "antigravity-subagent",
          providerType: typeName ?? "invoke_subagent",
          startedAt: new Date(nowMs).toISOString(),
        },
      ]) ?? [];
    if (!item) return false;
    this.active.set(key, {
      item,
      detached: !inTurn,
      daemon: false,
      subagentId: childId,
      seenInSummaries: options.seenInSummaries === true,
      trackedAtMs: nowMs,
    });
    this.lastUpdatedAt = new Date(nowMs);
    if (options.notify !== false) this.changed?.();
    return true;
  }

  hasActiveSubagents(): boolean {
    for (const work of this.active.values()) {
      if (work.subagentId) return true;
    }
    return false;
  }

  activeSubagentIds(): string[] {
    const ids: string[] = [];
    for (const work of this.active.values()) {
      if (work.subagentId) ids.push(work.subagentId);
    }
    return ids;
  }

  /**
   * Clear tracked subagents whose native `conversation_summaries.db` status has
   * settled (`CASCADE_RUN_STATUS_IDLE`, `killed`, or no longer running/busy),
   * disappeared after being observed, or remained provisional past the bounded
   * grace window. When `statuses` is `undefined` (transient DB unavailability),
   * confirmed children are preserved while expired provisional entries clear.
   */
  reconcileSubagents(
    statuses: ReadonlyMap<string, AntigravityChildStatus> | undefined,
    options: {
      expectedParentId?: string;
      notify?: boolean;
      nowMs?: number;
      provisionalGraceMs?: number;
    } = {},
  ): boolean {
    const nowMs = options.nowMs ?? Date.now();
    const graceMs =
      options.provisionalGraceMs ?? DEFAULT_PROVISIONAL_SUBAGENT_GRACE_MS;
    let changed = false;
    for (const [key, work] of this.active) {
      if (!work.subagentId) continue;
      if (statuses === undefined) {
        // Transient DB failure: never drop a confirmed child, but bound
        // provisional entries so an unavailable DB cannot retain forever.
        if (
          !work.seenInSummaries &&
          nowMs - (work.trackedAtMs ?? 0) >= graceMs
        ) {
          this.active.delete(key);
          changed = true;
        }
        continue;
      }
      const status = statuses.get(work.subagentId);
      if (!status) {
        // Confirmed absence from a readable summaries database: clear
        // immediately if previously seen, or once provisional grace elapses.
        if (
          work.seenInSummaries ||
          nowMs - (work.trackedAtMs ?? 0) >= graceMs
        ) {
          this.active.delete(key);
          changed = true;
        }
        continue;
      }
      // If a parent constraint is provided, a row belonging to a different (or
      // missing) parent must neither confirm a provisional launch nor retain a
      // moved child.
      if (
        options.expectedParentId !== undefined &&
        status.parentConversationId !== options.expectedParentId
      ) {
        this.active.delete(key);
        changed = true;
        continue;
      }
      work.seenInSummaries = true;
      if (!isAntigravityChildRunning(status)) {
        if (this.root && work.detached && !status.killed) {
          // The status transition can publish before the child's native
          // timestamp. Preserve ownership until we can anchor the wake.
          if (
            status.status !== "CASCADE_RUN_STATUS_IDLE" ||
            status.lastModifiedMs === undefined
          )
            continue;
          this.root.expectReply(new Date(status.lastModifiedMs));
        }
        this.active.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.lastUpdatedAt = new Date(nowMs);
      if (options.notify !== false) this.changed?.();
    }
    return changed;
  }

  foregroundSettled(startedAt?: Date): void {
    if (startedAt) this.root?.observeForegroundSettlement(startedAt);
    let changed = false;
    for (const work of this.active.values()) {
      if (work.detached) continue;
      work.detached = true;
      changed = true;
    }
    if (changed) this.publish();
  }

  snapshot(): ProviderRetentionSnapshot {
    const backgroundWork: ProviderWorkItem[] = [];
    const foregroundWaits: ProviderWorkItem[] = [];
    let retainedByTask = false;
    for (const { item, detached, daemon } of this.active.values()) {
      (detached ? backgroundWork : foregroundWaits).push(item);
      retainedByTask ||= detached && !daemon;
    }
    const reply = this.root?.snapshot;
    const retainedByReply = !!reply && reply.status !== "settled";
    return {
      retained: retainedByTask || retainedByReply,
      reasons: [
        ...(retainedByTask ? ["antigravity-background-work"] : []),
        ...(retainedByReply ? ["antigravity-detached-reply"] : []),
      ],
      ...(reply ? { detachedReply: reply } : {}),
      backgroundTaskCount: backgroundWork.length,
      backgroundWork,
      foregroundWaits,
      lastUpdatedAt: this.lastUpdatedAt,
    };
  }

  clear(): void {
    if (!this.active.size && !this.root?.snapshot) return;
    this.active.clear();
    this.root?.clear();
    this.publish();
  }

  private publish(): void {
    this.lastUpdatedAt = new Date();
    this.changed?.();
  }
}
