import { apiInputIds, type AgentMessageQueue } from "../messageQueue.js";
import type { UserMessage } from "../types.js";
import type { ProviderSessionReadyMetadata } from "./provider-session-protocol.js";

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
  private readonly nativeSteers = new Map<string, UserMessage>();

  constructor(
    initialDepth: number,
    private readonly send: (message: unknown) => void,
    private readonly rpc: <T>(method: string, args?: unknown[]) => Promise<T>,
    private readonly assertAdmission?: () => void,
    private readonly capabilities: Pick<
      ProviderSessionReadyMetadata["capabilities"],
      "queueHold" | "consumerIdle" | "steerConsumptionReported"
    > = {},
  ) {
    this.remoteDepth = initialDepth;
  }

  setConfigurationInputHeld(held: boolean): void {
    if (this.capabilities.queueHold) this.notify({ type: "queueHold", held });
  }

  onConsumerIdle(): void {
    if (this.capabilities.consumerIdle) this.notify({ type: "consumerIdle" });
  }

  /**
   * A notice the worker does without when its controller is gone: it drops
   * a configuration hold on detach, and its next controller reports idle
   * on activation.
   */
  private notify(message: unknown): void {
    try {
      this.send(message);
    } catch {
      // Detached or disconnected.
    }
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
    for (const uuid of uuids) this.nativeSteers.delete(uuid);
    this.pending = this.pending.filter(
      (message) => !message.uuid || !removed.has(message.uuid),
    );
  }

  /**
   * A steer the worker's provider reports consumed through its queue's
   * yield once it is (Antigravity, at the prompt's end), kept apart from
   * `pending` so a drain never sends it again. Bounded; oldest dropped.
   */
  awaitNativeSteer(message: UserMessage): void {
    if (!this.capabilities.steerConsumptionReported || !message.uuid) return;
    this.nativeSteers.set(message.uuid, message);
    for (const uuid of this.nativeSteers.keys()) {
      if (this.nativeSteers.size <= 64) break;
      this.nativeSteers.delete(uuid);
    }
  }

  notifyYielded(uuids: string[]): void {
    const yielded = new Set(uuids);
    const messages = this.pending.filter(
      (message) => message.uuid && yielded.has(message.uuid),
    );
    for (const uuid of uuids) {
      const steer = this.nativeSteers.get(uuid);
      if (!steer) continue;
      this.nativeSteers.delete(uuid);
      messages.push(steer);
    }
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
