import { describe, expect, it, vi } from "vitest";
import { getEffectiveProviderUpdatedAt } from "../src/sessions/recap-overlays.js";
import {
  Process,
  createControllableIterator,
  createMockIterator,
  getLogger,
  waitFor,
} from "./process.test-support.js";
import type {
  ProcessEvent,
  ProviderRetentionSnapshot,
  SDKMessage,
  UrlProjectId,
} from "./process.test-support.js";

describe("Process", () => {
  describe("event subscription", () => {
    it("emits message events", async () => {
      const messages: SDKMessage[] = [
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "assistant", message: { content: "Hi" } },
        { type: "result", session_id: "sess-1" },
      ];

      const iterator = createMockIterator(messages);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      const received: SDKMessage[] = [];
      process.subscribe((event) => {
        if (event.type === "message") {
          received.push(event.message);
        }
      });

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(received).toHaveLength(3);
      expect(received[0]?.type).toBe("system");
      expect(received[1]?.type).toBe("assistant");
      expect(received[2]?.type).toBe("result");
    });

    it("suppresses the user echo for hidden injected messages", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      const userEchoes: SDKMessage[] = [];
      process.subscribe((event) => {
        if (event.type === "message" && event.message.type === "user") {
          userEchoes.push(event.message);
        }
      });

      const visible = process.queueMessage({ text: "hello" });
      const compact = process.queueMessage({
        text: "/compact",
        metadata: { hidden: true },
      });

      expect(visible.success).toBe(true);
      expect(compact.success).toBe(true);

      // Let any emit flush, then confirm only the visible turn echoed — the
      // hidden /compact (queued, so compaction still runs) shows no user turn.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(userEchoes).toHaveLength(1);
    });

    it("emits a context-window-observed event per modelUsage entry (recorded exactly as observed)", async () => {
      const messages = [
        { type: "system", subtype: "init", session_id: "sess-1" },
        {
          type: "result",
          session_id: "sess-1",
          modelUsage: {
            "claude-opus-4-8": { contextWindow: 1_000_000 },
            "claude-haiku-4-5-20251001": { contextWindow: 200_000 },
            "claude-sonnet-4-6[1m]": { contextWindow: 1_000_000 },
            "zero-window-model": { contextWindow: 0 },
          },
        },
      ] as unknown as SDKMessage[];

      const iterator = createMockIterator(messages);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      const observed: Array<{ model: string; contextWindow: number }> = [];
      let observedProvider: string | undefined;
      process.subscribe((event) => {
        if (event.type === "context-window-observed") {
          observed.push({
            model: event.model,
            contextWindow: event.contextWindow,
          });
          observedProvider = event.provider;
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // One event per non-zero entry; the zero-window entry is skipped. Keys
      // are recorded verbatim (no [1m] munging).
      expect(observed).toEqual([
        { model: "claude-opus-4-8", contextWindow: 1_000_000 },
        { model: "claude-haiku-4-5-20251001", contextWindow: 200_000 },
        { model: "claude-sonnet-4-6[1m]", contextWindow: 1_000_000 },
      ]);
      expect(observedProvider).toBe("claude");
      // Live-override window is still the max across entries.
      expect(process.contextWindow).toBe(1_000_000);
    });

    it("transitions to idle after result", async () => {
      const messages: SDKMessage[] = [
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "result", session_id: "sess-1" },
      ];

      const iterator = createMockIterator(messages);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(process.state.type).toBe("idle");
    });

    it("does not manufacture provider recency before the first message", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 10_000,
      });
      const summaryUpdatedAt = "2026-08-01T00:00:00.000Z";

      expect(process.lastProviderMessageTime).toBeNull();
      expect(getEffectiveProviderUpdatedAt(summaryUpdatedAt, process)).toBe(
        summaryUpdatedAt,
      );

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      await waitFor(() =>
        expect(process.lastProviderMessageTime).toBeInstanceOf(Date),
      );
      expect(process.lastProviderContentTime).toBeNull();
      expect(getEffectiveProviderUpdatedAt(summaryUpdatedAt, process)).toBe(
        summaryUpdatedAt,
      );
      controller.finish();
    });

    it("keeps a read idle session read through command and telemetry updates", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime("2026-09-12T10:00:00.000Z");
      const controller = createControllableIterator();
      const onCommandsObserved = vi.fn();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 10_000,
        onCommandsObserved,
      });
      const received: SDKMessage[] = [];
      process.subscribe((event) => {
        if (event.type === "message") received.push(event.message);
      });
      try {
        controller.push({ type: "assistant", message: { content: "Done" } });
        controller.push({ type: "result", session_id: "sess-1" });
        await waitFor(() => expect(process.state.type).toBe("idle"));
        const contentAt = process.lastProviderContentTime;
        const lastSeenAt = "2026-09-12T10:01:00.000Z";
        vi.setSystemTime("2026-09-12T10:02:00.000Z");
        for (const subtype of [
          "commands_changed",
          "config_ack",
          "token_usage",
          "session_state_changed",
        ]) {
          const message = {
            type: "system",
            subtype,
            session_id: "sess-1",
            ...(subtype === "commands_changed"
              ? { slash_command_inventory: [] }
              : {}),
            ...(subtype === "session_state_changed" ? { state: "idle" } : {}),
          } as SDKMessage;
          const count = received.length;
          controller.push(message);
          await waitFor(() => expect(received).toHaveLength(count + 1));
          expect(process.lastProviderContentTime).toBe(contentAt);
          expect(
            getEffectiveProviderUpdatedAt("2026-09-12T09:00:00.000Z", process) >
              lastSeenAt,
          ).toBe(false);
          expect(process.state.type).toBe("idle");
        }
        expect(onCommandsObserved).toHaveBeenCalledWith("sess-1", []);
        expect(process.lastProviderMessageTime?.toISOString()).toBe(
          "2026-09-12T10:02:00.000Z",
        );

        // Actual streamed content still becomes unread before the file is flushed.
        vi.setSystemTime("2026-09-12T10:03:00.000Z");
        controller.push({
          type: "assistant",
          message: { content: "New output" },
        });
        await waitFor(() =>
          expect(process.lastProviderContentTime?.toISOString()).toBe(
            "2026-09-12T10:03:00.000Z",
          ),
        );
        expect(
          getEffectiveProviderUpdatedAt("2026-09-12T09:00:00.000Z", process) >
            lastSeenAt,
        ).toBe(true);
      } finally {
        controller.finish();
        vi.useRealTimers();
      }
    });

    it("publishes the provider session id for agentctl-active shells", async () => {
      const publishAgentctlSessionIdFn = vi.fn();
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-real" },
      ]);

      new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "temp-session",
        provider: "claude",
        idleTimeoutMs: 100,
        publishAgentctlSessionIdFn,
      });

      await waitFor(() =>
        expect(publishAgentctlSessionIdFn).toHaveBeenCalledWith("sess-real"),
      );
    });

    it("emits state-change events", async () => {
      const messages: SDKMessage[] = [
        { type: "system", subtype: "init", session_id: "sess-1" },
        { type: "result", session_id: "sess-1" },
      ];

      const iterator = createMockIterator(messages);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      const stateChanges: ProcessEvent[] = [];
      process.subscribe((event) => {
        if (event.type === "state-change") {
          stateChanges.push(event);
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have at least one state change to idle
      expect(stateChanges.length).toBeGreaterThan(0);
      const lastChange = stateChanges[stateChanges.length - 1];
      expect(lastChange?.type).toBe("state-change");
      if (lastChange?.type === "state-change") {
        expect(lastChange.state.type).toBe("idle");
      }
    });

    it("uses Claude session_state_changed idle as a turn boundary", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 10_000,
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({
        type: "system",
        subtype: "session_state_changed",
        state: "idle",
        session_id: "sess-1",
        uuid: "11111111-1111-4111-8111-111111111111",
      });

      await waitFor(() => expect(process.state.type).toBe("idle"));
    });

    it("treats Claude requires_action as non-idle evidence without fabricating input", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 10_000,
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({
        type: "system",
        subtype: "session_state_changed",
        state: "idle",
        session_id: "sess-1",
        uuid: "11111111-1111-4111-8111-111111111111",
      });
      await waitFor(() => expect(process.state.type).toBe("idle"));

      controller.push({
        type: "system",
        subtype: "session_state_changed",
        state: "requires_action",
        session_id: "sess-1",
        uuid: "22222222-2222-4222-8222-222222222222",
      });

      await waitFor(() => expect(process.state.type).toBe("in-turn"));
      expect(process.getLivenessSnapshot().lastWakeReason).toMatchObject({
        fromState: "idle",
        reason: "session-state-requires-action",
      });
      expect(process.getPendingInputRequest()).toBeNull();
    });

    it("defers idle reaping while provider retention is active and reaps when it clears", async () => {
      vi.useFakeTimers();
      try {
        let providerRetention: ProviderRetentionSnapshot = {
          retained: true,
          reasons: ["stop-hook-background-tasks:1"],
          backgroundTaskCount: 1,
          sessionCronCount: 0,
          liveTaskCount: 0,
        };
        const abortFn = vi.fn();
        const controller = createControllableIterator();
        const process = new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "claude",
          idleTimeoutMs: 100,
          abortFn,
          getProviderRetentionFn: () => providerRetention,
        });

        controller.push({
          type: "system",
          subtype: "init",
          session_id: "sess-1",
        });
        controller.push({ type: "result", session_id: "sess-1" });

        await vi.advanceTimersByTimeAsync(0);
        expect(process.state.type).toBe("idle");
        expect(process.getLivenessSnapshot()).toMatchObject({
          derivedStatus: "verified-waiting-provider",
          activeWorkKind: "agent-turn",
          providerRetention: {
            retained: true,
            reasons: ["stop-hook-background-tasks:1"],
            backgroundTaskCount: 1,
          },
        });

        await vi.advanceTimersByTimeAsync(150);
        expect(abortFn).not.toHaveBeenCalled();

        providerRetention = { retained: false, reasons: [] };
        process.handleProviderRetentionChanged();
        await vi.advanceTimersByTimeAsync(99);
        expect(abortFn).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(abortFn).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports retained-idle as in-turn activity in getInfo", async () => {
      vi.useFakeTimers();
      try {
        let providerRetention: ProviderRetentionSnapshot = {
          retained: true,
          reasons: ["stop-hook-background-tasks:1"],
          backgroundTaskCount: 1,
          sessionCronCount: 0,
          liveTaskCount: 0,
        };
        const controller = createControllableIterator();
        const process = new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "claude",
          idleTimeoutMs: 100,
          abortFn: vi.fn(),
          getProviderRetentionFn: () => providerRetention,
        });

        controller.push({
          type: "system",
          subtype: "init",
          session_id: "sess-1",
        });
        controller.push({ type: "result", session_id: "sess-1" });
        await vi.advanceTimersByTimeAsync(0);

        // Idle process, but the provider is still retaining background work:
        // surface it as active so inbox/sidebar match the session page.
        expect(process.state.type).toBe("idle");
        expect(process.isRetainingProviderWork()).toBe(true);
        expect(process.getInfo().state).toBe("in-turn");

        // Once retention clears it falls back to plain idle.
        providerRetention = { retained: false, reasons: [] };
        expect(process.isRetainingProviderWork()).toBe(false);
        expect(process.getInfo().state).toBe("idle");
      } finally {
        vi.useRealTimers();
      }
    });

    it("wakes retained idle on provider work before an immediate idle reap", async () => {
      vi.useFakeTimers();
      try {
        let providerRetention: ProviderRetentionSnapshot = {
          retained: true,
          reasons: ["stop-hook-background-tasks:1"],
          backgroundTaskCount: 1,
          sessionCronCount: 0,
          liveTaskCount: 0,
        };
        const abortFn = vi.fn();
        const controller = createControllableIterator();
        const process = new Process(controller.iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "claude",
          idleTimeoutMs: 100,
          abortFn,
          getProviderRetentionFn: () => providerRetention,
        });

        controller.push({
          type: "system",
          subtype: "init",
          session_id: "sess-1",
        });
        controller.push({ type: "result", session_id: "sess-1" });
        await vi.advanceTimersByTimeAsync(0);
        expect(process.state.type).toBe("idle");

        await vi.advanceTimersByTimeAsync(150);
        expect(abortFn).not.toHaveBeenCalled();

        providerRetention = { retained: false, reasons: [] };
        process.handleProviderRetentionChanged();
        controller.push({
          type: "system",
          subtype: "task_notification",
          task_id: "task-1",
          status: "completed",
          session_id: "sess-1",
        } as SDKMessage);

        await Promise.resolve();
        await Promise.resolve();
        expect(process.state.type).toBe("in-turn");

        await vi.advanceTimersByTimeAsync(0);
        expect(abortFn).not.toHaveBeenCalled();
        expect(process.getLivenessSnapshot()).toMatchObject({
          derivedStatus: "verified-progressing",
          lastWakeReason: {
            fromState: "idle",
            reason: "provider-message-after-idle",
            messageType: "system",
            messageSubtype: "task_notification",
          },
          providerRetention: {
            retained: false,
            reasons: [],
          },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not wake a finished idle process on a prompt_suggestion message", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 10_000,
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() => expect(process.state.type).toBe("idle"));

      // prompt_suggestion is a top-level type emitted after the turn's result.
      // It is bookkeeping (a predicted next prompt), never followed by another
      // result, so it must not pin the process in-turn. See doc 015.
      controller.push({
        type: "prompt_suggestion",
        suggestion: "Try the next thing",
        session_id: "sess-1",
      } as unknown as SDKMessage);

      await Promise.resolve();
      await Promise.resolve();
      expect(process.state.type).toBe("idle");
      expect(process.getLivenessSnapshot().lastWakeReason ?? null).toBeNull();
    });

    it("does not wake a finished idle process on unmodeled bookkeeping messages", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 10_000,
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() => expect(process.state.type).toBe("idle"));

      // Default-deny: known non-work subtypes and an invented future subtype all
      // stay idle rather than pinning the process in-turn.
      for (const subtype of [
        "status",
        "compact_boundary",
        "stop_hook_summary",
        "some_future_subtype_we_do_not_model",
      ]) {
        controller.push({
          type: "system",
          subtype,
          session_id: "sess-1",
        } as unknown as SDKMessage);
      }

      await Promise.resolve();
      await Promise.resolve();
      expect(process.state.type).toBe("idle");
      expect(process.getLivenessSnapshot().lastWakeReason ?? null).toBeNull();
    });

    it("wakes a finished idle process on assistant turn content", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 10_000,
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() => expect(process.state.type).toBe("idle"));

      controller.push({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "resuming after background work" }],
        },
        session_id: "sess-1",
        uuid: "33333333-3333-4333-8333-333333333333",
      } as unknown as SDKMessage);

      await waitFor(() => expect(process.state.type).toBe("in-turn"));
      expect(process.getLivenessSnapshot().lastWakeReason).toMatchObject({
        fromState: "idle",
        reason: "provider-message-after-idle",
        messageType: "assistant",
      });
    });

    it("keeps Claude idle with session crons out of verified-idle liveness", async () => {
      const providerRetention: ProviderRetentionSnapshot = {
        retained: true,
        reasons: ["stop-hook-session-crons:1"],
        backgroundTaskCount: 0,
        sessionCronCount: 1,
        liveTaskCount: 0,
      };
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 10_000,
        getProviderRetentionFn: () => providerRetention,
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({
        type: "system",
        subtype: "session_state_changed",
        state: "idle",
        session_id: "sess-1",
        uuid: "11111111-1111-4111-8111-111111111111",
      });

      await waitFor(() => expect(process.state.type).toBe("idle"));
      const liveness = process.getLivenessSnapshot();
      expect(liveness.derivedStatus).toBe("verified-waiting-provider");
      expect(liveness.evidence).toContain("provider-retained");
      expect(liveness.evidence).toContain(
        "provider-retention:stop-hook-session-crons:1",
      );
    });

    it("logs listener failures without blocking other listeners", async () => {
      const warnSpy = vi
        .spyOn(getLogger(), "warn")
        .mockImplementation(() => undefined);
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 10_000,
      });
      const received: ProcessEvent[] = [];

      process.subscribe(() => {
        throw new Error("broken listener");
      });
      process.subscribe((event) => {
        if (event.type === "message") {
          received.push(event);
        }
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });

      await waitFor(() => expect(received).toHaveLength(1));
      await waitFor(() =>
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "process_listener_error",
            emittedEventType: "message",
            error: "broken listener",
          }),
          "Process listener failed",
        ),
      );

      warnSpy.mockRestore();
    });
  });
});
