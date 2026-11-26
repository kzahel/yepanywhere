import { observeRecoverySignals } from "./recoverySignals";

export interface RecoveryPolicy {
  /** Visible slow-probe interval once the owner's own retries are exhausted. */
  slowProbeMs: number;
  /**
   * Shorter waits before the first slow probes of an outage, for an owner
   * whose own retries end long before slowProbeMs. Each wait runs from the
   * failure before it; later waits are slowProbeMs.
   */
  rampMs?: readonly number[];
  /** Minimum spacing between probe starts, whatever triggered them. */
  cooldownMs: number;
}

/**
 * The policy every owner ends on. The slow probe is not jittered: it is the
 * only passive recovery left by then, and owners that failed together were
 * already spread by the retries that preceded it.
 */
export const RECOVERY_POLICY: RecoveryPolicy = {
  slowProbeMs: 60_000,
  cooldownMs: 5_000,
};

/**
 * A bundled native source. Native gives up about four seconds after a loss,
 * where the browser keeps backing off for three minutes, so the ramp carries
 * on at the browser's cadence: these waits land within a few seconds of its
 * fourth to tenth attempts. The first two also keep one host inside the
 * relay's six circuit opens a minute, counting native's own four.
 */
export const NATIVE_RECOVERY_POLICY: RecoveryPolicy = {
  ...RECOVERY_POLICY,
  rampMs: [10_000, 20_000, 30_000, 30_000, 30_000, 30_000, 30_000],
};

/**
 * Why a probe starts. A backstop is the slow probe's own timer, with nothing
 * to suggest the path changed; a signal is renewed demand or a network event.
 */
export type RecoveryTrigger = "backstop" | "signal";

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
 * The owner arms it while waiting and disarms it while retrying on its own,
 * terminally failed or disposed. Starting a probe disarms: the owner re-arms
 * when that attempt fails. An owner with a ramp resets it once the outage is
 * over. While armed and visible there is always a pending slow probe; while
 * hidden or disarmed there is no timer at all.
 */
export class RecoveryScheduler<Handle> {
  private armed = false;
  private slowProbe: Handle | undefined;
  private deferredSignal: Handle | undefined;
  private lastProbeAt = Number.NEGATIVE_INFINITY;
  /** Waits begun since the last reset: the next wait's place in the ramp. */
  private waits = 0;
  private waitMs: number;

  constructor(
    private readonly probe: (trigger: RecoveryTrigger) => void,
    private readonly options: RecoverySchedulerOptions<Handle>,
  ) {
    this.waitMs = options.policy.slowProbeMs;
  }

  get waiting(): boolean {
    return this.armed;
  }

  /** Re-arming an armed scheduler does not postpone its slow probe. */
  arm(): void {
    if (!this.armed) {
      const { rampMs, slowProbeMs } = this.options.policy;
      this.waitMs = rampMs?.[this.waits] ?? slowProbeMs;
      this.waits++;
    }
    this.armed = true;
    this.scheduleSlowProbe();
  }

  /** Stop waiting, keeping this outage's place in the ramp. */
  disarm(): void {
    this.armed = false;
    this.clearTimers();
  }

  /** The outage is over: the next one starts the ramp from its first wait. */
  reset(): void {
    this.disarm();
    this.waits = 0;
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
    this.request("signal");
  }

  private request(trigger: RecoveryTrigger): void {
    if (!this.armed || !this.options.isVisible()) return;
    const { clock, policy } = this.options;
    const remaining = policy.cooldownMs - (clock.now() - this.lastProbeAt);
    if (remaining > 0) {
      // Whole milliseconds: a fractional clock could otherwise fire this a
      // rounding error early and re-defer by a delay too small to advance it.
      this.deferredSignal ??= clock.setTimeout(() => {
        this.deferredSignal = undefined;
        this.request(trigger);
      }, Math.ceil(remaining));
      return;
    }
    this.disarm();
    this.lastProbeAt = clock.now();
    this.probe(trigger);
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
    this.slowProbe = this.options.clock.setTimeout(() => {
      this.slowProbe = undefined;
      this.request("backstop");
    }, this.waitMs);
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
