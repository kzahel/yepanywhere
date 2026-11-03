import { levelFor } from "./limitedUserPolicy.js";
/**
 * Launch policy every process a limited user starts must obey.
 *
 * Contract: topics/limited-users.md § Delivery v1 and § Execution boundary.
 *
 * This is the one owner of what a limited user may launch, applied at every
 * route that starts or resumes a provider process on their behalf and at
 * Project Queue dispatch. Routes that would launch without it are refused by
 * the route policy (auth/limitedUserPolicy.ts) rather than left open.
 *
 * - The session runs sandboxed, network firewall included. A new session is
 *   forced to `project-write` with the firewall on, and a request that
 *   explicitly turns the firewall off is refused; an existing session must
 *   already run that way, since its boundary was settled when it was created
 *   and a limited user may not drive an unsandboxed process.
 * - It runs on this host: a remote executor and computer control are outside
 *   any sandbox, so either one is refused.
 * - A locked provider, model, or effort is applied. A request naming a value
 *   that conflicts with the lock is refused rather than quietly overridden,
 *   so a stale client cannot believe it launched what it asked for.
 */

import type { Context } from "hono";
import {
  type LimitedUserGrants,
  type LimitedUserLock,
  lockedThinkingOption,
  type ProjectQueueMessage,
  type ProjectQueueTarget,
  type ThinkingOption,
  thinkingOptionEffort,
  thinkingOptionToConfig,
} from "@yep-anywhere/shared";
import { type Principal, PRINCIPAL_VARIABLE } from "./principal.js";
import type { ModelSettings } from "../supervisor/Supervisor.js";

export interface LimitedLaunchBody {
  provider?: string;
  model?: string;
  thinking?: string;
  sandboxLevel?: string;
  sandboxNetworkFirewall?: boolean;
  executor?: string;
  computerControl?: boolean;
  routerAccountId?: string;
  routerPoolId?: string;
  routerPolicy?: string;
}

/** What a request asked for, as distinct from what the launch will use. */
export interface LimitedLaunchRequest {
  provider?: string;
  model?: string;
  thinking?: string;
}

export type LimitedLaunchOutcome =
  | { kind: "superuser" }
  | { kind: "applied"; username: string }
  | { kind: "error"; error: string };

/** The acting principal, defaulting to the superuser when unresolved. */
export function principalFor(c: Context): Principal {
  return (
    (c.get(PRINCIPAL_VARIABLE) as Principal | undefined) ?? {
      kind: "superuser",
    }
  );
}

/**
 * The acting limited username, or undefined for the superuser. This is the
 * attribution every usage record and user turn carries: absent means the
 * superuser, which is also what records predating limited users mean.
 */
export function actingUsername(c: Context): string | undefined {
  const principal = principalFor(c);
  return principal.kind === "limited" ? principal.username : undefined;
}

/** Refusal for launch options that leave the host's sandbox. */
function hostEscapeError(options: {
  executor?: string;
  computerControl?: boolean;
  routerAccountId?: string;
  routerPoolId?: string;
  routerPolicy?: string;
}): string | null {
  if (
    options.routerAccountId !== undefined ||
    options.routerPoolId !== undefined ||
    options.routerPolicy !== undefined
  )
    return "Router account and pool selection requires the server owner";
  if (options.executor) {
    return "This user's sessions run only on this host, not on a remote executor";
  }
  if (options.computerControl) {
    return "This user's sessions cannot use computer control";
  }
  return null;
}

/**
 * Refusal for a request that names a value the lock forbids. A blank or
 * "default" model names nothing and takes the locked one.
 */
function lockConflictError(
  lock: LimitedUserLock,
  requested: LimitedLaunchRequest,
): string | null {
  for (const field of ["provider", "model"] as const) {
    const locked = lock[field];
    const value = requested[field];
    if (
      locked &&
      typeof value === "string" &&
      value.length > 0 &&
      value !== "default" &&
      value !== locked
    ) {
      return `This user is limited to ${field} "${locked}"`;
    }
  }
  // The lock names a bare effort; the request names a thinking option. Compare
  // like with like, so "on:high" against a "high" lock is agreement, not a
  // conflict, and a request that names no effort at all ("off", "auto") takes
  // the locked one rather than escaping the budget the superuser set.
  if (lock.effort && typeof requested.thinking === "string") {
    const requestedEffort = thinkingOptionEffort(requested.thinking);
    if (requestedEffort !== null && requestedEffort !== lock.effort) {
      return `This user is limited to effort "${lock.effort}"`;
    }
  }
  return null;
}

/**
 * The network firewall is part of the sandbox a limited user may not clear
 * (topics/session-sandbox-network-boundary.md). An explicit opt-out is refused
 * rather than overridden, like a lock conflict, so a client that asked for it
 * learns it did not get it.
 */
const FIREWALL_OPT_OUT_ERROR =
  "This user's sessions always run with the sandbox network firewall on";

/**
 * Apply the launch policy to a new session's request body in place: the
 * session-create routes, a Project Queue new-session target, and a template
 * creation's preparation session.
 */
export function limitNewSessionLaunch(
  grants: LimitedUserGrants,
  body: LimitedLaunchBody,
): { error: string } | null {
  const hostEscape = hostEscapeError(body);
  if (hostEscape) return { error: hostEscape };
  const conflict = lockConflictError(grants.lock, body);
  if (conflict) return { error: conflict };
  if (body.sandboxNetworkFirewall === false) {
    return { error: FIREWALL_OPT_OUT_ERROR };
  }

  // Sandbox is not the user's to clear.
  body.sandboxLevel = "project-write";
  body.sandboxNetworkFirewall = true;
  const { lock } = grants;
  if (lock.provider) body.provider = lock.provider;
  if (lock.model) body.model = lock.model;
  if (lock.effort) body.thinking = lockedThinkingOption(lock.effort);
  return null;
}

/**
 * Apply the launch policy in place to the settings an existing session's
 * process will resume with. `requested` is what the request itself named,
 * which alone can conflict with the lock; a session's persisted model is not
 * the user's request and is simply replaced by the locked one.
 */
export function limitExistingSessionLaunch(
  grants: LimitedUserGrants,
  settings: ModelSettings,
  requested: LimitedLaunchRequest,
): { error: string } | null {
  if (settings.sandboxLevel !== "project-write") {
    return {
      error:
        "This session runs outside the sandbox, so this user cannot start it; start a new session instead",
    };
  }
  // Absent means on, as at every other launch (Supervisor, the resume route).
  if (settings.sandboxNetworkFirewall === false) {
    return {
      error:
        "This session runs without the sandbox network firewall, so this user cannot start it; start a new session instead",
    };
  }
  const hostEscape = hostEscapeError(settings);
  if (hostEscape) return { error: hostEscape };
  const conflict = lockConflictError(grants.lock, requested);
  if (conflict) return { error: conflict };

  const { lock } = grants;
  if (lock.provider && settings.providerName !== lock.provider) {
    return {
      error: `This session uses a provider other than "${lock.provider}", which this user is limited to`,
    };
  }
  if (lock.model) {
    settings.model = lock.model;
    settings.requestedModel = lock.model;
  }
  if (lock.effort) {
    const { thinking, effort } = thinkingOptionToConfig(
      lockedThinkingOption(lock.effort) as ThinkingOption,
    );
    settings.thinking = thinking;
    settings.effort = effort;
  }
  return null;
}

/**
 * Apply the launch policy in place to a Project Queue item a limited user
 * queues, and again at dispatch from their grants at that time. A new-session
 * target is held to the new-session rule. An existing-session target may not
 * name a remote executor or a value outside the lock; whether that session
 * runs sandboxed is a fact of the session, checked by
 * `limitExistingSessionLaunch` at dispatch. A queued YA command (a rewind or
 * clear) is refused, like the session routes that perform them.
 */
export function limitQueuedLaunch(
  grants: LimitedUserGrants,
  item: { target: ProjectQueueTarget; message: ProjectQueueMessage },
): { error: string } | null {
  if (item.message.yaCommand) {
    return { error: "This user cannot queue YA commands" };
  }
  const { target } = item;
  if (target.type === "new-session") {
    return limitNewSessionLaunch(grants, target);
  }
  const hostEscape = hostEscapeError(target);
  if (hostEscape) return { error: hostEscape };
  const conflict = lockConflictError(grants.lock, target);
  return conflict ? { error: conflict } : null;
}

/**
 * Apply the limited user's launch policy to a session-create body in place.
 * Returns what happened so the caller can record session ownership.
 */
export function applyLimitedLaunchPolicy(
  c: Context,
  body: LimitedLaunchBody,
): LimitedLaunchOutcome {
  const principal = principalFor(c);
  if (principal.kind !== "limited") return { kind: "superuser" };
  const refused = limitNewSessionLaunch(principal.grants, body);
  if (refused) return { kind: "error", error: refused.error };
  return { kind: "applied", username: principal.username };
}

/**
 * Apply the limited user's launch policy to an existing session's resume
 * settings in place.
 */
export function applyLimitedResumePolicy(
  c: Context,
  settings: ModelSettings,
  requested: LimitedLaunchRequest,
): LimitedLaunchOutcome {
  const principal = principalFor(c);
  if (principal.kind !== "limited") return { kind: "superuser" };
  const refused = limitExistingSessionLaunch(
    principal.grants,
    settings,
    requested,
  );
  if (refused) return { kind: "error", error: refused.error };
  return { kind: "applied", username: principal.username };
}

/** Recheck frozen admitted choices; a changed lock cannot rewrite saved intent. */
export function savedLimitedCreationError(
  saved: import("../sessions/SessionCreationStore.js").SavedSessionCreation,
  grants: LimitedUserGrants | null,
): string | null {
  const request = saved.request,
    launch = request?.launch;
  if (
    !grants ||
    !request ||
    !launch ||
    levelFor(grants, request.projectId) !== "new-session"
  )
    return "The admitted user can no longer create sessions in this project";
  const hostEscape = hostEscapeError({
    ...launch,
    computerControl: launch.machineControl,
  });
  if (hostEscape) return hostEscape;
  if (
    launch.sandboxLevel !== "project-write" ||
    launch.sandboxNetworkFirewall !== true
  )
    return "Admitted limited-user work requires its project sandbox and network firewall";
  const { lock } = grants;
  if (
    (lock.provider && lock.provider !== request.provider) ||
    (lock.model &&
      lock.model !== (request.settings.requestedModel ?? launch.model)) ||
    (lock.effort && lock.effort !== request.settings.effort)
  )
    return "The user's launch lock changed; saved intent cannot be rewritten";
  return null;
}
