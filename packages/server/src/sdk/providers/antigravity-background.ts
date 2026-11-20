import {
  normalizeProviderWorkItems,
  PROVIDER_WORK_ITEM_LIMIT,
  type ProviderWorkItem,
} from "@yep-anywhere/shared";
import type { ProviderRetentionSnapshot } from "../types.js";
import type { AntigravityUpdate } from "./antigravity-runtime.js";

/** ACP task edges are scoped to the live root session and end with its owner. */
export class AntigravityBackground {
  private readonly active = new Map<
    string,
    { item: ProviderWorkItem; detached: boolean; daemon: boolean }
  >();
  private lastUpdatedAt?: Date;

  constructor(private readonly changed?: () => void) {}

  observe(update: AntigravityUpdate, inTurn: boolean): void {
    const id = update.toolCallId;
    if (
      !id ||
      (update.sessionUpdate !== "tool_call" &&
        update.sessionUpdate !== "tool_call_update")
    )
      return;
    if (update.status === "completed" || update.status === "failed") {
      if (this.active.delete(id)) this.publish();
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

  foregroundSettled(): void {
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
    let retained = false;
    for (const { item, detached, daemon } of this.active.values()) {
      (detached ? backgroundWork : foregroundWaits).push(item);
      retained ||= detached && !daemon;
    }
    return {
      retained,
      reasons: retained ? ["antigravity-background-work"] : [],
      backgroundTaskCount: backgroundWork.length,
      backgroundWork,
      foregroundWaits,
      lastUpdatedAt: this.lastUpdatedAt,
    };
  }

  clear(): void {
    if (!this.active.size) return;
    this.active.clear();
    this.publish();
  }

  private publish(): void {
    this.lastUpdatedAt = new Date();
    this.changed?.();
  }
}
