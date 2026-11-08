import {
  AUTHENTICATED_DIRECT_LOGIN,
  AUTHENTICATED_SRP_TRANSPORT,
  type AuthenticatedSrpTransportContext,
} from "../middleware/authenticated-transport.js";
import { WS_INTERNAL_AUTHENTICATED } from "../middleware/internal-auth.js";
import {
  REQUEST_CONNECTION_PATH,
  wsConnectionPath,
} from "../network/connection-path.js";
import {
  isTrustedWithoutSrpTransport,
  shouldMarkInternalWsAuthenticated,
  type WsTransportAuthState,
} from "./ws-transport-auth.js";

type TunnelConnection = Pick<
  WsTransportAuthState,
  "connectionPolicy" | "authState" | "sessionKey"
> & {
  transport: "direct" | "relay";
  directLoginUsername: string | null;
};

/**
 * The private environment of a request tunneled over an authenticated
 * application WebSocket. It marks the request as already authenticated, names
 * the SRP login or bound direct login acting, and records how the WebSocket
 * reached the server. A tunneled request has no socket of its own, so the
 * connection path is what lets a settings change recognise its own caller.
 */
export function internalWsRequestEnv(
  connState: TunnelConnection,
  srpTransport: AuthenticatedSrpTransportContext | null,
): Record<symbol, unknown> {
  if (!shouldMarkInternalWsAuthenticated(connState)) return {};
  return {
    [WS_INTERNAL_AUTHENTICATED]: true,
    [REQUEST_CONNECTION_PATH]: wsConnectionPath(connState),
    ...(srpTransport ? { [AUTHENTICATED_SRP_TRANSPORT]: srpTransport } : {}),
    ...(!srpTransport && isTrustedWithoutSrpTransport(connState)
      ? {
          [AUTHENTICATED_DIRECT_LOGIN]: {
            kind: "direct-login" as const,
            username: connState.directLoginUsername,
          },
        }
      : {}),
  };
}
