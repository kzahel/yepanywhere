import type { GlobalSessionItem } from "../api/client";
import type { SessionCollectionRecord } from "./clientSummaryCollections";

export function sessionCollectionRecordToGlobalSessionItem(
  record: SessionCollectionRecord,
): GlobalSessionItem | null {
  const updatedAt = record.updatedAt ?? record.createdAt;
  if (!record.provider || !record.projectId || !updatedAt) {
    return null;
  }

  return {
    id: record.id,
    title: record.title ?? null,
    fullTitle: record.fullTitle ?? null,
    createdAt: record.createdAt,
    updatedAt,
    messageCount: record.messageCount ?? 0,
    provider: record.provider,
    model: record.model,
    projectId: record.projectId,
    projectName: record.projectName ?? "",
    ownership: record.ownership ?? { owner: "none" },
    pendingInputType: record.pendingInputType,
    activity: record.activity,
    hasUnread: record.hasUnread,
    customTitle: record.customTitle,
    isArchived: record.isArchived,
    isStarred: record.isStarred,
    sidebarCategory: record.sidebarCategory,
    createdByUser: record.createdByUser,
    apiClient: record.apiClient,
    autoResumeDisabled: record.autoResumeDisabled,
    parentSessionId: record.parentSessionId,
    parentSessionKind: record.parentSessionKind,
    forkedFromSessionId: record.forkedFromSessionId,
    creationProvenance: record.creationProvenance,
    clearloop: record.clearloop,
    initialPrompt: record.initialPrompt,
    executor: record.executor,
    lastAgentText: record.lastAgentText,
    lastHumanTurnAt: record.lastHumanTurnAt,
    asyncQuestions: record.asyncQuestions,
    nonHumanUserTurn: record.nonHumanUserTurn,
    providerChildren: record.providerChildren,
  };
}

export function sessionCollectionRecordsToGlobalSessionItems(
  records: readonly SessionCollectionRecord[],
): GlobalSessionItem[] {
  const sessions: GlobalSessionItem[] = [];
  for (const record of records) {
    const session = sessionCollectionRecordToGlobalSessionItem(record);
    if (session) {
      sessions.push(session);
    }
  }
  return sessions;
}
