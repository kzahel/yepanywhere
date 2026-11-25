import type { SessionCollectionRecord } from "./clientSummaryCollections";

/** Observation time of a field group that no event has reported. */
export const NO_OBSERVATION = Number.NEGATIVE_INFINITY;

// Field-group assignment for the remap merge below: every group's fields win
// or lose together on the group's observation timestamp.
const REMAP_MERGE_GROUPS = {
  contentObservedAt: [
    "title",
    "fullTitle",
    "createdAt",
    "updatedAt",
    "messageCount",
    "provider",
    "model",
    "initialPrompt",
    "lastAgentText",
    "lastHumanTurnAt",
    "asyncQuestions",
    "providerChildren",
  ],
  metadataObservedAt: [
    "nonHumanUserTurn",
    "customTitle",
    "isArchived",
    "isStarred",
    "sidebarCategory",
    "createdByUser",
    "apiClient",
    "autoResumeDisabled",
    "parentSessionId",
    "parentSessionKind",
    "forkedFromSessionId",
    "creationProvenance",
    "clearloop",
    "executor",
  ],
  projectObservedAt: ["projectId", "projectName"],
  lifecycleObservedAt: [
    "ownership",
    "activity",
    "activityInferredFromInboxTier",
    "pendingInputType",
    "activeStartedAt",
  ],
  unreadObservedAt: ["hasUnread"],
} as const satisfies Record<string, readonly (keyof SessionCollectionRecord)[]>;

// Compile-time exhaustiveness: every SessionCollectionRecord field must be in
// a merge group above or merged individually below; a new field fails this
// assignment instead of silently dropping during remap merges.
type RemapMergedField =
  | keyof typeof REMAP_MERGE_GROUPS
  | (typeof REMAP_MERGE_GROUPS)[keyof typeof REMAP_MERGE_GROUPS][number]
  | "id"
  | "observedAt"
  | "snapshotObservedAt"
  | "eventCreatedAt";
type RemapUnmergedField = Exclude<
  keyof SessionCollectionRecord,
  RemapMergedField
>;
const _remapMergeCoversAllRecordFields: [RemapUnmergedField] extends [never]
  ? true
  : { missingFromRemapMergeGroups: RemapUnmergedField } = true;
void _remapMergeCoversAllRecordFields;

/**
 * Merge a provisional session record into the canonical one it was remapped
 * to, field group by field group, keeping each group's fresher observation.
 */
export function mergeRemappedSessionRecords(
  provisional: SessionCollectionRecord | undefined,
  canonical: SessionCollectionRecord | undefined,
  canonicalId: string,
): SessionCollectionRecord | undefined {
  if (!provisional && !canonical) return undefined;
  if (!provisional) return canonical;
  if (!canonical) return { ...provisional, id: canonicalId };

  const pickGroup = (
    observedField: keyof typeof REMAP_MERGE_GROUPS,
    fields: readonly (keyof SessionCollectionRecord)[],
  ): Partial<SessionCollectionRecord> => {
    const provisionalObservedAt = provisional[observedField] ?? NO_OBSERVATION;
    const canonicalObservedAt = canonical[observedField] ?? NO_OBSERVATION;
    const [primary, secondary] =
      canonicalObservedAt >= provisionalObservedAt
        ? [canonical, provisional]
        : [provisional, canonical];
    const entries: Array<[keyof SessionCollectionRecord, unknown]> = [];
    for (const field of fields) {
      const value =
        primary[field] !== undefined ? primary[field] : secondary[field];
      if (value !== undefined) {
        entries.push([field, value]);
      }
    }
    const groupObservedAt = Math.max(
      provisionalObservedAt,
      canonicalObservedAt,
    );
    if (groupObservedAt !== NO_OBSERVATION) {
      entries.push([observedField, groupObservedAt]);
    }
    return Object.fromEntries(entries) as Partial<SessionCollectionRecord>;
  };

  const merged: SessionCollectionRecord = {
    id: canonicalId,
    observedAt: Math.max(provisional.observedAt, canonical.observedAt),
  };
  // Drive the merge off the group table itself, so a group added to
  // REMAP_MERGE_GROUPS is picked up here automatically. The exhaustiveness
  // assertion above only proves every field is assigned to some group; this
  // loop is what guarantees each group is actually merged.
  for (const observedField of Object.keys(REMAP_MERGE_GROUPS) as Array<
    keyof typeof REMAP_MERGE_GROUPS
  >) {
    Object.assign(
      merged,
      pickGroup(observedField, REMAP_MERGE_GROUPS[observedField]),
    );
  }
  if (
    provisional.snapshotObservedAt !== undefined ||
    canonical.snapshotObservedAt !== undefined
  ) {
    merged.snapshotObservedAt = Math.max(
      provisional.snapshotObservedAt ?? NO_OBSERVATION,
      canonical.snapshotObservedAt ?? NO_OBSERVATION,
    );
  }
  if (
    provisional.eventCreatedAt !== undefined ||
    canonical.eventCreatedAt !== undefined
  ) {
    merged.eventCreatedAt = Math.min(
      provisional.eventCreatedAt ?? Number.POSITIVE_INFINITY,
      canonical.eventCreatedAt ?? Number.POSITIVE_INFINITY,
    );
  }
  return merged;
}
