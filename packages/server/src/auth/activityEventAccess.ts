/**
 * Which global activity-stream events a limited user may receive.
 *
 * Contract: topics/limited-users.md § Delivery v1 — Authorization.
 *
 * Default-deny by event type: an event reaches a limited user only when it
 * names a project they may read, directly or through the session it is
 * about. Every bus event type is classified here, so a type added later
 * fails to compile until it is. List filtering is by project only, as for
 * the HTTP lists these events refresh.
 */

import type { BusEvent } from "../watcher/EventBus.js";

export interface LimitedActivityAccess {
  isProjectAccessible: (projectId: string) => boolean;
  /** Project of a session already known in memory; never reads a catalog. */
  knownSessionProject: (sessionId: string) => string | undefined;
}

/**
 * The event as a limited user may receive it, or null when it is hidden.
 * Events listing several projects are narrowed to the accessible ones.
 */
export function limitedActivityEvent(
  event: BusEvent,
  access: LimitedActivityAccess,
): BusEvent | null {
  const inProject = (projectId: string | undefined) =>
    projectId !== undefined && access.isProjectAccessible(projectId)
      ? event
      : null;
  const inSession = (sessionId: string | undefined) =>
    sessionId === undefined
      ? null
      : inProject(access.knownSessionProject(sessionId));

  switch (event.type) {
    // Carry no project data; clients refetch their filtered lists on them.
    case "backend-reloaded":
    case "session-queue-persistence-changed":
    case "recents-changed":
      return event;
    case "session-catalog-updated": {
      // The refresh error is an operator diagnostic, not list state.
      const { refreshError: _refreshError, ...catalog } = event.catalog;
      return { ...event, catalog };
    }

    // Host inventory with no project to filter by: watched file paths,
    // YA's own source files, network binding, browser tabs, worker counts.
    case "file-change":
    case "source-change":
    case "network-binding-changed":
    case "browser-tab-connected":
    case "browser-tab-disconnected":
    case "worker-activity-changed":
    case "safe-restart-changed":
      return null;

    case "project-code-names-changed":
    case "project-captions-changed":
    case "projects-changed": {
      const projectIds = event.projectIds.filter(access.isProjectAccessible);
      const collectionRefresh =
        event.type === "projects-changed" && event.collectionRefresh;
      return projectIds.length > 0 || collectionRefresh
        ? { ...event, projectIds }
        : null;
    }

    case "session-created":
      return inProject(event.session.projectId);
    case "cache-miss-billing":
    case "cache-miss-billing-expected-expiry":
      return inProject(event.record.projectId);
    case "session-metadata-changed":
      return event.projectId !== undefined
        ? inProject(event.projectId)
        : inSession(event.sessionId);
    case "session-seen":
    case "queue-position-changed":
    case "queue-request-removed":
      return inSession(event.sessionId);

    case "session-status-changed":
    case "process-state-changed":
    case "process-terminated":
    case "review-response-changed":
    case "provider-runtime-status-changed":
    case "queue-request-added":
    case "project-queue-changed":
    case "session-aborted":
    case "session-stop-requested":
    case "session-forked":
    case "session-updated":
      return inProject(event.projectId);

    default:
      // Compile-time: every bus event type is classified above. Run time: an
      // event outside the declared union stays hidden.
      event satisfies never;
      return null;
  }
}
