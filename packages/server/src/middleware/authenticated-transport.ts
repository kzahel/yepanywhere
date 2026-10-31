import type {
  SecurityClientAuthenticationMethod,
  SecurityClientTransport,
} from "@yep-anywhere/shared";

export interface AuthenticatedSrpTransportContext {
  kind: "srp";
  username: string;
  sessionId: string;
  transportNonce: string;
  authenticationMethod: Extract<
    SecurityClientAuthenticationMethod,
    "srp-full" | "srp-resume"
  >;
  transport: Extract<SecurityClientTransport, "direct" | "relay">;
  connectionId: string;
  /** Live server-owned state; absent cannot authorize queued owner enrollment. */
  isActive?: () => boolean;
  peerAddress?: string;
  closeConnection: () => void;
  closeAfterResponse: () => void;
  deferAfterResponse: (task: () => Promise<void> | void) => void;
}

/**
 * Private request environment populated only for an established SRP tunnel.
 * External headers and trusted-local/cookie sockets cannot manufacture it.
 */
export const AUTHENTICATED_SRP_TRANSPORT = Symbol(
  "authenticated-srp-transport",
);

export function getAuthenticatedSrpTransport(
  env: unknown,
): AuthenticatedSrpTransportContext | null {
  if (!env || typeof env !== "object") return null;
  const context = (
    env as { [AUTHENTICATED_SRP_TRANSPORT]?: AuthenticatedSrpTransportContext }
  )[AUTHENTICATED_SRP_TRANSPORT];
  return context?.kind === "srp" ? context : null;
}

/** The direct login a trusted-local websocket bound when it was upgraded. */
export interface AuthenticatedDirectLoginContext {
  kind: "direct-login";
  /** Limited username on the upgrade's cookie session; null for the superuser. */
  username: string | null;
}

/**
 * Private request environment carrying a trusted-local websocket's direct
 * login into its tunneled requests. The socket's own login decides who acts,
 * never a cookie the client chose to put in a tunneled request's headers.
 */
export const AUTHENTICATED_DIRECT_LOGIN = Symbol("authenticated-direct-login");

export function getAuthenticatedDirectLogin(
  env: unknown,
): AuthenticatedDirectLoginContext | null {
  if (!env || typeof env !== "object") return null;
  const context = (
    env as {
      [AUTHENTICATED_DIRECT_LOGIN]?: AuthenticatedDirectLoginContext;
    }
  )[AUTHENTICATED_DIRECT_LOGIN];
  return context?.kind === "direct-login" ? context : null;
}
