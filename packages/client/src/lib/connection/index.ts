export type {
  Connection,
  StreamHandlers,
  Subscription,
  UploadOptions,
} from "./types";
export {
  WebSocketCloseError,
  isNonRetryableError,
  NON_RETRYABLE_CLOSE_CODES,
} from "./types";
export { DirectConnection, directConnection } from "./DirectConnection";
export {
  WebSocketConnection,
  getWebSocketConnection,
} from "./WebSocketConnection";
export { SecureConnection } from "./SecureConnection";

import type { Connection } from "./types";

/**
 * Check if this is the remote client build.
 *
 * The remote client is a statically-built version that MUST use SecureConnection
 * for all API requests. This is determined at build time via VITE_IS_REMOTE_CLIENT.
 *
 * This is different from isRemoteMode() which checks runtime state.
 * isRemoteClient() is a static check based on how the app was built.
 */
export function isRemoteClient(): boolean {
  return import.meta.env.VITE_IS_REMOTE_CLIENT === true;
}

/**
 * Global connection for remote mode.
 *
 * When set, this connection is used for all API calls instead of
 * the default DirectConnection/WebSocketConnection.
 *
 * Set this after successful SRP authentication in remote mode.
 */
let globalConnection: Connection | null = null;

/**
 * Set the global connection (for remote mode).
 */
export function setGlobalConnection(connection: Connection | null): void {
  globalConnection = connection;
}

/**
 * Get the global connection if set.
 */
export function getGlobalConnection(): Connection | null {
  return globalConnection;
}

/**
 * Check if running in remote mode (global connection is set).
 */
export function isRemoteMode(): boolean {
  return globalConnection !== null;
}
