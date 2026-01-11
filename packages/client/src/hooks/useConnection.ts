import {
  type Connection,
  directConnection,
  getGlobalConnection,
  getWebSocketConnection,
} from "../lib/connection";
import { useDeveloperMode } from "./useDeveloperMode";

/**
 * Hook that provides the current connection to the server.
 *
 * Priority order:
 * 1. Global connection (SecureConnection in remote mode)
 * 2. WebSocketConnection (if developer setting enabled)
 * 3. DirectConnection (default)
 *
 * @returns The active Connection instance
 */
export function useConnection(): Connection {
  const { websocketTransportEnabled } = useDeveloperMode();

  // Check for global connection first (remote mode with SecureConnection)
  const globalConn = getGlobalConnection();
  if (globalConn) {
    return globalConn;
  }

  // Check developer setting for WebSocket transport
  if (websocketTransportEnabled) {
    return getWebSocketConnection();
  }

  // Default: use direct connection (fetch + SSE)
  return directConnection;
}
