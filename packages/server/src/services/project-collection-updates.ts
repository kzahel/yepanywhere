import type { BusEvent } from "../watcher/EventBus.js";

/** Canonical project publications and their live overlays, not every file event. */
export function projectCollectionEvent(
  query: string,
  event: BusEvent,
): boolean | undefined {
  const path = new URL(query, "http://collection.invalid").pathname;
  if (path === "/projects")
    return [
      "process-state-changed",
      "session-status-changed",
      "session-created",
      "project-code-names-changed",
      "project-captions-changed",
      "projects-changed",
      "project-queue-changed",
    ].includes(event.type);
  if (path === "/project-queue")
    return [
      "project-queue-changed",
      "session-catalog-updated",
      "session-metadata-changed",
      "session-queue-persistence-changed",
      "process-state-changed",
      "session-status-changed",
      "session-updated",
      "session-created",
      "process-terminated",
      "worker-activity-changed",
      "queue-request-added",
      "queue-position-changed",
      "queue-request-removed",
    ].includes(event.type);
  return undefined;
}

/** Live queue interest shares one server wake instead of one browser backstop. */
export function projectQueueTransition(
  query: string,
  body: Record<string, unknown>,
  now: number,
): number | undefined {
  if (new URL(query, "http://collection.invalid").pathname !== "/project-queue")
    return undefined;
  let next = Infinity;
  for (const status of Object.values(
    (body.projectStatuses ?? {}) as Record<string, Record<string, unknown>>,
  )) {
    for (const value of [status.nextAttemptAt, status.quietEligibleAt]) {
      if (typeof value !== "string") continue;
      const at = Date.parse(value);
      if (at > now) next = Math.min(next, at);
    }
    if (status.state === "ready" || status.state === "dispatching")
      next = Math.min(next, now + 5000);
  }
  return Number.isFinite(next) ? next : undefined;
}
