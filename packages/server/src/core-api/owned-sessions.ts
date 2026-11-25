import type { Supervisor } from "../supervisor/Supervisor.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { Process } from "../supervisor/Process.js";

/**
 * v0 session state: compacting while a YA-scheduled compaction runs, which
 * the provider reports as an ordinary turn. Compaction started by typed
 * provider text is not detected here.
 */
export function apiSessionState(
  process: Pick<
    Process,
    "state" | "getDeferredQueueSummary" | "provider" | "isRetainingProviderWork"
  >,
): string {
  return process
    .getDeferredQueueSummary()
    .some((entry) => entry.compactionGate?.state === "compacting")
    ? "compacting"
    : process.provider === "antigravity" &&
        process.state.type === "idle" &&
        process.isRetainingProviderWork()
      ? "background"
      : process.state.type;
}

/** Active native owners that may not yet appear in the retained catalog. */
export function ownedApiSessions(
  supervisor: Pick<Supervisor, "getAllProcesses">,
  metadataService: Pick<SessionMetadataService, "getMetadata"> | undefined,
) {
  return supervisor
    .getAllProcesses()
    .filter((process) => !process.isTerminated)
    .map((process) => {
      const info = process.getInfo();
      const metadata = metadataService?.getMetadata(process.sessionId);
      return {
        id: process.sessionId,
        projectId: metadata?.workingProjectId ?? process.projectId,
        provider: process.provider,
        title: metadata?.customTitle ?? info.sessionTitle,
        createdByUser: metadata?.createdByUser,
        apiClient: metadata?.apiClient,
        updatedAt: info.startedAt,
        state: apiSessionState(process),
      };
    });
}
