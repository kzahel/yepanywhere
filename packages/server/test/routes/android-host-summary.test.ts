import { controlledProvider } from "../support/scripted-provider.js";
import { describe, expect, it } from "vitest";
import { createAndroidHostSummaryRoutes } from "../../src/routes/android-host-summary.js";
import type { ProcessInfo } from "../../src/supervisor/types.js";
import { Supervisor } from "../../src/supervisor/Supervisor.js";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import { createControllableIterator } from "../process.test-support.js";
import { EventBus } from "../../src/watcher/EventBus.js";

function fixture() {
  const eventBus = new EventBus();
  let processes: ProcessInfo[] = [];
  const routes = createAndroidHostSummaryRoutes({
    eventBus,
    supervisor: { getProcessInfoList: () => processes },
  });
  return {
    routes,
    eventBus,
    change(states: ProcessInfo["state"][]) {
      processes = states.map(
        (state) =>
          ({
            state,
            sessionId: "private-id",
            projectPath: "/private/path",
          }) as ProcessInfo,
      );
      eventBus.emit({
        type: "session-status-changed",
        sessionId: "private-id",
        projectId: "private" as ProcessInfo["projectId"],
        ownership: { owner: "none" },
        timestamp: "now",
      });
    },
  };
}
const text = (value?: Uint8Array) => new TextDecoder().decode(value);

describe("Android foreground session summary", () => {
  it("seeds count-only state, follows actual activity and releases on disconnect", async () => {
    const f = fixture();
    f.change(["in-turn", "waiting-input", "idle", "terminated"]);
    const response = await f.routes.request("/summary");
    const reader = response.body!.getReader();
    expect(text((await reader.read()).value)).toBe(
      'data: {"working":1,"attention":1}\n\n',
    );
    expect(f.eventBus.subscriberCount).toBe(1);
    f.change(["idle"]);
    expect(text((await reader.read()).value)).toBe(
      'data: {"working":0,"attention":0}\n\n',
    );
    await reader.cancel();
    expect(f.eventBus.subscriberCount).toBe(0);
  });

  it("coalesces a slow consumer to the newest snapshot and bounds duplicate streams", async () => {
    const f = fixture();
    const streams = await Promise.all(
      Array.from({ length: 4 }, () => f.routes.request("/summary")),
    );
    expect((await f.routes.request("/summary")).status).toBe(429);
    f.change(["in-turn"]);
    await Promise.resolve();
    f.change(["waiting-input", "waiting-input"]);
    await Promise.resolve();
    const reader = streams[0]!.body!.getReader();
    expect(text((await reader.read()).value)).toContain(
      '"working":0,"attention":0',
    );
    expect(text((await reader.read()).value)).toContain(
      '"working":0,"attention":2',
    );
    await reader.cancel();
    await Promise.all(streams.slice(1).map((stream) => stream.body!.cancel()));
    expect(f.eventBus.subscriberCount).toBe(0);
    const next = await f.routes.request("/summary");
    expect(next.status).toBe(200);
    await next.body!.cancel();
  });
  it("follows a real supervisor through working, approval and termination", async () => {
    const eventBus = new EventBus();
    const controlled = createControllableIterator();
    controlled.push({
      type: "system",
      subtype: "init",
      session_id: "host-summary-fixture",
    });
    const supervisor = new Supervisor({
      eventBus,
      provider: controlledProvider({
        startSession: async () => ({
          iterator: controlled.iterator,
          queue: new MessageQueue(),
          abort: async () => controlled.finish(),
        }),
      }),
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const process = await supervisor.startSession(
        "/tmp/android-host-summary",
        { text: "Notification acceptance" },
      );
      if (!("id" in process)) throw new Error("Expected a live process");
      const routes = createAndroidHostSummaryRoutes({ supervisor, eventBus });
      const response = await routes.request("/summary");
      reader = response.body!.getReader();
      expect(text((await reader.read()).value)).toBe(
        'data: {"working":1,"attention":0}\n\n',
      );
      controlled.push({
        type: "system",
        subtype: "input_request",
        input_request: {
          id: "approval",
          type: "tool-approval",
          prompt: "Private prompt",
          toolName: "Bash",
        },
      });
      expect(text((await reader.read()).value)).toBe(
        'data: {"working":0,"attention":1}\n\n',
      );
      await supervisor.abortProcess(process.id);
      expect(text((await reader.read()).value)).toBe(
        'data: {"working":0,"attention":0}\n\n',
      );
    } finally {
      await reader?.cancel();
      for (const process of supervisor.getAllProcesses())
        await supervisor.abortProcess(process.id);
      await supervisor.stopBackgroundTasks();
    }
  });
});
