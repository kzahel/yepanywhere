import type { SessionMetadata } from "../../types";

function sameProviderChildren(
  left: SessionMetadata["providerChildren"],
  right: NonNullable<SessionMetadata["providerChildren"]>,
): boolean {
  return (
    left === right ||
    (!!left &&
      left.length === right.length &&
      left.every((child, index) => {
        const next = right[index]!;
        return (
          child.id === next.id &&
          child.parentSessionId === next.parentSessionId &&
          child.title === next.title &&
          child.agentType === next.agentType &&
          child.toolUseId === next.toolUseId &&
          child.spawnDepth === next.spawnDepth &&
          child.updatedAt === next.updatedAt
        );
      }))
  );
}

export function mergeSessionMetadataRefresh(
  prev: SessionMetadata | null,
  incoming: Partial<SessionMetadata>,
): SessionMetadata | null {
  if (!prev) return prev;
  const { creation, providerChildren } = incoming;
  const creationChanged =
    creation !== undefined &&
    JSON.stringify(creation) !== JSON.stringify(prev.creation);
  const childrenChanged =
    providerChildren !== undefined &&
    !sameProviderChildren(prev.providerChildren, providerChildren);
  return creationChanged || childrenChanged
    ? {
        ...prev,
        ...(creationChanged ? { creation } : {}),
        ...(childrenChanged ? { providerChildren } : {}),
      }
    : prev;
}
