import { apiInputIds, type AgentMessageQueue } from "../messageQueue.js";
import type { UserMessage } from "../types.js";

/**
 * Hono's proxy for a Provider Host worker's `MessageQueue`: pushes and
 * removals go to the worker, and the worker reports its depth and what it
 * yielded.
 */
export class HostedMessageQueue implements AgentMessageQueue {
  private pending: UserMessage[] = [];
  private remoteDepth: number;
  private yieldedListeners = new Set<(messages: UserMessage[]) => void>();
  private readonly apiInputs = new Set<string>();

  constructor(
    initialDepth: number,
    private readonly send: (message: unknown) => void,
    private readonly rpc: <T>(method: string, args?: unknown[]) => Promise<T>,
    private readonly assertAdmission?: () => void,
  ) {
    this.remoteDepth = initialDepth;
  }

  push(message: UserMessage): number {
    this.trackSteer(message);
    this.remoteDepth = Math.max(this.remoteDepth, this.pending.length);
    this.send({ type: "queuePush", message });
    return this.remoteDepth;
  }

  trackSteer(message: UserMessage): void {
    this.assertAdmission?.();
    this.pending.push(message);
  }

  drain(): UserMessage[] {
    const drained = this.pending.splice(0);
    this.remoteDepth = 0;
    void this.rpc<UserMessage[]>("drainQueue").catch(() => {});
    return drained;
  }

  async drainAsync(): Promise<UserMessage[]> {
    const remote = await this.rpc<UserMessage[]>("drainQueue");
    this.pending = [];
    this.remoteDepth = 0;
    return remote;
  }

  removeByTempId(tempId: string): UserMessage[] {
    const removed = this.pending.filter(
      (message) =>
        message.tempId === tempId || message.tempIds?.includes(tempId) === true,
    );
    this.pending = this.pending.filter((message) => !removed.includes(message));
    this.send({ type: "removeQueued", tempId });
    return removed;
  }

  updateDepth(depth: number): void {
    this.remoteDepth = Math.max(0, depth);
  }

  removeAccepted(uuids: string[]): void {
    const removed = new Set(uuids);
    this.pending = this.pending.filter(
      (message) => !message.uuid || !removed.has(message.uuid),
    );
  }

  notifyYielded(uuids: string[]): void {
    const yielded = new Set(uuids);
    const messages = this.pending.filter(
      (message) => message.uuid && yielded.has(message.uuid),
    );
    if (messages.length === 0) return;
    for (const message of messages) {
      for (const id of apiInputIds(message)) {
        this.apiInputs.add(id);
        while (this.apiInputs.size > 512)
          this.apiInputs.delete(this.apiInputs.values().next().value!);
      }
    }
    for (const listener of this.yieldedListeners) listener(messages);
  }

  hasYieldedApiInput(id: string) {
    return this.apiInputs.has(id);
  }
  subscribeYielded(listener: (messages: UserMessage[]) => void): () => void {
    this.yieldedListeners.add(listener);
    return () => this.yieldedListeners.delete(listener);
  }

  get depth(): number {
    return this.remoteDepth;
  }
}
