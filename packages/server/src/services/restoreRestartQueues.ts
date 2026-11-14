import type { SessionMetadataService } from "../metadata/index.js";
import {
  ensureProcessForRecoveredItem,
  resumeRecoveredGroup,
} from "../routes/session-recovered-queue.js";
import { isAutomaticSessionResumeAllowed } from "../sessions/resume-exemption.js";
import { isServerStopping } from "../server-restart-control.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { ProjectQueueService } from "./ProjectQueueService.js";
import type { QueueRestartRecord } from "./QueueRestartHandoff.js";
import type { SessionQueuePersistenceService } from "./SessionQueuePersistenceService.js";

/** Restore session ordering before enabling project-level promotion. No retries. */
export async function restoreRestartQueues(
  record: QueueRestartRecord | undefined,
  deps: {
    projectQueueService: ProjectQueueService;
    sessionQueuePersistenceService: SessionQueuePersistenceService;
    sessionMetadataService: SessionMetadataService;
    supervisor: Pick<Supervisor, "getProcessForSession" | "reactivateSession">;
    getGlobalInstructions: () => string | undefined;
  },
): Promise<void> {
  if (!record || isServerStopping()) return;
  const eligible = new Set(record.patientIds);
  const sessionIds = new Set(
    deps.sessionQueuePersistenceService
      .list()
      .filter((item) => eligible.has(item.id))
      .map((item) => item.sessionId),
  );
  for (const sessionId of sessionIds) {
    if (isServerStopping()) return;
    const group = deps.sessionQueuePersistenceService
      .listSession(sessionId)
      .filter((item) => item.kind === "patient")
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    const metadata = deps.sessionMetadataService.getMetadata(sessionId);
    // Pre-existing paused/uncertain work must not be jumped over or resumed.
    if (
      group.some(
        (item) =>
          !eligible.has(item.id) || item.status !== "paused-after-restart",
      ) ||
      !isAutomaticSessionResumeAllowed(metadata)
    )
      continue;
    try {
      let process = deps.supervisor.getProcessForSession(sessionId);
      if (!process || process.isTerminated) {
        const permissionSnapshot = record.sessionPermissions.find(
          ([id]) => id === sessionId,
        );
        // Missing rule evidence cannot authorize a less restricted cold owner.
        if (!permissionSnapshot) continue;
        const first = group[0];
        if (!first) continue;
        const effective =
          deps.sessionMetadataService.getEffectiveLaunchSettings(sessionId);
        const mode =
          effective?.permissionMode ?? first.message.mode ?? first.mode;
        const ensured = await ensureProcessForRecoveredItem(
          deps,
          sessionId,
          {
            ...first,
            mode,
            message: { ...first.message, mode },
            model: effective
              ? (effective.requestedModel ?? "default")
              : first.model,
            serviceTier: effective
              ? (effective.serviceTier ?? undefined)
              : first.serviceTier,
          },
          undefined,
          { permissions: permissionSnapshot[1] ?? undefined },
        );
        if ("error" in ensured) throw new Error(ensured.error);
        process = ensured.process;
      }
      if (isServerStopping()) return;
      if (process.getDeferredQueueSummary().length > 0) {
        throw new Error(
          "Live queued work already exists; recovered messages remain paused",
        );
      }
      const resumed = await resumeRecoveredGroup(process, group, {
        promoteIfReady: false,
      });
      await process.waitForPatientQueuePersistenceIdle();
      if (resumed.error) throw new Error(resumed.error);
      process.promoteDeferredAfterCompactionGate();
    } catch (error) {
      console.error(
        `[QueueRestart] Patient queue for ${sessionId} remains paused:`,
        error,
      );
    }
  }
  const state = deps.projectQueueService.getDispatchState();
  if (
    !isServerStopping() &&
    record.resumeProjectQueue &&
    JSON.stringify(state) === JSON.stringify(record.projectPause)
  ) {
    await deps.projectQueueService.resumeDispatch();
  }
}
