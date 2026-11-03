import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  mayCreateTemplate,
  templateGrantFor,
  truncateSessionTitle,
  type LimitedUserGrants,
} from "@yep-anywhere/shared";
import {
  principalFor,
  limitNewSessionLaunch,
} from "../auth/limitedLaunchPolicy.js";
import { isWithinRoot, isContainedOnDisk } from "./project-creation.js";
import type { TemplateSourceService } from "../projects/TemplateSourceService.js";
import {
  type TemplateCreationService,
  templateCreationRequest,
} from "../projects/TemplateCreationService.js";

/** Creation routes share the existing project-registration and session-launch policies. */
export function createProjectTemplateRoutes(
  sources: TemplateSourceService,
  creations: TemplateCreationService,
  dispatch: (
    context: Context,
    path: string,
    body: unknown,
    method?: "POST" | "PUT",
  ) => Promise<Response>,
  activeGrants?: (username: string) => LimitedUserGrants | null,
) {
  const routes = new Hono();
  routes.use("/project-templates/*", async (c, next) => {
    const principal = principalFor(c);
    if (principal.kind === "limited") {
      const grants = activeGrants?.(principal.username);
      if (!grants?.projectRoot || templateGrantFor(grants).mode === "none")
        return c.json(
          { error: "This user may not create projects from templates" },
          403,
        );
    }
    await next();
  });
  routes.get("/project-templates/choices", async (c) => {
    const state = await sources.current();
    if (!state.config.enabled) return c.json({ enabled: false, templates: [] });
    try {
      const library = await sources.creationLibrary();
      const principal = principalFor(c);
      const grants =
        principal.kind === "limited"
          ? activeGrants?.(principal.username)
          : null;
      if (principal.kind === "limited" && !grants)
        return c.json({ error: "User not found or disabled" }, 403);
      const templates = library
        .list()
        .filter(
          (item) =>
            item.status === "ready" &&
            (principal.kind === "superuser" ||
              mayCreateTemplate(grants!, library.sourceOf(item.id), item.id)),
        )
        .map((item) => {
          const composition = library.readyComposition(item.id);
          const artwork = (name: string) => {
            const bytes = composition.files.get(
              `.project-template/${name}.svg`,
            )?.content;
            return bytes && bytes.length <= 256 * 1024
              ? `data:image/svg+xml;base64,${bytes.toString("base64")}`
              : undefined;
          };
          return {
            id: item.id,
            sourceId: library.sourceOf(item.id),
            title: item.title,
            description: item.description,
            icon: artwork("icon"),
            preview: artwork("preview"),
          };
        });
      return c.json({ enabled: true, templates });
    } catch (error) {
      return c.json(
        {
          error:
            principalFor(c).kind === "limited"
              ? "Templates are unavailable. Ask the administrator to check the configured template sources."
              : error instanceof Error
                ? error.message
                : String(error),
        },
        409,
      );
    }
  });
  routes.get("/project-templates/operations/:id", async (c) => {
    const id = z.string().uuid().safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid operation ID" }, 400);
    const operation = await creations.get(id.data);
    const principal = principalFor(c);
    return operation &&
      (principal.kind === "superuser" ||
        operation.ownerUsername === principal.username)
      ? c.json(operation)
      : c.json({ error: "Operation not found" }, 404);
  });
  routes.post("/project-templates/operations", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const parsed = templateCreationRequest.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const principal = principalFor(c);
    const authorize = async (path: string) => {
      if (principal.kind === "superuser") return;
      const grants = activeGrants?.(principal.username);
      if (
        !grants ||
        !mayCreateTemplate(grants, parsed.data.sourceId, parsed.data.templateId)
      )
        throw new Error("This user may not create from the selected template");
      const root = grants.projectRoot!;
      if (!isWithinRoot(root, path) || !(await isContainedOnDisk(root, path)))
        throw new Error(
          `Project must be inside the configured creation directory: ${root}`,
        );
      const launchError = limitNewSessionLaunch(grants, parsed.data.session);
      if (launchError) throw new Error(launchError.error);
    };
    if (parsed.data.session.executor || parsed.data.session.attachments)
      return c.json(
        {
          error:
            "Template creation requires a local session without attachments",
        },
        400,
      );
    const call = async (
      path: string,
      payload: unknown,
      method: "POST" | "PUT" = "POST",
    ): Promise<Record<string, unknown>> => {
      const response = await dispatch(c, path, payload, method);
      const result = (await response.json()) as Record<string, unknown>;
      if (!response.ok)
        throw new Error(
          typeof result.error === "string"
            ? result.error
            : `Project creation request failed (${response.status})`,
        );
      return result;
    };
    try {
      await authorize(parsed.data.path);
      const staged = parsed.data.stagedAttachments;
      if (staged?.refs.length)
        await call(
          `/api/attachments/staging/drafts/${encodeURIComponent(staged.batchId)}/validate`,
          { refs: staged.refs },
        );
      const existing = await creations.get(parsed.data.operationId);
      if (
        existing &&
        principal.kind === "limited" &&
        existing.ownerUsername !== principal.username
      )
        return c.json({ error: "Operation not found" }, 404);
      const operation = await creations.start(parsed.data, {
        ownerUsername:
          principal.kind === "limited" ? principal.username : undefined,
        authorize,
        register: async (path, name) => {
          const result = await call("/api/projects", { path, name });
          const project = z.object({ id: z.string() }).parse(result.project);
          return project.id;
        },
        prepare: async (projectId, message, settings) => {
          const result = await call(
            `/api/projects/${encodeURIComponent(projectId)}/session-creations`,
            {
              ...settings,
              message,
              requestId: `template-${parsed.data.operationId}`,
              ...(staged?.refs.length
                ? { stagedAttachments: staged.refs }
                : {}),
            },
          );
          if (typeof result.sessionId !== "string")
            throw new Error("Preparation was not durably accepted");
          await call(
            `/api/sessions/${encodeURIComponent(result.sessionId)}/metadata`,
            { title: truncateSessionTitle(parsed.data.intent) },
            "PUT",
          );
          return result.sessionId;
        },
      });
      return c.json(operation, 202);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        409,
      );
    }
  });
  return routes;
}
