import { RecoveryScheduler, type RecoveryPolicy } from "../RecoveryScheduler";
import { MockTimers } from "./ConnectionSimulator";

/**
 * A number waits that many milliseconds. `fail` and `succeed` settle a probe
 * in flight. `recover` is the owner connecting by any other route, and
 * `exhaust` is a recovered owner running out of its own retries again.
 */
export type RecoveryEvent =
  | number
  | "signal"
  | "hide"
  | "show"
  | RecoveryOwnerEvent;
export type RecoveryOwnerEvent = "fail" | "succeed" | "recover" | "exhaust";

/** Probe start times, in milliseconds since exhaustion, grouped by event. */
export type RecoveryTrace = number[][];

export function slowProbeMaxMs(policy: RecoveryPolicy): number {
  return policy.slowProbeMs * (1 + policy.slowProbeJitter);
}

/**
 * The smallest owner of a RecoveryScheduler: exhausted at time zero, probes
 * stay in flight until an event settles them or, for an owner that bounds its
 * probes, until that bound fails them. Every real owner must produce this
 * model's trace for the same events.
 */
export class RecoveryModel {
  readonly timers = new MockTimers();
  readonly probes: number[] = [];
  readonly violations: string[] = [];
  visible = true;
  inFlight = false;
  done = false;
  private timersSetThisEvent = 0;
  private readonly scheduler: RecoveryScheduler<number>;

  constructor(
    private readonly policy: RecoveryPolicy,
    private readonly probeTimeoutMs?: number,
  ) {
    this.scheduler = new RecoveryScheduler(() => this.probe(), {
      clock: {
        // A timer that keeps re-arming at the current instant would spin
        // MockTimers forever; fail instead.
        setTimeout: (fn, ms) => {
          if (++this.timersSetThisEvent > 1_000)
            throw new Error("recovery timers re-arm without advancing");
          return this.timers.setTimeout(fn, ms);
        },
        clearTimeout: (handle) => this.timers.clearTimeout(handle),
        now: () => this.timers.now(),
      },
      isVisible: () => this.visible,
      policy,
    });
    this.scheduler.arm();
  }

  get waiting(): boolean {
    return !this.inFlight && !this.done;
  }

  private probe(): void {
    const now = this.timers.now();
    const previous = this.probes.at(-1);
    if (!this.visible) this.violations.push(`probe while hidden at ${now}`);
    if (this.inFlight) this.violations.push(`overlapping probe at ${now}`);
    if (this.done) this.violations.push(`probe after success at ${now}`);
    if (previous !== undefined && now - previous < this.policy.cooldownMs)
      this.violations.push(`probes at ${previous} and ${now} inside cooldown`);
    this.probes.push(now);
    this.inFlight = true;
    if (this.probeTimeoutMs === undefined) return;
    const attempt = this.probes.length;
    this.timers.setTimeout(() => {
      if (this.inFlight && this.probes.length === attempt) this.settle("fail");
    }, this.probeTimeoutMs);
  }

  private settle(outcome: "fail" | "succeed"): void {
    this.inFlight = false;
    if (outcome === "fail") this.scheduler.arm();
    else {
      this.done = true;
      this.scheduler.disarm();
    }
  }

  apply(event: RecoveryEvent): number[] {
    const before = this.probes.length;
    this.timersSetThisEvent = 0;
    if (typeof event === "number") this.timers.advance(event);
    else if (event === "signal") this.scheduler.signal();
    else if (event === "hide" || event === "show") {
      this.visible = event === "show";
      this.scheduler.visibilityChanged();
    } else if (event === "recover") {
      if (!this.done) this.settle("succeed");
    } else if (event === "exhaust") {
      if (this.done) {
        this.done = false;
        this.scheduler.arm();
      }
    } else if (this.inFlight) this.settle(event);
    return this.probes.slice(before);
  }
}

export function runRecoveryModel(
  policy: RecoveryPolicy,
  events: readonly RecoveryEvent[],
  probeTimeoutMs?: number,
): { model: RecoveryModel; trace: RecoveryTrace } {
  const model = new RecoveryModel(policy, probeTimeoutMs);
  const trace = events.map((event) => model.apply(event));
  return { model, trace };
}

/**
 * Waits that land inside the cooldown, complete it, and reach the slow probe;
 * with jitter in play, one more reaches the jittered maximum.
 */
export function recoveryAlphabet(
  policies: readonly RecoveryPolicy[],
  jittered: boolean,
): RecoveryEvent[] {
  const waits = new Set<number>();
  for (const policy of policies) {
    waits.add(1_000);
    waits.add(policy.cooldownMs - 1_000);
    waits.add(policy.slowProbeMs);
    if (jittered && policy.slowProbeJitter > 0)
      waits.add(policy.slowProbeMs * policy.slowProbeJitter);
  }
  return [
    ...waits,
    "signal",
    "hide",
    "show",
    "fail",
    "succeed",
    "recover",
    "exhaust",
  ];
}

/**
 * Every event sequence of the given length. Sequences do not depend on a
 * policy, so one sequence can drive owners with different policies at once.
 * Only repeated hide or show is skipped; owner events that do not apply to
 * the current state stay in, since an owner must ignore them too.
 */
export function* recoverySequences(
  alphabet: readonly RecoveryEvent[],
  depth: number,
  prefix: RecoveryEvent[] = [],
  visible = true,
): Generator<RecoveryEvent[]> {
  if (prefix.length === depth) {
    yield prefix;
    return;
  }
  for (const event of alphabet) {
    if (event === (visible ? "show" : "hide")) continue;
    yield* recoverySequences(
      alphabet,
      depth,
      [...prefix, event],
      event === "hide" ? false : event === "show" ? true : visible,
    );
  }
}

/**
 * The recovery contract of topics/source-transport.md, checked at the state
 * one event sequence reaches. Returns violations; empty means it holds. It
 * replays the sequence, so the caller must pin Math.random.
 */
export function checkRecoveryContract(
  policy: RecoveryPolicy,
  events: readonly RecoveryEvent[],
): string[] {
  const { model } = runRecoveryModel(policy, events);
  const problems = [...model.violations];
  const slowMax = slowProbeMaxMs(policy);
  const probesAfter = (...continuation: RecoveryEvent[]) => {
    const next = runRecoveryModel(policy, [...events, ...continuation]);
    problems.push(...next.model.violations.slice(model.violations.length));
    return next.model.probes.length - model.probes.length;
  };
  if (model.visible && model.waiting) {
    if (probesAfter(slowMax) < 1)
      problems.push("visible wait has no slow probe");
    if (probesAfter("signal", policy.cooldownMs) < 1)
      problems.push("signal not honoured within the cooldown");
    return problems;
  }
  if (model.timers.pendingCount !== 0)
    problems.push("timer pending while hidden, probing or connected");
  // Hidden waiting sources resume on show; the others ignore everything.
  const quiet: RecoveryEvent[] = model.waiting
    ? ["signal", 2 * slowMax]
    : ["signal", "hide", "show", "signal", 2 * slowMax];
  if (probesAfter(...quiet) > 0)
    problems.push("probe while hidden, probing or connected");
  return problems;
}
