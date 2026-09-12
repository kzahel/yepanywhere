import {
  ConversationQuerySchema,
  IdSchema,
  type ApiError,
  type ConversationQuery,
} from "@yep-anywhere/shared/experimental/simple-client.generated";
import {
  prepareConversation,
  selectConversation,
  serializeConversationSnapshot,
  type ConversationInput,
  type PreparedConversation,
} from "./conversation-projection.js";

export const CONVERSATION_COALESCE_MS = 200;
export const MAX_CONVERSATION_SOURCES = 16;
export const MAX_CONVERSATION_SUBSCRIPTIONS = 128;

/**
 * The adapter registers invalidations before returning this lease. read() must
 * capture a bounded, reconciled normalized snapshot after it is called. Provider
 * tokens must update owned memory, not trigger transcript reads. Both operations
 * honor the lifetime signal; close() releases every watch and provider demand.
 */
export interface ConversationSource {
  read(signal: AbortSignal): Promise<ConversationInput>;
  close(): void;
}

export type OpenConversationSource = (
  sessionId: string,
  invalidate: () => void,
  signal: AbortSignal,
) => Promise<ConversationSource>;

type Prepared = PreparedConversation | ApiError;
export interface ConversationConsumer {
  send(encodedSnapshot: string): void;
  /** Terminate the transport binding, including server-initiated teardown. */
  close(): void;
}
interface Subscriber {
  query: ConversationQuery;
  subscriptionId: string;
  sequence: number;
  previousView?: string;
  consumer: ConversationConsumer;
}
interface Owner {
  sessionId: string;
  abort: AbortController;
  subscribers: Set<Subscriber>;
  source?: ConversationSource;
  prepared?: Prepared;
  revision: number;
  preparedRevision: number;
  reading: boolean;
  opening: boolean;
  lastReadAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * One lifetime and in-flight computation per session in one YA server. This
 * owner is shared by HTTP, SSE and WebSocket bindings.
 */
export class ConversationSubscriptions {
  private owners = new Map<string, Owner>();
  private sourceSlots = new Set<Owner>();
  private subscriberCount = 0;
  private closed = false;

  constructor(private readonly openSource: OpenConversationSource) {}

  subscribe(
    query: ConversationQuery,
    subscriptionId: string,
    consumer: ConversationConsumer,
  ): () => void {
    const parsedQuery = ConversationQuerySchema.parse(query);
    IdSchema.parse(subscriptionId);
    if (this.closed) throw new Error("Conversation subscriptions are closed");
    if (this.subscriberCount >= MAX_CONVERSATION_SUBSCRIPTIONS)
      throw new Error("Conversation subscription capacity reached");
    let owner = this.owners.get(parsedQuery.sessionId);
    const opening = !owner;
    if (!owner) {
      if (this.sourceSlots.size >= MAX_CONVERSATION_SOURCES)
        throw new Error("Conversation source capacity reached");
      owner = {
        sessionId: parsedQuery.sessionId,
        abort: new AbortController(),
        subscribers: new Set(),
        revision: 0,
        preparedRevision: -1,
        reading: false,
        opening: true,
        lastReadAt: -Infinity,
      };
      this.owners.set(owner.sessionId, owner);
      this.sourceSlots.add(owner);
    }
    const subscriber: Subscriber = {
      query: parsedQuery,
      subscriptionId,
      sequence: 0,
      consumer,
    };
    owner.subscribers.add(subscriber);
    this.subscriberCount++;
    if (opening) void this.open(owner);
    // A new consumer must not receive cached state superseded by an observed
    // invalidation. It joins the already scheduled shared read instead.
    else if (owner.preparedRevision === owner.revision)
      this.publish(owner, subscriber);
    const acquired = owner;
    return () => this.remove(acquired, subscriber);
  }

  close(): void {
    this.closed = true;
    for (const owner of this.owners.values()) this.release(owner);
  }

  private async open(owner: Owner): Promise<void> {
    try {
      const source = await this.openSource(
        owner.sessionId,
        () => {
          if (owner.abort.signal.aborted) return;
          owner.revision++;
          this.schedule(owner);
        },
        owner.abort.signal,
      );
      if (owner.abort.signal.aborted) {
        source.close();
        return;
      }
      owner.source = source;
      this.schedule(owner);
    } catch {
      if (!owner.abort.signal.aborted) {
        owner.prepared = this.unavailable();
        owner.preparedRevision = owner.revision;
        this.publishAll(owner);
      }
    } finally {
      owner.opening = false;
      this.releaseSettledSlot(owner);
    }
  }

  private schedule(owner: Owner): void {
    if (
      owner.abort.signal.aborted ||
      !owner.source ||
      owner.reading ||
      owner.timer !== undefined
    )
      return;
    const delay = Math.max(
      0,
      owner.lastReadAt + CONVERSATION_COALESCE_MS - Date.now(),
    );
    owner.timer = setTimeout(() => {
      owner.timer = undefined;
      void this.refresh(owner);
    }, delay);
  }

  private async refresh(owner: Owner): Promise<void> {
    if (owner.abort.signal.aborted || !owner.source) return;
    owner.reading = true;
    owner.lastReadAt = Date.now();
    const revision = owner.revision;
    try {
      const input = await owner.source.read(owner.abort.signal);
      if (owner.abort.signal.aborted || revision !== owner.revision) return;
      owner.prepared =
        input.sessionId === owner.sessionId
          ? prepareConversation(input)
          : this.unavailable();
      owner.preparedRevision = revision;
      this.publishAll(owner);
    } catch {
      if (!owner.abort.signal.aborted && revision === owner.revision) {
        owner.prepared = this.unavailable();
        owner.preparedRevision = revision;
        this.publishAll(owner);
      }
    } finally {
      owner.reading = false;
      owner.lastReadAt = Date.now();
      this.releaseSettledSlot(owner);
      // Coalesce every invalidation observed during the read into one follow-up.
      // A failed read with no new evidence does not create a retry loop.
      if (revision !== owner.revision) this.schedule(owner);
    }
  }

  private unavailable(): ApiError {
    return {
      kind: "error",
      code: "unavailable",
      message: "Conversation source is unavailable",
    };
  }

  private publishAll(owner: Owner): void {
    // Delivery can close a binding or the service; iterate a stable recipient
    // set and recheck ownership before each call.
    for (const subscriber of [...owner.subscribers])
      this.publish(owner, subscriber);
  }

  private publish(owner: Owner, subscriber: Subscriber): void {
    if (
      owner.abort.signal.aborted ||
      !owner.prepared ||
      owner.preparedRevision !== owner.revision ||
      !owner.subscribers.has(subscriber)
    )
      return;
    try {
      const snapshot = selectConversation(owner.prepared, subscriber.query, {
        subscriptionId: subscriber.subscriptionId,
        sequence: subscriber.sequence,
      });
      const encoded = serializeConversationSnapshot(snapshot);
      const view = JSON.stringify(JSON.parse(encoded).view);
      if (view === subscriber.previousView) return;
      subscriber.previousView = view;
      subscriber.sequence++;
      subscriber.consumer.send(encoded);
      // The next frame would exceed the schema's Int32 sequence. Closing the
      // binding is deliberate; transports must surface closure and rebind.
      if (subscriber.sequence > 2147483647) this.remove(owner, subscriber);
    } catch {
      // A failed transport cannot pin source ownership or block healthy peers.
      this.remove(owner, subscriber);
    }
  }

  private remove(owner: Owner, subscriber: Subscriber): void {
    if (!owner.subscribers.delete(subscriber)) return;
    this.subscriberCount--;
    this.closeConsumer(subscriber);
    if (owner.subscribers.size === 0) this.release(owner);
  }

  private closeConsumer(subscriber: Subscriber): void {
    try {
      subscriber.consumer.close();
    } catch {
      // Ownership was already removed; one broken transport cannot prevent
      // teardown of the source or other transport bindings.
    }
  }

  private releaseSettledSlot(owner: Owner): void {
    // An adapter can take time to honor abort. Rapid open/close cycles must not
    // bypass the acquisition ceiling while those canceled operations settle.
    if (owner.abort.signal.aborted && !owner.opening && !owner.reading)
      this.sourceSlots.delete(owner);
  }

  private release(owner: Owner): void {
    if (owner.abort.signal.aborted) return;
    if (owner.timer !== undefined) clearTimeout(owner.timer);
    this.subscriberCount -= owner.subscribers.size;
    const subscribers = [...owner.subscribers];
    owner.subscribers.clear();
    this.owners.delete(owner.sessionId);
    owner.prepared = undefined;
    const source = owner.source;
    owner.source = undefined;
    // Abort listeners may immediately reconnect. Remove the old keyed owner
    // and account for its consumers before invoking any external cleanup.
    owner.abort.abort();
    for (const subscriber of subscribers) this.closeConsumer(subscriber);
    try {
      source?.close();
    } catch {
      // The lifetime is already aborted and all service references released.
      // One adapter's cleanup failure must not strand other session owners.
    }
    this.releaseSettledSlot(owner);
  }
}
