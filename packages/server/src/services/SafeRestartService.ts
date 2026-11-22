import type {
  SafeRestartBlocker,
  SafeRestartChangedEvent,
  SafeRestartPreservedWork,
  SafeRestartState,
  SafeRestartStatus,
} from "@yep-anywhere/shared";
import type { EventBus } from "../watcher/EventBus.js";

export interface SafeRestartWorkerActivity {
  activeWorkers: number;
  interruptibleSessionCount?: number;
  queueLength: number;
  queuedSessionMessageCount?: number;
  hasActiveWork: boolean;
}

export interface SafeRestartServiceOptions {
  eventBus: EventBus;
  getWorkerActivity: () => SafeRestartWorkerActivity;
  getPreservedWork?: () => SafeRestartPreservedWork[];
  preparePreservedWork?: () => Promise<void> | void;
  cancelPreservedWork?: () => void;
  restart: (
    canCommit: () => boolean,
  ) => Promise<boolean> | Promise<void> | boolean | void;
  pauseProjectQueueDispatch?: () => Promise<boolean> | boolean;
  resumeProjectQueueDispatch?: () => Promise<void>;
  now?: () => Date;
}

const RELEVANT_EVENT_TYPES = new Set([
  "worker-activity-changed",
  "queue-request-added",
  "queue-request-removed",
  "queue-position-changed",
  "session-queue-persistence-changed",
]);
const HANDOFF_RETRY_BASE_MS = 1_000;
const MAX_HANDOFF_RETRIES = 5;

export class SafeRestartService {
  private readonly eventBus: EventBus;
  private readonly getWorkerActivity: () => SafeRestartWorkerActivity;
  private readonly getPreservedWorkSnapshot:
    | (() => SafeRestartPreservedWork[])
    | undefined;
  private readonly preparePreservedWork?: () => Promise<void> | void;
  private readonly cancelPreservedWork?: () => void;
  private readonly restart: SafeRestartServiceOptions["restart"];
  private readonly pauseProjectQueueDispatch?: () => Promise<boolean> | boolean;
  private readonly resumeProjectQueueDispatch?: () => Promise<void>;
  private readonly now: () => Date;
  private readonly unsubscribe: () => void;

  private status: SafeRestartStatus = "idle";
  private scheduledAt: string | undefined;
  private updatedAt: string;
  private restartTriggered = false;
  private projectQueuePausedBySchedule = false;
  private evaluationPromise: Promise<void> | undefined;
  private reevaluateAfterAttempt = false;
  private handoffRetries = 0;
  private handoffRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(options: SafeRestartServiceOptions) {
    this.eventBus = options.eventBus;
    this.getWorkerActivity = options.getWorkerActivity;
    this.getPreservedWorkSnapshot = options.getPreservedWork;
    this.preparePreservedWork = options.preparePreservedWork;
    this.cancelPreservedWork = options.cancelPreservedWork;
    this.restart = options.restart;
    this.pauseProjectQueueDispatch = options.pauseProjectQueueDispatch;
    this.resumeProjectQueueDispatch = options.resumeProjectQueueDispatch;
    this.now = options.now ?? (() => new Date());
    this.updatedAt = this.timestamp();
    this.unsubscribe = this.eventBus.subscribe((event) => {
      if (!RELEVANT_EVENT_TYPES.has(event.type)) return;
      if (this.evaluationPromise) this.reevaluateAfterAttempt = true;
      else void this.evaluateAndMaybeRestart();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.cancelHandoffRetry();
  }

  getState(): SafeRestartState {
    const blockers = this.getBlockers();
    const preserved = this.getPreservedWork();
    const state: SafeRestartState = {
      status: this.status,
      blockers,
      canRestartNow: blockers.length === 0,
      updatedAt: this.updatedAt,
    };
    if (preserved.length > 0) {
      state.preserved = preserved;
    }
    if (this.scheduledAt) {
      state.scheduledAt = this.scheduledAt;
    }
    return state;
  }

  async schedule(): Promise<SafeRestartState> {
    this.handoffRetries = 0;
    if (this.status === "idle") {
      this.status = "scheduled";
      this.scheduledAt = this.timestamp();
      this.updatedAt = this.scheduledAt;
      this.projectQueuePausedBySchedule =
        (await this.pauseProjectQueueDispatch?.()) ?? false;
      this.emitChange();
    }

    await this.evaluateAndMaybeRestart();
    return this.getState();
  }

  async cancel(): Promise<SafeRestartState> {
    if (this.status !== "scheduled") {
      return this.getState();
    }

    this.status = "idle";
    this.scheduledAt = undefined;
    this.updatedAt = this.timestamp();
    this.restartTriggered = false;
    this.cancelHandoffRetry();
    if (this.projectQueuePausedBySchedule) {
      await this.resumeProjectQueueDispatch?.();
    }
    this.projectQueuePausedBySchedule = false;
    this.cancelPreservedWork?.();
    this.emitChange();
    return this.getState();
  }

  private getBlockers(): SafeRestartBlocker[] {
    const activity = this.getWorkerActivity();
    const interruptibleSessionCount =
      typeof activity.interruptibleSessionCount === "number" &&
      Number.isFinite(activity.interruptibleSessionCount)
        ? Math.max(0, activity.interruptibleSessionCount)
        : activity.hasActiveWork
          ? Math.max(0, activity.activeWorkers)
          : 0;
    const queuedSessionMessageCount = Math.max(
      0,
      activity.queuedSessionMessageCount ?? activity.queueLength,
    );
    const blockers: SafeRestartBlocker[] = [];
    if (interruptibleSessionCount > 0) {
      blockers.push({
        type: "active-sessions",
        count: interruptibleSessionCount,
      });
    }
    if (queuedSessionMessageCount > 0) {
      blockers.push({
        type: "session-queue",
        count: queuedSessionMessageCount,
      });
    }
    return blockers;
  }

  private getPreservedWork(): SafeRestartPreservedWork[] {
    if (!this.getPreservedWorkSnapshot) return [];
    try {
      return this.getPreservedWorkSnapshot()
        .map((item) => ({
          type: item.type,
          count:
            typeof item.count === "number" && Number.isFinite(item.count)
              ? Math.max(0, item.count)
              : 0,
        }))
        .filter((item) => item.count > 0);
    } catch (error) {
      console.warn(
        "[SafeRestartService] Failed to read preserved restart work:",
        error,
      );
      return [];
    }
  }

  private evaluateAndMaybeRestart(): Promise<void> {
    if (this.evaluationPromise) {
      return this.evaluationPromise;
    }
    this.evaluationPromise = this.evaluateAndMaybeRestartOnce().finally(() => {
      this.evaluationPromise = undefined;
      const reevaluate = this.reevaluateAfterAttempt;
      this.reevaluateAfterAttempt = false;
      if (reevaluate && this.status === "scheduled")
        void this.evaluateAndMaybeRestart();
    });
    return this.evaluationPromise;
  }

  private async evaluateAndMaybeRestartOnce(): Promise<void> {
    if (this.disposed || this.status !== "scheduled" || this.restartTriggered)
      return;
    this.cancelHandoffRetry();

    this.updatedAt = this.timestamp();
    if (this.preparePreservedWork) {
      try {
        await this.preparePreservedWork();
      } catch (error) {
        console.warn(
          "[SafeRestartService] Failed to prepare preserved restart work:",
          error,
        );
      }
    }
    const blockers = this.getBlockers();
    if (blockers.length > 0) {
      this.emitChange();
      return;
    }

    this.status = "restarting";
    this.restartTriggered = true;
    this.updatedAt = this.timestamp();
    this.emitChange();
    try {
      const committed = await this.restart(
        () => this.getBlockers().length === 0,
      );
      if (committed !== false) return;
    } catch (error) {
      console.warn("[SafeRestartService] Restart handoff failed:", error);
    }
    this.status = "scheduled";
    this.restartTriggered = false;
    this.updatedAt = this.timestamp();
    this.emitChange();
    if (this.getBlockers().length === 0) this.scheduleHandoffRetry();
  }

  private scheduleHandoffRetry(): void {
    if (this.disposed || this.handoffRetries >= MAX_HANDOFF_RETRIES) return;
    const delay = HANDOFF_RETRY_BASE_MS * 2 ** this.handoffRetries++;
    this.handoffRetryTimer = setTimeout(() => {
      this.handoffRetryTimer = undefined;
      void this.evaluateAndMaybeRestart();
    }, delay);
    this.handoffRetryTimer.unref?.();
  }

  private cancelHandoffRetry(): void {
    clearTimeout(this.handoffRetryTimer);
    this.handoffRetryTimer = undefined;
  }

  private emitChange(): void {
    const event: SafeRestartChangedEvent = {
      type: "safe-restart-changed",
      state: this.getState(),
      timestamp: this.timestamp(),
    };
    this.eventBus.emit(event);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
