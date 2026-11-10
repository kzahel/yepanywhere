import type {
  GlobalSessionItem,
  GlobalSessionsDeps,
} from "./global-sessions.js";
import type { RetainedSessionCollections } from "../services/RetainedSessionCollections.js";
import { retainedSessionQuery } from "../services/retained-session-query.js";
export { compareProjectOptions } from "./retained-session-item.js";

export type RetainedItemsDeps = Pick<
  GlobalSessionsDeps,
  | "signal"
  | "sessionMetadataService"
  | "supervisor"
  | "externalTracker"
  | "notificationService"
  | "sessionAutoArchiveDays"
  | "projectDisplayName"
  | "providerChildRelationships"
>;

/** Complete internal projection through the same SQL owner as paged routes. */
export function readRetainedSessionItems(
  service: RetainedSessionCollections,
  deps: RetainedItemsDeps,
  selectParents?: (
    sessions: readonly GlobalSessionItem[],
  ) => readonly GlobalSessionItem[],
) {
  return retainedSessionQuery(service, deps).all(selectParents);
}
