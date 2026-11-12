import type {
  ProjectQueueItemSummary,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { decodeProjectId, getProjectIdentityKey } from "../projects/paths.js";

function queueProjectKey(id: string): string {
  try {
    return JSON.stringify([
      "path",
      getProjectIdentityKey(decodeProjectId(id as UrlProjectId)),
    ]);
  } catch {
    return JSON.stringify(["id", id]);
  }
}

/** One request-local queue projection, shared by every project card in the response. */
export function projectQueueCounts(items: readonly ProjectQueueItemSummary[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.status !== "queued" && item.status !== "failed") continue;
    const key = queueProjectKey(item.projectId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (projectId: string) => counts.get(queueProjectKey(projectId)) ?? 0;
}
