import type {
  SessionQueuedMessageSummary,
  UserMessageDeliveryIntent,
  UserMessageMetadata,
} from "@yep-anywhere/shared";
import type { SessionMetadataService } from "../metadata/index.js";
import type { ClearloopService } from "../services/ClearloopService.js";
import type {
  PersistedSessionQueuedMessage,
  SessionQueuePersistenceService,
} from "../services/SessionQueuePersistenceService.js";
import type { UserMessage } from "../sdk/types.js";
import type { Process } from "../supervisor/Process.js";

export interface SessionQueueSummaryDeps {
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
  sessionMetadataService?: Pick<SessionMetadataService, "getMetadata">;
  clearloopService?: Pick<ClearloopService, "getRunningJob" | "getProgress">;
}

export function persistedPatientQueueSummary(
  item: PersistedSessionQueuedMessage,
): SessionQueuedMessageSummary {
  const attachmentCount =
    (item.message.attachments?.length ?? 0) +
    (item.message.images?.length ?? 0) +
    (item.message.documents?.length ?? 0);
  const tempId = item.message.tempId ?? item.source?.tempId;

  return {
    id: item.id,
    ...(tempId ? { tempId } : {}),
    content: item.message.text,
    ...(item.message.queuedCompact ? { operation: "compact" as const } : {}),
    timestamp: item.queuedAt,
    ...(item.message.attachments?.length
      ? { attachments: item.message.attachments }
      : {}),
    ...(attachmentCount > 0 ? { attachmentCount } : {}),
    ...(item.message.metadata ? { metadata: item.message.metadata } : {}),
    kind: "patient",
    status: item.status === "paused-after-restart" ? item.status : "queued",
    sessionId: item.sessionId,
    projectId: item.projectId,
    queuedAt: item.queuedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export function recoveredPatientQueueSummaries(
  deps: SessionQueueSummaryDeps,
  sessionId: string,
): SessionQueuedMessageSummary[] {
  return recoveredPatientQueueItems(deps, sessionId).map(
    persistedPatientQueueSummary,
  );
}

export function recoveredPatientQueueItems(
  deps: SessionQueueSummaryDeps,
  sessionId: string,
): PersistedSessionQueuedMessage[] {
  if (!deps.sessionQueuePersistenceService) {
    return [];
  }
  return deps.sessionQueuePersistenceService
    .listSession(sessionId)
    .filter(
      (item) =>
        item.kind === "patient" && item.status === "paused-after-restart",
    )
    .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
}

export function sessionQueueSummaries(
  deps: SessionQueueSummaryDeps,
  sessionId: string,
  process: Process | undefined,
): SessionQueuedMessageSummary[] {
  const recovered = recoveredPatientQueueSummaries(deps, sessionId);
  const live = process?.getDeferredQueueSummary() ?? [];
  const pendingBoundary =
    deps.sessionMetadataService?.getMetadata(sessionId)?.pendingSyntheticDone;
  const liveIds = new Set(
    live
      .map((message) => message.id)
      .filter((id): id is string => id !== undefined),
  );
  const liveTempIds = new Set(
    live
      .map((message) => message.tempId)
      .filter((id): id is string => id !== undefined),
  );
  const ordered = [
    ...live,
    ...recovered.filter(
      (message) => message.id === undefined || !liveIds.has(message.id),
    ),
    ...(pendingBoundary && !liveTempIds.has(pendingBoundary.message.uuid)
      ? [
          {
            tempId: pendingBoundary.message.uuid,
            content: pendingBoundary.message.content,
            timestamp: pendingBoundary.message.timestamp,
            kind: "ya-command" as const,
            yaCommand: "done" as const,
            status: "queued" as const,
          },
        ]
      : []),
  ].sort((left, right) =>
    (left.queuedAt ?? left.timestamp).localeCompare(
      right.queuedAt ?? right.timestamp,
    ),
  );
  // The clearloop entry is always last: it owns its own send boundary and
  // never holds a deferred or patient position (topics/session-rewind.md).
  const clearloop = deps.clearloopService?.getRunningJob(sessionId);
  const progress = clearloop
    ? deps.clearloopService?.getProgress(sessionId)
    : undefined;
  return clearloop && progress
    ? [
        ...ordered,
        {
          tempId: `ya-clearloop-${clearloop.id}`,
          content: clearloop.prompt,
          timestamp: clearloop.startedAt,
          kind: "ya-command" as const,
          yaCommand: "clearloop" as const,
          clearloop: progress,
          status: "queued" as const,
        },
      ]
    : ordered;
}

export function recoveredPatientUserMessage(
  item: PersistedSessionQueuedMessage,
): UserMessage {
  const mode = item.message.mode ?? item.mode;
  const metadata: UserMessageMetadata = {
    ...item.message.metadata,
    deliveryIntent: "patient" satisfies UserMessageDeliveryIntent,
  };
  // Live-queue chip actions (cancel, steer) address entries by tempId, so a
  // recovered entry that was persisted without one gets a stable fallback.
  const tempId =
    item.message.tempId ?? item.source?.tempId ?? `recovered-${item.id}`;
  return {
    ...item.message,
    tempId,
    ...(mode ? { mode } : {}),
    metadata,
  };
}

/**
 * Count live patient queue entries composed after the given recovered entry.
 * Resuming or steering the recovered entry would deliver its older content
 * behind these newer ones, so callers reject while any exist. Regular
 * deferred entries never block recovered work: the regular lane delivers on
 * turn boundaries and may pass patient work by design.
 */
export function livePatientEntriesNewerThan(
  process: Process | undefined,
  queuedAt: string,
): number {
  const live = process?.getDeferredQueueSummary() ?? [];
  return live.filter(
    (entry) =>
      entry.metadata?.deliveryIntent === "patient" &&
      entry.timestamp.localeCompare(queuedAt) > 0,
  ).length;
}
