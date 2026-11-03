import {
  createTestSessionMetadataService,
  closeTestDiscoveryDatabases,
} from "../utils/session-metadata-database.js";
import type { SessionCreationStore } from "../../src/sessions/SessionCreationStore.js";
import { snapshotCreationLaunch } from "../../src/sessions/session-creation-launch.js";
let admittedCreations: SessionCreationStore;
import {
  type LimitedUserGrants,
  type PermissionMode,
  type SessionClearloopJob,
  toUrlProjectId,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "../../src/logging/logger.js";
import type { SessionMetadataService } from "../../src/metadata/index.js";
import type { UserMessage } from "../../src/sdk/types.js";
import { ClearloopService } from "../../src/services/ClearloopService.js";
import type {
  ModelSettings,
  SessionLaunchOptions,
  Supervisor,
} from "../../src/supervisor/Supervisor.js";
import {
  ProjectQueueScheduler,
  type ProjectQueueDispatchResult,
  type ProjectQueueExternalTracker,
  type ProjectQueueProcessSnapshot,
  type ProjectQueueSessionLaunchMetadata,
  type ProjectQueueSupervisor,
} from "../../src/services/ProjectQueueScheduler.js";
import { ProjectQueueService } from "../../src/services/ProjectQueueService.js";
import { SessionQueuePersistenceService } from "../../src/services/SessionQueuePersistenceService.js";
import { EventBus } from "../../src/watcher/EventBus.js";

const PROJECT_PATH = "/tmp/project-queue-scheduler";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  assertion: () => void | Promise<void>,
  timeoutMs = 2000,
): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await wait(5);
    }
  }
  if (lastError) throw lastError;
}

function createProcess(
  projectId: UrlProjectId,
  overrides: Partial<ProjectQueueProcessSnapshot> = {},
): ProjectQueueProcessSnapshot {
  const process: ProjectQueueProcessSnapshot = {
    id: "process-1",
    sessionId: "session-1",
    projectId,
    projectPath: PROJECT_PATH,
    state: { type: "idle" },
    queueDepth: 0,
    provider: "claude",
    promptSuggestionMode: "native",
    recapAfterSeconds: 300,
    isRetainingProviderWork: () => false,
    getPendingInputRequest: () => null,
    getDeferredQueueSummary: () => [],
    hasPendingYaCommand: () => false,
    getLivenessSnapshot: () => ({
      derivedStatus:
        process.state.type === "idle" ? "verified-idle" : "recently-active",
    }),
    ...overrides,
  };
  return process;
}

class FakeSupervisor implements ProjectQueueSupervisor {
  processes: ProjectQueueProcessSnapshot[] = [];
  queueInfo: { projectId: UrlProjectId }[] = [];
  resumeCalls: {
    sessionId: string;
    projectPath: string;
    message: UserMessage;
  }[] = [];
  startCalls: { projectPath: string; message: UserMessage }[] = [];
  createCalls: { projectPath: string }[] = [];
  resumeError: Error | null = null;
  startError: Error | null = null;
  createError: Error | null = null;
  resumeBlocker: Promise<void> | null = null;
  queueNextStart = false;
  startModelSettings: Array<ModelSettings | undefined> = [];
  resumeModelSettings: Array<ModelSettings | undefined> = [];
  startLaunchOptions: SessionLaunchOptions | undefined;
  createLaunchOptions: SessionLaunchOptions | undefined;
  resumeLaunchOptions: SessionLaunchOptions | undefined;

  constructor(private projectId: UrlProjectId) {}

  getAllProcesses(): ProjectQueueProcessSnapshot[] {
    return this.processes;
  }

  getQueueInfo(): { projectId: UrlProjectId }[] {
    return this.queueInfo;
  }

  async startSession(
    projectPath: string,
    message: UserMessage,
    _permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    launchOptions?: SessionLaunchOptions,
  ): Promise<ProjectQueueDispatchResult> {
    this.startCalls.push({ projectPath, message });
    this.startModelSettings.push(modelSettings);
    this.startLaunchOptions = launchOptions;
    if (this.startError) throw this.startError;
    const creation = launchOptions?.creation;
    if (!creation)
      throw new Error("Fixture expected trusted admission context");
    // Model the accepted-result boundary only. Real Supervisor/SQLite/native
    // integration owns dispatch, uncertainty and attachment regression coverage.
    const saved = admittedCreations.admit({
      requestId: creation.requestId!,
      context: creation.context,
      request: {
        provider: modelSettings?.providerName ?? "claude",
        projectPath,
        projectId: this.projectId,
        message: message.text,
        settings: {
          permissionMode: _permissionMode ?? "default",
          requestedModel:
            modelSettings?.requestedModel ?? modelSettings?.model ?? null,
          serviceTier: modelSettings?.serviceTier ?? null,
          thinking: modelSettings?.thinking ?? null,
          effort: modelSettings?.effort ?? null,
        },
        launch: snapshotCreationLaunch({ ...modelSettings }),
      },
    });
    await creation.onAccepted?.(saved);
    if (this.queueNextStart) {
      return { queued: true, queueId: "worker-queue-1", position: 1 };
    }
    const process = createProcess(this.projectId, {
      id: `started-${this.startCalls.length}`,
      sessionId: saved.sessionId,
    });
    this.processes.push(process);
    await launchOptions?.onStarted?.(
      process.sessionId,
      process as unknown as import("../../src/supervisor/Process.js").Process,
    );
    return process;
  }

  async createSession(
    projectPath: string,
    _permissionMode?: PermissionMode,
    _modelSettings?: ModelSettings,
    launchOptions?: SessionLaunchOptions,
  ): Promise<ProjectQueueDispatchResult> {
    this.createCalls.push({ projectPath });
    this.createLaunchOptions = launchOptions;
    if (this.createError) throw this.createError;
    const process = createProcess(this.projectId, {
      id: `created-${this.createCalls.length}`,
      sessionId: `created-session-${this.createCalls.length}`,
    });
    this.processes.push(process);
    return process;
  }

  async resumeSession(
    sessionId: string,
    projectPath: string,
    message: UserMessage,
    _permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    launchOptions?: SessionLaunchOptions,
  ): Promise<ProjectQueueDispatchResult> {
    this.resumeCalls.push({ sessionId, projectPath, message });
    this.resumeModelSettings.push(modelSettings);
    this.resumeLaunchOptions = launchOptions;
    await this.resumeBlocker;
    if (this.resumeError) throw this.resumeError;
    const process = createProcess(this.projectId, { sessionId });
    this.processes.push(process);
    return process;
  }
}

class FakeExternalTracker implements ProjectQueueExternalTracker {
  sessions = new Map<string, UrlProjectId>();

  getExternalSessions(): string[] {
    return [...this.sessions.keys()];
  }

  async getExternalSessionInfoWithUrlId(
    sessionId: string,
  ): Promise<{ projectId: UrlProjectId; lastActivity: Date } | null> {
    const projectId = this.sessions.get(sessionId);
    return projectId ? { projectId, lastActivity: new Date() } : null;
  }
}

describe("ProjectQueueScheduler", () => {
  let testDir: string;
  let projectId: UrlProjectId;
  let eventBus: EventBus;
  let service: ProjectQueueService;
  let supervisor: FakeSupervisor;
  let scheduler: ProjectQueueScheduler;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "project-queue-scheduler-"),
    );
    projectId = toUrlProjectId(PROJECT_PATH);
    const metadata = createTestSessionMetadataService(testDir);
    await metadata.initialize();
    admittedCreations = metadata.creations;
    eventBus = new EventBus();
    service = new ProjectQueueService({ dataDir: testDir, eventBus });
    await service.initialize();
    supervisor = new FakeSupervisor(projectId);
    scheduler = new ProjectQueueScheduler({
      creations: admittedCreations,
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 1,
      blockedRetryMs: 10,
    });
  });

  afterEach(async () => {
    await scheduler.dispose();
    vi.restoreAllMocks();
    closeTestDiscoveryDatabases();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("polls external readiness no faster than ten seconds and publishes the hold", async () => {
    await scheduler.dispose();
    projectId = toUrlProjectId(testDir);
    supervisor = new FakeSupervisor(projectId);
    const gate = path.join(testDir, "occupied");
    const probes = path.join(testDir, "probes");
    await fs.writeFile(gate, "occupied");
    scheduler = new ProjectQueueScheduler({
      creations: admittedCreations,
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 0,
      blockedRetryMs: 1,
      getReadinessCommand: () => ({
        executable: process.execPath,
        args: [
          "-e",
          "const fs = require('node:fs'); fs.appendFileSync('probes', 'x'); if (fs.existsSync('occupied')) { console.log('Editing parser'); process.exitCode = 1; }",
        ],
      }),
    });
    const events: string[] = [];
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.type === "project-queue-changed") events.push(event.reason);
    });
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: testDir,
      request: {
        target: { type: "new-session", provider: "claude" },
        message: { text: "after claim" },
      },
    });
    await waitFor(async () => {
      const status = await scheduler.getProjectStatus(projectId);
      expect(status.state).toBe("blocked");
      expect(status.blockers).toContain("readiness:Editing parser");
    });
    expect(events).toContain("readiness");
    for (let i = 0; i < 5; i++)
      scheduler.sessionProjectChanged(projectId, projectId);
    const status = await scheduler.getProjectStatus(projectId);
    expect(Date.parse(status.nextAttemptAt!) - Date.now()).toBeGreaterThan(
      9000,
    );
    expect(await fs.readFile(probes, "utf8")).toBe("x");
    expect(supervisor.startCalls).toHaveLength(0);
    await fs.unlink(gate);
    await waitFor(() => expect(supervisor.startCalls).toHaveLength(1), 15000);
    expect(await fs.readFile(probes, "utf8")).toBe("xx");
    unsubscribe();
  }, 20000);

  it("waits for quiet after readiness clears and checks again before automatic promotion", async () => {
    await scheduler.dispose();
    projectId = toUrlProjectId(testDir);
    supervisor = new FakeSupervisor(projectId);
    scheduler = new ProjectQueueScheduler({
      creations: admittedCreations,
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 100,
      getReadinessCommand: () => ({
        executable: process.execPath,
        args: ["-e", "require('node:fs').appendFileSync('probes', 'x')"],
      }),
    });
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: testDir,
      request: {
        target: { type: "new-session", provider: "claude" },
        message: { text: "after quiet" },
      },
    });
    await waitFor(async () =>
      expect((await scheduler.getProjectStatus(projectId)).state).toBe(
        "waiting-quiet",
      ),
    );
    await wait(150);
    expect(supervisor.startCalls).toHaveLength(0);
    expect(await fs.readFile(path.join(testDir, "probes"), "utf8")).toBe("x");
    await waitFor(() => expect(supervisor.startCalls).toHaveLength(1), 15000);
    expect(await fs.readFile(path.join(testDir, "probes"), "utf8")).toBe("xx");
  }, 20000);

  it("cancels a live check when paused and uses the new command on resume", async () => {
    await scheduler.dispose();
    projectId = toUrlProjectId(testDir);
    supervisor = new FakeSupervisor(projectId);
    let command = {
      executable: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync('started', 'x'); setInterval(() => {}, 1000)",
      ],
    };
    scheduler = new ProjectQueueScheduler({
      creations: admittedCreations,
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 0,
      getReadinessCommand: () => command,
    });
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: testDir,
      request: {
        target: { type: "new-session", provider: "claude" },
        message: { text: "after resume" },
      },
    });
    await waitFor(async () =>
      expect(await fs.readFile(path.join(testDir, "started"), "utf8")).toBe(
        "x",
      ),
    );
    await service.pauseDispatch();
    await waitFor(async () =>
      expect((await scheduler.getProjectStatus(projectId)).inFlight).toBe(
        false,
      ),
    );
    expect((await scheduler.getProjectStatus(projectId)).state).toBe("paused");
    expect(supervisor.startCalls).toHaveLength(0);
    command = { executable: process.execPath, args: ["-e", "process.exit(0)"] };
    scheduler.readinessSettingsChanged();
    expect((await scheduler.promoteNow(projectId)).promoted).toBe(true);
  });

  it("checks Start now, applies changed settings, and lets Force start bypass", async () => {
    await scheduler.dispose();
    projectId = toUrlProjectId(testDir);
    supervisor = new FakeSupervisor(projectId);
    let command = {
      executable: process.execPath,
      args: ["-e", "console.log('Outside editor'); process.exitCode = 1"],
    };
    scheduler = new ProjectQueueScheduler({
      creations: admittedCreations,
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 30000,
      getReadinessCommand: () => command,
    });
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: testDir,
      request: {
        target: { type: "new-session", provider: "claude" },
        message: { text: "manual" },
      },
    });
    await waitFor(async () =>
      expect((await scheduler.getProjectStatus(projectId)).state).toBe(
        "blocked",
      ),
    );
    const blocked = await scheduler.promoteNow(projectId);
    expect(blocked.promoted).toBe(false);
    expect(blocked.status.blockers).toContain("readiness:Outside editor");
    command = {
      executable: process.execPath,
      args: ["-e", "console.log('New check'); process.exitCode = 2"],
    };
    scheduler.readinessSettingsChanged();
    expect((await scheduler.getProjectStatus(projectId)).blockers).toContain(
      "readiness:Waiting for readiness check",
    );
    expect((await scheduler.promoteNow(projectId)).status.blockers).toContain(
      "readiness:New check",
    );
    command = { executable: path.join(testDir, "missing"), args: [] };
    expect(
      (await scheduler.promoteNow(projectId, { force: true })).promoted,
    ).toBe(true);
    expect(supervisor.startCalls).toHaveLength(1);
  });

  it("promotes an existing-session item when the project is idle", async () => {
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "run after idle  " },
      },
    });

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));

    expect(supervisor.resumeCalls[0]).toMatchObject({
      sessionId: "session-1",
      projectPath: PROJECT_PATH,
      message: {
        text: "run after idle  ",
        automaticSource: "project-queue",
      },
    });
    expect(service.listProject(projectId).items).toEqual([]);
  });

  it("runs a queued YA command instead of resuming with its command line", async () => {
    const runs: unknown[] = [];
    scheduler.setYaCommandRunner({
      run: async (input) => {
        runs.push(input);
      },
    });
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: {
          text: "/clearloop 3 2: keep going",
          yaCommand: { name: "clearloop", argument: "3 2: keep going" },
        },
      },
    });

    await waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]).toMatchObject({
      sessionId: "session-1",
      projectId,
      projectPath: PROJECT_PATH,
      command: { name: "clearloop", argument: "3 2: keep going" },
      commandText: "/clearloop 3 2: keep going",
    });
    // The provider is never resumed with the command line as a prompt.
    expect(supervisor.resumeCalls).toHaveLength(0);
    await waitFor(() =>
      expect(service.listProject(projectId).items).toEqual([]),
    );
  });

  it("refuses a retried command whose text no longer spells it", async () => {
    await scheduler.dispose();
    await fs.writeFile(
      path.join(testDir, "project-queues.json"),
      JSON.stringify({
        version: 3,
        items: [
          {
            id: "stale",
            projectId,
            projectPath: PROJECT_PATH,
            target: { type: "existing-session", sessionId: "session-1" },
            // Left behind by a build that let an edit keep the old tag.
            message: {
              text: "summarize instead",
              yaCommand: { name: "clearloop", argument: "3 2: keep going" },
            },
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z",
            status: "queued",
          },
        ],
      }),
    );
    service = new ProjectQueueService({ dataDir: testDir, eventBus });
    await service.initialize();
    await service.resumeDispatch();
    scheduler = new ProjectQueueScheduler({
      creations: admittedCreations,
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 1,
      blockedRetryMs: 10,
    });
    const runs: unknown[] = [];
    scheduler.setYaCommandRunner({
      run: async (input) => {
        runs.push(input);
      },
    });

    await service.retryItem(projectId, "stale");

    await waitFor(() => {
      const [item] = service.listProject(projectId).items;
      expect(item?.lastAttemptAt).toBeDefined();
      expect(item?.status).toBe("failed");
      expect(item?.lastError).toContain("no longer spells /clearloop");
    });
    expect(runs).toHaveLength(0);
    expect(supervisor.resumeCalls).toHaveLength(0);
  });

  it("fails a queued YA command item with the session's refusal", async () => {
    scheduler.setYaCommandRunner({
      run: async () => {
        throw new Error("claude does not support same-session rewind");
      },
    });
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: {
          text: "/clear 7",
          yaCommand: { name: "clear", argument: "7" },
        },
      },
    });

    await waitFor(() => {
      const [item] = service.listProject(projectId).items;
      expect(item?.status).toBe("failed");
      expect(item?.lastError).toContain("same-session rewind");
      // The command text survives for Retry.
      expect(item?.message.text).toBe("/clear 7");
    });
    expect(supervisor.resumeCalls).toHaveLength(0);
  });

  it("holds automatic existing-session work behind a done boundary", async () => {
    await scheduler.dispose();
    scheduler = new ProjectQueueScheduler({
      creations: admittedCreations,
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 1,
      blockedRetryMs: 10,
      isSessionAutomationPaused: (sessionId) => sessionId === "session-1",
    });

    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "wait for a real user turn" },
      },
    });

    await wait(25);
    await expect(scheduler.getProjectStatus(projectId)).resolves.toMatchObject({
      state: "blocked",
      blockers: ["session-1:automation-paused"],
      itemCount: 1,
    });
    expect(supervisor.resumeCalls).toHaveLength(0);
  });

  it("waits for the configured project quiet window before promoting", async () => {
    await scheduler.dispose();
    scheduler = new ProjectQueueScheduler({
      creations: admittedCreations,
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 100,
    });

    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "wait for quiet" },
      },
    });

    await wait(30);
    expect(supervisor.resumeCalls).toHaveLength(0);

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1), 400);
  });

  it("blocks promotion while an admitted user session start is unresolved", async () => {
    await scheduler.dispose();
    scheduler = new ProjectQueueScheduler({
      creations: admittedCreations,
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 25,
    });

    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "queued-session" },
        message: { text: "wait for the user start" },
      },
    });
    const release = scheduler.reserveUserSessionStart(
      projectId,
      "user-session",
    );

    await wait(50);
    expect(supervisor.resumeCalls).toHaveLength(0);
    await expect(scheduler.getProjectIdleStatus(projectId)).resolves.toEqual({
      idle: false,
      blockers: ["user-session:user-starting"],
    });

    release();
    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1), 400);
  });

  it("waits for in-flight promotion work before disposing", async () => {
    let releaseResume!: () => void;
    supervisor.resumeBlocker = new Promise((resolve) => {
      releaseResume = resolve;
    });

    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "finish before teardown" },
      },
    });

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));

    let disposed = false;
    const disposePromise = scheduler.dispose().then(() => {
      disposed = true;
    });
    await wait(25);
    expect(disposed).toBe(false);

    releaseResume();
    await disposePromise;

    expect(disposed).toBe(true);
    expect(service.listProject(projectId).items).toEqual([]);
  });

  it("restarts the project quiet window after session activity", async () => {
    await scheduler.dispose();
    scheduler = new ProjectQueueScheduler({
      creations: admittedCreations,
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 100,
    });

    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "wait after activity" },
      },
    });

    await wait(30);
    eventBus.emit({
      type: "session-updated",
      sessionId: "session-1",
      projectId,
      updatedAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    });
    await wait(40);
    expect(supervisor.resumeCalls).toHaveLength(0);

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1), 400);
  });

  it("resumes a sandboxed session inside its sandbox for a queued turn", async () => {
    await scheduler.dispose();
    scheduler = new ProjectQueueScheduler({
      creations: admittedCreations,
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 1,
      blockedRetryMs: 10,
      getSessionLaunchMetadata: () => ({
        sandboxLevel: "project-write",
        sandboxNetworkFirewall: false,
        sandboxStateKey: "state-1",
        sandboxProjectPath: "/sandboxed/project",
        workingProjectId: projectId,
      }),
    });
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "continue inside the sandbox" },
      },
    });

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));
    expect(supervisor.resumeCalls[0]?.projectPath).toBe("/sandboxed/project");
    expect(supervisor.resumeModelSettings[0]).toMatchObject({
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: false,
      sandboxStateKey: "state-1",
    });
  });

  describe("an item a limited user queued", () => {
    const grantsFor = (level: "new-session" | "join"): LimitedUserGrants => ({
      newSessionProjects: level === "new-session" ? [projectId] : [],
      joinProjects: level === "join" ? [projectId] : [],
      viewProjects: [],
      joinStaleOffsetMinutes: 0,
      lock: { model: "gpt-5" },
    });

    async function schedulerWith(
      grants: LimitedUserGrants | null,
      session?: ProjectQueueSessionLaunchMetadata,
      fresh = true,
    ) {
      await scheduler.dispose();
      scheduler = new ProjectQueueScheduler({
        creations: admittedCreations,
        projectQueueService: service,
        supervisor,
        eventBus,
        idleGraceMs: 1,
        blockedRetryMs: 10,
        getLimitedUserGrants: (username) =>
          username === "alice" ? grants : null,
        getSessionLaunchMetadata: () => session,
        isSessionFreshForLimitedTurn: async () => fresh,
      });
    }

    const ownSandboxedSession: ProjectQueueSessionLaunchMetadata = {
      sandboxLevel: "project-write",
      workingProjectId: projectId,
      createdByUser: "alice",
      provider: "codex",
    };

    it("resumes the user's own fresh session", async () => {
      await schedulerWith(grantsFor("new-session"), ownSandboxedSession);
      await service.createItem({
        creationProvenance: { surface: "api" },
        projectId,
        projectPath: PROJECT_PATH,
        createdByUser: "alice",
        request: {
          target: { type: "existing-session", sessionId: "session-1" },
          message: { text: "continue as alice" },
        },
      });

      await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));
    });

    it("fails a turn to the user's own session once it has gone cold", async () => {
      await schedulerWith(grantsFor("new-session"), ownSandboxedSession, false);
      await service.createItem({
        creationProvenance: { surface: "api" },
        projectId,
        projectPath: PROJECT_PATH,
        createdByUser: "alice",
        request: {
          target: { type: "existing-session", sessionId: "session-1" },
          message: { text: "continue as alice" },
        },
      });

      expect(await failedError()).toMatch(/gone cold/);
      expect(supervisor.resumeCalls).toHaveLength(0);
    });

    async function failedError(): Promise<string | undefined> {
      let lastError: string | undefined;
      await waitFor(() => {
        const [item] = service.listProject(projectId).items;
        expect(item?.status).toBe("failed");
        lastError = item?.lastError;
      });
      return lastError;
    }

    it("launches sandboxed, inside the lock, and attributed to that user", async () => {
      await schedulerWith(grantsFor("new-session"));
      await service.createItem({
        creationProvenance: { surface: "api" },
        projectId,
        projectPath: PROJECT_PATH,
        createdByUser: "alice",
        request: {
          target: {
            type: "new-session",
            provider: "codex",
            sandboxLevel: "none",
          },
          message: {
            text: "start as alice",
            metadata: { sentByUser: "mallory" },
          },
        },
      });

      await waitFor(() => expect(supervisor.startCalls).toHaveLength(1));
      expect(supervisor.startModelSettings[0]).toMatchObject({
        sandboxLevel: "project-write",
        model: "gpt-5",
      });
      expect(supervisor.startCalls[0]?.message.metadata?.sentByUser).toBe(
        "alice",
      );
    });

    it("fails once the user no longer holds the project's new-session grant", async () => {
      await schedulerWith(grantsFor("join"));
      await service.createItem({
        creationProvenance: { surface: "api" },
        projectId,
        projectPath: PROJECT_PATH,
        createdByUser: "alice",
        request: {
          target: { type: "new-session", provider: "codex" },
          message: { text: "start as alice" },
        },
      });

      expect(await failedError()).toMatch(/can no longer start sessions/);
      expect(supervisor.startCalls).toHaveLength(0);
    });

    it("fails a turn to a session that runs outside the sandbox", async () => {
      await schedulerWith(grantsFor("new-session"), {
        sandboxLevel: "none",
        workingProjectId: projectId,
        provider: "codex",
      });
      await service.createItem({
        creationProvenance: { surface: "api" },
        projectId,
        projectPath: PROJECT_PATH,
        createdByUser: "alice",
        request: {
          target: { type: "existing-session", sessionId: "session-1" },
          message: { text: "continue as alice" },
        },
      });

      expect(await failedError()).toMatch(/outside the sandbox/);
      expect(supervisor.resumeCalls).toHaveLength(0);
    });

    it("fails a turn to a sandboxed session whose firewall is off", async () => {
      await schedulerWith(grantsFor("new-session"), {
        sandboxLevel: "project-write",
        sandboxNetworkFirewall: false,
        workingProjectId: projectId,
        provider: "codex",
      });
      await service.createItem({
        creationProvenance: { surface: "api" },
        projectId,
        projectPath: PROJECT_PATH,
        createdByUser: "alice",
        request: {
          target: { type: "existing-session", sessionId: "session-1" },
          message: { text: "continue as alice" },
        },
      });

      expect(await failedError()).toMatch(/network firewall/);
      expect(supervisor.resumeCalls).toHaveLength(0);
    });

    it("launches a new session with the firewall on", async () => {
      await schedulerWith(grantsFor("new-session"));
      await service.createItem({
        creationProvenance: { surface: "api" },
        projectId,
        projectPath: PROJECT_PATH,
        createdByUser: "alice",
        request: {
          target: { type: "new-session", provider: "codex" },
          message: { text: "start as alice" },
        },
      });

      await waitFor(() => expect(supervisor.startCalls).toHaveLength(1));
      expect(supervisor.startModelSettings[0]).toMatchObject({
        sandboxLevel: "project-write",
        sandboxNetworkFirewall: true,
      });
    });
  });

  it("defaults queued project sandboxes to the network firewall", async () => {
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: {
          type: "new-session",
          provider: "claude",
          sandboxLevel: "project-write",
        },
        message: { text: "start with public-only networking" },
      },
    });

    await waitFor(() => expect(supervisor.startCalls).toHaveLength(1));
    expect(supervisor.startModelSettings[0]).toMatchObject({
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: true,
    });
  });

  it("preserves a queued project sandbox network opt-out", async () => {
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: {
          type: "new-session",
          provider: "claude",
          sandboxLevel: "project-write",
          sandboxNetworkFirewall: false,
        },
        message: { text: "start with direct host networking" },
      },
    });

    await waitFor(() => expect(supervisor.startCalls).toHaveLength(1));
    expect(supervisor.startModelSettings[0]).toMatchObject({
      sandboxLevel: "project-write",
      sandboxNetworkFirewall: false,
    });
  });

  it("waits for an active owned process to become verified idle", async () => {
    const process = createProcess(projectId, { state: { type: "in-turn" } });
    supervisor.processes = [process];

    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "blocked while active" },
      },
    });

    await wait(25);
    expect(supervisor.resumeCalls).toHaveLength(0);

    process.state = { type: "idle" };
    eventBus.emit({
      type: "process-state-changed",
      sessionId: process.sessionId,
      projectId,
      activity: "idle",
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));
  });

  it("blocks the relocated working project instead of the launch project", async () => {
    await scheduler.dispose();
    const destinationProjectId = toUrlProjectId("/tmp/relocated-project");
    const process = createProcess(projectId, { state: { type: "in-turn" } });
    supervisor.processes = [process];
    let effectiveProjectId = destinationProjectId;
    scheduler = new ProjectQueueScheduler({
      creations: admittedCreations,
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 1,
      blockedRetryMs: 10,
      getEffectiveProcessProjectId: () => effectiveProjectId,
    });

    await expect(scheduler.getProjectIdleStatus(projectId)).resolves.toEqual({
      idle: true,
      blockers: [],
    });
    await expect(
      scheduler.getProjectIdleStatus(destinationProjectId),
    ).resolves.toMatchObject({
      idle: false,
      blockers: ["session-1:in-turn", "session-1:liveness-recently-active"],
    });

    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId: destinationProjectId,
      projectPath: "/tmp/relocated-project",
      request: {
        target: { type: "existing-session", sessionId: "queued-session" },
        message: { text: "wait for relocated work" },
      },
    });
    await wait(25);
    expect(supervisor.resumeCalls).toHaveLength(0);

    effectiveProjectId = projectId;
    scheduler.sessionProjectChanged(destinationProjectId, projectId);

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));
    expect(supervisor.resumeCalls[0]).toMatchObject({
      sessionId: "queued-session",
      projectPath: "/tmp/relocated-project",
    });
  });

  it("reports project readiness blockers and keeps retrying blocked backlog", async () => {
    await scheduler.dispose();
    const process = createProcess(projectId, { state: { type: "in-turn" } });
    supervisor.processes = [process];
    scheduler = new ProjectQueueScheduler({
      creations: admittedCreations,
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 1,
      blockedRetryMs: 10,
    });

    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "blocked then retry" },
      },
    });

    await wait(25);
    await expect(scheduler.getProjectStatus(projectId)).resolves.toMatchObject({
      state: "blocked",
      idle: false,
      blockers: ["session-1:in-turn", "session-1:liveness-recently-active"],
      itemCount: 1,
      nextItemId: expect.any(String),
    });
    expect(supervisor.resumeCalls).toHaveLength(0);

    process.state = { type: "idle" };

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1), 500);
    expect(supervisor.resumeCalls[0]).toMatchObject({
      sessionId: "session-1",
      message: { text: "blocked then retry" },
    });
    await waitFor(async () => {
      await expect(
        scheduler.getProjectStatus(projectId),
      ).resolves.toMatchObject({
        state: "empty",
        itemCount: 0,
        inFlight: false,
      });
    }, 500);
  });

  it("promoteNow skips the quiet timer but preserves idle blockers", async () => {
    await scheduler.dispose();
    scheduler = new ProjectQueueScheduler({
      creations: admittedCreations,
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 10_000,
    });

    const item = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "start before quiet" },
      },
    });

    const promoted = await scheduler.promoteNow(projectId, { itemId: item.id });
    expect(promoted).toMatchObject({
      promoted: true,
      reason: "promoted",
      itemId: item.id,
      sessionId: "session-1",
    });
    expect(supervisor.resumeCalls).toHaveLength(1);
    expect(supervisor.resumeCalls[0]).toMatchObject({
      sessionId: "session-1",
      message: { text: "start before quiet" },
    });
  });

  it("force promote starts a specific item despite project blockers", async () => {
    const process = createProcess(projectId, { state: { type: "in-turn" } });
    supervisor.processes = [process];
    const item = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-2" },
        message: { text: "force despite blocker" },
      },
    });

    const blocked = await scheduler.promoteNow(projectId, { itemId: item.id });
    expect(blocked).toMatchObject({
      promoted: false,
      reason: "blocked",
      itemId: item.id,
      status: {
        state: "blocked",
        blockers: ["session-1:in-turn", "session-1:liveness-recently-active"],
      },
    });
    expect(supervisor.resumeCalls).toHaveLength(0);

    const forced = await scheduler.promoteNow(projectId, {
      itemId: item.id,
      force: true,
      deliveryIntent: "steer",
    });

    expect(forced).toMatchObject({
      promoted: true,
      reason: "promoted",
      itemId: item.id,
      sessionId: "session-2",
    });
    expect(supervisor.resumeCalls).toHaveLength(1);
    expect(supervisor.resumeCalls[0]).toMatchObject({
      sessionId: "session-2",
      message: {
        text: "force despite blocker",
        metadata: { deliveryIntent: "steer", steerNow: true },
      },
    });
  });

  it("resumes paused dispatch before force-promoting a queued item", async () => {
    await scheduler.dispose();
    scheduler = new ProjectQueueScheduler({
      creations: admittedCreations,
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 10_000,
    });
    const item = await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "steer after restart" },
      },
    });
    await service.pauseDispatch("restart");

    const promoted = await scheduler.promoteNow(projectId, {
      itemId: item.id,
      force: true,
      deliveryIntent: "steer",
    });

    expect(promoted).toMatchObject({
      promoted: true,
      reason: "promoted",
      itemId: item.id,
      sessionId: "session-1",
    });
    expect(service.getDispatchState()).toEqual({ status: "running" });
    expect(supervisor.resumeCalls).toMatchObject([
      {
        sessionId: "session-1",
        message: {
          text: "steer after restart",
          metadata: { deliveryIntent: "steer", steerNow: true },
        },
      },
    ]);
  });

  it("waits for recovered patient queues before promoting project work", async () => {
    await scheduler.dispose();
    const sessionQueuePersistenceService = new SessionQueuePersistenceService({
      dataDir: testDir,
      eventBus,
    });
    await sessionQueuePersistenceService.initialize();
    await sessionQueuePersistenceService.replaceAll([
      {
        id: "persisted-patient-1",
        sessionId: "session-1",
        projectId,
        projectPath: PROJECT_PATH,
        provider: "claude",
        kind: "patient",
        message: { text: "older recovered session work" },
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
        queuedAt: "2026-06-30T00:00:00.000Z",
        status: "paused-after-restart",
      },
    ]);
    scheduler = new ProjectQueueScheduler({
      creations: admittedCreations,
      projectQueueService: service,
      supervisor,
      eventBus,
      sessionQueuePersistenceService,
      idleGraceMs: 1,
    });

    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "project work waits" },
      },
    });

    await wait(25);
    expect(supervisor.resumeCalls).toHaveLength(0);
    await expect(scheduler.getProjectIdleStatus(projectId)).resolves.toEqual({
      idle: false,
      blockers: ["recovered-session-queue:1"],
    });

    await sessionQueuePersistenceService.deleteItem("persisted-patient-1");

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));
    expect(supervisor.resumeCalls[0]).toMatchObject({
      sessionId: "session-1",
      projectPath: PROJECT_PATH,
      message: { text: "project work waits" },
    });
  });

  it("dispatches past a session whose user already queued /done", async () => {
    // The agent is still finishing some final action, but the user has
    // declared the session done, so it is no longer project backlog.
    const process = createProcess(projectId, {
      state: { type: "in-turn" },
      isRetainingProviderWork: () => true,
      getDeferredQueueSummary: () => [{ kind: "ya-command" }],
      hasPendingYaCommand: (command?: "done") => command === "done",
    });
    supervisor.processes = [process];

    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "runs while /done settles" },
      },
    });

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));
  });

  it("still blocks on an in-turn session with no queued /done", async () => {
    const process = createProcess(projectId, {
      state: { type: "in-turn" },
      isRetainingProviderWork: () => true,
    });
    supervisor.processes = [process];

    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "waits for the turn" },
      },
    });

    await wait(25);
    expect(supervisor.resumeCalls).toHaveLength(0);
  });

  it("waits for per-session deferred queues to drain", async () => {
    let deferredQueue: unknown[] = [{ id: "deferred-1" }];
    const process = createProcess(projectId, {
      getDeferredQueueSummary: () => deferredQueue,
    });
    supervisor.processes = [process];

    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "blocked by session queue" },
      },
    });

    await wait(25);
    expect(supervisor.resumeCalls).toHaveLength(0);

    deferredQueue = [];
    eventBus.emit({
      type: "session-updated",
      sessionId: process.sessionId,
      projectId,
      updatedAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));
  });

  it("waits for external ownership to clear", async () => {
    await scheduler.dispose();
    const externalTracker = new FakeExternalTracker();
    externalTracker.sessions.set("external-session", projectId);
    scheduler = new ProjectQueueScheduler({
      creations: admittedCreations,
      projectQueueService: service,
      supervisor,
      eventBus,
      externalTracker,
      idleGraceMs: 1,
    });

    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "blocked by external" },
      },
    });

    await wait(25);
    expect(supervisor.resumeCalls).toHaveLength(0);

    externalTracker.sessions.clear();
    eventBus.emit({
      type: "session-status-changed",
      sessionId: "external-session",
      projectId,
      ownership: { owner: "none" },
      timestamp: new Date().toISOString(),
    });

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));
  });

  it("does not promote while dispatch is paused and resumes on request", async () => {
    await scheduler.dispose();
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "paused project work" },
      },
    });
    await service.pauseDispatch();

    scheduler = new ProjectQueueScheduler({
      creations: admittedCreations,
      projectQueueService: service,
      supervisor,
      eventBus,
      idleGraceMs: 1,
    });

    await wait(25);
    expect(supervisor.resumeCalls).toHaveLength(0);

    await service.resumeDispatch();

    await waitFor(() => expect(supervisor.resumeCalls).toHaveLength(1));
  });

  it("persists a failed dispatch and stops behind it", async () => {
    vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
    supervisor.resumeError = new Error("provider unavailable");

    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-1" },
        message: { text: "first" },
      },
    });
    await service.createItem({
      creationProvenance: { surface: "api" },
      projectId,
      projectPath: PROJECT_PATH,
      request: {
        target: { type: "existing-session", sessionId: "session-2" },
        message: { text: "second" },
      },
    });

    await waitFor(() => {
      expect(service.listProject(projectId).items[0]).toMatchObject({
        status: "failed",
        lastError: "provider unavailable",
      });
    });
    await wait(25);

    expect(supervisor.resumeCalls).toHaveLength(1);
    expect(service.listProject(projectId).items).toMatchObject([
      { status: "failed", messagePreview: "first" },
      { status: "queued", messagePreview: "second" },
    ]);
  });

  describe("work that yields to the queue", () => {
    async function queueItem(sessionId = "session-2"): Promise<void> {
      await service.createItem({
        creationProvenance: { surface: "api" },
        projectId,
        projectPath: PROJECT_PATH,
        request: {
          target: { type: "existing-session", sessionId },
          message: { text: "queued behind a loop" },
        },
      });
    }

    async function schedulerWith(
      options: Partial<ConstructorParameters<typeof ProjectQueueScheduler>[0]>,
    ): Promise<void> {
      await scheduler.dispose();
      scheduler = new ProjectQueueScheduler({
        creations: admittedCreations,
        projectQueueService: service,
        supervisor,
        eventBus,
        idleGraceMs: 60_000,
        ...options,
      });
    }

    it("is blocked by an item the queue will promote once quiet", async () => {
      await schedulerWith({});
      await queueItem();

      await expect(
        scheduler.getProjectWorkStatusYieldingToQueue(projectId),
      ).resolves.toEqual({
        idle: false,
        blockers: ["project-queue:item-waiting"],
      });
      // The queue's own predicate must not wait on its own head.
      await expect(scheduler.getProjectWorkStatus(projectId)).resolves.toEqual({
        idle: true,
        blockers: [],
      });
    });

    it("is not blocked by an item the queue is holding", async () => {
      await schedulerWith({
        isSessionAutomationPaused: (sessionId) => sessionId === "session-2",
      });
      await queueItem();
      await expect(
        scheduler.getProjectWorkStatusYieldingToQueue(projectId),
      ).resolves.toEqual({ idle: true, blockers: [] });

      await queueItem("session-3");
      await service.pauseDispatch();
      await schedulerWith({});
      await expect(
        scheduler.getProjectWorkStatusYieldingToQueue(projectId),
      ).resolves.toEqual({ idle: true, blockers: [] });
    });

    it("adds no queue blocker while the project is otherwise busy", async () => {
      await schedulerWith({});
      supervisor.processes.push(
        createProcess(projectId, { state: { type: "in-turn" } }),
      );
      await queueItem();

      await expect(
        scheduler.getProjectWorkStatusYieldingToQueue(projectId),
      ).resolves.toMatchObject({
        idle: false,
        blockers: expect.not.arrayContaining(["project-queue:item-waiting"]),
      });
    });

    it("lets a queued item run before a patient loop's next iteration", async () => {
      // The loop's boundary (at least 250 ms) comes well before the queue's
      // quiet window, so without yielding the loop would start first.
      await schedulerWith({ idleGraceMs: 700 });
      let clearloop: SessionClearloopJob | undefined;
      const order: string[] = [];
      const loop = new ClearloopService({
        eventBus,
        sessionMetadataService: {
          getClearloop: () => clearloop,
          setClearloop: async (_id: string, job?: SessionClearloopJob) => {
            clearloop = job;
          },
          addLocalCommandMessage: async () => {},
        } as unknown as SessionMetadataService,
        getSupervisor: () =>
          ({ getProcessForSession: () => undefined }) as unknown as Supervisor,
        getInactivitySeconds: () => 0,
        patientRecheckMs: 20,
        getProjectIdleStatus: (id) =>
          scheduler.getProjectWorkStatusYieldingToQueue(id),
      });
      loop.setRunner({
        rewind: async () => "noop",
        send: async () => {
          order.push("loop");
        },
      });
      const resume = supervisor.resumeSession.bind(supervisor);
      supervisor.resumeSession = async (...args) => {
        order.push("queue");
        return resume(...args);
      };

      await loop.start("loop-session", projectId, {
        cutMessageId: "cut-1",
        cutTurnIndex: 1,
        prompt: "again",
        total: 2,
        commandText: "/clearloop 1 2: again",
        patient: true,
      });
      await queueItem();

      await waitFor(() => expect(clearloop?.state).toBe("completed"), 3_000);
      expect(order).toEqual(["loop", "queue", "loop"]);
    });
  });
});
