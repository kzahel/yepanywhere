import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type PermissionRules, toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataService } from "../../src/metadata/index.js";
import { ProjectQueueService } from "../../src/services/ProjectQueueService.js";
import { QueueRestartHandoff } from "../../src/services/QueueRestartHandoff.js";
import {
  SessionQueuePersistenceService,
  type PersistedSessionQueuedMessage,
} from "../../src/services/SessionQueuePersistenceService.js";
import { restoreRestartQueues } from "../../src/services/restoreRestartQueues.js";
import { shutdownProviderSessions } from "../../src/server-provider-shutdown.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { ProviderRetentionSnapshot } from "../../src/sdk/types.js";
import { DiscoverySqliteService } from "../../src/storage/discovery-sqlite.js";
import {
  MessageQueue,
  Process,
  createControllableIterator,
} from "../process.test-support.js";

const projectPath = "/tmp/queue-restart-project";
const projectId = toUrlProjectId(projectPath);
const exitedPid = spawnSync(process.execPath, ["-e", ""]).pid;

function patient(
  id: string,
  status: PersistedSessionQueuedMessage["status"] = "queued",
): PersistedSessionQueuedMessage {
  return {
    id,
    sessionId: "session-a",
    projectId,
    projectPath,
    provider: "codex",
    kind: "patient",
    status,
    message: { text: id, metadata: { deliveryIntent: "patient" } },
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
    queuedAt: `2026-11-14T00:00:0${id.endsWith("2") ? 2 : 1}.000Z`,
  };
}

describe("orderly queue restart", () => {
  let dataDir: string;
  let projects: ProjectQueueService;
  let sessions: SessionQueuePersistenceService;
  let handoff: QueueRestartHandoff;
  let metadata: SessionMetadataService;
  let storage: DiscoverySqliteService;
  const controllers: ReturnType<typeof createControllableIterator>[] = [];

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ya-queue-restart-"));
    projects = new ProjectQueueService({ dataDir });
    sessions = new SessionQueuePersistenceService({ dataDir });
    await projects.initialize();
    await sessions.initialize();
    await projects.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath,
      request: {
        target: { type: "existing-session", sessionId: "session-a" },
        message: { text: "project followup" },
      },
    });
    handoff = new QueueRestartHandoff(dataDir, projects, sessions);
    storage = new DiscoverySqliteService({
      dataDir,
      probeNetworkFilesystem: () => undefined,
    });
    metadata = new SessionMetadataService({
      dataDir,
      database: storage.getDatabase(),
    });
    await metadata.initialize();
  });

  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.finish();
    await metadata?.flushPendingWrites();
    storage?.close();
    await fs.rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function exitedHandoff() {
    handoff.commit();
    const filename = path.join(dataDir, "queue-restart-handoff.json");
    const record = JSON.parse(await fs.readFile(filename, "utf8"));
    // The committing process exits before its successor consumes this file.
    await fs.writeFile(filename, JSON.stringify({ ...record, pid: exitedPid }));
    projects = new ProjectQueueService({ dataDir });
    sessions = new SessionQueuePersistenceService({ dataDir });
    handoff = new QueueRestartHandoff(dataDir, projects, sessions);
    const loaded = handoff.consume();
    expect(loaded).toBeDefined();
    expect(handoff.consume()).toBeUndefined();
    await projects.initialize();
    await sessions.initialize();
    return loaded;
  }

  function owner(
    provider: "claude" | "codex" = "codex",
    permissions?: PermissionRules,
    retention?: ProviderRetentionSnapshot,
  ) {
    const controller = createControllableIterator();
    controllers.push(controller);
    const queue = new MessageQueue();
    let stopped = false;
    const process = new Process(controller.iterator, {
      projectPath,
      projectId,
      sessionId: "session-a",
      provider,
      queue,
      initialState: "idle",
      permissions,
      getProviderRetentionFn: () =>
        retention ?? { retained: false, reasons: [] },
      isProcessAlive: () => !stopped,
      abortFn: async () => {
        stopped = true;
        controller.finish();
      },
      idleTimeoutMs: 60_000,
      sessionQueuePersistenceService: sessions,
    });
    return { process, queue };
  }

  it("restores ordered waiting messages before enabling project dispatch", async () => {
    await sessions.replaceAll([patient("patient-1"), patient("patient-2")]);
    await handoff.prepare();
    const record = await exitedHandoff();
    const { process, queue } = owner();
    const resume = vi
      .spyOn(projects, "resumeDispatch")
      .mockImplementation(async () => {
        expect(queue.depth + process.getDeferredQueueSummary().length).toBe(2);
        return { status: "running" };
      });
    await restoreRestartQueues(record, {
      projectQueueService: projects,
      sessionQueuePersistenceService: sessions,
      sessionMetadataService: metadata,
      supervisor: {
        getProcessForSession: () => process,
        reactivateSession: vi.fn(),
      },
      getGlobalInstructions: () => undefined,
    });
    expect(resume).toHaveBeenCalledOnce();
    expect(queue.drain()[0]?.text).toBe("patient-1");
    expect(process.getDeferredQueueSummary().map((row) => row.content)).toEqual(
      ["patient-2"],
    );
    await process.waitForPatientQueuePersistenceIdle();
    expect(sessions.list().map((item) => item.id)).toEqual(["patient-2"]);
  });

  it("restores patient conditions on a cold owner without changing a manual Project Queue pause", async () => {
    await projects.pauseDispatch("manual");
    await sessions.replaceAll([patient("patient-1")]);
    await handoff.prepare([owner("claude").process]);
    const record = await exitedHandoff();
    const { process, queue } = owner("claude");
    const reactivateSession = vi
      .fn<Supervisor["reactivateSession"]>()
      .mockResolvedValue(process);
    await restoreRestartQueues(record, {
      projectQueueService: projects,
      sessionQueuePersistenceService: sessions,
      sessionMetadataService: metadata,
      supervisor: { getProcessForSession: () => undefined, reactivateSession },
      getGlobalInstructions: () => undefined,
    });
    expect(reactivateSession).toHaveBeenCalledOnce();
    expect(queue.depth).toBe(0);
    expect(process.getDeferredQueueSummary()).toHaveLength(1);
    expect(sessions.list()[0]?.status).toBe("queued");
    expect(projects.getDispatchState()).toMatchObject({
      status: "paused",
      reason: "manual",
    });
  });

  it.each(["failed", "compacting"] as const)(
    "does not reopen a %s patient compaction gate",
    async (gate) => {
      const { process } = owner("claude");
      process.deferMessage(
        {
          text: "gated",
          tempId: "gated",
          metadata: {
            deliveryIntent: "patient",
            compactAboveContextPercent: 50,
          },
        },
        { promoteIfReady: false },
      );
      expect(process.setCompactionGate("gated", gate)).toBe(true);
      await process.waitForPatientQueuePersistenceIdle();
      handoff.rememberPatientQueues([process]);
      // Safe restart can preserve the row after retiring its in-memory gate.
      await process.preservePatientDeferredMessagesForRestart();
      await handoff.prepare();
      const record = await exitedHandoff();
      expect(record?.patientIds).toEqual([]);
      expect(sessions.list()[0]?.status).toBe("paused-after-restart");
    },
  );

  it("honors saved default model and service tier over old queue launch values", async () => {
    await sessions.replaceAll([
      { ...patient("patient-1"), model: "old-model", serviceTier: "priority" },
    ]);
    await metadata.recordEffectiveLaunchSettings("session-a", {
      permissionMode: "default",
      requestedModel: null,
      serviceTier: null,
      thinking: null,
      effort: null,
    });
    await handoff.prepare([owner().process]);
    const record = await exitedHandoff();
    const { process } = owner();
    const reactivateSession = vi
      .fn<Supervisor["reactivateSession"]>()
      .mockResolvedValue(process);
    await restoreRestartQueues(record, {
      projectQueueService: projects,
      sessionQueuePersistenceService: sessions,
      sessionMetadataService: metadata,
      supervisor: { getProcessForSession: () => undefined, reactivateSession },
      getGlobalInstructions: () => undefined,
    });
    expect(reactivateSession.mock.calls[0]?.[3]).toMatchObject({
      requestedModel: "default",
    });
    expect(reactivateSession.mock.calls[0]?.[3]?.model).toBeUndefined();
    expect(reactivateSession.mock.calls[0]?.[3]?.serviceTier).toBeUndefined();
    await process.waitForPatientQueuePersistenceIdle();
  });

  it("restores the prior owner's tool restrictions during automatic cold resume", async () => {
    await sessions.replaceAll([patient("patient-1")]);
    const previous = owner("codex", {
      deny: ["Bash(rm *)"],
      allow: ["Read"],
    }).process;
    await handoff.prepare([previous]);
    const record = await exitedHandoff();
    const { process } = owner();
    const reactivateSession = vi
      .fn<Supervisor["reactivateSession"]>()
      .mockResolvedValue(process);
    await restoreRestartQueues(record, {
      projectQueueService: projects,
      sessionQueuePersistenceService: sessions,
      sessionMetadataService: metadata,
      supervisor: { getProcessForSession: () => undefined, reactivateSession },
      getGlobalInstructions: () => undefined,
    });
    expect(handoff.permissionRulesForSession("session-a", undefined)).toEqual(
      previous.permissions,
    );
    expect(
      handoff.permissionRulesForSession("session-a", process),
    ).toBeUndefined();
    expect(reactivateSession.mock.calls[0]?.[3]?.permissions).toEqual({
      deny: ["Bash(rm *)"],
      allow: ["Read"],
    });
    await process.waitForPatientQueuePersistenceIdle();
  });

  it("preserves rules across repeated restarts before a cold Project Queue target runs", async () => {
    const previous = owner("codex", { deny: ["Bash(rm *)"] }).process;
    await handoff.prepare([previous]);
    await exitedHandoff();
    expect(handoff.permissionRulesForSession("session-a", undefined)).toEqual(
      previous.permissions,
    );
    await handoff.prepare();
    const repeated = await exitedHandoff();
    expect(repeated?.sessionPermissions).toEqual([
      ["session-a", previous.permissions],
    ]);
    expect(handoff.permissionRulesForSession("session-a", undefined)).toEqual(
      previous.permissions,
    );
  });

  it("does not call a stop that kills non-retaining Codex background work orderly", async () => {
    const { process } = owner("codex", undefined, {
      retained: false,
      reasons: [],
      backgroundWork: [
        {
          id: "terminal",
          kind: "shell",
          label: "running command",
          source: "test",
        },
      ],
    });
    expect(process.getLivenessSnapshot().derivedStatus).toBe("verified-idle");
    expect(process.isRetainingProviderWork()).toBe(false);
    const supervisor = {
      getAllProcesses: () => [process],
      stopBackgroundTasks: async () => {},
      getWorkerActivity: () => ({ queueLength: 0 }),
      prepareForServerReload: async () => {},
    } as unknown as Supervisor;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await shutdownProviderSessions("SIGTERM", supervisor, handoff)).toBe(
      false,
    );
    expect(process.isProcessAlive).toBe(false);
    log.mockRestore();
  });

  it("retains the running intent across a scheduled restart's temporary pause", async () => {
    await sessions.replaceAll([
      patient("patient-1"),
      patient("old-paused", "paused-after-restart"),
    ]);
    expect(await handoff.pauseProjectQueue()).toBe(true);
    handoff.rememberPatientQueues();
    await sessions.upsertItem(patient("patient-1", "paused-after-restart"));
    await handoff.prepare();
    const record = await exitedHandoff();
    expect(record?.resumeProjectQueue).toBe(true);
    expect(record?.patientIds).toEqual(["patient-1"]);
    const reactivateSession = vi.fn();
    await restoreRestartQueues(record, {
      projectQueueService: projects,
      sessionQueuePersistenceService: sessions,
      sessionMetadataService: metadata,
      supervisor: { getProcessForSession: () => undefined, reactivateSession },
      getGlobalInstructions: () => undefined,
    });
    expect(reactivateSession).not.toHaveBeenCalled();
    expect(
      sessions.list().every((item) => item.status === "paused-after-restart"),
    ).toBe(true);
    expect(projects.getDispatchState()).toEqual({ status: "running" });
  });

  it("does not resume a later manual pause when a scheduled restart is cancelled", async () => {
    expect(await handoff.pauseProjectQueue()).toBe(true);
    await projects.pauseDispatch("manual");
    await handoff.cancelScheduledRestart();
    expect(projects.getDispatchState()).toMatchObject({
      status: "paused",
      reason: "manual",
    });
  });

  it("leaves crash recovery, uncertain work and explicitly killed sessions paused", async () => {
    await sessions.replaceAll([
      patient("patient-1"),
      { ...patient("uncertain", "claimed"), sessionId: "other" },
    ]);
    expect(handoff.consume()).toBeUndefined();
    await handoff.prepare();
    const record = await exitedHandoff();
    expect(record?.patientIds).toEqual(["patient-1"]);
    await metadata.updateMetadata("session-a", { autoResumeDisabled: true });
    const reactivateSession = vi.fn();
    await restoreRestartQueues(record, {
      projectQueueService: projects,
      sessionQueuePersistenceService: sessions,
      sessionMetadataService: metadata,
      supervisor: { getProcessForSession: () => undefined, reactivateSession },
      getGlobalInstructions: () => undefined,
    });
    expect(reactivateSession).not.toHaveBeenCalled();
    expect(
      sessions.list().every((item) => item.status === "paused-after-restart"),
    ).toBe(true);
  });

  it("rejects live, expired and malformed handoffs without leaving reusable permission", async () => {
    await handoff.prepare();
    handoff.commit();
    expect(handoff.consume()).toBeUndefined(); // This controller is still alive.
    expect(handoff.consume()).toBeUndefined();
    const filename = path.join(dataDir, "queue-restart-handoff.json");
    await fs.writeFile(
      filename,
      JSON.stringify({
        version: 1,
        pid: exitedPid,
        createdAt: Date.now() - 301_000,
      }),
    );
    expect(handoff.consume()).toBeUndefined();
    expect(handoff.consume()).toBeUndefined();
    await fs.writeFile(filename, "null");
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(handoff.consume()).toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
  });
});
