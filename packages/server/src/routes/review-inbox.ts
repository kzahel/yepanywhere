/** Global unread source-review outcomes for the Inbox surface. */

import { Hono } from "hono";
import { SourceVersionedSingleFlight } from "../lib/sourceVersionedSingleFlight.js";
import type { ReviewInboxItem } from "@yep-anywhere/shared";
import type { ProjectScanner } from "../projects/scanner.js";
import type { ReviewProject } from "../review/ReviewInboxSources.js";

/** Backstop for project-set changes, which publish no review event yet. */
const DEFAULT_PROJECT_SET_TTL_MS = 5_000;
const MAX_REVIEW_INBOX_RETARGETS = 4;

interface ReviewInboxProjection {
  items: ReviewInboxItem[];
}

export interface ReviewInboxDeps {
  scanner: Pick<ProjectScanner, "readRetainedProjects" | "listProjects">;
  inbox: {
    readonly revision: number;
    read(projects: readonly ReviewProject[]): Promise<ReviewInboxItem[]>;
  };
  isEnabled: () => boolean;
  projectSetTtlMs?: number;
  now?: () => number;
}

export function createReviewInboxRoutes(deps: ReviewInboxDeps): Hono {
  const routes = new Hono();
  const now = deps.now ?? Date.now;
  const ttlMs = Math.max(0, deps.projectSetTtlMs ?? DEFAULT_PROJECT_SET_TTL_MS);
  // One owner per server: concurrent mounts, manual refreshes, and repeated
  // review-response events share a single build instead of each starting an
  // all-project store load.
  const projections = new SourceVersionedSingleFlight<
    string,
    ReviewInboxProjection
  >({
    maxRetainedBytes: 4 * 1024 * 1024,
    estimateBytes: (value) => 256 + JSON.stringify(value.items).length,
  });
  let uncachedGeneration = 0;

  const currentSourceVersion = (): string => {
    const projectSetVersion =
      ttlMs > 0 ? String(Math.floor(now() / ttlMs)) : "uncached";
    return `${deps.inbox.revision}:${projectSetVersion}`;
  };

  const buildProjection = async (): Promise<ReviewInboxProjection> => {
    // A saved snapshot can be served during restart refresh. Newly
    // discovered projects join the next project-set bucket.
    const view = await deps.scanner.readRetainedProjects();
    const projects =
      view.complete && !view.refreshError
        ? view.projects
        : await deps.scanner.listProjects();
    return { items: await deps.inbox.read(projects) };
  };

  routes.get("/review/inbox", async (c) => {
    if (!deps.isEnabled()) {
      return c.json(
        { error: "Source-review submissions are not enabled" },
        409,
      );
    }
    // Every accepted mutation bumps the revision. The coarse time bucket is the
    // backstop for newly visible projects. The source separately rechecks
    // previously empty paths for out-of-band file imports. With a zero TTL,
    // each request gets a distinct version and still checks its revision.
    let projection: ReviewInboxProjection | undefined;
    for (let attempt = 0; attempt < MAX_REVIEW_INBOX_RETARGETS; attempt += 1) {
      const observedVersion = currentSourceVersion();
      const sourceVersion =
        ttlMs > 0
          ? observedVersion
          : `${observedVersion}:request-${++uncachedGeneration}`;
      const result = await projections.run({
        key: "review-inbox",
        sourceVersion,
        compute: buildProjection,
        isCurrent: () => observedVersion === currentSourceVersion(),
      });
      if (result.status !== "stale") {
        projection = result.value;
        break;
      }
      if (
        result.previous &&
        result.previous.sourceVersion === currentSourceVersion()
      ) {
        projection = result.previous.value;
        break;
      }
      // The source moved during the build. Re-admit against the newest version;
      // this hits or joins that generation when another caller already owns it.
    }
    if (!projection) {
      throw new Error("Review Inbox source version kept changing");
    }
    const items = projection.items;

    // Filtering serializes a subset of the retained projection; it never
    // builds a separate per-project projection from canonical stores.
    const projectId = c.req.query("projectId");
    return c.json({
      items: projectId
        ? items.filter((item) => item.projectId === projectId)
        : items,
    });
  });

  return routes;
}
