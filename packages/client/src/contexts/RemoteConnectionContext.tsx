/**
 * RemoteConnectionContext - Provides SecureConnection for remote client.
 *
 * This context manages the SecureConnection lifecycle and provides it to
 * the app. Unlike the regular client which uses DirectConnection by default,
 * the remote client ONLY uses SecureConnection.
 *
 * Supports two connection modes:
 * - Direct: Connect via WebSocket URL + SRP auth
 * - Relay: Connect via relay server + relay username + SRP auth
 */

import {
  type RelayClientConnected,
  type RelayClientError,
  isRelayClientConnected,
  isRelayClientError,
} from "@yep-anywhere/shared";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { setGlobalConnection } from "../lib/connection";
import {
  SecureConnection,
  type StoredSession,
} from "../lib/connection/SecureConnection";
import type { Connection } from "../lib/connection/types";

/** Stored credentials for auto-reconnect */
interface StoredCredentials {
  wsUrl: string;
  username: string;
  /** Session data for resumption (only stored if rememberMe was enabled) */
  session?: StoredSession;
  /** Connection mode: "direct" or "relay" */
  mode?: "direct" | "relay";
  /** Relay username (only for relay mode) */
  relayUsername?: string;
}

/** Relay connection status for UI feedback */
export type RelayConnectionStatus =
  | "idle"
  | "connecting_relay"
  | "waiting_server"
  | "authenticating"
  | "error";

/** Options for connecting via relay */
export interface ConnectViaRelayOptions {
  relayUrl: string;
  relayUsername: string;
  srpUsername: string;
  srpPassword: string;
  rememberMe?: boolean;
  onStatusChange?: (status: RelayConnectionStatus) => void;
}

interface RemoteConnectionState {
  /** The active connection (null if not connected) */
  connection: Connection | null;
  /** Whether a connection attempt is in progress */
  isConnecting: boolean;
  /** Whether auto-resume is being attempted (subset of isConnecting) */
  isAutoResuming: boolean;
  /** Error from last connection attempt */
  error: string | null;
  /** Connect to server with credentials (direct mode) */
  connect: (
    wsUrl: string,
    username: string,
    password: string,
    rememberMe?: boolean,
  ) => Promise<void>;
  /** Connect via relay server */
  connectViaRelay: (options: ConnectViaRelayOptions) => Promise<void>;
  /** Disconnect and clear credentials */
  disconnect: () => void;
  /** Stored server URL (for pre-filling form) */
  storedUrl: string | null;
  /** Stored username (for pre-filling form) */
  storedUsername: string | null;
  /** Whether there's a stored session that can be resumed */
  hasStoredSession: boolean;
  /** Try to resume a stored session (requires password for fallback) */
  resumeSession: (password: string) => Promise<void>;
}

const RemoteConnectionContext = createContext<RemoteConnectionState | null>(
  null,
);

const STORAGE_KEY = "yep-anywhere-remote-credentials";

function loadStoredCredentials(): StoredCredentials | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored) as StoredCredentials;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

function saveCredentials(
  wsUrl: string,
  username: string,
  session?: StoredSession,
): void {
  try {
    const creds: StoredCredentials = { wsUrl, username, session };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
  } catch {
    // Ignore storage errors
  }
}

function updateStoredSession(session: StoredSession): void {
  try {
    const stored = loadStoredCredentials();
    if (stored) {
      stored.session = session;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    }
  } catch {
    // Ignore storage errors
  }
}

function clearStoredCredentials(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

interface Props {
  children: ReactNode;
}

export function RemoteConnectionProvider({ children }: Props) {
  const [connection, setConnection] = useState<SecureConnection | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isAutoResuming, setIsAutoResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track if we've attempted auto-resume (to prevent repeated attempts)
  const [autoResumeAttempted, setAutoResumeAttempted] = useState(false);

  // Load stored credentials for form pre-fill
  const stored = loadStoredCredentials();
  const storedRef = useRef(stored);
  storedRef.current = stored;

  // Track whether we want to remember sessions
  const rememberMeRef = useRef(false);

  // Callback for when a new session is established (to store it)
  const handleSessionEstablished = useCallback((session: StoredSession) => {
    if (rememberMeRef.current) {
      console.log("[RemoteConnection] Storing session for resumption");
      updateStoredSession(session);
    }
  }, []);

  const connect = useCallback(
    async (
      wsUrl: string,
      username: string,
      password: string,
      rememberMe = false,
    ) => {
      setIsConnecting(true);
      setError(null);
      rememberMeRef.current = rememberMe;

      try {
        // If rememberMe is true, save credentials BEFORE auth so the onSessionEstablished
        // callback can update them. The callback fires during SRP handshake, before
        // conn.fetch() returns.
        if (rememberMe) {
          saveCredentials(wsUrl, username);
        }

        // Create and authenticate connection
        const conn = new SecureConnection(
          wsUrl,
          username,
          password,
          rememberMe ? handleSessionEstablished : undefined,
        );

        // Test the connection by making a simple request
        // This triggers the SRP handshake and verifies auth
        await conn.fetch("/auth/status");

        // Set global connection BEFORE setConnection to avoid race condition
        // where children render and try to use fetchJSON before globalConnection is set
        setGlobalConnection(conn);
        setConnection(conn);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Connection failed";
        setError(message);
        throw err;
      } finally {
        setIsConnecting(false);
      }
    },
    [handleSessionEstablished],
  );

  const resumeSession = useCallback(
    async (password: string) => {
      const currentStored = storedRef.current;
      if (!currentStored?.session) {
        throw new Error("No stored session to resume");
      }

      setIsConnecting(true);
      setError(null);
      rememberMeRef.current = true; // If resuming, we want to keep remembering

      try {
        // Create connection from stored session
        const conn = SecureConnection.fromStoredSession(
          currentStored.session,
          password,
          handleSessionEstablished,
        );

        // Test the connection - this will try resume, fall back to SRP if needed
        await conn.fetch("/auth/status");

        // Set global connection BEFORE setConnection to avoid race condition
        setGlobalConnection(conn);
        setConnection(conn);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Session resume failed";
        setError(message);
        throw err;
      } finally {
        setIsConnecting(false);
      }
    },
    [handleSessionEstablished],
  );

  const connectViaRelay = useCallback(
    async (options: ConnectViaRelayOptions) => {
      const {
        relayUrl,
        relayUsername,
        srpUsername,
        srpPassword,
        rememberMe = false,
        onStatusChange,
      } = options;

      setIsConnecting(true);
      setError(null);
      rememberMeRef.current = rememberMe;
      onStatusChange?.("connecting_relay");

      try {
        // 1. Connect to relay server
        const ws = new WebSocket(relayUrl);
        ws.binaryType = "arraybuffer";

        // Wait for WebSocket to open
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("Relay connection timeout"));
          }, 15000);

          ws.onopen = () => {
            clearTimeout(timeout);
            resolve();
          };

          ws.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("Failed to connect to relay server"));
          };
        });

        // 2. Send client_connect message
        onStatusChange?.("waiting_server");
        ws.send(
          JSON.stringify({ type: "client_connect", username: relayUsername }),
        );

        // 3. Wait for client_connected or error
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("Waiting for server timed out"));
          }, 30000);

          ws.onmessage = (event) => {
            clearTimeout(timeout);
            try {
              const msg = JSON.parse(event.data as string);
              if (isRelayClientConnected(msg)) {
                // Successfully paired with server
                resolve();
              } else if (isRelayClientError(msg)) {
                ws.close();
                reject(new Error(msg.reason));
              } else {
                // Unexpected message - might be server sending first message
                // This shouldn't happen, but treat as success
                resolve();
              }
            } catch {
              // JSON parse error - unexpected message format
              ws.close();
              reject(new Error("Invalid relay response"));
            }
          };

          ws.onclose = () => {
            clearTimeout(timeout);
            reject(new Error("Relay connection closed"));
          };

          ws.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("Relay connection error"));
          };
        });

        // 4. Now we have a direct pipe to yepanywhere server - do SRP auth
        onStatusChange?.("authenticating");

        // Store credentials if rememberMe
        if (rememberMe) {
          saveCredentials(relayUrl, srpUsername, undefined);
          const stored = loadStoredCredentials();
          if (stored) {
            stored.mode = "relay";
            stored.relayUsername = relayUsername;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
          }
        }

        // Create SecureConnection using the existing WebSocket
        const conn = await SecureConnection.connectWithExistingSocket(
          ws,
          srpUsername,
          srpPassword,
          rememberMe ? handleSessionEstablished : undefined,
        );

        // Test the connection
        await conn.fetch("/auth/status");

        // Set global connection
        setGlobalConnection(conn);
        setConnection(conn);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Connection failed";
        setError(message);
        onStatusChange?.("error");
        throw err;
      } finally {
        setIsConnecting(false);
      }
    },
    [handleSessionEstablished],
  );

  const disconnect = useCallback(() => {
    if (connection) {
      connection.close();
      setGlobalConnection(null);
      setConnection(null);
    }
    clearStoredCredentials();
    setError(null);
  }, [connection]);

  // Auto-resume on mount if we have a stored session
  useEffect(() => {
    const currentStored = storedRef.current;

    // Only attempt once, and only if we have a stored session
    if (autoResumeAttempted || !currentStored?.session) {
      return;
    }

    setAutoResumeAttempted(true);

    // Try to resume the stored session without password
    const storedSession = currentStored.session;
    if (!storedSession) return; // Already checked above, but satisfies TypeScript

    const attemptAutoResume = async () => {
      console.log(
        "[RemoteConnection] Attempting auto-resume from stored session",
      );
      setIsConnecting(true);
      setIsAutoResuming(true);
      setError(null);
      rememberMeRef.current = true;

      try {
        const conn = SecureConnection.forResumeOnly(
          storedSession,
          handleSessionEstablished,
        );

        // Test the connection - this will try resume only
        await conn.fetch("/auth/status");

        console.log("[RemoteConnection] Auto-resume successful");
        // Set global connection BEFORE setConnection to avoid race condition
        setGlobalConnection(conn);
        setConnection(conn);
      } catch (err) {
        console.log(
          "[RemoteConnection] Auto-resume failed, user will need to re-authenticate:",
          err instanceof Error ? err.message : err,
        );
        // Don't set error here - just show the login form
        // The stored credentials will pre-fill the form
      } finally {
        setIsConnecting(false);
        setIsAutoResuming(false);
      }
    };

    void attemptAutoResume();
  }, [autoResumeAttempted, handleSessionEstablished]);

  // Track connection in ref for cleanup (avoids stale closure issues)
  const connectionRef = useRef(connection);
  connectionRef.current = connection;

  // Clean up connection on unmount only (not on connection changes)
  // Using empty deps + ref avoids the cleanup running when connection changes
  useEffect(() => {
    return () => {
      if (connectionRef.current) {
        connectionRef.current.close();
        setGlobalConnection(null);
      }
    };
  }, []);

  const value: RemoteConnectionState = {
    connection,
    isConnecting,
    isAutoResuming,
    error,
    connect,
    connectViaRelay,
    disconnect,
    storedUrl: stored?.wsUrl ?? null,
    storedUsername: stored?.username ?? null,
    hasStoredSession: !!stored?.session,
    resumeSession,
  };

  return (
    <RemoteConnectionContext.Provider value={value}>
      {children}
    </RemoteConnectionContext.Provider>
  );
}

export function useRemoteConnection(): RemoteConnectionState {
  const context = useContext(RemoteConnectionContext);
  if (!context) {
    throw new Error(
      "useRemoteConnection must be used within RemoteConnectionProvider",
    );
  }
  return context;
}

/**
 * Hook to get the connection, throwing if not connected.
 * Use this in components that require an active connection.
 */
export function useRequiredConnection(): Connection {
  const { connection } = useRemoteConnection();
  if (!connection) {
    throw new Error("No active connection");
  }
  return connection;
}
