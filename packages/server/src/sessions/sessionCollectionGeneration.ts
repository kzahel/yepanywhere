/**
 * A monotonic revision covering every input a global session collection reads.
 *
 * `GET /api/sessions` walks every project, lists every project's sessions, and
 * enriches each row from session metadata, notification read state and supervisor
 * state. A client that already holds the rows has no cheap way to ask "is any of that
 * different?", so every tab's every revalidation repeats the whole walk.
 *
 * This counter answers that question. It is deliberately *coarse*: one number
 * for the whole collection, bumped by any event that could change any rendered
 * row. `topics/session-catalog-observation.md` explains why the durable catalog
 * splits its generation into a per-shard vector instead — a per-project query
 * should not be invalidated by a write in another project. That reasoning does
 * not apply here, because the unfiltered global list genuinely depends on every
 * project; a `project=` filtered read is the case a future vector component
 * would serve, and it is left for measurement rather than added speculatively.
 *
 * **The event test is a deny-list on purpose.** Anything not proven unable to
 * change a row invalidates. A new `BusEvent` variant added later therefore
 * defaults to correct-but-conservative rather than silently serving stale rows,
 * which is the failure a conditional response makes invisible.
 */
import type { BusEvent, EventBus } from "../watcher/index.js";

/**
 * Events that cannot change any field of a global session row. Everything else
 * bumps the generation.
 *
 * Each entry is a claim to re-check when the row shape changes: these carry
 * connection, host, build, or aggregate-only facts, none of which
 * `GlobalSessionItem` renders.
 */
const NON_COLLECTION_EVENT_TYPES: ReadonlySet<BusEvent["type"]> = new Set([
  "source-change",
  "backend-reloaded",
  "safe-restart-changed",
  "network-binding-changed",
  "browser-tab-connected",
  "browser-tab-disconnected",
  "worker-activity-changed",
  "cache-miss-billing",
  "cache-miss-billing-expected-expiry",
  // Inbox computes the phase per request, outside the shared walk.
  "session-provider-phase-changed",
]);

export function busEventChangesSessionCollection(event: BusEvent): boolean {
  return !NON_COLLECTION_EVENT_TYPES.has(event.type);
}

/**
 * The collection's current revision, advanced by the event bus.
 *
 * Starts at 1 so that 0 is never a valid client token: a client that sends a
 * default-initialized generation must get a full response, not `no-change`.
 */
export class SessionCollectionGeneration {
  private generation = 1;
  private readonly unsubscribe: (() => void) | null;
  private observedControlVersion: number | undefined;
  private controlVersionObserved = false;

  constructor(
    eventBus?: EventBus,
    private readonly controlVersion?: () => number | undefined,
  ) {
    this.unsubscribe =
      eventBus?.subscribe((event) => {
        if (busEventChangesSessionCollection(event)) {
          this.generation += 1;
        }
      }) ?? null;
  }

  get current(): number {
    const next = this.controlVersion?.();
    if (!this.controlVersionObserved) {
      this.controlVersionObserved = true;
      this.observedControlVersion = next;
    } else if (next !== this.observedControlVersion) {
      this.observedControlVersion = next;
      this.generation += 1;
    }
    return this.generation;
  }

  /**
   * Whether a client holding `known` still holds the current collection.
   *
   * A non-finite, non-positive, or future value is never a match. A future
   * value means the server restarted and rewound its counter, so the client's
   * token refers to a generation this process never produced.
   */
  matches(known: number | undefined, captured = this.current): boolean {
    if (known === undefined || !Number.isInteger(known) || known <= 0) {
      return false;
    }
    return known === captured;
  }

  /** Advance the revision directly, for inputs that reach no bus event. */
  bump(): void {
    this.generation += 1;
  }

  dispose(): void {
    this.unsubscribe?.();
  }
}
