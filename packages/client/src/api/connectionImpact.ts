/**
 * Client half of the connection-impact contract
 * (topics/connection-safe-settings.md). A server with the
 * `connection-safe-settings` capability refuses a change that would cut off
 * this client with 409, `reason: "connection-impact"` and the reasons below;
 * the server half is packages/server/src/network/connection-impact.ts.
 */

export const CONNECTION_IMPACT_CONFIRM_PARAM = "confirmConnectionImpact";
export const CONNECTION_IMPACT_REFUSAL_REASON = "connection-impact";

export type ConnectionImpactReason =
  | { kind: "listener-closed"; listener: string }
  | { kind: "host-not-allowed"; host: string }
  | { kind: "remote-session-ended" }
  | { kind: "remote-access-off" }
  | { kind: "relay-disconnected" };

const KNOWN_KINDS = new Set([
  "listener-closed",
  "host-not-allowed",
  "remote-session-ended",
  "remote-access-off",
  "relay-disconnected",
]);

/** The reasons on a refusal body, keeping only well-formed known kinds. */
export function parseConnectionImpact(
  value: unknown,
): ConnectionImpactReason[] | undefined {
  const reasons = (value as { reasons?: unknown } | null)?.reasons;
  if (!Array.isArray(reasons)) return undefined;
  return reasons.filter(
    (reason): reason is ConnectionImpactReason =>
      !!reason &&
      typeof reason === "object" &&
      KNOWN_KINDS.has((reason as { kind?: unknown }).kind as string),
  );
}

/** Append the confirmation parameter to an API path. */
export function withImpactConfirmation(
  path: string,
  confirmed: boolean | undefined,
): string {
  if (!confirmed) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${CONNECTION_IMPACT_CONFIRM_PARAM}=1`;
}

/** The reasons a request was refused with, when it was a connection impact. */
export function connectionImpactOf(
  error: unknown,
): ConnectionImpactReason[] | null {
  const refusal = error as {
    reason?: unknown;
    connectionImpact?: ConnectionImpactReason[];
  } | null;
  if (refusal?.reason !== CONNECTION_IMPACT_REFUSAL_REASON) return null;
  return refusal.connectionImpact ?? [];
}

/** Thrown when the user keeps their connection instead of confirming. */
export class ConnectionImpactDeclinedError extends Error {
  constructor() {
    super("The change was not applied.");
    this.name = "ConnectionImpactDeclinedError";
  }
}

export function isConnectionImpactDeclined(error: unknown): boolean {
  return error instanceof ConnectionImpactDeclinedError;
}

/**
 * Shared by the requests of one user action, so a save that sends several
 * disconnecting requests asks once.
 */
export interface ConnectionImpactScope {
  confirmed: boolean;
}

export interface ConnectionImpactPrompt {
  /** Ask the user about server-reported reasons; true to proceed. */
  confirmReasons: (
    reasons: ConnectionImpactReason[],
  ) => boolean | Promise<boolean>;
  /**
   * For servers not known to have the capability, which may apply without
   * asking: a generic question before sending, or null when the action is
   * not one that can disconnect. A refusal is still handled either way.
   */
  legacyQuestion: string | null;
  /** Ask `legacyQuestion`; true to proceed. */
  confirmLegacy: (question: string) => boolean | Promise<boolean>;
  serverConfirms: boolean;
}

/**
 * Run a write that the server may refuse as disconnecting this client. On a
 * refusal, ask once and repeat it confirmed; a declined prompt throws
 * `ConnectionImpactDeclinedError` without changing anything.
 */
export async function runConfirmingConnectionImpact<T>(
  send: (confirmed: boolean) => Promise<T>,
  prompt: ConnectionImpactPrompt,
  scope: ConnectionImpactScope = { confirmed: false },
): Promise<T> {
  if (scope.confirmed) return send(true);
  if (!prompt.serverConfirms && prompt.legacyQuestion) {
    if (!(await prompt.confirmLegacy(prompt.legacyQuestion)))
      throw new ConnectionImpactDeclinedError();
    // Already answered: a current server whose capability was not yet known
    // must not ask again, and older servers ignore the parameter.
    scope.confirmed = true;
    return send(true);
  }
  try {
    return await send(false);
  } catch (error) {
    const reasons = connectionImpactOf(error);
    if (!reasons) throw error;
    if (!(await prompt.confirmReasons(reasons)))
      throw new ConnectionImpactDeclinedError();
    scope.confirmed = true;
    return send(true);
  }
}
