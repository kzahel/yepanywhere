import { savedLimitedCreationError } from "../auth/limitedLaunchPolicy.js";
import type {
  SessionCreationStore,
  SavedSessionCreation,
  CreationContext,
} from "../sessions/SessionCreationStore.js";
import {
  DEFAULT_PROJECT_QUEUE_QUIET_SECONDS,
  type LimitedUserGrants,
  type PermissionMode,
  type ProjectQueueItem,
  type ProjectQueueProjectStatus,
  type ProjectQueuePromoteNowResult,
  type ProviderName,
  type QueuedYaCommand,
  type SessionSandboxLevel,
  type UploadedFile,
  type UrlProjectId,
  thinkingOptionToConfig,
  fromUrlProjectId,
  projectQueueSessionBlocker,
} from "@yep-anywhere/shared";
import {
  limitExistingSessionLaunch,
  limitQueuedLaunch,
} from "../auth/limitedLaunchPolicy.js";
import { levelFor } from "../auth/limitedUserPolicy.js";
import { getLogger } from "../logging/logger.js";
import type { UserMessage } from "../sdk/types.js";
import type { BusEvent, EventBus } from "../watcher/EventBus.js";
import {
  RetryableSessionLaunchError,
  type ModelSettings,
  type SessionLaunchOptions,
} from "../supervisor/Supervisor.js";
import type { AttachmentStagingService } from "../uploads/AttachmentStagingService.js";
import {
  type ProjectQueueService,
  projectQueueCreationRequestId,
  queueItemAttachmentStore,
  queuedYaCommandToRun,
} from "./ProjectQueueService.js";
import {
  ProjectQueueReadinessCheck,
  type ProjectQueueReadinessCommand,
} from "./ProjectQueueReadinessCheck.js";
import type {
  PersistedSessionQueuedMessage,
  SessionQueuePersistenceService,
} from "./SessionQueuePersistenceService.js";
import {
  getProjectWorkIdleStatus,
  type ProjectWorkExternalTracker,
  type ProjectWorkIdleStatus,
  type ProjectWorkProcessSnapshot,
  type ProjectWorkSupervisor,
} from "./projectWorkIdle.js";

const DEFAULT_IDLE_GRACE_MS = DEFAULT_PROJECT_QUEUE_QUIET_SECONDS * 1000;
const BLOCKED_RETRY_MS = 30_000;
const MIN_READINESS_POLL_MS = 10_000;

interface ReadinessSnapshot {
  commandKey: string;
  checkedAtMs: number;
  blocker: string | null;
  quietSinceMs?: number;
}

type ProjectQueueTimerReason = "quiet" | "blocked-retry";

interface ProjectQueueTimerState {
  timer: ReturnType<typeof setTimeout>;
  reason: ProjectQueueTimerReason;
  scheduledAtMs: number;
  eligibleAtMs: number;
}

export interface ProjectQueueProcessSnapshot
  extends ProjectWorkProcessSnapshot {
  id: string;
  sessionId: string;
  projectId: UrlProjectId;
  projectPath: string;
  provider: ProviderName;
  promptSuggestionMode?: ModelSettings["promptSuggestionMode"];
  recapAfterSeconds?: number;
}

export type ProjectQueueDispatchResult =
  | ProjectQueueProcessSnapshot
  | { queued: true; queueId: string; position: number }
  | { error: "queue_full"; maxQueueSize: number };

/**
 * What one dispatch settled to. A queued YA command starts no provider work,
 * so it is not a supervisor result.
 */
type ProjectQueueDispatchOutcome =
  | ProjectQueueDispatchResult
  | { yaCommand: true }
  | { admitted: true; sessionId: string };

/**
 * Runs a queued YA-emulated command against its target session at dispatch.
 * Supplied by the session routes, which own rewind boundary resolution; a
 * throw fails the item with its message and keeps the prompt for Retry.
 */
export interface ProjectQueueYaCommandRunner {
  run(input: {
    sessionId: string;
    projectId: UrlProjectId;
    projectPath: string;
    command: QueuedYaCommand;
    commandText: string;
  }): Promise<void>;
}

export interface ProjectQueueSupervisor extends ProjectWorkSupervisor {
  getAllProcesses(): ProjectQueueProcessSnapshot[];
  startSession(
    projectPath: string,
    message: UserMessage,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    launchOptions?: SessionLaunchOptions,
  ): Promise<ProjectQueueDispatchResult>;
  startSavedSession?(
    fence: SavedSessionCreation["attempt"],
    authorize: (saved: SavedSessionCreation) => Promise<void>,
  ): Promise<ProjectQueueDispatchResult>;
  resumeSession(
    sessionId: string,
    projectPath: string,
    message: UserMessage,
    permissionMode?: PermissionMode,
    modelSettings?: ModelSettings,
    launchOptions?: SessionLaunchOptions,
  ): Promise<ProjectQueueDispatchResult>;
}

export type ProjectQueueExternalTracker = ProjectWorkExternalTracker;

export type ProjectIdleStatus = ProjectWorkIdleStatus;

type RunProjectResult =
  | {
      reason: "promoted";
      itemId: string;
      sessionId?: string;
      promoted: true;
    }
  | {
      reason:
        | "empty"
        | "paused"
        | "blocked"
        | "in-flight"
        | "not-found"
        | "not-queued"
        | "failed";
      itemId?: string;
      error?: string;
      promoted: false;
    };

interface PromoteNowOptions {
  itemId?: string;
  force?: boolean;
  deliveryIntent?: "steer";
  automatic?: boolean;
}

export interface ProjectQueueSessionLaunchMetadata {
  sandboxLevel?: SessionSandboxLevel;
  sandboxNetworkFirewall?: boolean;
  sandboxStateKey?: string;
  sandboxProjectPath?: string;
  workingProjectId?: string;
  createdByUser?: string;
  provider?: ProviderName;
}

export interface ProjectQueueSchedulerOptions {
  projectQueueService: ProjectQueueService;
  creations?: SessionCreationStore;
  supervisor: ProjectQueueSupervisor;
  eventBus: EventBus;
  attachmentStagingService?: AttachmentStagingService;
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
  externalTracker?: ProjectQueueExternalTracker;
  idleGraceMs?: number;
  blockedRetryMs?: number;
  getIdleGraceMs?: () => number;
  getReadinessCommand?: () => ProjectQueueReadinessCommand | null;
  getEffectiveProcessProjectId?: (
    process: ProjectWorkProcessSnapshot,
  ) => UrlProjectId;
  getGlobalInstructions?: () => string | undefined;
  isSessionAutomationPaused?: (sessionId: string) => boolean;
  /**
   * The persisted launch facts of an existing session: the sandbox it was
   * created with, which a queued turn resumes it inside as `/resume` does, and
   * who started it.
   */
  getSessionLaunchMetadata?: (
    sessionId: string,
  ) => ProjectQueueSessionLaunchMetadata | undefined;
  /**
   * Current grants of the limited user who queued an item; null when that
   * user is gone, disabled, or limited users are off. Without this option no
   * item a limited user queued can run.
   */
  getLimitedUserGrants?: (username: string) => LimitedUserGrants | null;
  /**
   * Whether a limited user's queued turn may still resume an existing session
   * under the freshness cutoff (topics/limited-users.md § Freshness). Without
   * this option no limited user's existing-session item can run.
   */
  isSessionFreshForLimitedTurn?: (
    sessionId: string,
    grants: LimitedUserGrants,
  ) => Promise<boolean>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isQueueFullResult(
  result: ProjectQueueDispatchOutcome,
): result is { error: "queue_full"; maxQueueSize: number } {
  return "error" in result && result.error === "queue_full";
}

function isQueuedResult(
  result: ProjectQueueDispatchOutcome,
): result is { queued: true; queueId: string; position: number } {
  return "queued" in result && result.queued === true;
}

function isYaCommandResult(
  result: ProjectQueueDispatchOutcome,
): result is { yaCommand: true } {
  return "yaCommand" in result && result.yaCommand === true;
}

function isRecoveredPatientQueueItem(
  item: PersistedSessionQueuedMessage,
): boolean {
  return item.kind === "patient" && item.status === "paused-after-restart";
}

export class ProjectQueueScheduler {
  private readonly projectQueueService: ProjectQueueService;
  private readonly supervisor: ProjectQueueSupervisor;
  private readonly eventBus: EventBus;
  private readonly externalTracker?: ProjectQueueExternalTracker;
  private readonly fixedIdleGraceMs?: number;
  private readonly getConfiguredIdleGraceMs?: () => number;
  private readonly timers = new Map<UrlProjectId, ProjectQueueTimerState>();
  private readonly userSessionStartReservations = new Map<
    UrlProjectId,
    Map<string, number>
  >();
  private readonly inFlight = new Set<UrlProjectId>();
  private readonly inFlightRuns = new Set<Promise<RunProjectResult>>();
  private readonly readinessCheck = new ProjectQueueReadinessCheck();
  private readonly readiness = new Map<UrlProjectId, ReadinessSnapshot>();
  private readonly readinessControllers = new Map<
    UrlProjectId,
    AbortController
  >();
  private readonly unsubscribe: () => void;
  private yaCommandRunner: ProjectQueueYaCommandRunner | null = null;
  private disposed = false;

  constructor(private readonly options: ProjectQueueSchedulerOptions) {
    this.projectQueueService = options.projectQueueService;
    this.projectQueueService.attachCreationStore(options.creations);
    this.supervisor = options.supervisor;
    this.eventBus = options.eventBus;
    this.externalTracker = options.externalTracker;
    this.fixedIdleGraceMs = options.idleGraceMs;
    this.getConfiguredIdleGraceMs = options.getIdleGraceMs;
    this.unsubscribe = this.eventBus.subscribe(this.handleEvent);
    this.scheduleAllDispatchableProjects();
  }

  /** Wired once by the session routes, which own the rewind operations. */
  setYaCommandRunner(runner: ProjectQueueYaCommandRunner): void {
    this.yaCommandRunner = runner;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe();
    for (const state of this.timers.values()) {
      clearTimeout(state.timer);
    }
    this.timers.clear();
    this.userSessionStartReservations.clear();
    for (const controller of this.readinessControllers.values())
      controller.abort();
    await this.readinessCheck.dispose();
    await Promise.allSettled(this.inFlightRuns);
    this.inFlight.clear();
    this.readiness.clear();
  }

  /**
   * Reserve a project's idle predicate while an admitted user request is
   * starting a session but has not yet registered a live provider process.
   */
  reserveUserSessionStart(
    projectId: UrlProjectId,
    sessionId: string,
  ): () => void {
    if (this.disposed) return () => {};

    const reservations =
      this.userSessionStartReservations.get(projectId) ?? new Map();
    reservations.set(sessionId, (reservations.get(sessionId) ?? 0) + 1);
    this.userSessionStartReservations.set(projectId, reservations);
    this.clearProjectTimer(projectId);

    let released = false;
    return () => {
      if (released) return;
      released = true;

      const current = this.userSessionStartReservations.get(projectId);
      const count = current?.get(sessionId);
      if (current && count !== undefined) {
        if (count > 1) {
          current.set(sessionId, count - 1);
        } else {
          current.delete(sessionId);
          if (current.size === 0) {
            this.userSessionStartReservations.delete(projectId);
          }
        }
      }
      this.scheduleProjectIfDispatchable(projectId);
    };
  }

  async getProjectIdleStatus(
    projectId: UrlProjectId,
  ): Promise<ProjectIdleStatus> {
    const status = await this.getProjectWorkStatus(projectId);
    const command = this.options.getReadinessCommand?.();
    if (command) {
      const snapshot = this.readiness.get(projectId);
      const blocker =
        snapshot?.commandKey === JSON.stringify(command)
          ? snapshot.blocker
          : "Waiting for readiness check";
      if (blocker) status.blockers.unshift(`readiness:${blocker}`);
    }
    return { idle: status.blockers.length === 0, blockers: status.blockers };
  }

  /**
   * The project idle predicate without the Project Queue readiness check.
   * Other schedulers — a patient `/clearloop`, for instance — share this work
   * predicate through `getProjectWorkStatusYieldingToQueue`; the readiness
   * snapshot is only refreshed while this queue has backlog, so an empty
   * queue would hold them on a stale caption forever.
   */
  async getProjectWorkStatus(
    projectId: UrlProjectId,
  ): Promise<ProjectIdleStatus> {
    // Project Queue ordering and UI semantics are documented in
    // topics/project-queue.md. In particular, per-session queues must drain
    // before a project-level queue item can promote.
    const status = await getProjectWorkIdleStatus(projectId, {
      supervisor: this.supervisor,
      externalTracker: this.externalTracker,
      getRecoveredPatientQueueCount: (candidateProjectId) =>
        this.getRecoveredPatientQueueCount(candidateProjectId),
      getEffectiveProcessProjectId: this.options.getEffectiveProcessProjectId,
      ignoreSessionsPendingDone: true,
    });
    const reservations = this.userSessionStartReservations.get(projectId);
    if (reservations) {
      for (const sessionId of reservations.keys()) {
        status.blockers.push(
          projectQueueSessionBlocker(sessionId, "user-starting"),
        );
      }
    }
    return { idle: status.blockers.length === 0, blockers: status.blockers };
  }

  /**
   * The work predicate for automated work that yields to this queue, such as
   * a patient `/clearloop`. While the project is otherwise quiet, an item
   * this queue would promote once its quiet window passes also blocks: work
   * re-checking on a shorter window would otherwise start first every time,
   * and the item would wait the other work out. An item the queue itself is
   * holding (dispatch paused, first item failed, automation paused on its
   * session, readiness check not passed) does not block, so the other work
   * never waits on something that is not going to run. Nor does it block
   * while the project is otherwise busy: the caller already waits then, and
   * a blocker the caller discounts (its own session) also holds this queue.
   */
  async getProjectWorkStatusYieldingToQueue(
    projectId: UrlProjectId,
  ): Promise<ProjectIdleStatus> {
    const status = await this.getProjectWorkStatus(projectId);
    const queueBlocker = status.idle
      ? this.promotingItemBlocker(projectId)
      : null;
    if (queueBlocker) status.blockers.push(queueBlocker);
    return { idle: status.blockers.length === 0, blockers: status.blockers };
  }

  /** Why this queue is about to start work in the project, or null. */
  private promotingItemBlocker(projectId: UrlProjectId): string | null {
    if (!this.projectQueueService.hasDispatchableItem(projectId)) {
      // A claimed head is `dispatching`, no longer dispatchable, until the
      // work it starts shows up in the ordinary predicate.
      return this.inFlight.has(projectId) ? "project-queue:dispatching" : null;
    }
    const head = this.projectQueueService.listProject(projectId).items[0];
    if (
      head?.target.type === "existing-session" &&
      this.options.isSessionAutomationPaused?.(head.target.sessionId)
    ) {
      return null;
    }
    const command = this.options.getReadinessCommand?.();
    if (command) {
      const snapshot = this.readiness.get(projectId);
      if (
        snapshot?.commandKey !== JSON.stringify(command) ||
        snapshot.blocker !== null
      ) {
        return null;
      }
    }
    return "project-queue:item-waiting";
  }

  async getProjectStatus(
    projectId: UrlProjectId,
  ): Promise<ProjectQueueProjectStatus> {
    const items = this.projectQueueService.listProject(projectId).items;
    const first = items[0];
    const dispatchState = this.projectQueueService.getDispatchState();
    const dispatchPaused = dispatchState.status === "paused";
    const inFlight = this.inFlight.has(projectId);
    const quietWindowMs = this.getIdleGraceMs();
    const timer = this.timers.get(projectId);

    if (!first) {
      return {
        projectId,
        state: "empty",
        idle: true,
        blockers: [],
        dispatchPaused,
        inFlight,
        quietWindowMs,
        itemCount: 0,
      };
    }

    const idle = await this.getProjectIdleStatus(projectId);
    const blockers = [...idle.blockers];
    if (first.status === "failed") {
      blockers.push("project-queue:first-failed");
    }
    if (
      first.target.type === "existing-session" &&
      this.options.isSessionAutomationPaused?.(first.target.sessionId)
    ) {
      blockers.push(
        projectQueueSessionBlocker(first.target.sessionId, "automation-paused"),
      );
    }

    const now = Date.now();
    const timerFields: Pick<
      ProjectQueueProjectStatus,
      "nextAttemptAt" | "quietStartedAt" | "quietEligibleAt"
    > = {};
    if (timer && timer.eligibleAtMs > now) {
      timerFields.nextAttemptAt = new Date(timer.eligibleAtMs).toISOString();
      if (timer.reason === "quiet" && idle.idle) {
        timerFields.quietStartedAt = new Date(
          timer.scheduledAtMs,
        ).toISOString();
        timerFields.quietEligibleAt = new Date(
          timer.eligibleAtMs,
        ).toISOString();
      }
    }

    const state: ProjectQueueProjectStatus["state"] = dispatchPaused
      ? "paused"
      : inFlight || first.status === "dispatching"
        ? "dispatching"
        : blockers.length > 0
          ? "blocked"
          : timerFields.quietEligibleAt
            ? "waiting-quiet"
            : "ready";

    return {
      projectId,
      state,
      idle: idle.idle && blockers.length === 0,
      blockers,
      dispatchPaused,
      inFlight,
      quietWindowMs,
      itemCount: items.length,
      nextItemId: first.id,
      ...timerFields,
    };
  }

  async promoteNow(
    projectId: UrlProjectId,
    options: PromoteNowOptions = {},
  ): Promise<ProjectQueuePromoteNowResult> {
    if (this.projectQueueService.isDispatchPaused()) {
      const projectItems =
        this.projectQueueService.listProject(projectId).items;
      const requestedItem = options.itemId
        ? projectItems.find((item) => item.id === options.itemId)
        : projectItems[0];
      if (requestedItem?.status === "queued") {
        await this.projectQueueService.resumeDispatch();
      }
    }
    this.clearProjectTimer(projectId);
    const result = await this.runProject(projectId, options);
    return {
      ...result,
      status: await this.getProjectStatus(projectId),
    };
  }

  sessionProjectChanged(
    previousProjectId: UrlProjectId,
    nextProjectId: UrlProjectId,
  ): void {
    this.scheduleProjectIfDispatchable(previousProjectId);
    if (nextProjectId !== previousProjectId) {
      this.scheduleProjectIfDispatchable(nextProjectId);
    }
  }

  readinessSettingsChanged(): void {
    for (const controller of this.readinessControllers.values())
      controller.abort();
    for (const snapshot of this.readiness.values()) {
      snapshot.commandKey = "";
      snapshot.quietSinceMs = undefined;
    }
    this.scheduleAllDispatchableProjects();
    for (const projectId of this.projectQueueService.getProjectIdsWithDispatchableItems()) {
      this.publishReadinessStatus(projectId);
    }
  }

  private publishReadinessStatus(projectId: UrlProjectId): void {
    this.eventBus.emit({
      type: "project-queue-changed",
      projectId,
      items: this.projectQueueService.listProject(projectId).items,
      dispatchState: this.projectQueueService.getDispatchState(),
      reason: "readiness",
      timestamp: new Date().toISOString(),
    });
  }

  private readonly handleEvent = (event: BusEvent): void => {
    if (this.disposed) {
      return;
    }
    switch (event.type) {
      case "project-queue-changed":
        if (event.reason === "readiness") break;
        if (event.reason === "paused") {
          this.readinessControllers.get(event.projectId)?.abort();
          this.clearProjectTimer(event.projectId);
          break;
        }
        if (
          event.reason === "created" ||
          event.reason === "updated" ||
          event.reason === "deleted" ||
          event.reason === "retry" ||
          event.reason === "resumed" ||
          event.reason === "released"
        ) {
          this.scheduleProjectIfDispatchable(event.projectId);
        } else if (
          !this.projectQueueService.hasDispatchableItem(event.projectId)
        ) {
          this.clearProjectTimer(event.projectId);
        }
        break;
      case "process-state-changed":
      case "session-status-changed":
      case "session-updated":
      case "queue-request-added":
        this.scheduleProjectIfDispatchable(event.projectId);
        break;
      case "session-created":
        this.scheduleProjectIfDispatchable(event.session.projectId);
        break;
      case "worker-activity-changed":
      case "queue-position-changed":
      case "queue-request-removed":
      case "session-queue-persistence-changed":
        this.scheduleAllDispatchableProjects();
        break;
    }
  };

  private getRecoveredPatientQueueCount(projectId: UrlProjectId): number {
    const service = this.options.sessionQueuePersistenceService;
    if (!service) return 0;
    return service
      .list()
      .filter(
        (item) =>
          item.projectId === projectId && isRecoveredPatientQueueItem(item),
      ).length;
  }

  private getIdleGraceMs(): number {
    const raw =
      this.fixedIdleGraceMs ??
      this.getConfiguredIdleGraceMs?.() ??
      DEFAULT_IDLE_GRACE_MS;
    return Number.isFinite(raw)
      ? Math.max(0, Math.round(raw))
      : DEFAULT_IDLE_GRACE_MS;
  }

  private scheduleAllDispatchableProjects(
    delayMs = this.getIdleGraceMs(),
    reason: ProjectQueueTimerReason = "quiet",
  ): void {
    if (this.disposed) {
      return;
    }
    const projectIds =
      this.projectQueueService.getProjectIdsWithDispatchableItems();
    for (const projectId of projectIds) {
      this.scheduleProjectIfDispatchable(projectId, delayMs, reason);
    }
  }

  private scheduleProjectIfDispatchable(
    projectId: UrlProjectId,
    delayMs = this.getIdleGraceMs(),
    reason: ProjectQueueTimerReason = "quiet",
  ): void {
    if (this.disposed) {
      return;
    }
    if (!this.projectQueueService.hasDispatchableItem(projectId)) {
      this.readinessControllers.get(projectId)?.abort();
      this.clearProjectTimer(projectId);
      this.readiness.delete(projectId);
      return;
    }
    if (this.options.getReadinessCommand?.()) {
      const snapshot = this.readiness.get(projectId);
      if (snapshot) snapshot.quietSinceMs = undefined;
      const delay = snapshot
        ? Math.max(0, snapshot.checkedAtMs + MIN_READINESS_POLL_MS - Date.now())
        : 0;
      this.scheduleProject(projectId, delay, "blocked-retry");
      return;
    }
    this.scheduleProject(projectId, delayMs, reason);
  }

  private scheduleProject(
    projectId: UrlProjectId,
    delayMs: number,
    reason: ProjectQueueTimerReason,
  ): void {
    if (this.disposed) {
      return;
    }
    if (this.inFlight.has(projectId)) return;
    this.clearProjectTimer(projectId);
    const scheduledAtMs = Date.now();
    const eligibleAtMs = scheduledAtMs + Math.max(0, Math.round(delayMs));
    const timer = setTimeout(
      () => {
        this.timers.delete(projectId);
        void this.runProject(projectId, { automatic: true });
      },
      Math.max(0, Math.round(delayMs)),
    );
    timer.unref?.();
    this.timers.set(projectId, {
      timer,
      reason,
      scheduledAtMs,
      eligibleAtMs,
    });
  }

  private clearProjectTimer(projectId: UrlProjectId): void {
    const state = this.timers.get(projectId);
    if (!state) return;
    clearTimeout(state.timer);
    this.timers.delete(projectId);
  }

  private scheduleBlockedProjectRetry(projectId: UrlProjectId): void {
    if (!this.projectQueueService.hasDispatchableItem(projectId)) return;
    const retryMs = Math.max(
      this.options.getReadinessCommand?.() ? MIN_READINESS_POLL_MS : 0,
      Math.round(
        this.options.blockedRetryMs ??
          Math.max(
            1_000,
            Math.min(
              BLOCKED_RETRY_MS,
              this.getIdleGraceMs() || BLOCKED_RETRY_MS,
            ),
          ),
      ),
    );
    this.scheduleProject(projectId, retryMs, "blocked-retry");
  }

  private hasRunnableQueuedItem(
    projectId: UrlProjectId,
    itemId: string | undefined,
  ): boolean {
    if (!itemId) return this.projectQueueService.hasDispatchableItem(projectId);
    const item = this.projectQueueService
      .listProject(projectId)
      .items.find((candidate) => candidate.id === itemId);
    return item?.status === "queued";
  }

  private async runProject(
    projectId: UrlProjectId,
    options: PromoteNowOptions = {},
  ): Promise<RunProjectResult> {
    const run = this.runProjectNow(projectId, options);
    this.inFlightRuns.add(run);
    run.then(
      () => this.inFlightRuns.delete(run),
      () => this.inFlightRuns.delete(run),
    );
    return run;
  }

  private async runProjectNow(
    projectId: UrlProjectId,
    options: PromoteNowOptions = {},
  ): Promise<RunProjectResult> {
    if (this.disposed) return { promoted: false, reason: "paused" };
    if (this.inFlight.has(projectId)) {
      return { promoted: false, reason: "in-flight" };
    }
    if (this.projectQueueService.getDispatchState().status === "paused") {
      this.clearProjectTimer(projectId);
      return { promoted: false, reason: "paused" };
    }
    const projectItems = this.projectQueueService.listProject(projectId).items;
    if (
      options.itemId &&
      !projectItems.some((item) => item.id === options.itemId)
    ) {
      return { promoted: false, reason: "not-found", itemId: options.itemId };
    }
    if (!this.hasRunnableQueuedItem(projectId, options.itemId)) {
      return {
        promoted: false,
        reason: projectItems.length === 0 ? "empty" : "not-queued",
        ...(options.itemId ? { itemId: options.itemId } : {}),
      };
    }

    const nextItem = options.itemId
      ? projectItems.find((item) => item.id === options.itemId)
      : projectItems.find((item) => item.status === "queued");
    if (
      options.automatic === true &&
      nextItem?.target.type === "existing-session" &&
      this.options.isSessionAutomationPaused?.(nextItem.target.sessionId)
    ) {
      return {
        promoted: false,
        reason: "blocked",
        itemId: nextItem.id,
      };
    }

    this.inFlight.add(projectId);
    let item: ProjectQueueItem | null = null;
    let retryBlockedProject = false;
    let readinessRetry:
      | { delayMs: number; reason: ProjectQueueTimerReason }
      | undefined;

    try {
      if (!options.force) {
        const idle = await this.getProjectWorkStatus(projectId);
        if (!idle.idle) {
          const snapshot = this.readiness.get(projectId);
          if (snapshot) snapshot.quietSinceMs = undefined;
          retryBlockedProject = true;
          return {
            promoted: false,
            reason: "blocked",
            ...(options.itemId ? { itemId: options.itemId } : {}),
          };
        }
      }

      const command = this.options.getReadinessCommand?.();
      const commandKey = JSON.stringify(command ?? null);
      if (!options.force && command && nextItem) {
        const previous = this.readiness.get(projectId);
        const nextPollAt = previous
          ? previous.checkedAtMs + MIN_READINESS_POLL_MS
          : 0;
        if (options.automatic && Date.now() < nextPollAt) {
          readinessRetry = {
            delayMs: nextPollAt - Date.now(),
            reason: "blocked-retry",
          };
          return { promoted: false, reason: "blocked" };
        }
        const controller = new AbortController();
        this.readinessControllers.set(projectId, controller);
        const checkedAtMs = Date.now();
        this.readiness.set(projectId, {
          commandKey,
          checkedAtMs,
          blocker: previous?.blocker ?? "Waiting for readiness check",
          quietSinceMs: previous?.quietSinceMs,
        });
        const blocker = await this.readinessCheck.run(
          command,
          fromUrlProjectId(projectId),
          controller.signal,
        );
        if (this.disposed || this.projectQueueService.isDispatchPaused()) {
          return { promoted: false, reason: "paused" };
        }
        if (
          controller.signal.aborted ||
          commandKey !==
            JSON.stringify(this.options.getReadinessCommand?.() ?? null)
        ) {
          retryBlockedProject = true;
          return { promoted: false, reason: "blocked" };
        }
        const quietSinceMs =
          blocker === null
            ? previous?.commandKey === commandKey && previous.blocker === null
              ? (this.readiness.get(projectId)?.quietSinceMs ?? Date.now())
              : Date.now()
            : undefined;
        this.readiness.set(projectId, {
          commandKey,
          checkedAtMs,
          blocker,
          quietSinceMs,
        });
        if (blocker !== null) {
          retryBlockedProject = true;
          return { promoted: false, reason: "blocked" };
        }
        const quietRemaining =
          (quietSinceMs ?? Date.now()) + this.getIdleGraceMs() - Date.now();
        if (options.automatic && quietRemaining > 0) {
          readinessRetry = {
            delayMs: Math.max(MIN_READINESS_POLL_MS, quietRemaining),
            reason: "quiet",
          };
          return { promoted: false, reason: "blocked" };
        }
      }

      item = await this.projectQueueService.claimDispatchableItem(
        projectId,
        options.itemId,
      );
      if (!item) return { promoted: false, reason: "empty" };

      if (!options.force) {
        const stillIdle = await this.getProjectIdleStatus(projectId);
        if (
          !stillIdle.idle ||
          this.disposed ||
          this.projectQueueService.isDispatchPaused() ||
          commandKey !==
            JSON.stringify(this.options.getReadinessCommand?.() ?? null)
        ) {
          await this.projectQueueService.releaseDispatchingItem(
            projectId,
            item.id,
          );
          retryBlockedProject = true;
          return { promoted: false, reason: "blocked", itemId: item.id };
        }
      }

      const result = await this.dispatchItem(item, options);
      if (!isQueuedResult(result) || item.target.type === "existing-session") {
        await this.projectQueueService.completeDispatch(projectId, item.id);
      }
      const sessionId =
        item.target.type === "existing-session"
          ? item.target.sessionId
          : isQueuedResult(result) ||
              isQueueFullResult(result) ||
              isYaCommandResult(result)
            ? undefined
            : result.sessionId;
      return {
        promoted: true,
        reason: "promoted",
        itemId: item.id,
        ...(sessionId ? { sessionId } : {}),
      };
    } catch (error) {
      const message = errorMessage(error);
      const retryable =
        error instanceof RetryableSessionLaunchError &&
        item?.target.type === "existing-session";
      let retryScheduled = false;
      if (item && retryable) {
        const updated =
          await this.projectQueueService.recordRetryableStartupFailure(
            projectId,
            item.id,
            message,
          );
        retryScheduled = updated?.status === "queued";
        retryBlockedProject = retryScheduled;
      } else if (item) {
        await this.projectQueueService.failDispatch(
          projectId,
          item.id,
          message,
        );
      }
      if (retryScheduled) {
        getLogger().info(
          { event: "project_queue_dispatch_retry", projectId, error: message },
          "Project queue provider startup will retry",
        );
      } else if (retryable) {
        getLogger().warn(
          {
            event: "project_queue_dispatch_retry_exhausted",
            projectId,
            error: message,
          },
          "Project queue item paused after repeated provider startup failures",
        );
      } else {
        getLogger().warn(
          { event: "project_queue_dispatch_failed", projectId, error: message },
          "Project queue dispatch failed",
        );
      }
      return {
        promoted: false,
        reason: retryScheduled ? "blocked" : "failed",
        ...(item ? { itemId: item.id } : {}),
        error: message,
      };
    } finally {
      this.inFlight.delete(projectId);
      this.readinessControllers.delete(projectId);
      if (
        readinessRetry &&
        !this.disposed &&
        !this.projectQueueService.isDispatchPaused() &&
        this.projectQueueService.hasDispatchableItem(projectId)
      ) {
        this.scheduleProject(
          projectId,
          readinessRetry.delayMs,
          readinessRetry.reason,
        );
      } else if (
        retryBlockedProject &&
        !this.disposed &&
        !this.projectQueueService.isDispatchPaused()
      ) {
        this.scheduleBlockedProjectRetry(projectId);
      }
      if (this.options.getReadinessCommand?.() && !this.disposed) {
        this.publishReadinessStatus(projectId);
        if (this.projectQueueService.listProject(projectId).items.length === 0)
          this.readiness.delete(projectId);
      }
    }
  }

  private async dispatchItem(
    queuedItem: ProjectQueueItem,
    options: PromoteNowOptions,
  ): Promise<ProjectQueueDispatchOutcome> {
    if (
      queuedItem.creationSessionId &&
      queuedItem.target.type !== "new-session"
    )
      throw new Error(
        "An admitted Queue creation cannot be retargeted to another session",
      );
    const grants = this.enqueuerGrants(queuedItem);
    const item = grants
      ? this.withinEnqueuerLaunchPolicy(queuedItem, grants)
      : queuedItem;
    // Derived from the text as it stands, never a stored copy, so an item
    // left inconsistent by an older build fails here instead of running.
    const yaCommand = queuedYaCommandToRun(item);
    const permissionMode = item.message.mode ?? item.target.mode;
    const modelSettings = this.toModelSettings(item);
    const result =
      item.target.type === "existing-session"
        ? await this.dispatchExistingSessionItem(
            item,
            permissionMode,
            modelSettings,
            options.deliveryIntent,
            grants,
            yaCommand,
          )
        : await this.dispatchNewSessionItem(
            item,
            permissionMode,
            modelSettings,
          );

    if (isQueueFullResult(result)) {
      throw new Error(`Worker queue is full (${result.maxQueueSize})`);
    }

    return result;
  }

  /**
   * The current grants of the limited user who queued an item, or null for a
   * superuser's item. Grants are read at dispatch, not enqueue, so an item
   * whose user lost the project's new-session grant, was disabled, or was
   * removed fails rather than running as anyone.
   */
  private enqueuerGrants(item: ProjectQueueItem): LimitedUserGrants | null {
    const username = item.createdByUser;
    if (!username) return null;
    const grants = this.options.getLimitedUserGrants?.(username) ?? null;
    if (!grants || levelFor(grants, item.projectId) !== "new-session") {
      throw new Error(
        `${username}, who queued this item, can no longer start sessions in this project`,
      );
    }
    return grants;
  }

  /** The item as its limited user may launch it now, or a refusal. */
  private withinEnqueuerLaunchPolicy(
    item: ProjectQueueItem,
    grants: LimitedUserGrants,
  ): ProjectQueueItem {
    const launchItem = { ...item, target: { ...item.target } };
    const refused = limitQueuedLaunch(grants, launchItem);
    if (refused) throw new Error(refused.error);
    return launchItem;
  }

  private async dispatchExistingSessionItem(
    item: ProjectQueueItem,
    permissionMode: PermissionMode | undefined,
    modelSettings: ModelSettings,
    deliveryIntent: PromoteNowOptions["deliveryIntent"],
    grants: LimitedUserGrants | null,
    yaCommand: QueuedYaCommand | undefined,
  ): Promise<ProjectQueueDispatchOutcome> {
    if (item.target.type !== "existing-session") {
      throw new Error("Project queue item target changed during dispatch");
    }
    // A session's sandbox is settled when it is created; a queued turn
    // resumes it inside that boundary, as /resume does, rather than asking
    // for none (topics/session-sandboxing.md).
    const session = this.options.getSessionLaunchMetadata?.(
      item.target.sessionId,
    );
    let projectPath = item.projectPath;
    if (session?.sandboxLevel === "project-write") {
      modelSettings.sandboxLevel = "project-write";
      modelSettings.sandboxNetworkFirewall =
        session.sandboxNetworkFirewall !== false;
      modelSettings.sandboxStateKey = session.sandboxStateKey;
      projectPath = session.sandboxProjectPath ?? item.projectPath;
    }
    if (grants) {
      const ownSession = session?.createdByUser === item.createdByUser;
      if (!ownSession && session?.workingProjectId !== item.projectId) {
        throw new Error(
          "A queued turn from this user may target only a session in its project or one they started",
        );
      }
      // The lock is judged against the provider the session actually runs.
      modelSettings.providerName ??= session?.provider;
      const refused = limitExistingSessionLaunch(
        grants,
        modelSettings,
        item.target,
      );
      if (refused) throw new Error(refused.error);
      // Judged at dispatch, not enqueue: an item that waited past the
      // cutoff would otherwise resume a cold session at full cost.
      const fresh = await this.options.isSessionFreshForLimitedTurn?.(
        item.target.sessionId,
        grants,
      );
      if (!fresh) {
        throw new Error(
          "The target session has gone cold; queue a new session instead",
        );
      }
    }
    if (yaCommand) {
      // A YA-emulated command is not provider text; the composer deliberately
      // did not run it, so the runner performs it here instead of resuming
      // the session with its command line (topics/project-queue.md).
      if (!this.yaCommandRunner) {
        throw new Error("This server cannot run queued YA commands");
      }
      await this.yaCommandRunner.run({
        sessionId: item.target.sessionId,
        projectId: item.projectId,
        projectPath: item.projectPath,
        command: yaCommand,
        commandText: item.message.text,
      });
      return { yaCommand: true };
    }
    const stagedAttachments = await this.materializeStagedAttachments(
      item,
      item.target.sessionId,
    );
    return this.supervisor.resumeSession(
      item.target.sessionId,
      projectPath,
      this.toUserMessage(item, stagedAttachments, deliveryIntent),
      permissionMode,
      modelSettings,
    );
  }

  private async dispatchNewSessionItem(
    item: ProjectQueueItem,
    permissionMode: PermissionMode | undefined,
    modelSettings: ModelSettings,
  ): Promise<ProjectQueueDispatchOutcome> {
    const creationKey = projectQueueCreationRequestId(item.id);
    const owner: CreationContext["owner"] = item.createdByUser
      ? { kind: "limited", username: item.createdByUser }
      : { kind: "superuser" };
    const saved = this.options.creations?.get(owner, creationKey);
    if (item.creationSessionId && !saved)
      throw new Error(
        "The admitted Queue session is unavailable; refusing a replacement launch",
      );
    if (!this.options.creations)
      throw new Error("Project Queue new sessions require durable admission");
    return this.dispatchDurableNewSession(
      item,
      permissionMode,
      modelSettings,
      creationKey,
      saved,
    );
  }

  private async dispatchDurableNewSession(
    item: ProjectQueueItem,
    permissionMode: PermissionMode | undefined,
    modelSettings: ModelSettings,
    requestId: string,
    previous?: SavedSessionCreation,
  ): Promise<ProjectQueueDispatchOutcome> {
    let saved = previous;
    const authorize = async (current: SavedSessionCreation) => {
      if (current.deleted || current.request?.projectId !== item.projectId)
        throw new Error("Queue creation no longer has its admitted authority");
      if (current.context.owner.kind === "limited") {
        if (current.context.owner.username !== item.createdByUser)
          throw new Error("Queue creation owner changed");
        const refused = savedLimitedCreationError(
          current,
          this.options.getLimitedUserGrants?.(current.context.owner.username) ??
            null,
        );
        if (refused) throw new Error(refused);
      } else if (item.createdByUser)
        throw new Error("Queue creation owner changed");
    };
    const associate = async (current: SavedSessionCreation) => {
      saved = current;
      await authorize(current);
      await this.projectQueueService.recordSessionCreation(
        item.projectId,
        item.id,
        current.sessionId,
      );
    };
    let result: ProjectQueueDispatchResult;
    if (saved) {
      await associate(saved);
      const state = saved.attempt;
      if (state.delivery === "consumed")
        return { admitted: true, sessionId: saved.sessionId };
      if (
        state.state === "failed" &&
        state.delivery === "not-admitted" &&
        item.creationRetryId
      ) {
        const fence = this.options.creations!.retry(
          saved.context.owner,
          requestId,
          item.creationRetryId,
          state.attemptId,
        );
        if (!this.supervisor.startSavedSession)
          throw new Error("Durable creation dispatcher is unavailable");
        result = await this.supervisor.startSavedSession(fence, authorize);
      } else if (state.state === "failed" || state.state === "uncertain") {
        throw new Error(
          `Saved session ${saved.sessionId} requires recovery; input will not be replayed`,
        );
      } else {
        // The original admission already owns dispatch. Recover its result only.
        return { admitted: true, sessionId: saved.sessionId };
      }
    } else {
      const context: CreationContext = {
        owner: item.createdByUser
          ? { kind: "limited", username: item.createdByUser }
          : { kind: "superuser" },
        source: item.creationProvenance
          ? { kind: "request", provenance: item.creationProvenance }
          : { kind: "unknown", reason: "legacy-project-queue" },
      };
      result = await this.supervisor.startSession(
        item.projectPath,
        this.toUserMessage(item),
        permissionMode,
        modelSettings,
        {
          creation: {
            requestId,
            context,
            authorize,
            onAccepted: associate,
            attachments: item.message.stagedAttachments
              ? {
                  owner: { type: "project-queue", queueItemId: item.id },
                  refs: item.message.stagedAttachments.refs,
                }
              : undefined,
          },
        },
      );
    }
    if (isQueueFullResult(result)) return result;
    if (!saved) throw new Error("Queue creation was not durably admitted");
    return { admitted: true, sessionId: saved.sessionId };
  }

  private async materializeStagedAttachments(
    item: ProjectQueueItem,
    sessionId: string,
  ): Promise<UploadedFile[]> {
    const stagedAttachments = item.message.stagedAttachments;
    if (!stagedAttachments) {
      return [];
    }
    if (!this.options.attachmentStagingService) {
      throw new Error("Attachment staging service is unavailable");
    }
    return queueItemAttachmentStore(
      this.options.attachmentStagingService,
      item,
    ).materializeQueueAttachmentsForSession({
      queueItemId: item.id,
      refs: stagedAttachments.refs,
      projectPath: item.projectPath,
      sessionId,
    });
  }

  private toUserMessage(
    item: ProjectQueueItem,
    stagedAttachments: readonly UploadedFile[] = [],
    deliveryIntent?: PromoteNowOptions["deliveryIntent"],
  ): UserMessage {
    const attachments =
      item.message.attachments || stagedAttachments.length > 0
        ? [...(item.message.attachments ?? []), ...stagedAttachments]
        : undefined;
    // The turn is attributed to whoever queued it, never to a sender the
    // queued request itself claimed; absent means the superuser.
    const { sentByUser: _claimedSender, ...storedMetadata } =
      item.message.metadata ?? {};
    const hasMetadata =
      item.message.metadata || deliveryIntent || item.createdByUser;
    return {
      text: item.message.text,
      automaticSource: "project-queue",
      ...(attachments ? { attachments } : {}),
      ...(item.message.mode ? { mode: item.message.mode } : {}),
      ...(hasMetadata
        ? {
            metadata: {
              ...storedMetadata,
              ...(deliveryIntent === "steer"
                ? { deliveryIntent: "steer" as const, steerNow: true }
                : {}),
              ...(item.createdByUser ? { sentByUser: item.createdByUser } : {}),
            },
          }
        : {}),
    };
  }

  private toModelSettings(item: ProjectQueueItem): ModelSettings {
    const target = item.target;
    const thinkingConfig = target.thinking
      ? thinkingOptionToConfig(target.thinking, target.showThinking)
      : { thinking: undefined, effort: undefined };
    const globalInstructions = this.options.getGlobalInstructions?.();
    return {
      instructionUsername: item.createdByUser,
      ...(target.model && target.model !== "default"
        ? { model: target.model }
        : {}),
      ...(target.model ? { requestedModel: target.model } : {}),
      ...(target.serviceTier ? { serviceTier: target.serviceTier } : {}),
      ...(thinkingConfig.thinking ? { thinking: thinkingConfig.thinking } : {}),
      ...(thinkingConfig.effort ? { effort: thinkingConfig.effort } : {}),
      ...(target.provider ? { providerName: target.provider } : {}),
      ...(target.executor ? { executor: target.executor } : {}),
      ...(target.type === "new-session" && target.sandboxLevel
        ? { sandboxLevel: target.sandboxLevel }
        : {}),
      ...(target.type === "new-session" &&
      target.sandboxLevel === "project-write"
        ? {
            sandboxNetworkFirewall: target.sandboxNetworkFirewall !== false,
          }
        : {}),
      ...(globalInstructions ? { globalInstructions } : {}),
    };
  }
}
