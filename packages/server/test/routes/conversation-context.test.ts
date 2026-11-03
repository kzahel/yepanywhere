import { describe, expect, it, vi } from "vitest";
import { createConversationContextRoutes } from "../../src/routes/conversation-context.js";
import {
  Process,
  MessageQueue,
  createControllableIterator,
  toUrlProjectId,
} from "../process.test-support.js";

describe("conversation context delivery", () => {
  it("waits for resumed provider initialization before accepting context", async () => {
    vi.useFakeTimers();
    const controller = createControllableIterator();
    const append = vi.fn(async () => true);
    const process = new Process(controller.iterator, {
      queue: new MessageQueue(),
      projectPath: "/project",
      projectId: toUrlProjectId("project"),
      sessionId: "parent",
      initialState: "idle",
      appendConversationContextFn: append,
      abortFn: () => controller.finish(),
    });
    const routes = createConversationContextRoutes({
      supervisor: { getProcessForSession: () => process },
    });
    const submit = () =>
      routes.request(
        `/${process.projectId}/sessions/parent/conversation-context`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: "save-once",
            turns: [{ role: "user", text: "Saved question" }],
          }),
        },
      );
    try {
      const pending = submit();
      await vi.advanceTimersByTimeAsync(6000);
      expect(append).not.toHaveBeenCalled();
      controller.push({
        type: "system",
        subtype: "init",
        session_id: "parent",
      });
      expect((await pending).status).toBe(200);
      expect((await submit()).status).toBe(200);
      expect(append).toHaveBeenCalledTimes(1);
    } finally {
      await process.abort();
      vi.useRealTimers();
    }
  });

  it.each([true, false])(
    "delivers generic ordered turns once through a live process (native %s)",
    async (native) => {
      const controller = createControllableIterator();
      const queue = new MessageQueue();
      const append = vi.fn(async () => native);
      const process = new Process(controller.iterator, {
        projectPath: "/project",
        projectId: toUrlProjectId("project"),
        sessionId: "parent",
        initializedSessionId: "parent",
        initialState: "idle",
        queue,
        appendConversationContextFn: append,
        abortFn: () => controller.finish(),
      });
      const routes = createConversationContextRoutes({
        supervisor: {
          getProcessForSession: (id) => (id === "parent" ? process : undefined),
        },
      });
      const turns = [
        { role: "assistant", text: "First.\n" },
        { role: "user", text: "  Second." },
      ];
      const request = (
        body: unknown,
        path = `/${process.projectId}/sessions/parent/conversation-context`,
      ) =>
        routes.request(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      try {
        const responses = await Promise.all([
          request({ requestId: "same", turns }),
          request({ requestId: "same", turns }),
        ]);
        for (const response of responses) {
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({
            delivery: native ? "native-history" : "user-turn",
          });
        }
        expect(append).toHaveBeenCalledTimes(1);
        expect(append).toHaveBeenCalledWith(turns);
        expect(queue.depth).toBe(native ? 0 : 1);
        expect(
          (
            await request({
              requestId: "same",
              turns: [{ role: "user", text: "different" }],
            })
          ).status,
        ).toBe(409);
        expect(
          (
            await request({
              requestId: "bad",
              turns: [{ role: "system", text: "wrong role" }],
            })
          ).status,
        ).toBe(400);
        expect(
          (
            await request(
              { requestId: "other", turns },
              "/other/sessions/parent/conversation-context",
            )
          ).status,
        ).toBe(409);
        expect(append).toHaveBeenCalledTimes(1);
        append.mockRejectedValue(new Error("Acceptance unknown"));
        for (let attempt = 0; attempt < 2; attempt += 1) {
          expect(
            (await request({ requestId: "uncertain", turns })).status,
          ).toBe(502);
        }
        expect(append).toHaveBeenCalledTimes(2);
        expect(queue.depth).toBe(native ? 0 : 1);
      } finally {
        await process.abort();
      }
    },
  );
});
