/**
 * Connected browsers and the browser profiles the server remembers for them.
 */

// =============================================================================
// Connected Browser Types
// =============================================================================

/**
 * Information about a connected browser profile.
 */
export interface ConnectionInfo {
  /** Unique identifier for the browser profile */
  browserProfileId: string;
  /** Number of active tabs/connections from this browser profile */
  connectionCount: number;
  /** ISO timestamp of the first connection from this browser profile */
  connectedAt: string;
  /** Optional friendly name for the device (from push subscription) */
  deviceName?: string;
}

/**
 * Response from GET /api/connections endpoint.
 */
export interface ConnectionsResponse {
  connections: ConnectionInfo[];
}

// =============================================================================
// Browser Profile Origin Tracking
// =============================================================================

/**
 * Origin information for a browser profile connection.
 * Tracks where a browser profile has connected from.
 */
export interface BrowserProfileOrigin {
  /** Full origin string (e.g., "https://localhost:3400") */
  origin: string;
  /** URL scheme (e.g., "https", "http") */
  scheme: string;
  /** Hostname without port (e.g., "localhost", "phone.tailnet") */
  hostname: string;
  /** Port number, or null if default port */
  port: number | null;
  /** User agent string for browser identification */
  userAgent: string;
  /** ISO timestamp of first connection from this origin */
  firstSeen: string;
  /** ISO timestamp of most recent connection from this origin */
  lastSeen: string;
}

/**
 * Browser profile information with origin tracking.
 * Persisted server-side to track device connections.
 */
export interface BrowserProfileInfo {
  /** Unique browser profile identifier */
  browserProfileId: string;
  /** All origins this profile has connected from */
  origins: BrowserProfileOrigin[];
  /** ISO timestamp when this profile was first seen */
  createdAt: string;
  /** ISO timestamp of most recent activity */
  lastActiveAt: string;
  /** Optional friendly name (from push subscription) */
  deviceName?: string;
}

/**
 * Response from GET /api/browser-profiles endpoint.
 */
export interface BrowserProfilesResponse {
  profiles: BrowserProfileInfo[];
}
