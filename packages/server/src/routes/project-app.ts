import { basename, join } from "node:path";
import { realpath, unlink } from "node:fs/promises";
import {
  isUrlProjectId,
  type LimitedUserGrants,
  type ProjectAppInfo,
  type ProjectAppView,
  type ProjectAppAddresses,
  type ProjectAppInventory,
} from "@yep-anywhere/shared";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { ArtifactServer } from "../artifacts/ArtifactServer.js";
import type { ProjectAppDelivery } from "../artifacts/ProjectAppDelivery.js";
import { configuredVhostNames, parseVhosts } from "../artifacts/vhosts.js";
import { principalFor } from "../auth/limitedLaunchPolicy.js";
import { levelFor, satisfies } from "../auth/limitedUserPolicy.js";
import type { SessionAccessResolver } from "../auth/sessionAccess.js";
import type { ProjectAppAutoStart } from "../projects/ProjectAppAutoStart.js";
import type { ProjectAppStore } from "../projects/ProjectAppStore.js";
import { projectAppPublicAllowed } from "../projects/projectAppPolicy.js";
import {
  readProjectService,
  readAppDeclaration,
  projectServiceStaticStamp,
  projectServiceStaticApp,
  writeProjectStartCommand,
  type ProjectServices,
} from "../projects/ProjectServiceManager.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { Principal } from "../auth/principal.js";
import type { Project } from "../supervisor/types.js";
import {
  createLocalResourcePathPolicy,
  isPathInsideDirectory,
} from "./local-resource-policy.js";
import type { SessionPathScopeResolver } from "./session-path-scope.js";

const openRequest = z.strictObject({
  target: z.enum(["app", "artifact"]),
  artifactId: z.string().uuid().optional(),
  audience: z.enum(["local", "public"]),
});

/** Project authorization is refreshed at entry and again when queued work executes. */
export function createProjectAppRoutes(deps: {
  scanner: Pick<ProjectScanner, "getProject" | "listProjects">;
  store: ProjectAppStore;
  services: ProjectServices;
  artifacts: ArtifactServer;
  sessionAccess: SessionAccessResolver;
  sessionPathScope: SessionPathScopeResolver;
  activeGrants: (username: string) => LimitedUserGrants | null;
  onVisibilityChanged?: (projectId: string) => void;
  delivery?: ProjectAppDelivery;
  autoStart?: ProjectAppAutoStart;
  openService: (
    projectId: string,
    audience: "local" | "public",
  ) => Promise<ProjectAppView>;
}) {
  const routes = new Hono();
  /**
   * `view` admits anyone who can see the project, which is also enough to
   * start its declared app; `new-session` is required to stop it or change
   * how it is served (topics/project-service.md § Project App and Settings).
   */
  const authorize = async (
    c: Context,
    required: "view" | "new-session" = "view",
  ) => {
    const projectId = c.req.param("projectId");
    if (!projectId || !isUrlProjectId(projectId))
      throw new HTTPException(404, { message: "Project not found" });
    const principal = principalFor(c);
    if (principal.kind === "limited") {
      const grants = deps.activeGrants(principal.username);
      const level = grants ? levelFor(grants, projectId) : "none";
      if (level === "none")
        throw new HTTPException(404, { message: "Project not found" });
      if (!satisfies(level, required))
        throw new HTTPException(403, {
          message: "Project execution is not permitted",
        });
    }
    const project = await deps.scanner.getProject(projectId);
    if (!project)
      throw new HTTPException(404, { message: "Project not found" });
    return project;
  };

  const appInfo = async (project: Project, principal: Principal) => {
    const latest = await deps.store.latestArtifact(project.id);
    const history =
      principal.kind === "superuser"
        ? await deps.store.visibilityHistory(project.id)
        : [];
    const visibility = new Map<string, { username: string; at: string }>();
    for (const event of history) {
      if (event.hidden)
        visibility.set(event.username, {
          username: event.username,
          at: event.at,
        });
      else visibility.delete(event.username);
    }
    const info: ProjectAppInfo = {
      projectId: project.id,
      declaration: null,
      state: "none",
      latestArtifact: latest
        ? {
            id: latest.id,
            label: basename(latest.path),
            sessionId: latest.sessionId,
            associatedAt: latest.associatedAt,
          }
        : null,
      canExecute:
        principal.kind === "superuser" ||
        satisfies(levelFor(principal.grants, project.id), "new-session"),
      // Reaching this read already required a view grant.
      canStart: true,
      canPublish: principal.kind === "superuser",
      canShare: !!deps.artifacts.config.publicOrigin,
      removedFrom: [...visibility.values()],
    };
    let fileLinks: { enabled: boolean; pathTemplate: string } | undefined;
    try {
      fileLinks = (await readAppDeclaration(project.path))?.fileLinks;
      info.declaration = await readProjectService(project.path);
      info.livePreview =
        (await readProjectService(project.path, "live-preview")) ?? undefined;
      if (info.declaration?.where.kind === "static") {
        info.updatedAt = (
          await projectServiceStaticStamp(project.path, info.declaration)
        ).toISOString();
        info.state = "ready";
      } else if (info.declaration) {
        const runtime = await deps.services.status(project.id);
        info.state = runtime?.observed ?? "stopped";
        info.generation = runtime?.generation;
        info.updatedAt = runtime?.updatedAt;
        info.error = runtime?.error;
      }
    } catch (error) {
      info.state =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing"
          : "unavailable";
      info.error = error instanceof Error ? error.message : String(error);
    }
    const runtime = await deps.services.status(project.id);
    if (runtime && (await deps.services.ownsLaunch(project.id))) {
      info.mode = runtime.mode;
      info.activeDeclaration = runtime.declaration;
      info.restartRequired =
        JSON.stringify(
          runtime.mode === "live-preview" ? info.livePreview : info.declaration,
        ) !== JSON.stringify(runtime.declaration);
      info.state = runtime.observed;
      info.generation = runtime.generation;
      info.updatedAt = runtime.updatedAt;
      info.error = runtime.error ?? info.error;
    }
    if (
      deps.artifacts.config.vhostPublicRoot &&
      (info.activeDeclaration ?? info.declaration)?.where.kind === "process"
    )
      info.canShare = true;
    info.canCopyLink =
      principal.kind === "superuser" ||
      principal.grants.allowPrivateAppLinks !== false;
    if (!info.canCopyLink) info.canShare = false;
    if (fileLinks?.enabled && info.declaration && info.canCopyLink) {
      const url = await publicAddress(project.id);
      if (url)
        info.fileLinks = { pathTemplate: fileLinks.pathTemplate, baseUrl: url };
    }
    return info;
  };

  const publicAddress = async (
    projectId: string,
  ): Promise<string | undefined> => {
    if (!deps.delivery || !deps.artifacts.config.vhostPublicRoot)
      return undefined;
    const reservation = (await deps.store.reservations(projectId)).find(
      (row) =>
        row.serving && row.namespace === deps.artifacts.config.vhostPublicRoot,
    );
    return reservation
      ? deps.delivery.addressLink(
          await deps.delivery.effectiveReservation(reservation),
        )
      : undefined;
  };

  routes.get("/projects/:projectId/app", async (c) => {
    return c.json(await appInfo(await authorize(c), principalFor(c)));
  });

  const administrator = (c: Context) => {
    if (principalFor(c).kind !== "superuser")
      throw new HTTPException(403, {
        message: "Administrator access required",
      });
  };
  routes.delete("/projects/:projectId/app", async (c) => {
    administrator(c);
    const project = await authorize(c, "new-session");
    let declaration: string | undefined;
    try {
      const root = await realpath(project.path);
      const parent = await realpath(join(root, ".project-template"));
      if (!isPathInsideDirectory(parent, root))
        throw new HTTPException(403, {
          message: "App declaration escapes project",
        });
      declaration = join(parent, "app.json");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Remove the declaration before the queued stop: later starts cannot
    // reload it, and any start already in flight is drained by that stop.
    if (declaration) {
      try {
        await unlink(declaration);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await deps.services.stop(project.id, async () => {
      administrator(c);
    });
    await deps.store.releaseAll(project.id, async (rows) => {
      administrator(c);
      for (const row of rows)
        await deps.artifacts.vhostAccess.rotate({
          name: row.name,
          projectId: project.id,
        });
    });
    await deps.delivery?.refreshHosts();
    return c.json({ deleted: true });
  });
  routes.get("/project-apps", async (c) => {
    administrator(c);
    const reservations = await deps.store.allReservations();
    const reservedProjects = new Set(reservations.map((row) => row.projectId));
    const inventory: ProjectAppInventory = { projects: [], reservations };
    // Bound filesystem work; opening Settings must not start a service or watcher.
    const projects = await deps.scanner.listProjects();
    for (let offset = 0; offset < projects.length; offset += 8) {
      const batch = await Promise.all(
        projects.slice(offset, offset + 8).map(async (project) => {
          const info = await appInfo(project, principalFor(c));
          return {
            projectId: project.id,
            name: project.name,
            path: project.path,
            owner: project.ownerUsername,
            info,
          };
        }),
      );
      inventory.projects.push(
        ...batch.filter(
          (row) =>
            (row.info.state !== "none" &&
              (row.info.state !== "missing" ||
                !!row.info.declaration ||
                !!row.info.activeDeclaration)) ||
            reservedProjects.has(row.projectId),
        ),
      );
    }
    inventory.projects.sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId),
    );
    return c.json(inventory);
  });
  routes.post("/project-apps/address/release", async (c) => {
    administrator(c);
    const parsed = z
      .strictObject({
        projectId: z.string().min(1),
        namespace: z.string().min(1),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "Expected projectId and namespace" }, 400);
    await releaseAddress(
      parsed.data.projectId,
      parsed.data.namespace,
      async () => administrator(c),
    );
    return c.json({ released: true });
  });

  routes.post("/projects/:projectId/app/start", async (c) => {
    const text = await c.req.text();
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return c.json({ error: "Expected JSON start options" }, 400);
      }
    }
    const parsed = z
      .strictObject({ mode: z.enum(["app", "live-preview"]).default("app") })
      .safeParse(body);
    if (!parsed.success)
      return c.json({ error: "Expected app or live-preview mode" }, 400);
    const required =
      parsed.data.mode === "live-preview" ? "new-session" : "view";
    const project = await authorize(c, required);
    await deps.services.start(
      project.id,
      project.path,
      async () => {
        await authorize(c, required);
      },
      parsed.data.mode,
    );
    deps.autoStart?.reset(project.id);
    return c.json({ started: true });
  });
  // Editing what the app runs needs the same execution authority as stopping
  // it; a session with that grant could edit the file itself.
  routes.put("/projects/:projectId/app/start-command", async (c) => {
    const parsed = z
      .strictObject({
        expected: z.array(z.string()).min(1).max(64),
        argv: z.array(z.string()).min(1).max(64),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "Expected expected and argv string arrays" }, 400);
    const project = await authorize(c, "new-session");
    const result = await writeProjectStartCommand(
      project.path,
      parsed.data.expected,
      parsed.data.argv,
    );
    if (result.kind === "invalid")
      return c.json({ error: result.message }, 400);
    if (result.kind === "conflict")
      return c.json(
        {
          error:
            result.argv === null
              ? "The project no longer declares a process app"
              : "The start command changed since it was loaded",
          argv: result.argv,
        },
        409,
      );
    return c.json(await appInfo(project, principalFor(c)));
  });
  routes.post("/projects/:projectId/app/stop", async (c) => {
    const project = await authorize(c, "new-session");
    await deps.services.stop(project.id, async () => {
      await authorize(c, "new-session");
    });
    return c.json({ stopped: true });
  });

  routes.post("/projects/:projectId/app/open", async (c) => {
    const project = await authorize(c);
    const parsed = openRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: "Expected app/artifact target and local/public audience" },
        400,
      );
    const request = parsed.data;
    let publicViewUrl: string | undefined;
    if (
      request.target === "app" &&
      (await readAppDeclaration(project.path))?.viewAudience === "public"
    ) {
      publicViewUrl = await publicAddress(project.id);
      if (!publicViewUrl)
        throw new HTTPException(409, {
          message: "This app requires a serving public address",
        });
      request.audience = "public";
    }
    let path: string;
    let declaredRoot: string | undefined;
    let id: string;
    let kind: ProjectAppView["kind"];
    if (request.target === "artifact") {
      const association = request.artifactId
        ? await deps.store.artifact(project.id, request.artifactId)
        : await deps.store.latestArtifact(project.id);
      if (!association)
        throw new HTTPException(404, {
          message: "Artifact association is unavailable",
        });
      const scope = association.sessionId
        ? deps.sessionPathScope(c, association.path, association.sessionId)
        : { allowedPaths: () => [project.path], includeProjects: () => false };
      if ("status" in scope)
        throw new HTTPException(404, {
          message: "Artifact source session is unavailable",
        });
      if (
        association.sessionId &&
        (await deps.sessionAccess.resolve(association.sessionId))?.projectId !==
          project.id
      )
        throw new HTTPException(404, {
          message: "Artifact source session is unavailable",
        });
      // The retained path is already host-canonical; do not remap private /tmp a second time.
      const allowed = await createLocalResourcePathPolicy({
        ...scope,
        scanner: deps.scanner,
      }).resolveAllowedFilePath(association.path);
      if (!allowed.ok)
        throw new HTTPException(allowed.status, { message: allowed.error });
      path = allowed.file.resolvedPath;
      id = association.id;
      kind = "artifact";
    } else {
      if (await deps.services.upstream(project.id))
        return c.json(await deps.openService(project.id, request.audience));
      const declaration = await readProjectService(project.path);
      if (!declaration)
        throw new HTTPException(404, {
          message: "Project has no app declaration",
        });
      if (declaration.where.kind === "process") {
        try {
          await deps.autoStart?.startForOpen(project.id, project.path, () =>
            authorize(c).then(() => undefined),
          );
        } catch (error) {
          if (error instanceof HTTPException) throw error;
          throw new HTTPException(409, {
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return c.json(await deps.openService(project.id, request.audience));
      }
      const staticApp = await projectServiceStaticApp(
        project.path,
        declaration,
      );
      path = staticApp.entry;
      declaredRoot = staticApp.root;
      id = `static:${project.id}`;
      kind = "static";
    }
    await authorize(c);
    const grant = await deps.artifacts.createGrant(
      path,
      request.audience,
      false,
      declaredRoot,
    );
    const view: ProjectAppView = {
      id,
      kind,
      url: publicViewUrl ?? grant.url,
      expiresAt: grant.expiresAt,
      label: basename(path),
      transferable: true,
    };
    return c.json(view);
  });

  routes.post("/projects/:projectId/app/restore", async (c) => {
    const project = await authorize(c);
    if (principalFor(c).kind !== "superuser")
      throw new HTTPException(403, {
        message:
          "Only the administrator can restore another user's project visibility",
      });
    const parsed = z
      .strictObject({ username: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Expected username" }, 400);
    await deps.store.setHidden(
      project.id,
      parsed.data.username,
      false,
      "superuser",
    );
    deps.onVisibilityChanged?.(project.id);
    return c.json({ restored: true });
  });
  const namespace = () => deps.artifacts.config.vhostPublicRoot ?? null;
  const publisher = async (c: Context, release = false) => {
    await authorize(c, "new-session");
    const principal = principalFor(c);
    if (
      principal.kind !== "superuser" &&
      (release ||
        deps.activeGrants(principal.username)?.allowPublicApps !== true)
    )
      throw new HTTPException(403, {
        message: "Only the administrator can publish or release an app address",
      });
  };
  routes.get("/projects/:projectId/app/address", async (c) => {
    const project = await authorize(c);
    const principal = principalFor(c);
    const current = namespace();
    const addresses: ProjectAppAddresses = {
      enabled: !!current,
      namespace: current,
      requiredPrefix:
        principal.kind === "limited" ? `${principal.username}-` : "",
      canReserve:
        principal.kind === "superuser" ||
        satisfies(levelFor(principal.grants, project.id), "new-session"),
      canPublish:
        principal.kind === "superuser" ||
        (principal.grants.allowPublicApps === true &&
          satisfies(levelFor(principal.grants, project.id), "new-session")),
      canRelease: principal.kind === "superuser",
      reservations: current
        ? await Promise.all(
            (await deps.store.reservations(project.id)).map(async (stored) => {
              const allowed = projectAppPublicAllowed(
                project.ownerUsername,
                stored,
                deps.activeGrants,
              );
              const row = {
                ...stored,
                // The superuser may make any app public.
                privateOnly: principal.kind !== "superuser" && !allowed,
                public: stored.public && allowed,
              };
              const canCopy =
                row.public ||
                principal.kind === "superuser" ||
                principal.grants.allowPrivateAppLinks !== false;
              return {
                ...row,
                ...(canCopy && row.namespace === current && deps.delivery
                  ? { url: await deps.delivery.addressLink(row) }
                  : {}),
              };
            }),
          )
        : [],
      ...(deps.autoStart
        ? { autoStart: await deps.autoStart.status(project.id) }
        : {}),
    };
    return c.json(addresses);
  });
  routes.post("/projects/:projectId/app/address/auto-start", async (c) => {
    const project = await authorize(c, "new-session");
    await publisher(c);
    if (!deps.autoStart)
      throw new HTTPException(409, { message: "Auto-start is unavailable" });
    const parsed = z
      .strictObject({ enabled: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "Expected an enabled choice" }, 400);
    const principal = principalFor(c);
    return c.json(
      await deps.autoStart.set(
        project.id,
        parsed.data.enabled,
        principal.kind === "limited" ? principal.username : "superuser",
        () => publisher(c),
      ),
    );
  });
  routes.post("/projects/:projectId/app/address/reserve", async (c) => {
    const project = await authorize(c, "new-session");
    const principal = principalFor(c);
    const current = namespace();
    if (!current)
      throw new HTTPException(409, { message: "App addresses are disabled" });
    const parsed = z
      .strictObject({ name: z.string().min(1).max(63) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Expected an app name" }, 400);
    const name = parsed.data.name.trim().toLowerCase();
    try {
      parseVhosts([{ name, port: 1 }]);
    } catch {
      return c.json({ error: "Invalid app name" }, 400);
    }
    if (/^(?:app-|sbx-)/.test(name))
      return c.json({ error: "This name prefix is reserved" }, 400);
    if (
      principal.kind === "limited" &&
      !name.startsWith(`${principal.username}-`)
    )
      return c.json(
        { error: `App names must start with ${principal.username}-` },
        403,
      );
    if (configuredVhostNames(deps.artifacts.config).includes(name))
      return c.json({ error: "App address is already configured" }, 409);
    try {
      const reservation = await deps.store.reserve(
        {
          namespace: current,
          name,
          projectId: project.id,
          owner:
            principal.kind === "limited" ? principal.username : "superuser",
          privateOnly: principal.kind === "limited" || !!project.ownerUsername,
        },
        async () => {
          await authorize(c, "new-session");
          if (
            namespace() !== current ||
            configuredVhostNames(deps.artifacts.config).includes(name)
          )
            throw new HTTPException(409, {
              message: "App address configuration changed",
            });
        },
      );
      await deps.delivery?.refreshHosts();
      return c.json(reservation);
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      if (
        error instanceof Error &&
        /already (?:reserved|has an address)/.test(error.message)
      )
        return c.json({ error: error.message }, 409);
      throw error;
    }
  });
  routes.post("/projects/:projectId/app/address/serve", async (c) => {
    const project = await authorize(c, "new-session");
    await publisher(c);
    const current = namespace();
    if (!current)
      throw new HTTPException(409, { message: "App addresses are disabled" });
    const parsed = z
      .strictObject({ serving: z.boolean(), public: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "Expected serving and public choices" }, 400);
    const reservation = (await deps.store.reservations(project.id)).find(
      (row) => row.namespace === current,
    );
    if (!reservation) return c.json({ error: "Reserve an address first" }, 409);
    const superuser = principalFor(c).kind === "superuser";
    if (
      parsed.data.public &&
      !superuser &&
      !projectAppPublicAllowed(
        project.ownerUsername,
        reservation,
        deps.activeGrants,
      )
    )
      return c.json({ error: "This owner's apps require a private link" }, 403);
    return c.json(
      await deps.store.setServing(
        project.id,
        current,
        parsed.data.serving,
        parsed.data.public,
        async () => {
          await publisher(c);
          const freshProject = await authorize(c, "new-session");
          const allowed =
            superuser ||
            projectAppPublicAllowed(
              freshProject.ownerUsername,
              reservation,
              deps.activeGrants,
            );
          if (parsed.data.public && !allowed)
            throw new HTTPException(403, {
              message: "This owner's apps require a private link",
            });
          return { allowed, superuser };
        },
      ),
    );
  });
  routes.post("/projects/:projectId/app/address/release", async (c) => {
    const project = await authorize(c, "new-session");
    await publisher(c, true);
    const parsed = z
      .strictObject({ namespace: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Expected namespace" }, 400);
    await releaseAddress(project.id, parsed.data.namespace, () =>
      publisher(c, true),
    );
    return c.json({ released: true });
  });
  async function releaseAddress(
    projectId: string,
    namespace: string,
    authorizeRelease: () => Promise<void>,
  ) {
    await deps.store.release(projectId, namespace, async () => {
      await authorizeRelease();
      const row = (await deps.store.reservations(projectId)).find(
        (entry) => entry.namespace === namespace,
      );
      if (row)
        await deps.artifacts.vhostAccess.rotate({
          name: row.name,
          projectId,
        });
    });
  }
  return routes;
}
