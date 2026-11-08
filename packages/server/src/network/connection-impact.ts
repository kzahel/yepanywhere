/**
 * Refuse a settings write that would cut off the client making it until that
 * client repeats it with explicit confirmation. Only the caller's own path is
 * judged: other clients are never asked about. Contract and reason kinds:
 * topics/connection-safe-settings.md; the client parses the same wire shape
 * in packages/client/src/api/connectionImpact.ts.
 */
import type { Context } from "hono";
import { getAuthenticatedSrpTransport } from "../middleware/authenticated-transport.js";
import type { RequestConnectionPath } from "./connection-path.js";
import {
  formatListenerAddress,
  type ListenerAddress,
  type ListenerPlan,
  listenerServes,
  plannedListeners,
} from "./listeners.js";

export const CONNECTION_IMPACT_CONFIRM_PARAM = "confirmConnectionImpact";
export const CONNECTION_IMPACT_REFUSAL_REASON = "connection-impact";

export type ConnectionImpactReason =
  | { kind: "listener-closed"; listener: string }
  | { kind: "host-not-allowed"; host: string }
  | { kind: "remote-session-ended" }
  | { kind: "remote-access-off" }
  | { kind: "relay-disconnected" };

function callerAddress(path: RequestConnectionPath): ListenerAddress | null {
  if (path.kind !== "listener") return null;
  const lower = path.localAddress.toLowerCase();
  const host =
    lower.startsWith("::ffff:") && lower.includes(".")
      ? lower.slice("::ffff:".length)
      : lower;
  return { host, port: path.localPort };
}

/**
 * Whether a listener change leaves the caller with nothing to reconnect to:
 * a socket serves its address now and none would afterward. A replaced socket
 * that a new one still serves only interrupts the connection.
 */
export function listenerChangeImpact(
  path: RequestConnectionPath,
  active: ListenerAddress[],
  next: ListenerPlan,
): ConnectionImpactReason[] {
  const local = callerAddress(path);
  if (!local) return [];
  if (!active.some((listener) => listenerServes(listener, local))) return [];
  if (
    plannedListeners(next).some((listener) => listenerServes(listener, local))
  )
    return [];
  return [{ kind: "listener-closed", listener: formatListenerAddress(local) }];
}

/** The port a plan serves the caller's own address on, when one does. */
export function plannedPortForCaller(
  path: RequestConnectionPath,
  next: ListenerPlan,
): number | null {
  const local = callerAddress(path);
  if (!local) return null;
  const serving = plannedListeners(next).find((listener) =>
    listenerServes(listener, { host: local.host, port: listener.port }),
  );
  return serving?.port ?? null;
}

function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith("[")) {
    const close = hostHeader.indexOf("]");
    return close === -1 ? hostHeader : hostHeader.slice(1, close);
  }
  return hostHeader.replace(/:\d+$/, "");
}

export interface AllowedHostsCheck {
  host: (host: string) => boolean;
  origin: (origin: string) => boolean;
}

/**
 * Whether an allowed-hosts change would refuse the caller's own Host, or the
 * Origin its page was served from (CORS uses the same list).
 */
export function allowedHostsChangeImpact(
  path: RequestConnectionPath,
  origin: string | undefined,
  now: AllowedHostsCheck,
  after: AllowedHostsCheck,
): ConnectionImpactReason[] {
  if (path.kind !== "listener") return [];
  const refused = new Set<string>();
  if (path.host && now.host(path.host) && !after.host(path.host))
    refused.add(hostnameOf(path.host));
  if (
    origin &&
    origin !== "null" &&
    now.origin(origin) &&
    !after.origin(origin)
  )
    try {
      refused.add(new URL(origin).hostname);
    } catch {
      // An unparseable Origin is refused either way.
    }
  return [...refused].map((host) => ({ kind: "host-not-allowed", host }));
}

export interface RemoteAccessChange {
  /** Every Remote Access login of this SRP identity ends. */
  endsLoginsOf?: string | null;
  /** This one Remote Access login ends. */
  endsLogin?: string;
  /** New SRP logins are refused. */
  refusesLogins?: boolean;
  /** The server's relay connection is dropped or replaced. */
  dropsRelay?: boolean;
}

/** What a Remote Access change does to a caller connected over SRP. */
export function remoteAccessChangeImpact(
  c: Context,
  change: RemoteAccessChange,
): ConnectionImpactReason[] {
  const srp = getAuthenticatedSrpTransport(c.env);
  if (!srp) return [];
  const reasons: ConnectionImpactReason[] = [];
  if (
    (change.endsLoginsOf && change.endsLoginsOf === srp.username) ||
    (change.endsLogin && change.endsLogin === srp.sessionId)
  )
    reasons.push({ kind: "remote-session-ended" });
  if (change.refusesLogins) reasons.push({ kind: "remote-access-off" });
  if (change.dropsRelay && srp.transport === "relay")
    reasons.push({ kind: "relay-disconnected" });
  return reasons;
}

function describeReason(reason: ConnectionImpactReason): string {
  switch (reason.kind) {
    case "listener-closed":
      return `it is connected through ${reason.listener}, which would stop listening`;
    case "host-not-allowed":
      return `${reason.host} would no longer be an allowed host`;
    case "remote-session-ended":
      return "its Remote Access login would end";
    case "remote-access-off":
      return "Remote Access would stop accepting logins";
    case "relay-disconnected":
      return "its relay connection would be dropped";
  }
}

/** Readable on its own, for clients that predate the structured reasons. */
export function describeConnectionImpact(
  reasons: ConnectionImpactReason[],
): string {
  return `This change would disconnect this device: ${reasons
    .map(describeReason)
    .join(
      "; ",
    )}. Apply it from a current Yep Anywhere client, which asks for confirmation.`;
}

export function isConnectionImpactConfirmed(c: Context): boolean {
  return c.req.query(CONNECTION_IMPACT_CONFIRM_PARAM) === "1";
}

/** The 409 refusal for an unconfirmed disconnecting change, else null. */
export function refuseUnconfirmedImpact(
  c: Context,
  reasons: ConnectionImpactReason[],
): Response | null {
  if (reasons.length === 0 || isConnectionImpactConfirmed(c)) return null;
  return c.json(
    {
      success: false,
      error: describeConnectionImpact(reasons),
      reason: CONNECTION_IMPACT_REFUSAL_REASON,
      connectionImpact: { reasons },
    },
    409,
  );
}
