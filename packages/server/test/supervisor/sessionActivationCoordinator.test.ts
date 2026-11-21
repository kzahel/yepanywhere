import { describe, expect, it } from "vitest";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { MessageQueue } from "../../src/sdk/messageQueue.js";
import { Process } from "../../src/supervisor/Process.js";
import {
  SessionActivationCoordinator,
  type SessionActivationCoordinatorOptions,
} from "../../src/supervisor/SessionActivationCoordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function coordinator(
  overrides: Partial<SessionActivationCoordinatorOptions> = {},
): SessionActivationCoordinator {
  return new SessionActivationCoordinator({
    defaultPermissionMode: "default",
    getProcess: () => undefined,
    getProcessForSession: () => undefined,
    unregisterProcess: () => {},
    assertProviderOwnershipSettled: () => {},
    assertSessionSandboxSettings: () => {},
    restartProcess: async () => null,
    ...overrides,
  });
}

describe("SessionActivationCoordinator", () => {
  it("snapshots after queued changes and uses applied effort rather than an unsent selection", async () => {
    const gate = deferred<void>();
    const process = {
      id: "process-1",
      sessionId: "source",
      isTerminated: false,
      permissionMode: "bypassPermissions",
      requestedModel: "default",
      resolvedModel: "resolved-source",
      model: "default",
      thinking: { type: "adaptive" },
      appliedEffort: "high",
      effort: "max",
      serviceTier: "priority",
    } as unknown as Process;
    const state = coordinator({ getProcessForSession: () => process });
    const change = state.enqueueConfiguration("source", async () => {
      await gate.promise;
      Object.assign(process, {
        permissionMode: "default",
        appliedEffort: "low",
      });
    });
    const snapshot = state.snapshotLaunchSettings(
      "project" as never,
      "source",
      "claude",
    );
    gate.resolve();
    await change;
    expect(await snapshot).toEqual({
      permissionMode: "default",
      requestedModel: "resolved-source",
      thinking: { type: "adaptive" },
      effort: "low",
      serviceTier: "priority",
    });
  });

  it("exposes one settled activation result to concurrent waiters", async () => {
    const activationGate = deferred<Process>();
    const state = coordinator();

    const activation = state.startActivation(
      "session-1",
      () => activationGate.promise,
    );
    const waiter = state.waitForActivation("session-1");
    let waiterSettled = false;
    void waiter.finally(() => {
      waiterSettled = true;
    });

    await Promise.resolve();
    expect(waiterSettled).toBe(false);

    const process = { id: "process-1" } as Process;
    activationGate.resolve(process);
    await expect(activation).resolves.toBe(process);
    await expect(waiter).resolves.toBe(true);
    await expect(state.waitForActivation("session-1")).resolves.toBe(false);
  });

  it("flushes the latest standing policy before reload and propagates write failures", async () => {
    const gate = deferred<void>();
    const writes: string[] = [];
    let fail = false;
    const state = coordinator({
      sessionMetadataService: {
        recordEffectiveLaunchSettings: async (
          _id: string,
          value: { permissionMode: string },
        ) => {
          writes.push(value.permissionMode);
          if (fail) throw new Error("disk unavailable");
        },
        flushPendingWrites: async () => {
          writes.push("flushed");
        },
      } as unknown as NonNullable<
        SessionActivationCoordinatorOptions["sessionMetadataService"]
      >,
    });
    const process = {
      id: "process-1",
      sessionId: "session-1",
      permissionMode: "bypassPermissions",
    } as Process;
    const pending = state.enqueueConfiguration("session-1", async () => {
      await gate.promise;
      Object.assign(process, { permissionMode: "default" });
    });
    const reload = state.prepareForServerReload(process);
    expect(writes).toEqual([]);
    gate.resolve();
    await pending;
    await reload;
    expect(writes).toEqual(["default", "flushed"]);
    fail = true;
    await expect(state.prepareForServerReload(process)).rejects.toThrow(
      "disk unavailable",
    );
    expect(writes).toEqual(["default", "flushed", "default"]);
  });

  describe("stopping process launch settings", () => {
    function stoppingFixture() {
      const gate = deferred<void>();
      const writes: string[] = [];
      let owner: Process | undefined;
      const state = coordinator({
        getProcessForSession: () => owner,
        sessionMetadataService: {
          recordEffectiveLaunchSettings: async (
            _id: string,
            value: { permissionMode: string },
          ) => {
            writes.push(value.permissionMode);
          },
        } as unknown as NonNullable<
          SessionActivationCoordinatorOptions["sessionMetadataService"]
        >,
      });
      const process = {
        id: "process-1",
        sessionId: "session-1",
        permissionMode: "default",
        isTerminated: false,
      } as Process;
      owner = process;
      // A configuration transition still running holds the scheduled save.
      const busy = state.enqueueConfiguration("session-1", () => gate.promise);
      Object.assign(process, { permissionMode: "plan" });
      state.scheduleLaunchSettingsPersistence(process, "permissionMode");
      const stop = (successor?: Process) => {
        Object.assign(process, { isTerminated: true });
        owner = successor;
        state.discardProcess(process);
      };
      return { state, process, writes, gate, busy, stop };
    }

    it("saves a mode change whose scheduled save the stop overtook", async () => {
      const { state, process, writes, gate, busy, stop } = stoppingFixture();

      const settled = state.settleStoppingProcessLaunchSettings(process);
      expect(state.settleStoppingProcessLaunchSettings(process)).toBe(settled);
      stop();
      gate.resolve();
      await busy;
      await settled;

      expect(writes).toEqual(["plan"]);
    });

    it("leaves the session to a successor that owns it by then", async () => {
      const { state, process, writes, gate, busy, stop } = stoppingFixture();

      const settled = state.settleStoppingProcessLaunchSettings(process);
      stop({ id: "process-2", sessionId: "session-1" } as Process);
      gate.resolve();
      await busy;
      await settled;

      expect(writes).toEqual([]);
    });
  });

  it("runs configuration transitions in request order", async () => {
    const firstGate = deferred<void>();
    const state = coordinator();
    const transitions: string[] = [];

    const first = state.enqueueConfiguration("session-1", async () => {
      transitions.push("first-start");
      await firstGate.promise;
      transitions.push("first-end");
      return 1;
    });
    const second = state.enqueueConfiguration("session-1", async () => {
      transitions.push("second");
      return 2;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(transitions).toEqual(["first-start"]);

    firstGate.resolve();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(transitions).toEqual(["first-start", "first-end", "second"]);
  });

  it("preserves appliedEffort when normalizing Antigravity thinking during an active turn", async () => {
    let appliedEffort: string | undefined;
    let queuedEffort: string | undefined;
    let thinking: unknown;
    const process = {
      id: "process-1",
      sessionId: "session-1",
      projectPath: "/tmp/proj",
      provider: "antigravity",
      permissionMode: "default",
      state: { type: "in-turn" },
      isTerminated: false,
      hasUnverifiedProviderOwnership: false,
      requestedModel: "gemini-4-neon",
      resolvedModel: "gemini-4-neon",
      model: "gemini-4-neon",
      get thinking() {
        return thinking;
      },
      get effort() {
        return queuedEffort ?? appliedEffort;
      },
      get appliedEffort() {
        return appliedEffort;
      },
      supportsSetModel: true,
      supportsEffortChange: true,
      supportsThinkingModeChange: false,
      supportsServiceTierChange: false,
      supportsInterrupt: true,
      getProviderRuntimeStatus: () => null,
      supportedModels: async () => [
        {
          id: "gemini-4-neon",
          name: "Gemini 4 Neon",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
      ],
      setEffort: async (next?: string) => {
        // Active turn queues without mutating appliedEffort yet.
        queuedEffort = next;
        return true;
      },
      updateThinkingConfig: (nextThinking: unknown, nextEffort?: string) => {
        thinking = nextThinking;
        appliedEffort = nextEffort;
      },
    } as unknown as Process;

    const state = coordinator({ getProcess: () => process });
    await state.reconfigureProcess("process-1", {
      thinking: { type: "adaptive", display: "summarized" },
      effort: "low",
    });

    expect(thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(appliedEffort).toBeUndefined();
    expect(queuedEffort).toBe("low");
  });

  it("keeps Codex combined changes on restart", async () => {
    let restarted = false;
    const codexSetModel = async () => {
      throw new Error("should not call live setModel on combined Codex switch");
    };
    const codexProcess = {
      id: "codex-1",
      sessionId: "session-codex",
      projectPath: "/tmp/proj",
      provider: "codex",
      permissionMode: "default",
      state: { type: "idle" },
      isTerminated: false,
      hasUnverifiedProviderOwnership: false,
      requestedModel: "gpt-6.2-sol",
      resolvedModel: "gpt-6.2-sol",
      model: "gpt-6.2-sol",
      thinking: { type: "adaptive", display: "summarized" },
      effort: "xhigh",
      appliedEffort: "xhigh",
      supportsSetModel: true,
      supportsEffortChange: true,
      supportsThinkingModeChange: false,
      supportsServiceTierChange: false,
      supportsInterrupt: true,
      getProviderRuntimeStatus: () => null,
      setModel: codexSetModel,
      setEffort: async () => true,
    } as unknown as Process;
    const codexCoordinator = coordinator({
      getProcess: () => codexProcess,
      restartProcess: async () => {
        restarted = true;
        return codexProcess;
      },
    });
    await codexCoordinator.reconfigureProcess("codex-1", {
      model: "gpt-6.1-terra",
      requestedModel: "gpt-6.1-terra",
      thinking: { type: "adaptive", display: "summarized" },
      effort: "medium",
    });
    expect(restarted).toBe(true);
  });

  it("validates Antigravity reset-to-default against the default catalog entry and allows active-turn fixed-effort switch", async () => {
    const modelCalls: Array<string | undefined> = [];
    const effortCalls: Array<string | undefined> = [];
    let currentState: { type: string } = { type: "idle" };
    let currentModel = "gemini-pro-orchestrator-neon";
    let currentEffort: string | undefined;
    const process = {
      id: "agy-2",
      sessionId: "session-agy-2",
      projectPath: "/tmp/proj",
      provider: "antigravity",
      permissionMode: "default",
      get state() {
        return currentState;
      },
      isTerminated: false,
      hasUnverifiedProviderOwnership: false,
      get requestedModel() {
        return currentModel;
      },
      get resolvedModel() {
        return currentModel;
      },
      get model() {
        return currentModel;
      },
      thinking: { type: "adaptive", display: "summarized" },
      get effort() {
        return currentEffort;
      },
      get appliedEffort() {
        return currentEffort;
      },
      supportsSetModel: true,
      supportsEffortChange: true,
      supportsThinkingModeChange: false,
      supportsServiceTierChange: false,
      supportsInterrupt: true,
      getProviderRuntimeStatus: () => null,
      supportedModels: async () => [
        {
          id: "default",
          name: "Antigravity default",
          isDefault: true,
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
        {
          id: "gemini-pro-orchestrator-neon",
          name: "Orchestrator (Neon)",
          supportsEffort: false,
          supportsAdaptiveThinking: false,
        },
      ],
      setModelAndEffort: async (next: { model?: string; effort?: string }) => {
        modelCalls.push(next.model);
        effortCalls.push(next.effort);
        currentModel = next.model ?? "default";
        currentEffort = next.effort;
        return true;
      },
      updateThinkingConfig: () => {},
    } as unknown as Process;

    const state = coordinator({ getProcess: () => process });
    // Fixed-effort model -> Antigravity default with medium effort must validate
    // against "default", not the old fixed-effort model.
    await state.reconfigureProcess("agy-2", {
      model: undefined,
      requestedModel: "default",
      thinking: { type: "adaptive", display: "summarized" },
      effort: "medium",
    });
    expect(modelCalls).toEqual([undefined]);
    expect(effortCalls).toEqual(["medium"]);

    // Active-turn switch back to fixed-effort model with Auto clears override
    // live without throwing 409.
    currentState = { type: "in-turn" };
    await state.reconfigureProcess("agy-2", {
      model: "gemini-pro-orchestrator-neon",
      requestedModel: "gemini-pro-orchestrator-neon",
      thinking: { type: "adaptive", display: "summarized" },
      effort: undefined,
    });
    expect(modelCalls).toEqual([undefined, "gemini-pro-orchestrator-neon"]);
    expect(effortCalls).toEqual(["medium", undefined]);
  });

  it("holds concurrent input during an Antigravity combined switch and clears rejected pending effort on rollback", async () => {
    const queue = new MessageQueue();
    const inputIterator = queue.generator();
    const modelStarted = deferred<void>();
    const modelGate = deferred<void>();
    const promptDelivered = deferred<void>();
    const ops: string[] = [];
    let rejectNextEffort = true;
    const process = new Process(
      (async function* () {
        yield {
          type: "system" as const,
          subtype: "init",
          session_id: "agy-real",
          model: "gemini-4-neon",
        };
        yield { type: "result" as const, session_id: "agy-real" };
        for await (const msg of inputIterator) {
          ops.push(`prompt:${String(msg.message.content)}`);
          yield { type: "result" as const, session_id: "agy-real" };
          if (msg.message.content === "concurrent-turn")
            promptDelivered.resolve();
        }
      })(),
      {
        projectPath: "/tmp/proj",
        projectId: toUrlProjectId("/tmp/proj"),
        sessionId: "agy-real",
        idleTimeoutMs: 60_000,
        queue,
        abortFn: () => {
          void inputIterator.return();
        },
        provider: "antigravity",
        model: "gemini-4-neon",
        requestedModel: "gemini-4-neon",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
        effortUpdatesActiveTurn: true,
        supportedModelsFn: async () => [],
        setModelFn: async (next) => {
          ops.push(`setModel:${next}`);
          if (next === "claude-opus-5-5") {
            modelStarted.resolve();
            await modelGate.promise;
          }
        },
        setEffortFn: async (next) => {
          ops.push(`setEffort:${next}`);
          if (rejectNextEffort && next === "low") {
            rejectNextEffort = false;
            throw new Error("effort rejected");
          }
        },
      },
    );
    try {
      await process.waitForProviderSessionId(1000);
      await new Promise<void>((resolve) => {
        if (process.state.type === "idle") {
          resolve();
          return;
        }
        const unsubscribe = process.subscribe((event) => {
          if (event.type === "state-change" && event.state.type === "idle") {
            unsubscribe();
            resolve();
          }
        });
      });
      const state = coordinator({ getProcess: () => process });

      // Start combined switch; queue ordinary input and attempt explicit Steer
      // of a queued patient entry while setModel is still awaiting.
      const patientDeferred = process.deferMessage(
        {
          text: "patient-turn",
          tempId: "patient-1",
          metadata: { deliveryIntent: "patient" },
        },
        { promoteIfReady: false },
      );
      expect(patientDeferred.success).toBe(true);
      const failedSwitch = state.reconfigureProcess("agy-real", {
        model: "claude-opus-5-5",
        requestedModel: "claude-opus-5-5",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "low",
      });
      await modelStarted.promise;
      expect(process.queueMessage({ text: "concurrent-turn" }).success).toBe(
        true,
      );
      const blockedSteer =
        process.steerPatientDeferredMessagesThrough("patient-1");
      expect(blockedSteer.success).toBe(false);
      expect(blockedSteer.error).toMatch(
        /configuration change is in progress/i,
      );
      expect(
        process
          .getDeferredQueueSummary()
          .some((entry) => entry.tempId === "patient-1"),
      ).toBe(true);
      // Neither input may reach the provider queue before the switch settles.
      expect(ops).toEqual(["setModel:claude-opus-5-5"]);

      modelGate.resolve();
      await expect(failedSwitch).rejects.toThrow("effort rejected");

      // Both model and effort rolled back cleanly, no rejected pending effort
      // remains, and the held message now dispatches cleanly.
      expect(process.resolvedModel).toBe("gemini-4-neon");
      expect(process.effort).toBe("high");
      expect(process.appliedEffort).toBe("high");
      await promptDelivered.promise;
      expect(ops).toEqual([
        "setModel:claude-opus-5-5",
        "setEffort:low",
        "setModel:gemini-4-neon",
        "setEffort:high",
        "prompt:patient-turn",
        "prompt:concurrent-turn",
      ]);
    } finally {
      await process.abort();
    }
  });

  it("keeps queued work paused when an Antigravity rollback fails until a later switch recovers", async () => {
    const queue = new MessageQueue();
    const inputIterator = queue.generator();
    const promptDelivered = deferred<void>();
    const ops: string[] = [];
    let failRollbackModel = true;
    let rejectModelChange = true;
    const process = new Process(
      (async function* () {
        yield {
          type: "system" as const,
          subtype: "init",
          session_id: "agy-rollback-fail",
          model: "gemini-4-neon",
        };
        yield { type: "result" as const, session_id: "agy-rollback-fail" };
        for await (const msg of inputIterator) {
          ops.push(`prompt:${String(msg.message.content)}`);
          yield { type: "result" as const, session_id: "agy-rollback-fail" };
          if (msg.message.content === "patient-after-rollback-fail")
            promptDelivered.resolve();
        }
      })(),
      {
        projectPath: "/tmp/proj",
        projectId: toUrlProjectId("/tmp/proj"),
        sessionId: "agy-rollback-fail",
        idleTimeoutMs: 60_000,
        queue,
        abortFn: () => {
          void inputIterator.return();
        },
        provider: "antigravity",
        model: "gemini-4-neon",
        requestedModel: "gemini-4-neon",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
        effortUpdatesActiveTurn: true,
        supportedModelsFn: async () => [],
        setModelFn: async (next) => {
          ops.push(`setModel:${next}`);
          if (rejectModelChange && next === "claude-opus-5-5") {
            rejectModelChange = false;
            throw new Error("second native model command rejected");
          }
          if (failRollbackModel && next === "gemini-4-neon") {
            failRollbackModel = false;
            throw new Error("model rollback failed");
          }
        },
        setEffortFn: async (next) => {
          ops.push(`setEffort:${next}`);
        },
      },
    );
    try {
      await process.waitForProviderSessionId(1000);
      await new Promise<void>((resolve) => {
        if (process.state.type === "idle") {
          resolve();
          return;
        }
        const unsubscribe = process.subscribe((event) => {
          if (event.type === "state-change" && event.state.type === "idle") {
            unsubscribe();
            resolve();
          }
        });
      });
      const state = coordinator({ getProcess: () => process });

      await expect(
        state.reconfigureProcess("agy-rollback-fail", {
          model: "claude-opus-5-5",
          requestedModel: "claude-opus-5-5",
          thinking: { type: "adaptive", display: "summarized" },
          effort: "high",
        }),
      ).rejects.toThrow(/configuration rollback failed/);

      // Queued input and explicit Steer must remain paused under the partially
      // applied model until a later configuration switch recovers cleanly.
      expect(process.resolvedModel).toBe("gemini-4-neon");
      expect(
        process.queueMessage({ text: "held-after-rollback-fail" }).success,
      ).toBe(true);
      expect(
        process.deferMessage(
          {
            text: "patient-after-rollback-fail",
            tempId: "patient-2",
            metadata: { deliveryIntent: "patient" },
          },
          { promoteIfReady: false },
        ).success,
      ).toBe(true);
      expect(
        process.steerPatientDeferredMessagesThrough("patient-2").success,
      ).toBe(false);
      await Promise.resolve();
      expect(ops.some((op) => op.startsWith("prompt:"))).toBe(false);

      // Recovery switch succeeds and resumes held work under the recovered pair.
      await state.reconfigureProcess("agy-rollback-fail", {
        model: "gemini-4-neon",
        requestedModel: "gemini-4-neon",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      });
      await promptDelivered.promise;
      expect(ops.slice(-2)).toEqual([
        "prompt:held-after-rollback-fail",
        "prompt:patient-after-rollback-fail",
      ]);
    } finally {
      await process.abort();
    }
  });
});
