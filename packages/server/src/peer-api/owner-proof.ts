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
export function createPeerOwnerProof(options: {
  authService: Pick<AuthService, "validateSession" | "getSessionUsername">;
  desktopAuthToken?: string;
  desktopBootstrapService?: Pick<DesktopBootstrapService, "validateSession">;
  remoteAccessService?: Pick<RemoteAccessService, "isEnabled" | "getUsername">;
  agentServerTokens?: Pick<AgentServerTokens, "accepts">;
}) {
  return async (c: Context): Promise<boolean> => {
    if (
      (c.get(PRINCIPAL_VARIABLE) as Principal | undefined)?.kind !== "superuser"
    )
      return false;
    const token = bearerToken(c.req.header("Authorization"));
    if (token && options.agentServerTokens?.accepts(token)) return false;
    if (
      options.desktopAuthToken &&
      hasValidDesktopToken(c, options.desktopAuthToken)
    )
      return true;
    if (
      options.desktopBootstrapService?.validateSession(
        getCookie(c, DESKTOP_SESSION_COOKIE_NAME),
      )
    )
      return true;
    const srp = getAuthenticatedSrpTransport(c.env);
    if (
      srp &&
      options.remoteAccessService?.isEnabled() &&
      srp.username === options.remoteAccessService.getUsername()
    )
      return true;
    const session = getCookie(c, SESSION_COOKIE_NAME);
    return Boolean(
      session &&
        (await options.authService.validateSession(session)) &&
        options.authService.getSessionUsername(session) === null,
    );
  };
}
