import type { UrlProjectId } from "@yep-anywhere/shared";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { SessionIdentity } from "./SessionIdentityStore.js";

/** Public control-state projection. Saved text is not a native transcript row. */
export function savedCreationView(
  metadata: SessionMetadataService | undefined,
  identity: SessionIdentity,
  projectId: UrlProjectId,
) {
  if (!metadata || identity.native) return;
  const creation = metadata.creations.getForSession(identity.sessionId);
  if (!creation || creation.deleted || !creation.request) return;
  const stored = metadata.getMetadata(identity.sessionId);
  if ((stored?.workingProjectId ?? identity.projectId) !== projectId) return;
  const { attempt, request } = creation;
  const ownership = { owner: "none" as const };
  return {
    session: {
      id: identity.sessionId,
      projectId,
      provider: identity.provider,
      title: request.message.trim().slice(0, 120) || null,
      fullTitle: request.message,
      initialPrompt: request.message,
      createdAt: creation.createdAt,
      updatedAt: attempt.updatedAt,
      messageCount: 0,
      ownership,
      customTitle: stored?.customTitle,
      isArchived: stored?.isArchived,
      isStarred: stored?.isStarred,
      creationProvenance: stored?.creationProvenance,
      effectiveLaunchSettings: stored?.effectiveLaunchSettings,
      workingProjectId: stored?.workingProjectId,
      transcriptProjectId: stored?.transcriptProjectId,
      hasUnread: false,
      creation: {
        state: attempt.state,
        attemptId: attempt.attemptId,
        delivery: attempt.delivery,
        ...(attempt.failure ? { failure: attempt.failure } : {}),
      },
    },
    ownership,
    processState: null,
    providerRuntimeStatus: null,
    pendingInputRequest: null,
    slashCommands: [],
  };
}
