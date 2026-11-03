import { afterEach, describe, expect, it, vi } from "vitest";
import { Supervisor } from "../../src/supervisor/Supervisor.js";
import { getLogger } from "../../src/logging/logger.js";
import { controlledProvider } from "../support/scripted-provider.js";
import {
  createControllableIterator,
  MessageQueue,
  waitFor,
} from "../process.test-support.js";

const compact = {
  text: "/compact",
  tempId: "compact",
  queuedCompact: { command: "compact" as const, argument: "" },
};
const instances: Supervisor[] = [];
afterEach(async () => {
  for (const s of instances.splice(0)) {
    s.stopBackgroundTasks();
    for (const p of s.getAllProcesses()) await p.abort();
  }
  vi.restoreAllMocks();
});
async function fixture(retainedInitially = false) {
  let retained = retainedInitially;
  let changed: (() => void) | undefined;
  const runs: {
    c: ReturnType<typeof createControllableIterator>;
    queue: MessageQueue;
    compact: ReturnType<typeof vi.fn>;
  }[] = [];
  const provider = controlledProvider({
    startSession: async (options) => {
      const c = createControllableIterator();
      const queue = new MessageQueue();
      const native = vi.fn(async () => {
        c.push({
          type: "system",
          subtype: "compact_boundary",
          session_id: "existing",
        });
        c.push({ type: "result", session_id: "existing" });
        return { handled: true };
      });
      runs.push({ c, queue, compact: native });
      changed = options.onProviderRetentionChange;
      c.push({ type: "system", subtype: "init", session_id: "existing" });
      return {
        iterator: c.iterator,
        queue,
        abort: () => c.finish(),
        interrupt: async () => false,
        initialTurnState: "idle",
        runProviderCommand: native,
        getProviderRetention: () => ({ retained, reasons: [] }),
      };
    },
  });
  const s = new Supervisor({ provider, idleTimeoutMs: 60000 });
  instances.push(s);
  const p = await s.resumeSession("existing", "/tmp/test", { text: "INITIAL" });
  runs[0]!.queue.drain();
  return {
    s,
    p,
    runs,
    retain(value: boolean) {
      retained = value;
      changed?.();
    },
  };
}

describe("supervisor queued compact ownership", () => {
  it("waits for provider-retained work and wakes the same queue when retention clears", async () => {
    const f = await fixture(true);
    f.retain(true);
    f.p.deferMessage(compact);
    f.p.deferMessage({ text: "NEXT", tempId: "next" });
    f.runs[0]!.c.push({ type: "result", session_id: "existing" });
    await waitFor(() => expect(f.p.state.type).toBe("idle"));
    expect(f.runs[0]!.compact).not.toHaveBeenCalled();
    expect(f.p.getDeferredQueueSummary()).toHaveLength(2);
    f.retain(false);
    await waitFor(() => expect(f.runs[0]!.queue.depth).toBe(1));
    expect(f.runs[0]!.compact).toHaveBeenCalledOnce();
    expect(f.runs[0]!.queue.drain()[0]?.text).toBe("NEXT");
  });

  it("hard-abort recovery restores a pending compact before later messages without a launch prompt", async () => {
    const warn = vi
      .spyOn(getLogger(), "warn")
      .mockImplementation(() => undefined);
    const f = await fixture();
    f.p.deferMessage(compact);
    f.p.deferMessage({ text: "NEXT", tempId: "next" });
    expect(await f.s.interruptProcess(f.p.id)).toMatchObject({
      hardAborted: true,
    });
    await waitFor(() => expect(f.runs).toHaveLength(2));
    await waitFor(() => expect(f.runs[1]!.queue.depth).toBe(1));
    expect(f.runs[1]!.compact).toHaveBeenCalledOnce();
    expect(f.runs[1]!.queue.drain().map((m) => m.text)).toEqual(["NEXT"]);
    expect(f.s.getProcessForSession("existing")?.id).not.toBe(f.p.id);
    expect(
      warn.mock.calls.map(([fields]) => (fields as { event?: string }).event),
    ).toEqual(["session_interrupt_incomplete", "process_terminated"]);
  });
});
