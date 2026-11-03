import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Process,
  MessageQueue,
  createControllableIterator,
  waitFor,
  withSessionQueuePersistence,
  type UrlProjectId,
} from "./process.test-support.js";

const compact = (id = "compact") => ({
  text: "/compact preserve decisions",
  tempId: id,
  queuedCompact: {
    command: "compact" as const,
    argument: "preserve decisions",
  },
  metadata: { deliveryIntent: "deferred" as const },
});
const controllers: ReturnType<typeof createControllableIterator>[] = [];
afterEach(() => {
  for (const c of controllers.splice(0)) c.finish();
  vi.useRealTimers();
});
function fixture(native: boolean, extra: Record<string, unknown> = {}) {
  const c = createControllableIterator();
  controllers.push(c);
  const queue = new MessageQueue();
  const run = vi.fn(async () => ({ handled: native }));
  const p = new Process(c.iterator, {
    projectPath: "/test",
    projectId: "project" as UrlProjectId,
    sessionId: "session",
    provider: native ? "codex" : "claude",
    queue,
    runProviderCommandFn: run,
    idleTimeoutMs: 60_000,
    ...extra,
  });
  const emit = async (message: Record<string, unknown>) => {
    let resolve!: () => void;
    const seen = new Promise<void>((r) => {
      resolve = r;
    });
    const off = p.subscribe((e) => {
      if (e.type === "message" && e.message.marker === message.marker)
        resolve();
    });
    c.push({ ...message, session_id: "session" });
    await seen;
    off();
    await Promise.resolve();
  };
  let marker = 0;
  return {
    p,
    queue,
    run,
    event: (m: Record<string, unknown>) => emit({ ...m, marker: ++marker }),
  };
}

describe("queued compaction boundary", () => {
  it.each([true, false])(
    "holds later messages until boundary AND terminal result (native=%s)",
    async (native) => {
      const f = fixture(native, {
        deferredDelivery: { joinWindowSeconds: 100 },
      });
      f.p.deferMessage(compact());
      f.p.deferMessage({ text: "FOLLOW_UP", tempId: "follow" });
      expect(f.run).not.toHaveBeenCalled();
      await f.event({ type: "result" }); // previous ordinary turn ends
      await waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(f.p.getDeferredQueueSummary()[0]).toMatchObject({
          operation: "compact",
          cancellable: false,
        }),
      );
      if (!native) {
        await waitFor(() => expect(f.queue.depth).toBe(1));
        expect([
          (await f.queue[Symbol.asyncIterator]().next()).value,
        ]).toMatchObject([
          { type: "user", message: { content: "/compact preserve decisions" } },
        ]);
      }
      expect(f.p.cancelDeferredMessage("compact")).toBe(false);
      f.p.queueMessage({ text: "ARRIVED_DURING_COMPACT", tempId: "during" });
      expect(f.queue.depth).toBe(0);
      await f.event({ type: "system", subtype: "compact_boundary" });
      expect(f.queue.depth).toBe(0);
      expect(f.p.getDeferredQueueSummary()).toHaveLength(3);
      await f.event({ type: "result" });
      await waitFor(() => expect(f.queue.depth).toBe(1));
      // Join mode may join ordinary messages, but never the compact command.
      const turn = f.queue.drain()[0]!;
      expect(turn.text).toContain("FOLLOW_UP");
      expect(turn.text).toContain("ARRIVED_DURING_COMPACT");
      expect(turn.text).not.toContain("/compact");
      expect(f.run).toHaveBeenCalledWith("compact", "preserve decisions");
      expect(f.p.getDeferredQueueSummary()).toHaveLength(0);
    },
  );

  it("holds failures until explicit cancellation and never steers a compact", async () => {
    const f = fixture(true);
    f.p.deferMessage(compact());
    f.p.deferMessage({
      text: "NEXT",
      metadata: { deliveryIntent: "patient" },
      tempId: "next",
    });
    await f.event({ type: "result" });
    await waitFor(() => expect(f.run).toHaveBeenCalledOnce());
    await f.event({ type: "error", error: "compact refused" });
    expect(f.p.cancelDeferredMessage("compact")).toBe(false);
    await f.event({ type: "result" });
    expect(f.queue.depth).toBe(0);
    expect(f.p.getDeferredQueueSummary()[0]).toMatchObject({
      operation: "compact",
      cancellable: true,
      compactionGate: { state: "failed", reason: "compact refused" },
    });
    expect(f.p.steerPatientDeferredMessagesThrough("next").success).toBe(false);
    expect(f.p.cancelDeferredMessage("compact")).toBe(true);
    await waitFor(() => expect(f.queue.depth).toBe(1));
    expect(f.queue.drain()[0]?.text).toBe("NEXT");
  });

  it("cancels a pending compact without dispatching or changing earlier work", async () => {
    const f = fixture(true);
    f.p.deferMessage({ text: "BEFORE", tempId: "before" });
    f.p.deferMessage(compact());
    f.p.deferMessage({ text: "AFTER", tempId: "after" });
    expect(f.p.cancelDeferredMessage("compact")).toBe(true);
    await f.event({ type: "result" });
    expect(f.run).not.toHaveBeenCalled();
    expect(f.queue.drain()[0]?.text).toBe("BEFORE");
    await f.event({ type: "result" });
    expect(f.queue.drain()[0]?.text).toBe("AFTER");
  });

  it("preserves patient readiness and retires its persisted command before provider dispatch", async () => {
    await withSessionQueuePersistence(async ({ service, projectId }) => {
      const f = fixture(false, {
        sessionQueuePersistenceService: service,
        projectId,
      });
      f.p.deferMessage({
        ...compact(),
        metadata: { deliveryIntent: "patient", patienceSeconds: 10 },
      });
      await f.p.waitForPatientQueuePersistenceIdle();
      expect(service.listSession("session")[0]?.message.queuedCompact).toEqual(
        compact().queuedCompact,
      );
      await f.event({ type: "result" });
      expect(f.run).not.toHaveBeenCalled();
      const now = Date.now();
      expect(
        f.p.promoteEligiblePatientDeferredMessages({
          quietSinceMs: now,
          now: now + 9999,
        }).promoted,
      ).toBe(false);
      expect(
        f.p.promoteEligiblePatientDeferredMessages({
          quietSinceMs: now,
          now: now + 10_000,
        }).promoted,
      ).toBe(true);
      await waitFor(() => expect(f.queue.depth).toBe(1));
      expect(service.listSession("session")).toHaveLength(0);
      await f.queue[Symbol.asyncIterator]().next();
      await f.event({ type: "system", subtype: "compact_boundary" });
      await f.event({ type: "result" });
      expect(f.p.getDeferredQueueSummary()).toHaveLength(0);
    });
  });
  it("does not release later work when completion arrives before the dispatch reply", async () => {
    let release!: (result: { handled: boolean }) => void;
    const reply = new Promise<{ handled: boolean }>((resolve) => {
      release = resolve;
    });
    const f = fixture(true, { runProviderCommandFn: () => reply });
    f.p.deferMessage(compact());
    f.p.deferMessage({ text: "NEXT", tempId: "next" });
    await f.event({ type: "result" });
    // Dispatch first waits for the persistence chain, even on volatile entries.
    await Promise.resolve();
    await f.event({ type: "system", subtype: "compact_boundary" });
    await f.event({ type: "result" });
    expect(f.queue.depth).toBe(0);
    expect(f.p.cancelDeferredMessage("compact")).toBe(false);
    release({ handled: true });
    await waitFor(() => expect(f.queue.depth).toBe(1));
    expect(f.queue.drain()[0]?.text).toBe("NEXT");
  });

  it("a timeout keeps execution unconfirmed until actual completion, without retry", async () => {
    const f = fixture(true);
    f.p.deferMessage(compact());
    f.p.deferMessage({ text: "NEXT", tempId: "next" });
    vi.useFakeTimers();
    await f.event({ type: "result" });
    await Promise.resolve();
    expect(f.run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(f.queue.depth).toBe(0);
    expect(f.p.cancelDeferredMessage("compact")).toBe(false);
    expect(f.p.getDeferredQueueSummary()[0]).toMatchObject({
      compactionGate: { state: "unconfirmed" },
      cancellable: false,
    });
    await f.event({ type: "system", subtype: "compact_boundary" });
    await f.event({ type: "result" });
    expect(f.p.getDeferredQueueSummary()).toEqual([]);
    expect(f.queue.drain()[0]?.text).toBe("NEXT");
    expect(f.run).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
  it("a persistence refusal before dispatch leaves failure cancellable without stranding later input", async () => {
    await withSessionQueuePersistence(async ({ service, projectId }) => {
      const f = fixture(true, {
        sessionQueuePersistenceService: service,
        projectId,
      });
      f.p.deferMessage({
        ...compact(),
        metadata: { deliveryIntent: "patient" },
      });
      f.p.deferMessage({ text: "NEXT", tempId: "next" });
      await f.p.waitForPatientQueuePersistenceIdle();
      const remove = vi
        .spyOn(service, "deleteItem")
        .mockRejectedValueOnce(new Error("owned disk refusal"));
      await f.event({ type: "result" });
      await waitFor(() =>
        expect(f.p.getDeferredQueueSummary()[0]).toMatchObject({
          cancellable: true,
          compactionGate: { state: "failed", reason: "owned disk refusal" },
        }),
      );
      expect(f.p.state.type).toBe("idle");
      expect(f.run).not.toHaveBeenCalled();
      remove.mockRestore();
      expect(f.p.cancelDeferredMessage("compact")).toBe(true);
      expect(f.queue.drain()[0]?.text).toBe("NEXT");
      await f.p.waitForPatientQueuePersistenceIdle();
    });
  });
  it("a definitive native refusal becomes idle and cancellable without releasing later work", async () => {
    const run = vi.fn(async () => ({
      handled: true,
      error: "native refused before dispatch",
    }));
    const f = fixture(true, { runProviderCommandFn: run });
    f.p.deferMessage(compact());
    f.p.deferMessage({ text: "NEXT", tempId: "next" });
    await f.event({ type: "result" });
    await waitFor(() =>
      expect(f.p.getDeferredQueueSummary()[0]).toMatchObject({
        cancellable: true,
        compactionGate: { state: "failed" },
      }),
    );
    expect(f.p.state.type).toBe("idle");
    expect(f.queue.depth).toBe(0);
    expect(f.p.cancelDeferredMessage("compact")).toBe(true);
    expect(f.queue.drain()[0]?.text).toBe("NEXT");
    expect(run).toHaveBeenCalledOnce();
  });

  it("a lost native dispatch reply keeps cancellation fenced until a real terminal result", async () => {
    const f = fixture(true, {
      runProviderCommandFn: async () => ({
        handled: true,
        error: "lost reply",
        uncertain: true,
      }),
    });
    f.p.deferMessage(compact());
    f.p.deferMessage({ text: "NEXT", tempId: "next" });
    await f.event({ type: "result" });
    await waitFor(() =>
      expect(f.p.getDeferredQueueSummary()[0]?.compactionGate?.state).toBe(
        "failed",
      ),
    );
    expect(f.p.cancelDeferredMessage("compact")).toBe(false);
    expect(f.queue.depth).toBe(0);
    await f.event({ type: "result" });
    expect(f.p.cancelDeferredMessage("compact")).toBe(true);
    expect(f.queue.drain()[0]?.text).toBe("NEXT");
  });

  it("retrying errors do not poison a successful compaction", async () => {
    const f = fixture(true);
    f.p.deferMessage(compact());
    f.p.deferMessage({ text: "NEXT", tempId: "next" });
    await f.event({ type: "result" });
    await waitFor(() => expect(f.run).toHaveBeenCalledOnce());
    await f.event({
      type: "error",
      error: "reconnecting",
      codexWillRetry: true,
    });
    expect(f.p.getDeferredQueueSummary()[0]?.compactionGate?.state).toBe(
      "compacting",
    );
    await f.event({ type: "system", subtype: "compact_boundary" });
    await f.event({ type: "result" });
    expect(f.queue.drain().map((m) => m.text)).toEqual(["NEXT"]);
    expect(f.p.getDeferredQueueSummary()).toEqual([]);
  });

  it("a fallback ignores stale results before its exact input is yielded", async () => {
    const f = fixture(false);
    f.p.deferMessage(compact());
    f.p.deferMessage({ text: "NEXT", tempId: "next" });
    await f.event({ type: "result" });
    await waitFor(() => expect(f.queue.depth).toBe(1));
    await f.event({ type: "result" });
    expect(f.p.cancelDeferredMessage("compact")).toBe(false);
    await f.queue[Symbol.asyncIterator]().next();
    await f.event({ type: "system", subtype: "compact_boundary" });
    await f.event({ type: "result" });
    expect(f.queue.drain().map((m) => m.text)).toEqual(["NEXT"]);
  });

  it("a started patient compact cannot be re-created by restart preservation", async () => {
    await withSessionQueuePersistence(async ({ service, projectId }) => {
      let release!: (result: { handled: boolean }) => void;
      const f = fixture(true, {
        sessionQueuePersistenceService: service,
        projectId,
        runProviderCommandFn: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      });
      f.p.deferMessage({
        ...compact(),
        metadata: { deliveryIntent: "patient" },
      });
      await f.p.waitForPatientQueuePersistenceIdle();
      await f.event({ type: "result" });
      await waitFor(() => expect(release).toBeDefined());
      await f.event({ type: "system", subtype: "compact_boundary" });
      await f.event({ type: "result" }); // Process idle, RPC reply still held
      expect(f.p.state.type).toBe("idle");
      expect(await f.p.preservePatientDeferredMessagesForRestart()).toBe(0);
      expect(service.listSession("session")).toEqual([]);
      release({ handled: true });
      await waitFor(() => expect(f.p.getDeferredQueueSummary()).toEqual([]));
    });
  });

  it("cancelling failure applies a pending effort change before the following message", async () => {
    const effort = vi.fn(async () => {});
    const f = fixture(true, { setEffortFn: effort, effort: "low" });
    f.p.deferMessage(compact());
    f.p.deferMessage({ text: "NEXT", tempId: "next" });
    await f.event({ type: "result" });
    await waitFor(() => expect(f.run).toHaveBeenCalledOnce());
    await f.p.setEffort("high");
    await f.event({ type: "error", error: "compact failed" });
    await f.event({ type: "result" });
    expect(effort).not.toHaveBeenCalled();
    expect(f.p.cancelDeferredMessage("compact")).toBe(true);
    await waitFor(() => expect(f.queue.depth).toBe(1));
    expect(effort).toHaveBeenCalledWith("high");
    expect(f.p.appliedEffort).toBe("high");
    expect(f.queue.drain()[0]?.text).toBe("NEXT");
  });
});
