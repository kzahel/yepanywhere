import type { AntigravitySummaryRow } from "../../sessions/antigravity-summaries.js";
import type { ProviderRetentionSnapshot } from "../types.js";
import type { AntigravityUpdate } from "./antigravity-runtime.js";

type DetachedReply = NonNullable<ProviderRetentionSnapshot["detachedReply"]>;

/** Detached prompts have no ACP prompt response. Track the native root until
 * this wake has a fresh, fully idle summary. */
export class AntigravityRootActivity {
  private reply?: DetachedReply;
  private expectedWakeAtMs?: number;

  get snapshot(): DetachedReply | undefined {
    return this.reply;
  }

  expectReply(now = new Date()): boolean {
    this.expectedWakeAtMs = Math.max(this.expectedWakeAtMs ?? 0, now.getTime());
    if (this.reply && this.reply.status !== "settled") return false;
    this.reply = { status: "unverified", at: now };
    return true;
  }

  observe(update: AntigravityUpdate, now = new Date()): boolean {
    if (
      update.sessionUpdate !== "agent_message_chunk" &&
      update.sessionUpdate !== "agent_thought_chunk" &&
      update.sessionUpdate !== "tool_call"
    )
      return false;
    if (this.reply?.status === "progressing") return false;
    this.reply = { status: "progressing", at: now };
    return true;
  }

  observeForegroundSettlement(startedAt: Date): void {
    if (
      this.expectedWakeAtMs === undefined &&
      this.reply?.status === "progressing" &&
      startedAt > this.reply.at
    ) {
      // A later submitted prompt supplies a causal boundary if the
      // original unsolicited output had no identifiable wake trigger.
      this.expectedWakeAtMs = startedAt.getTime();
    }
  }

  reconcile(row: AntigravitySummaryRow | undefined, now = new Date()): boolean {
    if (
      !this.reply ||
      this.reply.status === "settled" ||
      row?.status !== "CASCADE_RUN_STATUS_IDLE" ||
      row.notFullyIdle !== false ||
      row.lastModifiedMs === undefined ||
      row.lastModifiedMs < (this.expectedWakeAtMs ?? this.reply.at.getTime())
    )
      return false;
    this.reply = { status: "settled", at: now };
    this.expectedWakeAtMs = undefined;
    return true;
  }

  clear(): void {
    this.reply = undefined;
    this.expectedWakeAtMs = undefined;
  }
}
