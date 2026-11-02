import { creationProvenanceForHeaders } from "../sessions/creation-provenance.js";
import {
  type CreateProjectQueueItemRequest,
  type ProjectQueueItemSummary,
  type ProjectQueuePromoteNowRequest,
  type ProjectQueuePromoteNowResponse,
  type UpdateProjectQueueItemRequest,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import {
  limitQueuedLaunch,
  principalFor,
} from "../auth/limitedLaunchPolicy.js";
import { levelFor } from "../auth/limitedUserPolicy.js";
import {
  type LimitedPrincipal,
  PRINCIPAL_VARIABLE,
  type Principal,
} from "../auth/principal.js";
import type {
  GlobalProjectQueueRoutesDeps,
  ProjectQueueRoutesDeps,
} from "./project-queue-response.js";
import {
  globalQueueResponse,
  projectQueueResponse,
} from "./project-queue-response.js";
import {
  ProjectQueueLaunchRefusedError,
  type ProjectQueueLaunchPolicy,
  ProjectQueueValidationError,
} from "../services/ProjectQueueService.js";
import type { Project } from "../supervisor/types.js";

function validationError(message: string) {
  return { error: "Invalid project queue request", reason: message };
}

/** The acting limited user, or null for the superuser. */
function limitedActorFor(c: Context): LimitedPrincipal | null {
  const principal = principalFor(c);
  return principal.kind === "limited" ? principal : null;
}

/** A limited user's launch policy, applied as they queue or edit an item. */
function queuedLaunchPolicyFor(
  actor: LimitedPrincipal,
): ProjectQueueLaunchPolicy {
  return (draft) => limitQueuedLaunch(actor.grants, draft)?.error ?? null;
}

/**
 * The projects a request's principal may see in the global queue: every
 * project for the superuser, only granted ones for a limited user
 * (topics/limited-users.md § Delivery v1).
 */
function projectVisibilityFor(
  c: Context,
): ((projectId: string) => boolean) | undefined {
  const principal = c.get(PRINCIPAL_VARIABLE) as Principal | undefined;
  if (!principal || principal.kind === "superuser") return undefined;
  return (projectId) => levelFor(principal.grants, projectId) !== "none";
}

export function createGlobalProjectQueueRoutes(
  deps: GlobalProjectQueueRoutesDeps,
): Hono {
  const routes = new Hono();

  routes.get("/", async (c) => {
    return c.json(
      await globalQueueResponse(deps, {
        isProjectVisible: projectVisibilityFor(c),
      }),
    );
  });

  routes.post("/pause", async (c) => {
    try {
      const dispatchState = await deps.projectQueueService.pauseDispatch();
      return c.json(
        await globalQueueResponse(deps, {
          dispatchState,
          isProjectVisible: projectVisibilityFor(c),
        }),
      );
    } catch (error) {
      if (error instanceof ProjectQueueValidationError) {
        return c.json(validationError(error.message), 400);
      }
      throw error;
    }
  });

  routes.post("/resume", async (c) => {
    const dispatchState = await deps.projectQueueService.resumeDispatch();
    return c.json(
      await globalQueueResponse(deps, {
        dispatchState,
        isProjectVisible: projectVisibilityFor(c),
      }),
    );
  });

  routes.post("/:projectId/promote-now", async (c) => {
    const projectId = c.req.param("projectId");
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    if (!deps.projectQueueScheduler) {
      return c.json({ error: "Project Queue scheduler unavailable" }, 503);
    }

    let body: ProjectQueuePromoteNowRequest = {};
    if (c.req.header("content-type")?.includes("application/json")) {
      try {
        body = await c.req.json<ProjectQueuePromoteNowRequest>();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
    }
    const options = {
      ...(typeof body.itemId === "string" && body.itemId.trim()
        ? { itemId: body.itemId }
        : {}),
      ...(body.force === true ? { force: true } : {}),
      ...(body.deliveryIntent === "steer"
        ? { deliveryIntent: "steer" as const }
        : {}),
    };
    const promoteResult = await deps.projectQueueScheduler.promoteNow(
      projectId,
      options,
    );
    const response: ProjectQueuePromoteNowResponse = {
      ...(await globalQueueResponse(deps, {
        isProjectVisible: projectVisibilityFor(c),
      })),
      promoteResult,
    };
    return c.json(response);
  });

  return routes;
}

export function createProjectQueueRoutes(deps: ProjectQueueRoutesDeps): Hono {
  const routes = new Hono();

  async function resolveProject(projectId: string): Promise<
    | { project: Project }
    | {
        error: "Invalid project ID format" | "Project not found";
        status: 400 | 404;
      }
  > {
    if (!isUrlProjectId(projectId)) {
      return { error: "Invalid project ID format" as const, status: 400 };
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return { error: "Project not found" as const, status: 404 };
    }

    return { project };
  }

  // A limited user changes only the items they queued: someone else's item
  // runs with that person's launch settings and attribution, so editing,
  // retrying, reordering, or deleting it is not theirs to do
  // (topics/limited-users.md § Delivery v1).
  const refuseForeignItem: MiddlewareHandler = async (c, next) => {
    const actor = limitedActorFor(c);
    if (actor) {
      const projectId = c.req.param("projectId") ?? "";
      const itemId = c.req.param("itemId");
      const owned =
        isUrlProjectId(projectId) &&
        deps.projectQueueService
          .listProject(projectId)
          .items.some(
            (item) =>
              item.id === itemId && item.createdByUser === actor.username,
          );
      if (!owned) {
        return c.json({ error: "Project queue item not found" }, 404);
      }
    }
    await next();
  };
  routes.use("/:projectId/queue/:itemId", refuseForeignItem);
  routes.use("/:projectId/queue/:itemId/*", refuseForeignItem);

  routes.get("/:projectId/queue", async (c) => {
    const resolved = await resolveProject(c.req.param("projectId"));
    if ("error" in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }

    return c.json(await projectQueueResponse(resolved.project, deps));
  });

  routes.post("/:projectId/queue", async (c) => {
    const resolved = await resolveProject(c.req.param("projectId"));
    if ("error" in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }

    let body: CreateProjectQueueItemRequest;
    try {
      body = await c.req.json<CreateProjectQueueItemRequest>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const actor = limitedActorFor(c);
    try {
      const item = await deps.projectQueueService.createItem({
        projectId: resolved.project.id,
        projectPath: resolved.project.path,
        request: body,
        creationProvenance: creationProvenanceForHeaders(c.req.raw.headers),
        ...(actor
          ? {
              createdByUser: actor.username,
              launchPolicy: queuedLaunchPolicyFor(actor),
            }
          : {}),
      });
      // Queuing is the user's action, so it counts now, like a turn deferred
      // on the session route; a YA command is no turn there either.
      if (!item.message.yaCommand) {
        if (item.target.type === "new-session") {
          void deps.userUsageService?.recordSession(actor?.username);
        }
        void deps.userUsageService?.recordTurn(
          actor?.username,
          item.message.text,
        );
      }
      const queue = await projectQueueResponse(resolved.project, deps);
      return c.json(
        {
          item:
            queue.items.find((candidate) => candidate.id === item.id) ?? item,
          queue,
        },
        201,
      );
    } catch (error) {
      if (error instanceof ProjectQueueLaunchRefusedError) {
        return c.json({ error: error.message }, 403);
      }
      if (error instanceof ProjectQueueValidationError) {
        return c.json(validationError(error.message), 400);
      }
      throw error;
    }
  });

  routes.patch("/:projectId/queue/:itemId", async (c) => {
    const resolved = await resolveProject(c.req.param("projectId"));
    if ("error" in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }

    let body: UpdateProjectQueueItemRequest;
    try {
      body = await c.req.json<UpdateProjectQueueItemRequest>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (body.target === undefined && body.message === undefined) {
      return c.json(validationError("target or message is required"), 400);
    }

    const actor = limitedActorFor(c);
    try {
      const item = await deps.projectQueueService.updateItem(
        resolved.project.id,
        c.req.param("itemId"),
        body,
        actor
          ? {
              launchPolicy: queuedLaunchPolicyFor(actor),
              editor: actor.username,
            }
          : {},
      );
      if (!item) {
        return c.json({ error: "Project queue item not found" }, 404);
      }
      const queue = await projectQueueResponse(resolved.project, deps);
      return c.json({
        item: queue.items.find((candidate) => candidate.id === item.id) ?? item,
        queue,
      });
    } catch (error) {
      if (error instanceof ProjectQueueLaunchRefusedError) {
        return c.json({ error: error.message }, 403);
      }
      if (error instanceof ProjectQueueValidationError) {
        return c.json(validationError(error.message), 400);
      }
      throw error;
    }
  });

  routes.delete("/:projectId/queue/:itemId", async (c) => {
    const resolved = await resolveProject(c.req.param("projectId"));
    if ("error" in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }

    let deleted: boolean;
    try {
      deleted = await deps.projectQueueService.deleteItem(
        resolved.project.id,
        c.req.param("itemId"),
      );
      if (!deleted) {
        return c.json({ error: "Project queue item not found" }, 404);
      }
    } catch (error) {
      if (error instanceof ProjectQueueValidationError) {
        return c.json(validationError(error.message), 400);
      }
      throw error;
    }
    return c.json({
      deleted: true,
      queue: await projectQueueResponse(resolved.project, deps),
    });
  });

  routes.post("/:projectId/queue/:itemId/retry", async (c) => {
    const resolved = await resolveProject(c.req.param("projectId"));
    if ("error" in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }

    let item: ProjectQueueItemSummary | null;
    try {
      item = await deps.projectQueueService.retryItem(
        resolved.project.id,
        c.req.param("itemId"),
      );
      if (!item) {
        return c.json({ error: "Project queue item not found" }, 404);
      }
      const queue = await projectQueueResponse(resolved.project, deps);
      const enrichedItem =
        queue.items.find((candidate) => candidate.id === item?.id) ?? item;
      return c.json({
        item: enrichedItem,
        queue,
      });
    } catch (error) {
      if (error instanceof ProjectQueueValidationError) {
        return c.json(validationError(error.message), 400);
      }
      throw error;
    }
  });

  routes.post("/:projectId/queue/:itemId/move-to-top", async (c) => {
    const resolved = await resolveProject(c.req.param("projectId"));
    if ("error" in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }

    let item: ProjectQueueItemSummary | null;
    try {
      item = await deps.projectQueueService.moveItemToTop(
        resolved.project.id,
        c.req.param("itemId"),
      );
      if (!item) {
        return c.json({ error: "Project queue item not found" }, 404);
      }
      const queue = await projectQueueResponse(resolved.project, deps);
      const enrichedItem =
        queue.items.find((candidate) => candidate.id === item?.id) ?? item;
      return c.json({
        item: enrichedItem,
        queue,
      });
    } catch (error) {
      if (error instanceof ProjectQueueValidationError) {
        return c.json(validationError(error.message), 400);
      }
      throw error;
    }
  });

  return routes;
}
