/**
 * Principal resolution and limited-user authorization for every API request.
 *
 * Contract: topics/limited-users.md § Delivery v1 — Authorization.
 *
 * One middleware does both halves so no route can be reached with an
 * unresolved principal: it decides who is acting, and — when that is a
 * limited user — whether this exact operation is allowed, refusing by
 * default. List responses the user is allowed to read are then pruned of
 * projects outside their grants, so a filtered UI and an enforced API agree.
 */

import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { LimitedUserGrants } from "@yep-anywhere/shared";
import {
  ACTING_USER_COOKIE,
  DIRECT_LOGIN_VARIABLE,
  type LimitedPrincipal,
  type Principal,
  PRINCIPAL_VARIABLE,
  SUPERUSER,
  verifyActingUser,
} from "../auth/principal.js";
import type { SessionAccessResolver } from "../auth/sessionAccess.js";
import {
  type FilteredListKind,
  decideLimitedRoute,
  levelFor,
  satisfies,
} from "../auth/limitedUserPolicy.js";
import {
  getAuthenticatedDirectLogin,
  getAuthenticatedSrpTransport,
} from "./authenticated-transport.js";
import { WS_INTERNAL_AUTHENTICATED } from "./internal-auth.js";

export interface LimitedUsersMiddlewareOptions {
  /**
   * Grants for a limited user who may act now: null when the feature is off
   * or the user is unknown or disabled. With the feature off no login other
   * than the superuser's resolves, so a live limited login is refused rather
   * than read as the superuser.
   */
  getActiveGrants: (username: string) => LimitedUserGrants | null;
  sessionAccess: SessionAccessResolver;
  /** The superuser's relay/SRP identity, when remote access is configured. */
  getSuperuserIdentity: () => string | null;
  /** Username recorded on the direct cookie session, when there is one. */
  getCookieSessionUsername: (
    c: Parameters<MiddlewareHandler>[0],
  ) => Promise<string | null>;
  /** Secret used to sign the acting-user cookie. */
  getCookieSecret: () => string;
  /** Personal list visibility; does not change direct project/session access. */
  getHiddenProjectIds?: (username: string) => Promise<ReadonlySet<string>>;
}

function limitedPrincipal(
  username: string,
  grants: LimitedUserGrants,
  options: { switched: boolean; locked: boolean; via: "relay" | "direct" },
): LimitedPrincipal {
  return { kind: "limited", username, grants, ...options };
}

/**
 * The direct login's username for this request, or null for the superuser.
 * An internal request never takes its login from its own headers: a
 * trusted-local websocket carries the login it bound at upgrade, and a
 * server-originated request has none.
 */
async function resolveDirectLoginUsername(
  c: Parameters<MiddlewareHandler>[0],
  options: LimitedUsersMiddlewareOptions,
): Promise<string | null> {
  if (getAuthenticatedSrpTransport(c.env)) return null;
  const bound = getAuthenticatedDirectLogin(c.env);
  if (bound) return bound.username;
  if (c.env?.[WS_INTERNAL_AUTHENTICATED]) return null;
  return options.getCookieSessionUsername(c);
}

/** Resolve the acting principal without enforcing anything. */
export async function resolvePrincipal(
  c: Parameters<MiddlewareHandler>[0],
  options: LimitedUsersMiddlewareOptions,
  directLoginUsername: string | null,
): Promise<Principal> {
  const srp = getAuthenticatedSrpTransport(c.env);
  const superuserIdentity = options.getSuperuserIdentity();
  if (srp && srp.username !== superuserIdentity) {
    const grants = options.getActiveGrants(srp.username);
    if (!grants) return DENIED_PRINCIPAL;
    return limitedPrincipal(srp.username, grants, {
      switched: false,
      locked: true,
      via: "relay",
    });
  }

  if (directLoginUsername) {
    const grants = options.getActiveGrants(directLoginUsername);
    if (!grants) return DENIED_PRINCIPAL;
    return limitedPrincipal(directLoginUsername, grants, {
      switched: false,
      locked: true,
      via: "direct",
    });
  }

  // The login is the superuser; honor a switch into a limited user.
  const acting = verifyActingUser(
    getCookie(c, ACTING_USER_COOKIE),
    options.getCookieSecret(),
  );
  if (acting) {
    const grants = options.getActiveGrants(acting);
    if (grants) {
      return limitedPrincipal(acting, grants, {
        switched: true,
        locked: false,
        via: srp ? "relay" : "direct",
      });
    }
  }
  return SUPERUSER;
}

/**
 * A login that named a limited user who no longer exists or was disabled.
 * The middleware turns this into 401 so the client logs in again rather than
 * driving a UI in which every operation is refused.
 */
const DENIED_PRINCIPAL: LimitedPrincipal = {
  kind: "limited",
  username: "",
  grants: {
    newSessionProjects: [],
    joinProjects: [],
    viewProjects: [],
    joinStaleOffsetMinutes: 0,
    lock: {},
  },
  switched: false,
  locked: true,
  via: "direct",
};

const DROP = Symbol("drop-inaccessible");

/**
 * Remove rows for projects outside the grants. A row is anything carrying a
 * `projectId`, at any depth, which is how every list route identifies the
 * project a session, queue item, or recent entry belongs to.
 */
function pruneInaccessible(
  value: unknown,
  isAccessible: (projectId: string) => boolean,
): unknown | typeof DROP {
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    for (const entry of value) {
      const pruned = pruneInaccessible(entry, isAccessible);
      if (pruned !== DROP) kept.push(pruned);
    }
    return kept;
  }
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const projectId = record.projectId;
  if (typeof projectId === "string" && !isAccessible(projectId)) {
    return DROP;
  }
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const pruned = pruneInaccessible(entry, isAccessible);
    if (pruned === DROP) {
      // A nested object naming an inaccessible project takes its row with it.
      return DROP;
    }
    next[key] = pruned;
  }
  return next;
}

/** The projects list identifies rows by `id`, not `projectId`. */
function pruneProjectsList(
  body: unknown,
  isAccessible: (projectId: string) => boolean,
): unknown {
  if (!body || typeof body !== "object") return body;
  const record = body as Record<string, unknown>;
  const projects = record.projects;
  if (!Array.isArray(projects)) return body;
  return {
    ...record,
    projects: projects.filter(
      (project) =>
        typeof (project as { id?: unknown }).id === "string" &&
        isAccessible((project as { id: string }).id),
    ),
  };
}

/** Session rows use `projectId`, while their filter options use project `id`. */
function pruneSessionsList(
  body: unknown,
  isAccessible: (projectId: string) => boolean,
): unknown {
  const pruned = pruneInaccessible(body, isAccessible);
  if (pruned === DROP || !pruned || typeof pruned !== "object") return {};
  const record = pruned as Record<string, unknown>;
  const projects = record.projects;
  if (!Array.isArray(projects)) return record;
  return {
    ...record,
    projects: projects.filter(
      (project) =>
        typeof (project as { id?: unknown }).id === "string" &&
        isAccessible((project as { id: string }).id),
    ),
  };
}

/** Keep row identities and each window under the same grants/hidden projection. */
function pruneSidebarSnapshot(
  body: unknown,
  isAccessible: (projectId: string) => boolean,
): unknown {
  if (!body || typeof body !== "object") return {};
  const record = body as Record<string, unknown>;
  const pruned = pruneInaccessible(record.rows, isAccessible);
  const rows = Array.isArray(pruned) ? pruned : [];
  const allowed = new Set(
    rows.map((row) => row?.id).filter((id) => typeof id === "string"),
  );
  const source = record.windows as
    | Record<string, { ids?: unknown; hasMore?: unknown }>
    | undefined;
  const windows = Object.fromEntries(
    ["recent", "starred", "categorized"].map((feed) => {
      const window = source?.[feed];
      return [
        feed,
        {
          ids: Array.isArray(window?.ids)
            ? window.ids.filter((id) => allowed.has(id))
            : [],
          hasMore: window?.hasMore === true,
        },
      ];
    }),
  );
  return {
    rows,
    windows,
    catalog: record.catalog,
    nextTransitionAt: record.nextTransitionAt,
  };
}

function projectScopedRows(
  value: unknown,
  isAccessible: (projectId: string) => boolean,
): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const projectId = (entry as { projectId?: unknown }).projectId;
    return typeof projectId === "string" && isAccessible(projectId);
  });
}

/**
 * Project Queue is a global response made of several project-keyed fields.
 * Build an allowlist projection so a future field cannot silently bypass the
 * grants merely because it has a new response shape.
 */
function pruneProjectQueueResponse(
  body: unknown,
  isAccessible: (projectId: string) => boolean,
): unknown {
  if (!body || typeof body !== "object") return {};
  const record = body as Record<string, unknown>;
  const projected: Record<string, unknown> = {
    items: projectScopedRows(record.items, isAccessible),
  };

  if (record.dispatchState !== undefined) {
    // The global pause gates this user's own queue too, so it remains visible.
    projected.dispatchState = record.dispatchState;
  }
  if (record.recoveredSessionQueues !== undefined) {
    projected.recoveredSessionQueues = projectScopedRows(
      record.recoveredSessionQueues,
      isAccessible,
    );
  }
  if (record.projectStatuses !== undefined) {
    const statuses: Record<string, unknown> = {};
    if (record.projectStatuses && typeof record.projectStatuses === "object") {
      for (const [projectId, status] of Object.entries(
        record.projectStatuses as Record<string, unknown>,
      )) {
        if (!isAccessible(projectId) || !status || typeof status !== "object") {
          continue;
        }
        if ((status as { projectId?: unknown }).projectId !== projectId) {
          continue;
        }
        statuses[projectId] = status;
      }
    }
    projected.projectStatuses = statuses;
  }
  if (record.promoteResult && typeof record.promoteResult === "object") {
    const status = (record.promoteResult as { status?: unknown }).status;
    const projectId =
      status && typeof status === "object"
        ? (status as { projectId?: unknown }).projectId
        : undefined;
    if (typeof projectId === "string" && isAccessible(projectId)) {
      projected.promoteResult = record.promoteResult;
    }
  }

  return projected;
}

async function filterResponse(
  response: Response,
  filter: FilteredListKind,
  isAccessible: (projectId: string) => boolean,
): Promise<Response> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json") || !response.ok) {
    return response;
  }
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  let filtered: unknown | typeof DROP;
  switch (filter) {
    case "projects":
      filtered = pruneProjectsList(body, isAccessible);
      break;
    case "project-queue":
      filtered = pruneProjectQueueResponse(body, isAccessible);
      break;
    case "sidebar-sessions":
      filtered = pruneSidebarSnapshot(body, isAccessible);
      break;
    case "sessions":
      filtered = pruneSessionsList(body, isAccessible);
      break;
    default:
      filtered = pruneInaccessible(body, isAccessible);
  }
  const payload = filtered === DROP ? {} : filtered;
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  return new Response(JSON.stringify(payload), {
    status: response.status,
    headers,
  });
}

export function createLimitedUsersMiddleware(
  options: LimitedUsersMiddlewareOptions,
): MiddlewareHandler {
  return async (c, next) => {
    const directLoginUsername = await resolveDirectLoginUsername(c, options);
    c.set(DIRECT_LOGIN_VARIABLE, directLoginUsername);
    const principal = await resolvePrincipal(c, options, directLoginUsername);
    c.set(PRINCIPAL_VARIABLE, principal);
    if (principal.kind === "superuser") {
      await next();
      return;
    }
    if (principal === DENIED_PRINCIPAL) {
      // The login named a user who is gone or disabled.
      return c.json({ error: "Session expired" }, 401);
    }

    // The routed path, not `new URL(c.req.url).pathname`: Hono matches
    // handlers against the percent-decoded path.
    const decision = decideLimitedRoute({
      method: c.req.method,
      path: c.req.path,
    });

    const isAccessible = (projectId: string) =>
      levelFor(principal.grants, projectId) !== "none";
    const filterVisible = async (
      response: Response,
      filter: FilteredListKind,
    ) => {
      const hidden = await options.getHiddenProjectIds?.(principal.username);
      return filterResponse(
        response,
        filter,
        (projectId) => isAccessible(projectId) && !hidden?.has(projectId),
      );
    };

    switch (decision.kind) {
      case "deny":
        return c.json({ error: "Not permitted for this user" }, 403);
      case "allow":
        await next();
        return;
      case "detached-create":
        if (principal.grants.allowNoProjectSessions !== true) {
          return c.json(
            {
              error: "No project session creation is not enabled for this user",
            },
            403,
          );
        }
        await next();
        return;
      case "allow-filtered": {
        await next();
        if (c.res) {
          c.res = await filterVisible(c.res, decision.filter);
        }
        return;
      }
      case "project": {
        const level = levelFor(principal.grants, decision.projectId);
        if (level === "none") {
          return c.json({ error: "Project not found" }, 404);
        }
        if (!satisfies(level, decision.required)) {
          return c.json({ error: "Not permitted for this user" }, 403);
        }
        await next();
        if (decision.filter && c.res) {
          c.res = await filterVisible(c.res, decision.filter);
        }
        return;
      }
      case "session": {
        const facts = await options.sessionAccess.resolve(decision.sessionId);
        if (!facts) {
          return c.json({ error: "Session not found" }, 404);
        }
        const ownedByCaller = facts.createdByUser === principal.username;
        const level = levelFor(principal.grants, facts.projectId);
        if (level === "none" && !ownedByCaller) {
          return c.json({ error: "Session not found" }, 404);
        }
        if (decision.required === "view") {
          await next();
          return;
        }
        if (!satisfies(level, decision.required)) {
          return c.json({ error: "Not permitted for this user" }, 403);
        }
        if (decision.required === "join" && !facts.sandboxed) {
          // Driving a process that runs outside the sandbox — sending turns,
          // approving tools, changing its permission mode — is the server
          // account's authority, whoever started it and however fresh it is.
          // Its network firewall is part of that sandbox.
          return c.json(
            {
              error:
                "This session runs outside the sandbox or without its network firewall, so this user cannot act in it; start a new session instead",
              reason: "unsandboxed-session",
            },
            403,
          );
        }
        if (
          decision.startsTurn &&
          !options.sessionAccess.isFresh(facts, {
            offsetMinutes: principal.grants.joinStaleOffsetMinutes,
          })
        ) {
          // A turn on a cold session re-reads its whole context without the
          // prompt cache, whoever started it. Where the user may start
          // sessions, the client redirects the turn into a new one seeded
          // with a handoff (the `stale-handoff` action) instead.
          return c.json(
            {
              error:
                "This session has gone cold; start a new session instead of resuming it",
              reason: "stale-session",
              ...(level === "new-session"
                ? { staleRedirect: "stale-handoff" }
                : {}),
            },
            403,
          );
        }
        await next();
        return;
      }
    }
  };
}
