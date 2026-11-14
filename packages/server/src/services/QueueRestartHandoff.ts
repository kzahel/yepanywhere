import * as fs from "node:fs";
import * as path from "node:path";
import type {
  PermissionRules,
  ProjectQueueDispatchState,
} from "@yep-anywhere/shared";
import type { Process } from "../supervisor/Process.js";
import type { ProjectQueueService } from "./ProjectQueueService.js";
import type { SessionQueuePersistenceService } from "./SessionQueuePersistenceService.js";

const MAX_HANDOFF_AGE_MS = 5 * 60_000;
const FILE_NAME = "queue-restart-handoff.json";

export interface QueueRestartRecord {
  version: 1;
  pid: number;
  createdAt: number;
  projectPause: ProjectQueueDispatchState;
  resumeProjectQueue: boolean;
  patientIds: string[];
  sessionPermissions: [string, PermissionRules | null][];
}

/** One-use permission to continue waiting work after an orderly owner handoff. */
export class QueueRestartHandoff {
  private readonly filePath: string;
  // Bounded by live patient backlog; cleared when scheduling is cancelled.
  private readonly scheduledPatientIds = new Set<string>();
  private readonly blockedPatientIds = new Set<string>();
  private readonly sessionPermissions = new Map<
    string,
    PermissionRules | null
  >();
  // Fixed snapshot from one consumed handoff; never grows after startup.
  private readonly restoredPermissions = new Map<
    string,
    PermissionRules | null
  >();
  private drainProjects: (() => void | Promise<void>) | undefined;
  private scheduledProjectPause: string | undefined;
  private pending:
    | Omit<QueueRestartRecord, "version" | "pid" | "createdAt">
    | undefined;

  constructor(
    dataDir: string,
    private readonly projects: ProjectQueueService,
    private readonly sessions: SessionQueuePersistenceService,
  ) {
    this.filePath = path.join(dataDir, FILE_NAME);
  }

  /** Consume before startup can fail; a failed generation cannot reuse it. */
  consume(): QueueRestartRecord | undefined {
    try {
      const content = fs.readFileSync(this.filePath, "utf8");
      fs.unlinkSync(this.filePath);
      const value = JSON.parse(content) as QueueRestartRecord;
      const age = Date.now() - value.createdAt;
      if (
        value.version !== 1 ||
        !Number.isInteger(value.pid) ||
        value.pid <= 0 ||
        !Number.isFinite(age) ||
        age < 0 ||
        age > MAX_HANDOFF_AGE_MS ||
        typeof value.resumeProjectQueue !== "boolean" ||
        !Array.isArray(value.sessionPermissions) ||
        !value.sessionPermissions.every(validPermissionSnapshot) ||
        !Array.isArray(value.patientIds) ||
        !value.patientIds.every((id) => typeof id === "string") ||
        (value.projectPause?.status !== "running" &&
          !(
            value.projectPause?.status === "paused" &&
            (value.projectPause.reason === "restart" ||
              value.projectPause.reason === "manual") &&
            typeof value.projectPause.pausedAt === "string"
          ))
      )
        return undefined;
      // A live prior controller (or reused PID) is never a clean handoff.
      try {
        process.kill(value.pid, 0);
        return undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return undefined;
      }
      for (const [id, rules] of value.sessionPermissions)
        this.restoredPermissions.set(id, rules);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[QueueRestart] Could not consume queue handoff:", error);
      }
      return undefined;
    }
  }

  rememberPatientQueues(
    owners: Pick<
      Process,
      "sessionId" | "getDeferredQueueSummary" | "permissions"
    >[] = [],
  ): void {
    const items = this.sessions.list();
    const queuedSessions = new Set([
      ...items.map((item) => item.sessionId),
      ...owners.map((owner) => owner.sessionId),
    ]);
    for (const item of this.projects.listAll()) {
      if (item.target.type === "existing-session")
        queuedSessions.add(item.target.sessionId);
    }
    // A still-cold Project Queue target can outlive several orderly restarts.
    for (const id of queuedSessions) {
      if (
        !this.sessionPermissions.has(id) &&
        this.restoredPermissions.has(id)
      ) {
        this.sessionPermissions.set(id, this.restoredPermissions.get(id)!);
      }
    }
    for (const owner of owners) {
      if (queuedSessions.has(owner.sessionId)) {
        this.sessionPermissions.set(
          owner.sessionId,
          owner.permissions ? structuredClone(owner.permissions) : null,
        );
      }
    }
    for (const id of this.sessionPermissions.keys()) {
      if (!queuedSessions.has(id)) this.sessionPermissions.delete(id);
    }
    const blockedSessions = new Set(
      owners
        .filter((owner) =>
          owner
            .getDeferredQueueSummary()
            .some((row) => row.compactionGate !== undefined),
        )
        .map((owner) => owner.sessionId),
    );
    for (const item of items) {
      if (blockedSessions.has(item.sessionId)) {
        this.blockedPatientIds.add(item.id);
        this.scheduledPatientIds.delete(item.id);
      } else if (
        item.kind === "patient" &&
        item.status === "queued" &&
        !this.blockedPatientIds.has(item.id)
      ) {
        this.scheduledPatientIds.add(item.id);
      }
    }
    const retained = new Set(items.map((item) => item.id));
    for (const ids of [this.scheduledPatientIds, this.blockedPatientIds]) {
      for (const id of ids) if (!retained.has(id)) ids.delete(id);
    }
  }

  permissionRulesForSession(
    sessionId: string,
    live: Pick<Process, "permissions"> | undefined,
  ): PermissionRules | undefined {
    return live
      ? live.permissions
      : (this.restoredPermissions.get(sessionId) ?? undefined);
  }

  async pauseProjectQueue(): Promise<boolean> {
    if (
      this.projects.listAll().length === 0 ||
      this.projects.isDispatchPaused()
    )
      return false;
    const paused = await this.projects.pauseDispatch("restart");
    if (paused.status === "paused")
      this.scheduledProjectPause = paused.pausedAt;
    return true;
  }

  forgetPreservedPatients(): void {
    this.scheduledPatientIds.clear();
    this.blockedPatientIds.clear();
    this.sessionPermissions.clear();
  }

  async cancelScheduledRestart(): Promise<void> {
    const state = this.projects.getDispatchState();
    if (
      state.status === "paused" &&
      state.reason === "restart" &&
      state.pausedAt === this.scheduledProjectPause
    ) {
      await this.projects.resumeDispatch();
    }
    this.scheduledProjectPause = undefined;
    this.scheduledPatientIds.clear();
  }

  setProjectQueueDrain(drain: () => void | Promise<void>): void {
    this.drainProjects = drain;
  }

  /** Called only after admission closes, before providers detach or stop. */
  async prepare(
    owners: Pick<
      Process,
      "sessionId" | "getDeferredQueueSummary" | "permissions"
    >[] = [],
  ): Promise<void> {
    this.rememberPatientQueues(owners);
    const previous = this.projects.getDispatchState();
    const resumeProjectQueue =
      previous.status === "running" ||
      (previous.reason === "restart" &&
        previous.pausedAt === this.scheduledProjectPause);
    if (previous.status === "running" && this.projects.listAll().length > 0) {
      await this.projects.pauseDispatch("restart");
    }
    await this.drainProjects?.();
    this.pending = {
      resumeProjectQueue,
      projectPause: this.projects.getDispatchState(),
      patientIds: [...this.scheduledPatientIds],
      sessionPermissions: [...this.sessionPermissions],
    };
  }

  /** Synchronous final step immediately before process.exit, after verified cleanup. */
  commit(): void {
    if (!this.pending) return;
    const waiting = new Set(
      this.sessions
        .list()
        .filter((item) => item.kind === "patient" && item.status !== "claimed")
        .map((item) => item.id),
    );
    const record: QueueRestartRecord = {
      ...this.pending,
      sessionPermissions: [
        ...new Map([
          ...this.pending.sessionPermissions,
          ...this.sessionPermissions,
        ]),
      ],
      patientIds: this.pending.patientIds.filter(
        (id) => waiting.has(id) && !this.blockedPatientIds.has(id),
      ),
      version: 1,
      pid: process.pid,
      createdAt: Date.now(),
    };
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      console.error("[QueueRestart] Could not preserve queue handoff:", error);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}

function validPermissionSnapshot(value: unknown): boolean {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string"
  )
    return false;
  const rules = value[1];
  if (rules === null) return true;
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) return false;
  return Object.entries(rules).every(
    ([key, patterns]) =>
      (key === "allow" || key === "deny") &&
      Array.isArray(patterns) &&
      patterns.every((pattern) => typeof pattern === "string"),
  );
}
