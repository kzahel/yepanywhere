import type { SessionMetadataService } from "../metadata/index.js";
import type {
  PersistedSessionQueuedMessage,
  SessionQueuePersistenceService,
} from "../services/SessionQueuePersistenceService.js";
import type { UserMessage } from "../sdk/types.js";
import type { Process } from "../supervisor/Process.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import { persistLaunchMetadata } from "./session-launch-metadata.js";
import { parseOptionalExecutor } from "./session-request-helpers.js";
import {
  livePatientEntriesNewerThan,
  recoveredPatientQueueItems,
  recoveredPatientUserMessage,
  sessionQueueSummaries,
} from "./session-queue-summaries.js";

export interface RecoveredQueueDeps {
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
  sessionMetadataService?: SessionMetadataService;
  supervisor: Pick<Supervisor, "getProcessForSession" | "reactivateSession">;
  getGlobalInstructions: () => string | undefined;
}

// A recovered patient queue entry may need a fresh process before it can
// rejoin the live queue. Shared by the recovered-queue resume/steer routes.
export async function ensureProcessForRecoveredItem(
  deps: RecoveredQueueDeps,
  sessionId: string,
  item: PersistedSessionQueuedMessage,
  existing: Process | undefined,
): Promise<{ process: Process } | { error: string; status: 400 | 503 }> {
  let process = existing;
  const mode = item.message.mode ?? item.mode;
  const metadata = deps.sessionMetadataService?.getMetadata(sessionId);
  const parsedExecutor = parseOptionalExecutor(
    item.executor ?? metadata?.executor,
  );
  if (parsedExecutor.error) {
    return { error: parsedExecutor.error, status: 400 };
  }
  const rawModel = item.model ?? metadata?.requestedModel;
  const model = rawModel && rawModel !== "default" ? rawModel : undefined;

  if (!process) {
    try {
      process = await deps.supervisor.reactivateSession(
        item.projectPath,
        sessionId,
        mode,
        {
          model,
          requestedModel: item.model,
          serviceTier: item.serviceTier,
          providerName: item.provider,
          executor: parsedExecutor.executor,
          globalInstructions: deps.getGlobalInstructions(),
          recapAfterSeconds: metadata?.recapAfterSeconds,
          promptSuggestionMode: metadata?.promptSuggestionMode,
        },
      );
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "Failed to reactivate session",
        status: 503,
      };
    }
    await persistLaunchMetadata(deps.sessionMetadataService, sessionId, {
      provider: item.provider,
      executor: parsedExecutor.executor,
      requestedModel: item.model ?? metadata?.requestedModel,
      promptSuggestionMode: metadata?.promptSuggestionMode,
      recapAfterSeconds: metadata?.recapAfterSeconds,
    });
  } else if (mode) {
    process.setPermissionMode(mode);
  }
  return { process };
}

// Move recovered entries back into the live patient queue in queuedAt
// order. On a mid-group failure the earlier resumes stand; the caller
// reports the failed entry.
export async function resumeRecoveredGroup(
  process: Process,
  group: PersistedSessionQueuedMessage[],
  options: { promoteIfReady: boolean },
): Promise<{
  last?: { deferred: boolean; promoted?: boolean; position?: number };
  lastMessage?: UserMessage;
  error?: string;
}> {
  let last:
    | { deferred: boolean; promoted?: boolean; position?: number }
    | undefined;
  let lastMessage: UserMessage | undefined;
  for (const item of group) {
    const userMessage = recoveredPatientUserMessage(item);
    await process.primeSupportedCommandsForMessage(userMessage);
    const result = process.deferMessage(userMessage, {
      promoteIfReady: options.promoteIfReady,
      persistedQueueId: item.id,
      timestamp: item.queuedAt,
    });
    if (!result.success) {
      return {
        last,
        lastMessage,
        error: result.error ?? "Failed to queue message",
      };
    }
    last = result;
    lastMessage = userMessage;
  }
  return { last, lastMessage };
}

export function reportableProcessState(process: Process) {
  return process.state.type === "waiting-input" ||
    process.state.type === "in-turn"
    ? process.state.type
    : "idle";
}

// Shared prologue for the recovered-queue resume/steer routes: resolve the
// target and the recovered group composed before it, refuse while newer
// live patient entries exist, and ensure a live process. The newer-entries
// guard runs again after the ensure; its await is a window for new
// arrivals, and recovered context must never jump a newer patient entry.
export async function resolveRecoveredGroupForDelivery(
  deps: RecoveredQueueDeps,
  sessionId: string,
  queueId: string,
  refusal: string,
): Promise<
  | {
      ok: true;
      process: Process;
      group: PersistedSessionQueuedMessage[];
    }
  | {
      ok: false;
      status: 400 | 404 | 409 | 503;
      body: Record<string, unknown>;
    }
> {
  if (!deps.sessionQueuePersistenceService) {
    return {
      ok: false,
      status: 503,
      body: { error: "Session queue persistence unavailable" },
    };
  }
  const recoveredItems = recoveredPatientQueueItems(deps, sessionId);
  const targetIndex = recoveredItems.findIndex(
    (candidate) => candidate.id === queueId,
  );
  const target = recoveredItems[targetIndex];
  if (!target) {
    return {
      ok: false,
      status: 404,
      body: { error: "Recovered queued message not found" },
    };
  }
  const group = recoveredItems.slice(0, targetIndex + 1);

  let process = deps.supervisor.getProcessForSession(sessionId);
  if (process?.isTerminated) {
    process = undefined;
  }
  const refuseIfNewerEntries = (candidate: Process | undefined) =>
    livePatientEntriesNewerThan(candidate, target.queuedAt) > 0
      ? {
          ok: false as const,
          status: 409 as const,
          body: {
            error: refusal,
            headQueueId: target.id,
            deferredMessages: sessionQueueSummaries(deps, sessionId, candidate),
          },
        }
      : null;
  const refusedBefore = refuseIfNewerEntries(process);
  if (refusedBefore) {
    return refusedBefore;
  }

  const ensured = await ensureProcessForRecoveredItem(
    deps,
    sessionId,
    target,
    process,
  );
  if ("error" in ensured) {
    return {
      ok: false,
      status: ensured.status,
      body: { error: ensured.error },
    };
  }
  process = ensured.process;
  const refusedAfter = refuseIfNewerEntries(process);
  if (refusedAfter) {
    return refusedAfter;
  }

  return { ok: true, process, group };
}
