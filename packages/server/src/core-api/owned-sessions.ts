import type { Supervisor } from "../supervisor/Supervisor.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";

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
        updatedAt: info.startedAt,
        state: process.state.type,
      };
    });
}
