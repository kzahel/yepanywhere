import type { DurableSyntheticDoneMessage } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type { SessionMetadataService } from "../../src/metadata/index.js";
import type {
  PendingYaCommand,
  Process,
} from "../../src/supervisor/Process.js";
import { SessionDoneCoordinator } from "../../src/supervisor/SessionDoneCoordinator.js";

function coordinatorProcess(overrides: Partial<Process> = {}): Process {
  const pending: PendingYaCommand[] = [];
  return {
    sessionId: "session-1",
    id: "process-1",
    projectId: "project-1",
    state: { type: "in-turn" },
    userTurnVersion: 1,
    isRetainingProviderWork: () => false,
    hasPendingYaCommand: () => pending.length > 0,
    getPendingYaCommand: () => pending[0],
    queueYaCommand: (
      _command: Parameters<Process["queueYaCommand"]>[0],
      options: Parameters<Process["queueYaCommand"]>[1],
    ) => {
      const existing = pending[0];
      if (existing) {
        existing.content = options?.content ?? "/done";
        return existing;
      }
      const entry: PendingYaCommand = {
        command: "done",
        content: options?.content ?? "/done",
        tempId: options?.tempId ?? "ya-done-queued",
        timestamp: options?.timestamp ?? "2026-08-16T10:00:00.000Z",
        userTurnVersion: options?.userTurnVersion ?? 1,
        completionStarted: false,
      };
      pending.push(entry);
      return entry;
    },
    beginPendingYaCommandCompletion: () => {
      const entry = pending[0];
      if (!entry || entry.completionStarted) return undefined;
      entry.completionStarted = true;
      return entry;
    },
    releasePendingYaCommandCompletion: (tempId: string) => {
      const entry = pending.find((candidate) => candidate.tempId === tempId);
      if (entry) entry.completionStarted = false;
    },
    completePendingYaCommand: (tempId: string) => {
      const index = pending.findIndex(
        (entry) => entry.tempId === tempId && entry.completionStarted,
      );
      if (index === -1) return false;
      pending.splice(index, 1);
      return true;
    },
    pauseRecapsUntilUserTurn: vi.fn(),
    resumeRecapsAfterUserTurn: vi.fn(),
    handleAutomationPauseChanged: vi.fn(),
    ...overrides,
  } as unknown as Process;
}

describe("SessionDoneCoordinator", () => {
  it("persists the automation pause before queuing a live-turn /done", async () => {
    const order: string[] = [];
    const process = coordinatorProcess();
    const updateMetadata = vi.fn(async () => {
      order.push("persist");
    });
    const state = new SessionDoneCoordinator({
      sessionMetadataService: {
        getMetadata: () => undefined,
        updateMetadata,
      } as unknown as SessionMetadataService,
      getProcessForSession: () => process,
      cancelInFlightForkedRecap: () => {
        order.push("cancel-recap");
      },
      requestMaintenanceSweep: () => {
        order.push("sweep");
      },
    });

    const originalQueue = process.queueYaCommand.bind(process);
    process.queueYaCommand = ((...args) => {
      order.push("queue");
      return originalQueue(...args);
    }) as Process["queueYaCommand"];

    const result = await state.requestSessionDone("session-1");

    expect(result).toMatchObject({ queued: true, paused: true });
    expect(updateMetadata).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        automationPausedUntilUserTurn: true,
        pendingSyntheticDone: expect.objectContaining({
          message: expect.objectContaining({ content: "/done" }),
          userTurnVersion: 1,
        }),
      }),
    );
    expect(order[0]).toBe("persist");
    expect(order).toContain("queue");
    expect(process.hasPendingYaCommand("done")).toBe(true);
  });

  it("archives durably before projecting a live-turn /archive", async () => {
    const process = coordinatorProcess();
    const updateMetadata = vi.fn(async () => {});
    const queueYaCommand = vi.fn(process.queueYaCommand);
    process.queueYaCommand = queueYaCommand;
    const state = new SessionDoneCoordinator({
      sessionMetadataService: {
        getMetadata: () => undefined,
        updateMetadata,
      } as unknown as SessionMetadataService,
      getProcessForSession: () => process,
      cancelInFlightForkedRecap: () => {},
      requestMaintenanceSweep: () => {},
    });

    const result = await state.requestSessionDone("session-1", "/archive");

    expect(updateMetadata).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        automationPausedUntilUserTurn: true,
        archived: true,
        pendingSyntheticDone: expect.objectContaining({
          message: expect.objectContaining({ content: "/archive" }),
        }),
      }),
    );
    expect(queueYaCommand).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({ content: "/archive" }),
    );
    expect(result).toMatchObject({
      queued: true,
      message: { content: "/archive" },
    });
  });

  it("upgrades one queued done boundary to /archive without a second lane", async () => {
    const process = coordinatorProcess();
    const state = new SessionDoneCoordinator({
      sessionMetadataService: {
        getMetadata: () => undefined,
        updateMetadata: async () => {},
      } as unknown as SessionMetadataService,
      getProcessForSession: () => process,
      cancelInFlightForkedRecap: () => {},
      requestMaintenanceSweep: () => {},
    });

    const done = await state.requestSessionDone("session-1", "/done");
    const archive = await state.requestSessionDone("session-1", "/archive");
    const laterDone = await state.requestSessionDone("session-1", "/done");

    expect(done.message.content).toBe("/done");
    expect(archive.message).toMatchObject({
      uuid: done.message.uuid,
      content: "/archive",
    });
    expect(laterDone.message).toMatchObject({
      uuid: done.message.uuid,
      content: "/archive",
    });
  });

  it("keeps /terminate stronger than queued done or archive boundaries", async () => {
    const process = coordinatorProcess();
    const state = new SessionDoneCoordinator({
      sessionMetadataService: {
        getMetadata: () => undefined,
        updateMetadata: async () => {},
      } as unknown as SessionMetadataService,
      getProcessForSession: () => process,
      cancelInFlightForkedRecap: () => {},
      requestMaintenanceSweep: () => {},
    });

    const done = await state.requestSessionDone("session-1", "/done");
    const terminate = await state.requestSessionDone("session-1", "/terminate");
    const laterArchive = await state.requestSessionDone(
      "session-1",
      "/archive",
    );

    expect(terminate.message).toMatchObject({
      uuid: done.message.uuid,
      content: "/terminate",
    });
    expect(laterArchive.message).toMatchObject({
      uuid: done.message.uuid,
      content: "/terminate",
    });
  });

  it("serializes an archive request behind queued-boundary finalization", async () => {
    const process = coordinatorProcess();
    let releaseFirstWrite: () => void = () => {};
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const recordSyntheticDone = vi.fn(
      async (_sessionId: string, message: { content: string }) => {
        if (message.content === "/done") {
          await firstWrite;
        }
      },
    );
    const state = new SessionDoneCoordinator({
      sessionMetadataService: {
        getMetadata: () => undefined,
        updateMetadata: async () => {},
        recordSyntheticDone,
      } as unknown as SessionMetadataService,
      getProcessForSession: () => process,
      cancelInFlightForkedRecap: () => {},
      requestMaintenanceSweep: () => {},
    });
    await state.requestSessionDone("session-1", "/done");
    (process as unknown as { state: { type: "idle" } }).state = {
      type: "idle",
    };

    const finalize = state.finalizePendingDone(process);
    await vi.waitFor(() => expect(recordSyntheticDone).toHaveBeenCalledOnce());
    const archive = state.requestSessionDone("session-1", "/archive");
    await Promise.resolve();
    expect(recordSyntheticDone).toHaveBeenCalledOnce();

    releaseFirstWrite();
    await expect(finalize).resolves.toMatchObject({ content: "/done" });
    await expect(archive).resolves.toMatchObject({
      queued: false,
      message: { content: "/archive" },
    });
    expect(
      recordSyntheticDone.mock.calls.map((call) => call[1].content),
    ).toEqual(["/done", "/archive"]);
  });

  it("persists idle /archive and the automation pause atomically", async () => {
    const recordSyntheticDone = vi.fn(async () => {});
    const state = new SessionDoneCoordinator({
      sessionMetadataService: {
        getMetadata: () => undefined,
        recordSyntheticDone,
      } as unknown as SessionMetadataService,
      getProcessForSession: () => undefined,
      cancelInFlightForkedRecap: () => {},
      requestMaintenanceSweep: () => {},
    });

    const result = await state.requestSessionDone("session-1", "/archive");

    expect(recordSyntheticDone).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        content: "/archive",
        message: { role: "user", content: "/archive" },
      }),
      { archived: true },
    );
    expect(result).toMatchObject({
      queued: false,
      message: { content: "/archive" },
    });
  });

  it("upgrades a persisted /done after its process is gone", async () => {
    const message = {
      type: "user" as const,
      content: "/done" as const,
      message: { role: "user" as const, content: "/done" as const },
      timestamp: "2026-08-16T10:00:00.000Z",
      uuid: "durable-boundary-1",
      id: "durable-boundary-1",
      isSynthetic: true as const,
      yaSyntheticSource: "done" as const,
    };
    const updateMetadata = vi.fn(async () => {});
    const state = new SessionDoneCoordinator({
      sessionMetadataService: {
        getMetadata: () => ({
          automationPausedUntilUserTurn: true,
          pendingSyntheticDone: { message, userTurnVersion: 4 },
        }),
        updateMetadata,
      } as unknown as SessionMetadataService,
      getProcessForSession: () => undefined,
      cancelInFlightForkedRecap: () => {},
      requestMaintenanceSweep: () => {},
    });

    await expect(
      state.requestSessionDone("session-1", "/archive"),
    ).resolves.toMatchObject({
      queued: true,
      message: {
        uuid: "durable-boundary-1",
        timestamp: "2026-08-16T10:00:00.000Z",
        content: "/archive",
      },
    });
    expect(updateMetadata).toHaveBeenCalledWith("session-1", {
      automationPausedUntilUserTurn: true,
      archived: true,
      pendingSyntheticDone: {
        message: expect.objectContaining({
          uuid: "durable-boundary-1",
          content: "/archive",
        }),
        userTurnVersion: 4,
      },
    });
  });

  it("finalizes a persisted boundary when its process is already gone", async () => {
    const message = {
      type: "user" as const,
      content: "/done" as const,
      message: { role: "user" as const, content: "/done" as const },
      timestamp: "2026-08-16T10:00:00.000Z",
      uuid: "durable-boundary-1",
      id: "durable-boundary-1",
      isSynthetic: true as const,
      yaSyntheticSource: "done" as const,
    };
    let pendingMessage: DurableSyntheticDoneMessage = message;
    const recordSyntheticDone = vi.fn(async () => {});
    const state = new SessionDoneCoordinator({
      sessionMetadataService: {
        getMetadata: () => ({
          automationPausedUntilUserTurn: true,
          pendingSyntheticDone: {
            message: pendingMessage,
            userTurnVersion: 4,
          },
        }),
        updateMetadata: vi.fn<SessionMetadataService["updateMetadata"]>(
          async (_sessionId, updates) => {
            pendingMessage =
              updates.pendingSyntheticDone?.message ?? pendingMessage;
          },
        ),
        recordSyntheticDone,
      } as unknown as SessionMetadataService,
      getProcessForSession: () => undefined,
      cancelInFlightForkedRecap: () => {},
      requestMaintenanceSweep: () => {},
    });

    const result = await state.requestSessionBoundaryForStop(
      "session-1",
      "/terminate",
    );

    expect(result).toMatchObject({
      queued: false,
      message: { content: "/terminate", uuid: "durable-boundary-1" },
    });
    expect(recordSyntheticDone).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ content: "/terminate" }),
      { archived: true },
    );
  });

  it.each(["/done", "/archive", "/terminate"] as const)(
    "recovers and finalizes a queued %s boundary on a replacement process",
    async (command) => {
      const process = coordinatorProcess();
      const recordSyntheticDone = vi.fn(async () => {});
      const message = {
        type: "user" as const,
        content: command,
        message: { role: "user" as const, content: command },
        timestamp: "2026-08-16T10:00:00.000Z",
        uuid: "durable-boundary-1",
        id: "durable-boundary-1",
        isSynthetic: true as const,
        yaSyntheticSource: "done" as const,
      };
      const state = new SessionDoneCoordinator({
        sessionMetadataService: {
          getMetadata: () => ({
            automationPausedUntilUserTurn: true,
            pendingSyntheticDone: { message, userTurnVersion: 4 },
          }),
          recordSyntheticDone,
        } as unknown as SessionMetadataService,
        getProcessForSession: () => process,
        cancelInFlightForkedRecap: () => {},
        requestMaintenanceSweep: () => {},
      });

      state.recoverPendingDone(process);

      expect(process.getPendingYaCommand("done")).toMatchObject({
        content: command,
        tempId: "durable-boundary-1",
        timestamp: "2026-08-16T10:00:00.000Z",
        userTurnVersion: process.userTurnVersion,
      });
      expect(process.pauseRecapsUntilUserTurn).toHaveBeenCalled();

      (process as unknown as { state: { type: "idle" } }).state = {
        type: "idle",
      };
      await expect(state.finalizePendingDone(process)).resolves.toEqual(
        message,
      );
      if (command !== "/done") {
        expect(recordSyntheticDone).toHaveBeenCalledWith("session-1", message, {
          archived: true,
        });
      } else {
        expect(recordSyntheticDone).toHaveBeenCalledWith("session-1", message);
      }
      expect(process.hasPendingYaCommand("done")).toBe(false);
    },
  );

  it("resumes automation when the replacement process takes a user turn", async () => {
    // The requesting process counted four user turns; its replacement starts
    // its own count at zero, so the recovered boundary must wait for a turn
    // this process sees rather than one it can never reach.
    const process = coordinatorProcess({
      userTurnVersion: 0,
    } as unknown as Partial<Process>);
    const message = {
      type: "user" as const,
      content: "/done" as const,
      message: { role: "user" as const, content: "/done" as const },
      timestamp: "2026-08-16T10:00:00.000Z",
      uuid: "durable-boundary-1",
      id: "durable-boundary-1",
      isSynthetic: true as const,
      yaSyntheticSource: "done" as const,
    };
    const updateMetadata = vi.fn(async () => {});
    const state = new SessionDoneCoordinator({
      sessionMetadataService: {
        getMetadata: () => ({
          automationPausedUntilUserTurn: true,
          pendingSyntheticDone: { message, userTurnVersion: 4 },
        }),
        recordSyntheticDone: async () => {},
        updateMetadata,
      } as unknown as SessionMetadataService,
      getProcessForSession: () => process,
      cancelInFlightForkedRecap: () => {},
      requestMaintenanceSweep: () => {},
    });

    state.recoverPendingDone(process);
    expect(process.getPendingYaCommand("done")?.userTurnVersion).toBe(0);

    (process as unknown as { userTurnVersion: number }).userTurnVersion = 1;
    (process as unknown as { state: { type: "idle" } }).state = {
      type: "idle",
    };
    await state.finalizePendingDone(process);

    expect(updateMetadata).toHaveBeenCalledWith("session-1", {
      automationPausedUntilUserTurn: false,
    });
    expect(process.resumeRecapsAfterUserTurn).toHaveBeenCalled();
  });

  it("does not queue /done when the pause cannot be persisted", async () => {
    const process = coordinatorProcess();
    const queueYaCommand = vi.fn(process.queueYaCommand);
    process.queueYaCommand = queueYaCommand;
    const state = new SessionDoneCoordinator({
      sessionMetadataService: {
        getMetadata: () => undefined,
        updateMetadata: async () => {
          throw new Error("disk full");
        },
      } as unknown as SessionMetadataService,
      getProcessForSession: () => process,
      cancelInFlightForkedRecap: () => {},
      requestMaintenanceSweep: () => {},
    });

    await expect(state.requestSessionDone("session-1")).rejects.toThrow(
      "disk full",
    );
    expect(queueYaCommand).not.toHaveBeenCalled();
    expect(process.hasPendingYaCommand("done")).toBe(false);
  });
});
