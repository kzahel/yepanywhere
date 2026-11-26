import { observeRecoverySignals } from "./recoverySignals";

export interface RecoveryPolicy {
  /** Visible slow-probe interval once the owner's own retries are exhausted. */
  slowProbeMs: number;
  /** Minimum spacing between probe starts, whatever triggered them. */
  cooldownMs: number;
}

/**
 * One policy for every owner. The slow probe is not jittered: it is the only
 * passive recovery left by then, and owners that failed together were already
 * spread by the retries that preceded it.
 */
export const RECOVERY_POLICY: RecoveryPolicy = {
  slowProbeMs: 60_000,
  cooldownMs: 5_000,
};

export interface RecoveryClock<Handle> {
  setTimeout(fn: () => void, ms: number): Handle;
  clearTimeout(handle: Handle): void;
  now(): number;
}

export const realRecoveryClock: RecoveryClock<ReturnType<typeof setTimeout>> = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  now: () => Date.now(),
};

export interface RecoverySchedulerOptions<Handle> {
  clock: RecoveryClock<Handle>;
  isVisible: () => boolean;
  policy: RecoveryPolicy;
}

/**
 * Decides when a source that has exhausted its own retries probes again.
 *
 * The owner arms it while waiting and disarms it when connected, retrying on
 * its own, terminally failed or disposed. Starting a probe disarms: the owner
 * re-arms when that attempt fails. While armed and visible there is always a
 * pending slow probe; while hidden or disarmed there is no timer at all.
 */
export class RecoveryScheduler<Handle> {
  private armed = false;
  private slowProbe: Handle | undefined;
  private deferredSignal: Handle | undefined;
  private lastProbeAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly probe: () => void,
    private readonly options: RecoverySchedulerOptions<Handle>,
  ) {}

  get waiting(): boolean {
    return this.armed;
  }

  /** Re-arming an armed scheduler does not postpone its slow probe. */
  arm(): void {
    this.armed = true;
    this.scheduleSlowProbe();
  }

  disarm(): void {
    this.armed = false;
    this.clearTimers();
  }

  /** An attempt the owner started itself still counts toward the cooldown. */
  recordProbe(): void {
    this.lastProbeAt = this.options.clock.now();
  }

  /**
   * A recovery opportunity, not proof of reachability. Inside the cooldown it
   * keeps one attempt for the cooldown's end rather than being lost until the
   * slow probe.
   */
  signal(): void {
    if (!this.armed || !this.options.isVisible()) return;
    const { clock, policy } = this.options;
    const remaining = policy.cooldownMs - (clock.now() - this.lastProbeAt);
    if (remaining > 0) {
      // Whole milliseconds: a fractional clock could otherwise fire this a
      // rounding error early and re-defer by a delay too small to advance it.
      this.deferredSignal ??= clock.setTimeout(() => {
        this.deferredSignal = undefined;
        this.signal();
      }, Math.ceil(remaining));
      return;
    }
    this.disarm();
    this.lastProbeAt = clock.now();
    this.probe();
  }

  /** Call after the visibility reported by isVisible has changed. */
  visibilityChanged(): void {
    if (!this.armed) return;
    if (!this.options.isVisible()) {
      this.clearTimers();
      return;
    }
    this.scheduleSlowProbe();
    this.signal();
  }

  private scheduleSlowProbe(): void {
    if (this.slowProbe !== undefined || !this.options.isVisible()) return;
    const { clock, policy } = this.options;
    this.slowProbe = clock.setTimeout(() => {
      this.slowProbe = undefined;
      this.signal();
    }, policy.slowProbeMs);
  }

  private clearTimers(): void {
    const { clock } = this.options;
    if (this.slowProbe !== undefined) clock.clearTimeout(this.slowProbe);
    if (this.deferredSignal !== undefined)
      clock.clearTimeout(this.deferredSignal);
    this.slowProbe = undefined;
    this.deferredSignal = undefined;
  }
}

/** Feed a scheduler from the page: visibility plus renewed-demand signals. */
export function observePageRecovery(
  scheduler: Pick<RecoveryScheduler<unknown>, "signal" | "visibilityChanged">,
  includeInteraction = true,
): () => void {
  if (typeof document === "undefined") return () => {};
  const visibility = () => scheduler.visibilityChanged();
  const stopSignals = observeRecoverySignals(
    () => scheduler.signal(),
    includeInteraction,
  );
  document.addEventListener("visibilitychange", visibility);
  return () => {
    stopSignals();
    document.removeEventListener("visibilitychange", visibility);
  };
}
