import { controlledProvider } from "../support/scripted-provider.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockServerClaudeProvider } from "../../src/sdk/mock.js";
import { ScriptedClaudeProvider } from "../support/scripted-provider.js";
import { Supervisor } from "../../src/supervisor/Supervisor.js";

let supervisor: Supervisor | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await supervisor?.stopBackgroundTasks();
  supervisor = undefined;
  vi.useRealTimers();
});

describe("Supervisor background ownership", () => {
  it("releases maintenance timers and ignores later schedule announcements", async () => {
    supervisor = new Supervisor({
      provider: new ScriptedClaudeProvider(),
    });
    await vi.advanceTimersByTimeAsync(30000);
    await supervisor.stopBackgroundTasks();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the live provider owned when maintenance work stops", async () => {
    supervisor = new Supervisor({
      provider: controlledProvider(new MockServerClaudeProvider()),
    });
    const started = await supervisor.startSession("/tmp/owned", {
      text: "live turn",
    });
    if (!("id" in started)) throw new Error("Expected a live process");
    const abort = vi.spyOn(started, "abort");
    await supervisor.stopBackgroundTasks();
    expect(supervisor.getProcessForSession(started.sessionId)).toBe(started);
    expect(abort).not.toHaveBeenCalled();
    vi.useRealTimers();
    await supervisor.abortProcess(started.id);
  });

  it("does not leave maintenance timers behind when construction is rejected", () => {
    expect(() => new Supervisor({})).toThrow("must be provided");
    expect(vi.getTimerCount()).toBe(0);
  });
});
