import type { StartSessionOptions } from "./types.js";

/**
 * Hono's side of a Provider Host worker's native session owner (plan 195
 * step 9; Antigravity). This backend's copy of the owner (that it holds its
 * conversation, the IDs it retired, its release) is rebuilt from the
 * snapshot every attach carries and then follows the worker's changes,
 * through `StartSessionOptions.hostedNativeOwner`; reads of the owner's
 * window ask the worker. The native store observation the worker's
 * provider needs is this backend's, forwarded, with one notice on attach
 * for changes made while no backend was attached. A retention read the
 * worker's provider settles evidence on is passed on to the worker too.
 */
export class HostedNativeOwnerSync {
  private unobserveStore: (() => void) | undefined;
  private retentionRead: Promise<unknown> | undefined;

  constructor(
    private readonly options: StartSessionOptions,
    private readonly rpc: (
      method: string,
      args?: unknown[],
    ) => Promise<unknown>,
    private readonly send: (message: unknown) => void,
    /** The connection is done or being handed to a replacement. */
    private readonly closed: () => boolean,
  ) {}

  /** A snapshot or change the worker published (undefined: none yet). */
  observe(publication: unknown): void {
    const link = this.options.hostedNativeOwner;
    if (!link || publication === undefined) return;
    const native = link.update(publication, (query) =>
      this.rpc("readNativeOwner", [query]),
    );
    if (!native || this.unobserveStore) return;
    const notify = () => {
      if (this.closed()) return;
      try {
        this.send({ type: "nativeStoreChanged" });
      } catch {
        // The connection's own close reports the loss.
      }
    };
    this.unobserveStore =
      this.options.observeAntigravitySummaries?.(native.scope, notify) ??
      (() => {});
    notify();
  }

  /**
   * The connection ended: the worker exited, or this backend handed it to
   * its replacement on reload (the conversation stays held until it exits).
   */
  end(reason: "exited" | "detached"): void {
    this.unobserveStore?.();
    this.unobserveStore = () => {};
    this.options.hostedNativeOwner?.end(reason);
  }

  /**
   * Passes a retention read on to the worker, one at a time, when its
   * provider settles evidence on a read; a change it finds arrives as a
   * retention notice.
   */
  readRetention(reconciles: boolean | undefined): void {
    if (!reconciles || this.retentionRead || this.closed()) return;
    this.retentionRead = this.rpc("readProviderRetention")
      .catch(() => undefined)
      .finally(() => {
        this.retentionRead = undefined;
      });
  }
}
