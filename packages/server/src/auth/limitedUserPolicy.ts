/**
 * What a limited user may ask the API to do.
 *
 * Contract: topics/limited-users.md § Delivery v1 — Authorization.
 *
 * The rule is default-deny: a request path that is not listed here is
 * refused, so a route added later is unreachable for limited users until
 * someone lists it deliberately. Listed paths are then scoped — a project or
 * session outside the user's grants answers 404 rather than 403, because
 * whether a project exists is itself not the user's business.
 *
 * This module is pure: it decides from the method and the path, and hands
 * back what the caller must still resolve (a session's project). The path
 * must be the one the router matches handlers against (Hono's `c.req.path`,
 * already percent-decoded), never the raw URL pathname: `/api/%69ssues`
 * reaches the `/api/issues` handler, so the decision has to see it as that.
 *
 * A project grant comes only from the path. No route is opened by a
 * `projectId` query parameter, because most handlers ignore one.
 */

import type {
  LimitedUserGrants,
  ProjectAccessLevel,
} from "@yep-anywhere/shared";
import { projectAccessLevel } from "@yep-anywhere/shared";

/** What the request needs from the project it touches. */
export type RequiredAccess = "view" | "join" | "new-session";

export type LimitedRouteDecision =
  | { kind: "deny" }
  /** Allowed with no project scope (identity, version, catalogs). */
  | { kind: "allow" }
  | { kind: "detached-create" }
  /** Allowed when the named project grants at least `required`. */
  | {
      kind: "project";
      projectId: string;
      required: RequiredAccess;
      /** Optional projection for a successful project-scoped response. */
      filter?: FilteredListKind;
    }
  /**
   * Allowed when the session's project grants at least `required`. A `join`
   * requirement additionally needs the session to run sandboxed. A request
   * that `startsTurn` — makes the provider answer on the session's existing
   * context — also needs the session to be fresh, whoever started it.
   */
  | {
      kind: "session";
      sessionId: string;
      required: RequiredAccess;
      startsTurn?: boolean;
    }
  /** Allowed, and the response is a list the caller must filter. */
  | { kind: "allow-filtered"; filter: FilteredListKind };

export type FilteredListKind =
  | "projects"
  | "project-queue"
  | "sessions"
  | "inbox"
  | "recents"
  | "processes";

/**
 * Route families a limited user may never reach, listed ahead of the
 * allowances so a project-scoped-looking path cannot sneak one in.
 *
 * Issues & PRs spend the host's ticket-system credentials; bang commands run
 * outside the provider sandbox; file editing reads and writes any absolute
 * path in the host-wide local-file allow-set, which no project grant scopes,
 * and its rebuild route runs a registered command outside any session
 * sandbox; the rest are host administration, other people's devices, or grant
 * machinery.
 */
const DENIED_PREFIXES: readonly string[] = [
  "/api/issues",
  "/api/bang-commands",
  "/api/env-settings",
  "/api/server",
  "/api/server-admin",
  "/api/devices",
  "/api/device-bridge",
  "/api/computer-control",
  "/api/public-shares",
  "/api/public-file-shares",
  "/api/sharing",
  "/api/vhost",
  "/api/apps",
  "/api/security",
  "/api/host-agent-processes",
  "/api/agents",
  "/api/local-file",
  "/api/local-image",
  "/api/file-edit",
  "/api/artifacts",
  "/api/artifact-previews",
  "/api/glossary-artifacts",
  "/api/debug",
  "/api/dev",
  "/api/remote-access",
  "/api/network-binding",
  "/api/browser-debug",
  "/api/browser-settings-backup",
  "/api/connections",
  "/api/review",
  "/api/supervisor",
  "/api/desktop",
  "/api/onboarding",
  "/api/speech-vocabulary",
  "/api/experimental",
];

/** Identity and catalog reads every principal needs to render the app. */
const PUBLIC_GET_PREFIXES: readonly string[] = [
  "/api/version",
  "/api/server-info",
  "/api/providers",
  "/api/provider-catalog",
  "/api/provider-host",
  "/api/auth/status",
  "/api/users/me",
  "/api/push/vapid-public-key",
  "/api/push/settings",
  "/api/push/subscriptions",
  "/api/browser-profiles",
  "/api/client",
  // Pinned third-party renderer code; no project content.
  "/api/pdfjs",
];

/** Writes that only touch the caller's own device or identity. */
const SELF_WRITE_PATHS: readonly string[] = [
  "/api/users/logout",
  "/api/auth/logout",
  "/api/push/subscribe",
  "/api/push/unsubscribe",
  "/api/client-logs",
];

/**
 * Status reads every client polls, carrying no project content: whether
 * onboarding is done, and whether public sharing is configured at all.
 * Listed ahead of the denied families they sit under.
 */
const READ_ONLY_STATUS_PATHS: readonly string[] = [
  "/api/onboarding",
  "/api/public-shares/status",
  "/api/status/workers",
  // Dev-server-only reload signals; absent from a production build.
  "/api/dev/status",
  "/api/dev/safe-restart",
];

/**
 * Dictation through the speech backends the superuser configured: the
 * streaming socket, batch transcription, a model prewarm, and the short-lived
 * xAI client secret the direct Grok method streams with. The raw xAI key
 * route stays refused even where the superuser shares it with their own
 * browsers, since a limited user could keep it; backend setup (install, GPU,
 * restart, and a status naming the host's working directory) and the learned
 * vocabulary, drawn from every session's text, stay the superuser's.
 */
const SPEECH_USE_ROUTES: readonly string[] = [
  "GET /api/speech/ws",
  "POST /api/speech/transcribe",
  "POST /api/speech/prewarm",
  "POST /api/speech/xai-client-secret",
];

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function hasPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/**
 * Session-scoped mutations a joiner may perform: sending and shaping turns in
 * an existing session, which must run sandboxed (the middleware checks). The
 * few others a limited user may perform need the project's new-session grant
 * and are listed below.
 */
const JOIN_SESSION_ACTIONS = new Set([
  "messages",
  "input",
  "mode",
  "mark-seen",
  "deferred",
  "steering",
  "pending-input",
  "interrupt",
  "approve",
  "approvals",
  "permissions",
  "queue",
  // Attaching an image or document is part of composing that turn.
  "upload",
  // Opening a server the session started in its sandbox: it acts on that
  // session's own process, as a turn does.
  "sandbox-apps",
  // An interactive preview of a file the session wrote: a bearer link to
  // that file's directory, confined by the route to the session's project
  // and sandbox temp (routes/session-path-scope.ts).
  "artifacts",
  "artifact-previews",
]);

/**
 * Session-scoped mutations a new-session grant adds to the join actions.
 * Every one here that starts or resumes a provider process applies the
 * limited launch policy at its route (auth/limitedLaunchPolicy.ts):
 * resume and reactivate, while fork and clone record the user as creator of
 * a transcript that only a policy-checked resume can run. Any other session
 * action is refused, including restart, recap, retitle, fork-summary, rewind,
 * clearloop, recovered-queue resume, session bang commands, and moving a
 * session between projects, so a launching route added later stays out of a
 * limited user's reach until it applies the policy and is listed here.
 */
const NEW_SESSION_SESSION_ACTIONS = new Set([
  "resume",
  "reactivate",
  "fork",
  "clone",
  "terminate",
  "archive",
  "done",
  "metadata",
  // Materializing staged attachments into a session's first turn.
  "attachments",
  // A turn sent to a cold session, redirected into a new session seeded with
  // a handoff; the source session launches nothing.
  "stale-handoff",
]);

/**
 * Actions that make the provider answer on the session's existing context:
 * a turn, an answer that continues one, or a resume carrying one. On a cold
 * session each re-reads the whole context without the prompt cache, which is
 * the cost the freshness cutoff exists to stop. Removing or steering a
 * deferred message is judged by its method below.
 */
const TURN_STARTING_ACTIONS = new Set([
  "messages",
  "input",
  "approve",
  "approvals",
  "queue",
  "resume",
]);

function startsTurn(action: string, method: string): boolean {
  if (TURN_STARTING_ACTIONS.has(action)) return true;
  // POST /deferred/:tempId/steer delivers a deferred message; DELETE drops it.
  return action === "deferred" && method === "POST";
}

/** What a session-scoped mutation needs, or null when it is refused. */
function sessionMutationRequirement(
  action: string,
  method: string,
): RequiredAccess | null {
  // Recomputes the list preview from the transcript a reader may already
  // read; it launches nothing and stores nothing.
  if (action === "refresh-preview" && method === "POST") return "view";
  if (JOIN_SESSION_ACTIONS.has(action)) return "join";
  if (NEW_SESSION_SESSION_ACTIONS.has(action)) return "new-session";
  // Dropping a restart-paused queued message launches nothing; resuming or
  // steering it does, through a path without the launch policy.
  if (action === "recovered-queue" && method === "DELETE") {
    return "new-session";
  }
  return null;
}

function sessionMutationDecision(
  sessionId: string,
  action: string,
  method: string,
): LimitedRouteDecision {
  const required = sessionMutationRequirement(action, method);
  if (!required) return { kind: "deny" };
  return startsTurn(action, method)
    ? { kind: "session", sessionId, required, startsTurn: true }
    : { kind: "session", sessionId, required };
}

export interface LimitedRouteRequest {
  method: string;
  /** The routed path: percent-decoded as the router matches it, no query. */
  path: string;
}

/** One path segment as the router's param decoding reads it, or null. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Decide what a limited principal's request needs, or that it is refused. */
export function decideLimitedRoute(
  request: LimitedRouteRequest,
): LimitedRouteDecision {
  const { path } = request;
  const method = request.method.toUpperCase();
  const isRead = READ_METHODS.has(method);

  // V0 application reads enforce project/session scope before pagination.
  if (
    isRead &&
    /^\/v0(?:\/(?:help|schema|me|servers(?:\/[^/]+(?:\/(?:access|capabilities|projects|providers|sessions(?:\/[^/]+(?:\/conversation(?:\/follow)?)?)?))?)?))?$/.test(
      path,
    )
  ) {
    return { kind: "allow" };
  }
  if (path === "/v0" || path.startsWith("/v0/")) return { kind: "deny" };

  if (
    (method === "POST" &&
      ["/api/drafts/read", "/api/drafts/write", "/api/drafts/clear"].includes(
        path,
      )) ||
    (method === "GET" &&
      ["/api/drafts/index", "/api/drafts/changes"].includes(path))
  )
    return { kind: "allow" };
  if (path === "/health") return { kind: "allow" };
  if (path === "/api/ws") {
    // The websocket upgrade itself. What may be subscribed over it, and what
    // its tunneled requests may do, is decided per message and per request by
    // this same policy.
    return { kind: "allow" };
  }
  if (!path.startsWith("/api/")) {
    // Static client assets and the SPA shell; nothing principal-specific.
    return { kind: "allow" };
  }
  if (READ_ONLY_STATUS_PATHS.includes(path)) {
    // Status reads with no project content. Refusing them would only make a
    // limited user's console a stream of 403s from polls the client makes
    // for everyone.
    return isRead ? { kind: "allow" } : { kind: "deny" };
  }
  // These handlers enforce creator ownership and the supplied project's grant.
  if (
    (path === "/api/artifacts/vhost-sites" &&
      ["GET", "POST"].includes(method)) ||
    (/^\/api\/artifacts\/vhost-sites\/[^/]+$/.test(path) && method === "DELETE")
  )
    return { kind: "allow" };
  if (hasPrefix(path, DENIED_PREFIXES)) return { kind: "deny" };
  // Provider sign-in signs the host's CLI into an account. Even its status
  // read carries a live device code that would sign the host into whichever
  // account enters it.
  if (/^\/api\/providers\/[^/]+\/login(?:\/|$)/.test(path)) {
    return { kind: "deny" };
  }

  if (SELF_WRITE_PATHS.includes(path)) return { kind: "allow" };
  // The staging service isolates drafts by the authenticated acting account.
  if (
    (method === "GET" &&
      path === "/api/attachments/staging/drafts/upload/ws") ||
    (method === "POST" &&
      /^\/api\/attachments\/staging\/drafts\/[^/]+\/validate$/.test(path)) ||
    (method === "DELETE" &&
      /^\/api\/attachments\/staging\/drafts\/[^/]+\/[^/]+$/.test(path))
  )
    return { kind: "allow" };
  if (path.startsWith("/api/users")) {
    // Everything else under user administration is the superuser's.
    return path === "/api/users/me" && isRead
      ? { kind: "allow" }
      : { kind: "deny" };
  }
  if (path.startsWith("/api/auth")) {
    return path === "/api/auth/status" && isRead
      ? { kind: "allow" }
      : { kind: "deny" };
  }
  if (path === "/api/settings") {
    // Read the settings document, never write it. The route answers a
    // limited user with its projection, which withholds secrets and host
    // inventory. Every settings subpath (browser backup, remote executors,
    // cache-billing events, file-access and host-awake status) is host
    // administration and falls to the default deny below.
    return isRead ? { kind: "allow" } : { kind: "deny" };
  }
  if (path === "/api/settings/limited-user-defaults") {
    // The browser defaults published for limited users are theirs to read;
    // only the superuser publishes them.
    return isRead ? { kind: "allow" } : { kind: "deny" };
  }
  if (hasPrefix(path, PUBLIC_GET_PREFIXES)) {
    return isRead ? { kind: "allow" } : { kind: "deny" };
  }
  if (SPEECH_USE_ROUTES.includes(`${method} ${path}`)) {
    return { kind: "allow" };
  }

  // The receipt handler looks up only this authenticated principal's key.
  if (isRead && /^\/api\/session-creations\/[^/]+$/.test(path))
    return { kind: "allow" };
  const projectScoped = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
  if (projectScoped) {
    const projectId = decodeSegment(projectScoped[1] as string);
    if (projectId === null) return { kind: "deny" };
    const rest = projectScoped[2] ?? "";
    // Seeing a project is enough to open its app and to start it; stopping
    // it stays with the default new-session requirement below.
    if ((rest === "/app/open" || rest === "/app/start") && method === "POST")
      return { kind: "project", projectId, required: "view" };
    // Copying reads the project and writes only under the user's own
    // project directory, which the copy route enforces.
    if (rest === "/copy" && method === "POST")
      return { kind: "project", projectId, required: "view" };
    if (
      rest === "/sessions" ||
      rest === "/sessions/create" ||
      rest === "/session-creations"
    ) {
      // Creating a session in this project. Checked before the session-scoped
      // match below, whose `[^/]+` would otherwise read "create" as an id.
      return isRead
        ? { kind: "project", projectId, required: "view" }
        : { kind: "project", projectId, required: "new-session" };
    }
    const sessionScoped = rest.match(/^\/sessions\/([^/]+)(\/(.*))?$/);
    if (sessionScoped) {
      const sessionId = decodeSegment(sessionScoped[1] as string);
      if (sessionId === null) return { kind: "deny" };
      const action = (sessionScoped[3] ?? "").split("/")[0] ?? "";
      if (isRead) {
        return { kind: "session", sessionId, required: "view" };
      }
      return sessionMutationDecision(sessionId, action, method);
    }
    return {
      kind: "project",
      projectId,
      required: isRead ? "view" : "new-session",
    };
  }

  if (path === "/api/projects") {
    if (isRead) return { kind: "allow-filtered", filter: "projects" };
    // POST adds a project. Whether this user may add one, and where, is a
    // path question this pure decision cannot see: the route holds them to
    // their configured directory and refuses when they have none
    // (routes/project-creation.ts, topics/limited-users.md § Delivery v1).
    if (method === "POST") return { kind: "allow" };
    return { kind: "deny" };
  }

  // The creation route enforces template/root grants and operation ownership.
  if (
    (isRead && path === "/api/project-templates/choices") ||
    (method === "POST" && path === "/api/project-templates/operations") ||
    (isRead && /^\/api\/project-templates\/operations\/[^/]+$/.test(path))
  ) {
    return { kind: "allow" };
  }

  if (
    method === "POST" &&
    (path === "/api/sessions" ||
      path === "/api/sessions/create" ||
      path === "/api/session-creations")
  ) {
    return { kind: "detached-create" };
  }
  if (path === "/api/sessions") {
    return isRead
      ? { kind: "allow-filtered", filter: "sessions" }
      : { kind: "deny" };
  }

  const sessionScoped = path.match(/^\/api\/sessions\/([^/]+)(\/(.*))?$/);
  if (sessionScoped) {
    const sessionId = decodeSegment(sessionScoped[1] as string);
    if (sessionId === null) return { kind: "deny" };
    const action = (sessionScoped[3] ?? "").split("/")[0] ?? "";
    if (isRead) return { kind: "session", sessionId, required: "view" };
    return sessionMutationDecision(sessionId, action, method);
  }
  if (path === "/api/inbox" || path.startsWith("/api/inbox/")) {
    return isRead
      ? { kind: "allow-filtered", filter: "inbox" }
      : { kind: "deny" };
  }
  if (path === "/api/recents") {
    // The recents list is the install's, shared with the superuser: reading
    // it is filtered, clearing it is refused.
    return isRead
      ? { kind: "allow-filtered", filter: "recents" }
      : { kind: "deny" };
  }
  if (path === "/api/recents/visit" && method === "POST") {
    // Every session page posts its visit. The route records nothing for a
    // limited user and says so, rather than every open drawing a 403.
    return { kind: "allow" };
  }
  if (path === "/api/processes") {
    return isRead
      ? { kind: "allow-filtered", filter: "processes" }
      : { kind: "deny" };
  }
  // `/api/activity/*` is not listed: its REST reads are watcher status and
  // every connected tab and browser profile, host inventory that carries no
  // project to filter by. The activity channel itself runs over /api/ws.
  if (path === "/api/project-queue") {
    // The route already builds the global queue from the caller's granted
    // projects (routes/project-queue.ts), so other projects' statuses and
    // titles are never computed for them; this allowlist projection is the
    // fail-closed backstop for any response field added later.
    return isRead
      ? { kind: "allow-filtered", filter: "project-queue" }
      : { kind: "deny" };
  }
  const promoteNow = path.match(/^\/api\/project-queue\/([^/]+)\/promote-now$/);
  if (promoteNow && method === "POST") {
    const projectId = decodeSegment(promoteNow[1] as string);
    if (projectId === null) return { kind: "deny" };
    return {
      kind: "project",
      projectId,
      required: "new-session",
      filter: "project-queue",
    };
  }
  // Pausing and resuming dispatch are host-wide, and nothing else under
  // /api/project-queue is listed.

  return { kind: "deny" };
}

/** Whether a grant level satisfies what the route needs. */
export function satisfies(
  level: ProjectAccessLevel,
  required: RequiredAccess,
): boolean {
  switch (required) {
    case "view":
      return level !== "none";
    case "join":
      return level === "join" || level === "new-session";
    case "new-session":
      return level === "new-session";
  }
}

/** Access a limited user has to one project, from their grants. */
export function levelFor(
  grants: LimitedUserGrants,
  projectId: string,
): ProjectAccessLevel {
  return projectAccessLevel(grants, projectId);
}
