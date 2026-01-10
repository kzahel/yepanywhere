import { type Connection, directConnection } from "../lib/connection";

/**
 * Hook that provides the current connection to the server.
 *
 * Currently returns DirectConnection for all cases.
 * When relay support is added, this will use context to
 * select between DirectConnection and SecureConnection.
 *
 * @returns The active Connection instance
 */
export function useConnection(): Connection {
  // For Phase 2a, always return direct connection
  // Phase 3+ will add context-based selection for SecureConnection
  return directConnection;
}
