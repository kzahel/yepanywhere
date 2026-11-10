import {
  isYaSessionId,
  type UrlProjectId,
  type SessionCreationStatus,
} from "@yep-anywhere/shared";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { SessionSummary } from "../supervisor/types.js";
import type { SessionCreationProjection } from "./SessionCreationStore.js";
import type { SessionIdentity } from "./SessionIdentityStore.js";

/** Public control-state projection. Saved text is not a native transcript row. */
export function savedCreationView(
  metadata: SessionMetadataService | undefined,
  identity: SessionIdentity,
  projectId: UrlProjectId,
  signal?: AbortSignal,
  missingNativeTranscript = false,
) {
  if (
    signal?.aborted ||
    !metadata ||
    (identity.native && !missingNativeTranscript)
  )
    return;
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
      nativeSessionId: identity.native?.id,
      createdAt: creation.createdAt,
      updatedAt: attempt.updatedAt,
      messageCount: 0,
      ownership,
      forkedFromSessionId: stored?.forkedFromSessionId,
      parentSessionId: stored?.parentSessionId,
      parentSessionKind: stored?.parentSessionKind,
      customTitle: stored?.customTitle,
      isArchived: stored?.isArchived,
      isStarred: stored?.isStarred,
      creationProvenance: stored?.creationProvenance,
      routerBinding: stored?.routerBinding,
      effectiveLaunchSettings: stored?.effectiveLaunchSettings,
      workingProjectId: stored?.workingProjectId,
      transcriptProjectId: stored?.transcriptProjectId,
      hasUnread: false,
      creation: {
        state: attempt.state,
        attemptId: attempt.attemptId,
        updatedAt: attempt.updatedAt,
        delivery: attempt.delivery,
        ...(attempt.kind ? { kind: attempt.kind } : {}),
        ...(request.intent ? { initialInputExpected: false as const } : {}),
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

/** No native-source read or payload JSON decoding belongs to a collection. */
export function creationCollectionRows(
  metadata: SessionMetadataService | undefined,
  signal?: AbortSignal,
): SessionCreationProjection[] {
  return signal?.aborted ? [] : (metadata?.creations?.listProjections() ?? []);
}

export function creationStatusForSession(
  metadata: SessionMetadataService | undefined,
  sessionId: string,
  signal?: AbortSignal,
): SessionCreationStatus | undefined {
  return !signal?.aborted && isYaSessionId(sessionId)
    ? metadata?.creations?.statusForSession(sessionId)
    : undefined;
}

export function creationSessionSummary(
  row: SessionCreationProjection,
  metadata: Pick<SessionMetadataService, "getMetadata">,
): SessionSummary | undefined {
  if (row.deleted) return;
  const stored = metadata.getMetadata(row.sessionId);
  const message = stored?.initialPrompt;
  return {
    id: row.sessionId,
    projectId: stored?.workingProjectId ?? row.projectId,
    provider: row.provider,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    title: message?.trim().slice(0, 120) || null,
    fullTitle: message ?? null,
    messageCount: 0,
    ownership: { owner: "none" },
    hasUnread: false,
    forkedFromSessionId: stored?.forkedFromSessionId,
    parentSessionId: stored?.parentSessionId,
    parentSessionKind: stored?.parentSessionKind,
    customTitle: stored?.customTitle,
    isArchived: stored?.isArchived,
    isStarred: stored?.isStarred,
    creationProvenance: stored?.creationProvenance,
    creation: row.creation,
  };
}

export function mergeCreationSessionSummaries(
  native: SessionSummary[],
  metadata: SessionMetadataService | undefined,
  projectId: UrlProjectId,
  signal?: AbortSignal,
  activeAfterMs?: number,
): SessionSummary[] {
  if (!metadata || signal?.aborted) return signal?.aborted ? [] : native;
  const rows = creationCollectionRows(metadata, signal),
    byId = new Map(rows.map((row) => [row.sessionId, row]));
  const result = native.flatMap((session) => {
    const row = isYaSessionId(session.id) ? byId.get(session.id) : undefined;
    return row?.deleted || (row && !row.nativeBound)
      ? []
      : [{ ...session, ...(row ? { creation: row.creation } : {}) }];
  });
  const seen = new Set(result.map((session) => session.id));
  for (const row of rows) {
    if (seen.has(row.sessionId)) continue;
    const summary = creationSessionSummary(row, metadata);
    if (
      summary?.projectId === projectId &&
      (activeAfterMs === undefined ||
        !Number.isFinite(Date.parse(summary.updatedAt)) ||
        Date.parse(summary.updatedAt) >= activeAfterMs)
    )
      result.push(summary);
  }
  return result;
}
