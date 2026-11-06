import type { ProviderWorkItem } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderRetentionSnapshot } from "../../src/sdk/types.js";
import { sessionProviderPhaseFromProcess } from "../../src/sessions/session-provider-phase.js";
import { Supervisor } from "../../src/supervisor/Supervisor.js";
import { type BusEvent, EventBus } from "../../src/watcher/EventBus.js";
import {
  createControllableIterator,
  MessageQueue,
  waitFor,
} from "../process.test-support.js";
import { controlledProvider } from "../support/scripted-provider.js";

const instances: Supervisor[] = [];
afterEach(async () => {
  for (const s of instances.splice(0)) {
    s.stopBackgroundTasks();
    for (const p of s.getAllProcesses()) await p.abort();
  }
});

const testRun: ProviderWorkItem = {
  id: "task-1",
  kind: "shell",
  label: "pnpm test",
  source: "task_started",
};
const devServer: ProviderWorkItem = {
  id: "task-2",
  kind: "shell",
  label: "pnpm dev",
  source: "background_tasks_changed",
};
const reminder: ProviderWorkItem = {
  id: "cron-1",
  kind: "cron",
  label: "Check CI",
  source: "stop_hook.session_crons",
};

async function fixture() {
  let retention: ProviderRetentionSnapshot = { retained: false, reasons: [] };
  let changed: (() => void) | undefined;
  const c = createControllableIterator();
  const provider = controlledProvider({
    startSession: async (options) => {
      changed = options.onProviderRetentionChange;
      c.push({ type: "system", subtype: "init", session_id: "sess-phase" });
      return {
        iterator: c.iterator,
        queue: new MessageQueue(),
        abort: () => c.finish(),
        getProviderRetention: () => retention,
      };
    },
  });
  const eventBus = new EventBus();
  const events: BusEvent[] = [];
  eventBus.subscribe((event) => events.push(event));
  const s = new Supervisor({ provider, idleTimeoutMs: 60000, eventBus });
  instances.push(s);
  const process = await s.startSession("/tmp/test", { text: "hi" });
  if ("queued" in process || "error" in process) {
    throw new Error("expected a started process");
  }
  const count = (type: BusEvent["type"]) =>
    events.filter((event) => event.type === type).length;
  return {
    process,
    c,
    count,
    /** Change the provider snapshot without reporting it. */
    set(next: Partial<ProviderRetentionSnapshot>) {
      retention = { retained: false, reasons: [], ...next };
    },
    /** Change the provider snapshot; return the phase events it caused. */
    report(next: Partial<ProviderRetentionSnapshot>) {
      retention = { retained: false, reasons: [], ...next };
      const before = events.length;
      changed?.();
      return events
        .slice(before)
        .flatMap((event) =>
          event.type === "session-provider-phase-changed"
            ? [event.providerPhase]
            : [],
        );
    },
  };
}

describe("session provider phase", () => {
  it("publishes row-only phase changes through a turn and its background work", async () => {
    const f = await fixture();
    expect(sessionProviderPhaseFromProcess(f.process)).toEqual({
      phase: "generating",
    });

    // Foreground waits move the phase without touching row activity.
    const activityEvents = f.count("process-state-changed");
    expect(f.report({ foregroundWaits: [testRun] })).toEqual([
      { phase: "waiting", work: [testRun] },
    ]);
    expect(f.report({ foregroundWaits: [testRun] })).toEqual([]);
    expect(f.report({})).toEqual([{ phase: "generating" }]);
    expect(f.count("process-state-changed")).toBe(activityEvents);

    // The same wait in the next turn publishes again even when the provider
    // never reported the turn boundary: rows refetched on the transitions
    // and no longer show the earlier phase.
    f.report({ foregroundWaits: [testRun] });
    f.set({});
    f.c.push({ type: "result", session_id: "sess-phase" });
    await waitFor(() => expect(f.process.state.type).toBe("idle"));
    expect(f.process.queueMessage({ text: "again" }).success).toBe(true);
    await waitFor(() => expect(f.process.state.type).toBe("in-turn"));
    expect(f.report({ foregroundWaits: [testRun] })).toEqual([
      { phase: "waiting", work: [testRun] },
    ]);
    f.c.push({ type: "result", session_id: "sess-phase" });
    await waitFor(() => expect(f.process.state.type).toBe("idle"));

    // Retained background work holds the ended turn: row activity flips
    // once, and later work changes stay phase-only.
    const beforeRetained = f.count("process-state-changed");
    expect(
      f.report({
        retained: true,
        reasons: ["bg"],
        backgroundWork: [devServer],
      }),
    ).toEqual([{ phase: "background", work: [devServer] }]);
    expect(f.count("process-state-changed")).toBe(beforeRetained + 1);
    expect(
      f.report({
        retained: true,
        reasons: ["bg"],
        backgroundWork: [devServer, reminder],
      }),
    ).toEqual([{ phase: "background", work: [devServer, reminder] }]);
    expect(f.count("process-state-changed")).toBe(beforeRetained + 1);

    expect(f.report({})).toEqual([null]);
    expect(f.count("process-state-changed")).toBe(beforeRetained + 2);
    expect(sessionProviderPhaseFromProcess(f.process)).toBeUndefined();
  });
});
