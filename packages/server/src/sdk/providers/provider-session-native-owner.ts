import type { NativeOwnerHost } from "./types.js";

/** Marks waiting for an acknowledgement; the oldest is dropped past this. */
const MAX_DELIVERY_MARKS = 64;

/**
 * A Provider Host worker's side of its provider's native session owner
 * (plan 195 step 9; Antigravity): the owner state the attached backend
 * copies and reads, the native store observation the backend forwards, and
 * when the backend had applied the output the provider yielded.
 */
export class WorkerNativeOwner {
  private owner: { snapshot(): unknown; read(query: unknown): unknown } | null =
    null;
  private readonly storeListeners = new Set<() => void>();
  private marks: Array<{ sequence: number; at?: number }> = [];

  constructor(
    /** Writes to the attached controller, if any. */
    private readonly emit: (message: unknown) => void,
    /** The last event sequence buffered for the controller. */
    private readonly sequence: () => number,
    /** The last sequence the controller acknowledged. */
    private readonly acknowledged: () => number,
  ) {}

  /** The channel the provider's owner publishes through and is read by. */
  host(): NativeOwnerHost {
    return {
      publish: (change) => this.emit({ type: "nativeOwner", value: change }),
      serve: (owner) => {
        this.owner = owner;
        this.emit({ type: "nativeOwner", value: owner.snapshot() });
      },
    };
  }

  /** Sent with every attach, so a replacement backend rebuilds its copy. */
  snapshot(): unknown {
    return this.owner?.snapshot();
  }

  /** The backend's read of the owner's view; null with no owner. */
  read(query: unknown): unknown {
    return this.owner?.read(query) ?? null;
  }

  observeStore(listener: () => void): () => void {
    this.storeListeners.add(listener);
    return () => this.storeListeners.delete(listener);
  }

  /** The backend saw the native store change (or attached and says so once). */
  storeChanged(): void {
    for (const listener of [...this.storeListeners]) listener();
  }

  /**
   * Marks every event yielded so far; the returned clock reports when the
   * attached backend had acknowledged all of them (applied them in Process,
   * whose replay buffer then held them), on this process's monotonic clock.
   * After a reload, events the old backend never acknowledged are applied
   * and acknowledged by its replacement, whose time is the one that counts.
   */
  markDelivery(): () => number | undefined {
    const mark: { sequence: number; at?: number } = {
      sequence: this.sequence(),
    };
    if (this.acknowledged() >= mark.sequence) mark.at = performance.now();
    else {
      this.marks.push(mark);
      if (this.marks.length > MAX_DELIVERY_MARKS) this.marks.shift();
    }
    return () => mark.at;
  }

  /** The controller acknowledged events through `sequence`. */
  acknowledge(sequence: number): void {
    if (!this.marks.length) return;
    const at = performance.now();
    this.marks = this.marks.filter((mark) => {
      if (mark.sequence > sequence) return true;
      mark.at = at;
      return false;
    });
  }
}
