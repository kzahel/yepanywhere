/**
 * Recovery conformance: every owner of exhausted-retry recovery behaves as
 * the shared RecoveryScheduler does, and that scheduler keeps the contract in
 * topics/source-transport.md, over every event sequence up to a depth.
 *
 * The default depths keep this in ordinary unit runs. For an exhaustive run:
 *
 *   YA_RECOVERY_CONFORMANCE_DEPTH=5 pnpm --filter @yep-anywhere/client \
 *     exec vitest run recoveryConformance
 *
 * Each added level multiplies the owner replay by about ten.
 */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useResumeRecovery } from "../../../hooks/useResumeRecovery";
import { NativeSourceTransport } from "../../transport/NativeSourceTransport";
import { NativeTransportFixture } from "../../transport/__tests__/nativeTransportFixture";
import { ConnectionManager } from "../ConnectionManager";
import { RECOVERY_POLICY, RecoveryScheduler } from "../RecoveryScheduler";
import {
  type RecoveryEvent,
  type RecoveryOwnerEvent,
  checkRecoveryContract,
  recoveryAlphabet,
  recoverySequences,
  runRecoveryModel,
} from "./recoveryConformance";

const requestedDepth = Number(process.env.YA_RECOVERY_CONFORMANCE_DEPTH) || 0;
const MODEL_DEPTH = requestedDepth || 5;
const OWNER_DEPTH = requestedDepth || 3;
// Measured 2026-11-26 on a 14-core Mac. Default depths: under 0.1 s for the
// model and about 0.3 s for the owners. Depth 5: 21 s for the owner replay of
// 59,049 sequences.
const TIMEOUT_MS = requestedDepth ? 60 * 60_000 : 30_000;

/** Paths the default owner depth is too short to reach. */
const DEEPER_SEQUENCES: RecoveryEvent[][] = [
  // A signal inside the cooldown is kept for its end.
  ["signal", "fail", 1_000, "signal", 4_000, "fail", 60_000],
  // Hiding drops that deferred signal; showing probes again.
  ["signal", "fail", "signal", "hide", 60_000, "show", "fail", 60_000],
  // A probe left in flight resumes only when its owner gives up on it.
  [60_000, "hide", "show", "signal", 60_000, 60_000, "succeed", 60_000],
  // A second outage keeps the cooldown of the probe that ended the first.
  ["signal", "succeed", 1_000, "exhaust", "signal", 4_000, "recover", 60_000],
];

// Fake timers replace setImmediate; a real macrotask boundary lets every
// promise chain an event started finish without moving the fake clock.
const realSetImmediate = setImmediate;
const drain = () => new Promise<void>((resolve) => realSetImmediate(resolve));

interface Owner {
  name: string;
  /** How long the owner itself lets a probe stay in flight, if it bounds it. */
  probeTimeoutMs?: number;
  probes: number[];
  /** Apply an owner event, or ignore it where the model would. */
  apply(event: RecoveryOwnerEvent): Promise<void> | void;
  afterEvent?(): void;
  dispose(): void;
  /** Probes observed where the owner hands them off, when that differs. */
  delivered?(): number;
  /** Whether the owner still reports itself as not recovered. */
  recovering?(): boolean;
  /** Timers the owner holds for anything other than recovery. */
  restTimers(): number;
}

function managerOwner(now: () => number): Owner {
  const probes: number[] = [];
  let pending: { resolve(): void; reject(error: Error): void } | undefined;
  // No rapid attempts: the first close already exhausts the budget. Its
  // backoff jitter stays at the default, which must not reach the slow probe.
  const manager = new ConnectionManager({ maxAttempts: 0 });
  manager.start(() => {
    probes.push(now());
    return new Promise<void>((resolve, reject) => {
      pending = { resolve, reject };
    });
  });
  manager.handleClose();
  return {
    name: "ConnectionManager",
    probes,
    apply(event) {
      const attempt = pending;
      if (event === "exhaust") {
        if (manager.state === "connected") manager.handleClose();
      } else if (event === "recover") {
        pending = undefined;
        // As when a request reconnects the socket outside the manager.
        if (manager.state !== "connected") manager.markConnected();
      } else if (attempt) {
        pending = undefined;
        if (event === "fail") attempt.reject(new Error("offline"));
        else attempt.resolve();
      }
    },
    dispose: () => manager.stop(),
    recovering: () =>
      manager.waitingForRecovery || manager.state !== "connected",
    // Its stale-connection check.
    restTimers: () => 1,
  };
}

async function nativeOwner(now: () => number): Promise<Owner> {
  const host = new NativeTransportFixture(true, "CONNECTED");
  const transport = new NativeSourceTransport(host.channel);
  for (let turn = 0; turn < 50; turn++) {
    if (transport.status.getSnapshot().state === "ready") break;
    await drain();
  }
  expect(transport.status.getSnapshot().state).toBe("ready");
  const probes: number[] = [];
  const reconnect = transport.reconnect.bind(transport);
  let pending:
    | { resolve(value: unknown): void; reject(error: Error): void }
    | undefined;
  transport.reconnect = () => {
    probes.push(now());
    const attempt = reconnect();
    // The bridge can give up on a probe before the test settles it.
    attempt.catch(() => {
      pending = undefined;
    });
    return attempt;
  };
  host.handler = (command) =>
    command.method === "reconnect"
      ? new Promise((resolve, reject) => {
          pending = { resolve, reject };
        })
      : {};
  const exhausted = { type: "state", phase: "FAILED", recoverable: true };
  await host.emit(exhausted);
  return {
    name: "NativeSourceTransport",
    // NativeTransportBridge abandons a command without a reply.
    probeTimeoutMs: 30_000,
    probes,
    async apply(event) {
      const attempt = pending;
      const ready = transport.status.getSnapshot().state === "ready";
      if (event === "exhaust") {
        if (ready) await host.emit(exhausted);
      } else if (event === "recover") {
        if (ready) return;
        pending = undefined;
        // As when native reconnects on its own network callback.
        await host.emit({ type: "state", phase: "CONNECTED" });
        attempt?.resolve({});
      } else if (attempt) {
        pending = undefined;
        if (event === "fail") {
          await host.emit(exhausted);
          attempt.reject(new Error("offline"));
        } else {
          await host.emit({ type: "state", phase: "CONNECTED" });
          attempt.resolve({});
        }
      }
    },
    dispose: () => transport.dispose(),
    delivered: () =>
      host.commands.filter((command) => command.method === "reconnect").length,
    recovering: () => transport.status.getSnapshot().state !== "ready",
    // The bridge's bound on a probe awaiting its reply.
    restTimers: () => (pending ? 1 : 0),
  };
}

function acquisitionOwner(now: () => number): Owner {
  const probes: number[] = [];
  let attempting = false;
  let acquired = false;
  let enabled = true;
  const view = renderHook(
    (props: { enabled: boolean }) =>
      useResumeRecovery(props.enabled, () => {
        probes.push(now());
        attempting = true;
      }),
    { initialProps: { enabled } },
  );
  const enable = (next: boolean) => {
    if (next === enabled) return;
    enabled = next;
    view.rerender({ enabled });
  };
  return {
    name: "useResumeRecovery",
    probes,
    // Its callers disable the hook for the duration of an attempt.
    afterEvent: () => {
      if (attempting) enable(false);
    },
    apply(event) {
      if (event === "exhaust") {
        if (acquired) enable(true);
        acquired = false;
      } else if (event === "recover") {
        if (!acquired) enable(false);
        attempting = false;
        acquired = true;
      } else if (attempting) {
        attempting = false;
        acquired = event === "succeed";
        if (event === "fail") enable(true);
      }
    },
    dispose: () => view.unmount(),
    restTimers: () => 0,
  };
}

/** Drive all three owners through one page and return any divergence. */
async function divergence(
  events: readonly RecoveryEvent[],
  hidden: { mockReturnValue(value: boolean): unknown },
): Promise<string | undefined> {
  hidden.mockReturnValue(false);
  const start = Date.now();
  const now = () => Date.now() - start;
  const owners = [
    managerOwner(now),
    await nativeOwner(now),
    acquisitionOwner(now),
  ];
  const traces = owners.map((): number[][] => []);
  let problem: string | undefined;
  let isHidden = false;
  for (const event of events) {
    const before = owners.map((owner) => owner.probes.length);
    if (typeof event === "number") await vi.advanceTimersByTimeAsync(event);
    else if (event === "signal") window.dispatchEvent(new Event("online"));
    else if (event === "hide" || event === "show") {
      isHidden = event === "hide";
      hidden.mockReturnValue(isHidden);
      document.dispatchEvent(new Event("visibilitychange"));
    } else for (const owner of owners) await owner.apply(event);
    await drain();
    for (const owner of owners) owner.afterEvent?.();
    owners.forEach((owner, index) => {
      traces[index]?.push(owner.probes.slice(before[index]));
    });
    const atRest = owners.reduce((sum, owner) => sum + owner.restTimers(), 0);
    if (isHidden && vi.getTimerCount() !== atRest)
      problem ??= `${vi.getTimerCount()} timers while hidden, ${atRest} unrelated to recovery`;
  }
  owners.forEach((owner, index) => {
    const { model, trace } = runRecoveryModel(
      RECOVERY_POLICY,
      events,
      owner.probeTimeoutMs,
    );
    const expected = JSON.stringify(trace);
    const actual = JSON.stringify(traces[index]);
    if (actual !== expected)
      problem ??= `${owner.name} probed ${actual}, the scheduler ${expected}`;
    const recovering = owner.recovering?.();
    if (recovering !== undefined && recovering === model.done)
      problem ??= `${owner.name} recovering=${recovering}, the scheduler done=${model.done}`;
    const delivered = owner.delivered?.();
    if (delivered !== undefined && delivered !== owner.probes.length)
      problem ??= `${owner.name} delivered ${delivered} of ${owner.probes.length} probes`;
  });
  for (const owner of owners) owner.dispose();
  await drain();
  if (vi.getTimerCount() !== 0)
    problem ??= `${vi.getTimerCount()} timers left after disposal`;
  // An exhaustive run replays hundreds of thousands of sequences in one test:
  // drop rendered containers and the spies' call records as it goes.
  cleanup();
  vi.clearAllMocks();
  return problem;
}

describe("recovery conformance", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("defers by whole milliseconds so a fractional clock always advances", () => {
    let now = 0.25;
    const delays: number[] = [];
    const scheduler = new RecoveryScheduler(() => {}, {
      clock: {
        now: () => now,
        setTimeout: (_fn, ms) => delays.push(ms),
        clearTimeout: () => {},
      },
      isVisible: () => true,
      policy: RECOVERY_POLICY,
    });
    scheduler.arm();
    expect(delays).toEqual([RECOVERY_POLICY.slowProbeMs]);
    scheduler.signal();
    scheduler.arm();
    now += RECOVERY_POLICY.cooldownMs - 1e-7;
    scheduler.signal();
    // A sub-millisecond delay can round to no delay at all, and the deferred
    // signal would then re-arm itself at the same instant forever.
    expect(delays.at(-1)).toBe(1);
  });

  const alphabet = recoveryAlphabet(RECOVERY_POLICY);

  it(
    `the scheduler keeps the recovery contract to depth ${MODEL_DEPTH}`,
    () => {
      for (let depth = 0; depth <= MODEL_DEPTH; depth++)
        for (const events of recoverySequences(alphabet, depth)) {
          const problems = checkRecoveryContract(RECOVERY_POLICY, events);
          if (problems.length > 0)
            throw new Error(`[${events.join(", ")}]: ${problems.join("; ")}`);
        }
    },
    TIMEOUT_MS,
  );

  it(
    `every owner follows the shared scheduler to depth ${OWNER_DEPTH}`,
    async () => {
      vi.useFakeTimers();
      const hidden = vi.spyOn(document, "hidden", "get");
      const check = async (events: RecoveryEvent[]) => {
        const problem = await divergence(events, hidden);
        if (problem) throw new Error(`[${events.join(", ")}]: ${problem}`);
      };
      for (const events of DEEPER_SEQUENCES) await check(events);
      for (const events of recoverySequences(alphabet, OWNER_DEPTH))
        await check(events);
    },
    TIMEOUT_MS,
  );
});
