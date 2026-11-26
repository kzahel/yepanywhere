import {
  type RecoveryPolicy,
  RecoveryScheduler,
  type RecoveryTrigger,
} from "../RecoveryScheduler";
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

/**
 * The smallest owner of a RecoveryScheduler: exhausted at time zero, probes
 * stay in flight until an event settles them or, for an owner that bounds its
 * probes, until that bound fails them. Every real owner must produce this
 * model's trace for the same events.
 */
export class RecoveryModel {
  readonly timers = new MockTimers();
  readonly probes: number[] = [];
  readonly triggers: RecoveryTrigger[] = [];
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
    this.scheduler = new RecoveryScheduler((trigger) => this.probe(trigger), {
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

  private probe(trigger: RecoveryTrigger): void {
    const now = this.timers.now();
    const previous = this.probes.at(-1);
    if (!this.visible) this.violations.push(`probe while hidden at ${now}`);
    if (this.inFlight) this.violations.push(`overlapping probe at ${now}`);
    if (this.done) this.violations.push(`probe after success at ${now}`);
    if (previous !== undefined && now - previous < this.policy.cooldownMs)
      this.violations.push(`probes at ${previous} and ${now} inside cooldown`);
    this.probes.push(now);
    this.triggers.push(trigger);
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
      this.scheduler.reset();
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

/** Waits that land inside the cooldown, complete it, and reach the slow probe. */
export function recoveryAlphabet(policy: RecoveryPolicy): RecoveryEvent[] {
  return [
    1_000,
    policy.cooldownMs - 1_000,
    policy.slowProbeMs,
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
 * Every event sequence of the given length. Only repeated hide or show is
 * skipped; owner events that do not apply to the current state stay in, since
 * an owner must ignore them too.
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
 * one event sequence reaches. Returns violations; empty means it holds.
 */
export function checkRecoveryContract(
  policy: RecoveryPolicy,
  events: readonly RecoveryEvent[],
): string[] {
  const { model } = runRecoveryModel(policy, events);
  const problems = [...model.violations];
  const slowMax = policy.slowProbeMs;
  let first: { at: number; trigger?: string } | undefined;
  const probesAfter = (...continuation: RecoveryEvent[]) => {
    const next = runRecoveryModel(policy, [...events, ...continuation]);
    problems.push(...next.model.violations.slice(model.violations.length));
    const at = next.model.probes[model.probes.length];
    first =
      at === undefined
        ? undefined
        : { at, trigger: next.model.triggers[model.triggers.length] };
    return next.model.probes.length - model.probes.length;
  };
  if (model.visible && model.waiting) {
    const now = model.timers.now();
    if (probesAfter(slowMax) < 1)
      problems.push("visible wait has no slow probe");
    // An earlier signal can only still be pending inside the cooldown.
    else if (
      first &&
      first.at - now > policy.cooldownMs &&
      first.trigger !== "backstop"
    )
      problems.push("slow probe not reported as a backstop");
    if (probesAfter("signal", policy.cooldownMs) < 1)
      problems.push("signal not honoured within the cooldown");
    else if (first?.trigger !== "signal")
      problems.push("honoured signal not reported as a signal");
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
