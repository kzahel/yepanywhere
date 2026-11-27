import type { ProviderCatalogFamily } from "../sessions/provider-catalog-family.js";

/** Only the first inventory joins eligible watchers. Expiry releases the scan
 * without certifying coverage; capture still reads the exact root's epoch. */
export class ProjectWatchStartup {
  private readonly pending: Set<ProviderCatalogFamily>;
  private release?: () => void;
  private waiting?: Promise<void>;
  private deadline?: NodeJS.Timeout;
  private listening = false;

  constructor(eligible: readonly ProviderCatalogFamily[]) {
    this.pending = new Set(
      eligible.filter((f) => f === "claude" || f === "codex" || f === "gemini"),
    );
  }

  wait(signal?: AbortSignal): Promise<void> | undefined {
    signal?.throwIfAborted();
    if (!this.pending.size) return;
    this.waiting ??= new Promise<void>((resolve, reject) => {
      const onAbort = () => this.finish();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.release = () => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) reject(signal.reason);
        else resolve();
      };
      this.armDeadline();
    });
    return this.waiting;
  }

  /** A slow runtime reattach before listen must not consume the baseline budget. */
  listenerReady(): boolean {
    if (this.listening) return false;
    this.listening = true;
    if (!this.release) return false;
    this.armDeadline();
    return true;
  }

  private armDeadline(): void {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(
      () => this.finish(),
      this.listening ? 2000 : 5000,
    );
    this.deadline.unref();
  }

  attempted(family: ProviderCatalogFamily, baseline?: Promise<unknown>): void {
    if (!this.pending.has(family)) return;
    const settled = () => {
      this.pending.delete(family);
      if (!this.pending.size) this.finish();
    };
    if (baseline) void baseline.then(settled, settled);
    else settled();
  }

  finish(): void {
    this.pending.clear();
    clearTimeout(this.deadline);
    this.release?.();
    this.release = undefined;
  }
}
