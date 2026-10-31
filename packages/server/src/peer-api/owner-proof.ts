import { createHash } from "node:crypto";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AuthService } from "../auth/AuthService.js";
import {
  bearerToken,
  type AgentServerTokens,
} from "../auth/AgentServerTokens.js";
import { SESSION_COOKIE_NAME } from "../auth/routes.js";
import { PRINCIPAL_VARIABLE, type Principal } from "../auth/principal.js";
import {
  DESKTOP_SESSION_COOKIE_NAME,
  type DesktopBootstrapService,
} from "../desktop/DesktopBootstrapService.js";
import { hasValidDesktopToken } from "../middleware/auth.js";
import { getAuthenticatedSrpTransport } from "../middleware/authenticated-transport.js";
import type { RemoteAccessService } from "../remote-access/RemoteAccessService.js";

/** Resolve actual owner proof even when the ordinary UI auth policy is open. */
type OwnerProofOptions = {
  authService: Pick<AuthService, "isSessionActive" | "getSessionUsername">;
  desktopAuthToken?: string;
  desktopBootstrapService?: Pick<DesktopBootstrapService, "validateSession">;
  remoteAccessService?: Pick<RemoteAccessService, "isEnabled" | "getUsername">;
  agentServerTokens?: Pick<AgentServerTokens, "accepts">;
};
export function createPeerOwnerBinding(options: OwnerProofOptions) {
  const bind = (kind: string, value: string) =>
    value
      ? createHash("sha256").update(`${kind}:${value}`).digest("hex")
      : null;
  return (c: Context): string | null => {
    if (
      (c.get(PRINCIPAL_VARIABLE) as Principal | undefined)?.kind !== "superuser"
    )
      return null;
    const token = bearerToken(c.req.header("Authorization"));
    if (token && options.agentServerTokens?.accepts(token)) return null;
    if (
      options.desktopAuthToken &&
      hasValidDesktopToken(c, options.desktopAuthToken)
    )
      return bind("desktop-token", options.desktopAuthToken!);
    if (
      options.desktopBootstrapService?.validateSession(
        getCookie(c, DESKTOP_SESSION_COOKIE_NAME),
      )
    )
      return bind(
        "desktop-session",
        getCookie(c, DESKTOP_SESSION_COOKIE_NAME)!,
      );
    const srp = getAuthenticatedSrpTransport(c.env);
    if (
      srp &&
      srp.isActive?.() === true &&
      options.remoteAccessService?.isEnabled() &&
      srp.username === options.remoteAccessService.getUsername()
    )
      return bind("srp-session", srp.sessionId);
    const session = getCookie(c, SESSION_COOKIE_NAME);
    return session &&
      options.authService.isSessionActive(session) &&
      options.authService.getSessionUsername(session) === null
      ? bind("owner-cookie", session)
      : null;
  };
}

export function createPeerOwnerProof(options: OwnerProofOptions) {
  const binding = createPeerOwnerBinding(options);
  return async (c: Context) => Boolean(await binding(c));
}
