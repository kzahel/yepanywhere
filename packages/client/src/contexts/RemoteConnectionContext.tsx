/**
 * RemoteConnectionContext - Provides SecureConnection for remote client.
 *
 * This context manages the SecureConnection lifecycle and provides it to
 * the app. Unlike the regular client, which uses a localhost source transport
 * by default, the remote client ONLY uses SecureConnection.
 *
 * Supports two connection modes:
 * - Direct: Connect via WebSocket URL + SRP auth
 * - Relay: Connect via relay server + relay username + SRP auth
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  REMOTE_NONE_CLIENT_SUMMARY_SOURCE_KEY,
  type ClientSummarySourceKey,
} from "../lib/clientSummaryStore";
import {
  SecureConnection,
  type StoredSession,
} from "../lib/connection/SecureConnection";
import { openRelayClientSocket } from "../lib/connection/RelayClientSocket";
import type { Connection } from "../lib/connection/types";
import { SecureSourceTransport } from "../lib/transport";
import {
  clearRelayHostSession,
  getHostByDirectWsUrl,
  getHostById,
  getHostByRelayUsername,
  updateHostSession,
  upsertRelayHost,
} from "../lib/hostStorage";
import {
  resolveSourceKeyForDirectUrl,
  resolveSourceKeyForSavedHost,
} from "../lib/sourceIdentity";
import { getSourceRuntimeRegistry } from "../lib/sourceRuntime";
import { consumeSwitchHostReload } from "../lib/switchHostReload";

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

/** Categorized auto-resume failure reason */
export type AutoResumeErrorReason =
  | "server_offline" // Server not connected to relay
  | "unknown_username" // No server with that username on relay
  | "relay_timeout" // Timeout waiting for relay or server
  | "relay_unreachable" // Can't connect to relay server
  | "direct_unreachable" // Can't reach server via direct WebSocket
  | "resume_incompatible" // Server is too old for two-phase session resume
  | "auth_failed" // Session expired or auth error
  | "other"; // Unexpected error

/** Structured error from auto-resume failure */
export interface AutoResumeError {
  reason: AutoResumeErrorReason;
  mode: "relay" | "direct";
  /** Relay username (relay mode only) */
  relayUsername?: string;
  /** Server URL (direct mode) or relay URL (relay mode) */
  serverUrl?: string;
  /** Original error message */
  message: string;
}

/** Options for connecting via relay */
export interface ConnectViaRelayOptions {
  relayUrl: string;
  relayUsername: string;
  srpUsername: string;
  srpPassword: string;
  rememberMe?: boolean;
  onStatusChange?: (status: RelayConnectionStatus) => void;
  /** Optional session for resumption (if provided, srpPassword is ignored) */
  session?: StoredSession;
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
  /** Structured error from auto-resume failure (for showing modal) */
  autoResumeError: AutoResumeError | null;
  /** Current host ID from hostStorage (for multi-host tracking) */
  currentHostId: string | null;
  /** Relay username of the active connection, including unsaved hosts */
  currentRelayUsername: string | null;
  /** Live relay URL, including connections that are not remembered. */
  currentRelayUrl: string | null;
  /** Direct WebSocket URL for direct connections without a saved host */
  currentDirectUrl: string | null;
  /** Set the current host ID (called by RelayConnectionGate after connect) */
  setCurrentHostId: (hostId: string | null) => void;
  /** Whether user intentionally disconnected (prevents auto-redirect) */
  isIntentionalDisconnect: boolean;
  /** Connect to server with credentials (direct mode) */
  connect: (
    wsUrl: string,
    username: string,
    password: string,
    rememberMe?: boolean,
  ) => Promise<void>;
  /** Connect via relay server */
  connectViaRelay: (options: ConnectViaRelayOptions) => Promise<void>;
  /** Disconnect and clear credentials. Set isIntentional=false for programmatic host switches. */
  disconnect: (isIntentional?: boolean) => void;
  /** Clear auto-resume error (e.g., user chose to go to login) */
  clearAutoResumeError: () => void;
  /** Retry auto-resume after failure */
  retryAutoResume: () => void;
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

function clearStoredSession(): void {
  try {
    const stored = loadStoredCredentials();
    if (stored?.session) {
      delete stored.session;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    }
  } catch {
    // Ignore storage errors
  }
}

function clearStaleResumeSession(stored: StoredCredentials | null): void {
  clearStoredSession();
  if (stored?.mode === "relay" && stored.relayUsername) {
    clearRelayHostSession(stored.relayUsername);
  }
}

function clearStoredCredentials(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

/** Categorize an error message into a structured AutoResumeErrorReason */
function categorizeError(message: string): AutoResumeErrorReason {
  const lowerMessage = message.toLowerCase();

  if (
    lowerMessage.includes("resume_incompatible") ||
    lowerMessage.includes("session resume unsupported")
  ) {
    return "resume_incompatible";
  }

  // Relay-specific errors
  if (lowerMessage.includes("server_offline")) {
    return "server_offline";
  }
  if (lowerMessage.includes("unknown_username")) {
    return "unknown_username";
  }
  if (
    lowerMessage.includes("waiting for server timed out") ||
    lowerMessage.includes("relay connection timeout")
  ) {
    return "relay_timeout";
  }
  if (
    lowerMessage.includes("failed to connect to relay") ||
    lowerMessage.includes("relay connection closed") ||
    lowerMessage.includes("relay connection error")
  ) {
    return "relay_unreachable";
  }

  // Direct connection errors
  if (
    lowerMessage.includes("websocket") ||
    lowerMessage.includes("econnrefused") ||
    lowerMessage.includes("connection refused") ||
    lowerMessage.includes("failed to connect") ||
    lowerMessage.includes("connection failed") ||
    lowerMessage.includes("network error")
  ) {
    return "direct_unreachable";
  }

  // Auth errors
  if (
    lowerMessage.includes("authentication") ||
    lowerMessage.includes("session") ||
    lowerMessage.includes("invalid_identity") ||
    lowerMessage.includes("unauthorized")
  ) {
    return "auth_failed";
  }

  return "other";
}

interface Props {
  children: ReactNode;
}

class ConnectionAttemptSupersededError extends Error {
  constructor() {
    super("Connection attempt superseded");
    this.name = "ConnectionAttemptSupersededError";
  }
}

function resolveRemoteConnectionSourceKey(options: {
  hostId: string | null;
  directUrl: string | null;
}): ClientSummarySourceKey {
  const host = options.hostId ? getHostById(options.hostId) : undefined;
  if (host) return resolveSourceKeyForSavedHost(host);
  if (options.directUrl) return resolveSourceKeyForDirectUrl(options.directUrl);
  return REMOTE_NONE_CLIENT_SUMMARY_SOURCE_KEY;
}

function getSecureSourceTransport(
  sourceKey: ClientSummarySourceKey,
): SecureSourceTransport {
  const transport = getSourceRuntimeRegistry().registerSourceTransport(
    sourceKey,
    { kind: "secure" },
  );
  if (transport instanceof SecureSourceTransport) return transport;
  throw new Error(
    "Remote source transport registration did not create secure transport",
  );
}

export function RemoteConnectionProvider({ children }: Props) {
  // Load stored credentials synchronously to determine initial state
  const initialStored = loadStoredCredentials();
  const [switchHostReload] = useState(() => consumeSwitchHostReload());

  const [connection, setConnection] = useState<SecureConnection | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  // Initialize isAutoResuming to true if we have a stored session to resume
  // This prevents a flash of the login form before auto-resume starts
  const [isAutoResuming, setIsAutoResuming] = useState(
    () => !switchHostReload && !!initialStored?.session,
  );
  const [error, setError] = useState<string | null>(null);
  const [autoResumeError, setAutoResumeError] =
    useState<AutoResumeError | null>(null);
  // Track current host ID for multi-host support
  const [currentHostId, setCurrentHostIdState] = useState<string | null>(null);
  // Keep the live relay identity separate because "Remember me" may leave the
  // active connection without a persisted SavedHost record.
  const [currentRelayUsername, setCurrentRelayUsername] = useState<
    string | null
  >(() =>
    initialStored?.mode === "relay"
      ? (initialStored.relayUsername ?? null)
      : null,
  );
  const [currentRelayUrl, setCurrentRelayUrl] = useState<string | null>(() =>
    initialStored?.mode === "relay" ? initialStored.wsUrl : null,
  );
  const [currentDirectUrl, setCurrentDirectUrlState] = useState<string | null>(
    null,
  );
  // Keep currentHostId in a ref so handleSessionEstablished always has latest value
  const currentHostIdRef = useRef<string | null>(null);
  const setCurrentHostId = useCallback((hostId: string | null) => {
    currentHostIdRef.current = hostId;
    setCurrentHostIdState(hostId);
  }, []);
  const currentDirectUrlRef = useRef<string | null>(null);
  const setCurrentDirectUrl = useCallback((url: string | null) => {
    currentDirectUrlRef.current = url;
    setCurrentDirectUrlState(url);
  }, []);
  // Track if we've attempted auto-resume (to prevent repeated attempts)
  const [autoResumeAttempted, setAutoResumeAttempted] = useState(
    () => switchHostReload,
  );
  // Track intentional disconnect (to prevent auto-redirect back to host after Switch Host)
  const [isIntentionalDisconnect, setIsIntentionalDisconnect] =
    useState(switchHostReload);
  const activeSecureTransportRef = useRef<SecureSourceTransport | null>(null);
  const activeTransportStatusUnsubscribeRef = useRef<(() => void) | null>(null);
  const connectionRef = useRef<SecureConnection | null>(connection);
  connectionRef.current = connection;
  const connectionAttemptRef = useRef(0);
  const beginConnectionAttempt = useCallback(() => {
    connectionAttemptRef.current += 1;
    return connectionAttemptRef.current;
  }, []);
  const isCurrentConnectionAttempt = useCallback(
    (attempt: number) => connectionAttemptRef.current === attempt,
    [],
  );

  // Keep stored credentials in ref for updates during the component lifecycle
  const storedRef = useRef(initialStored);
  storedRef.current = loadStoredCredentials();

  const clearTransportStatusSubscription = useCallback(() => {
    activeTransportStatusUnsubscribeRef.current?.();
    activeTransportStatusUnsubscribeRef.current = null;
  }, []);

  const handleTransportDisconnected = useCallback((error: Error) => {
    console.log(
      "[RemoteConnection] Source transport disconnected:",
      error.message,
    );
    connectionRef.current = null;
    setConnection(null);
    const reason = categorizeError(error.message);
    const currentStored = storedRef.current;
    const isRelay = currentStored?.mode === "relay";
    if (reason === "resume_incompatible") {
      clearStaleResumeSession(currentStored);
    }
    if (reason !== "auth_failed" && reason !== "other") {
      setAutoResumeError({
        reason,
        mode: isRelay ? "relay" : "direct",
        relayUsername: isRelay ? currentStored?.relayUsername : undefined,
        serverUrl: currentStored?.wsUrl,
        message: error.message,
      });
    } else {
      setError(`Connection lost: ${error.message}`);
    }
  }, []);

  const subscribeToTransportStatus = useCallback(
    (transport: SecureSourceTransport, conn: SecureConnection) => {
      clearTransportStatusSubscription();

      const handleDisconnectedSnapshot = () => {
        if (
          activeSecureTransportRef.current !== transport ||
          connectionRef.current !== conn
        ) {
          return;
        }
        clearTransportStatusSubscription();
        const latestSnapshot = transport.status.getSnapshot();
        const message =
          latestSnapshot.channels.find(
            (channel) => channel.name === "secure-websocket",
          )?.lastError ?? "Connection disconnected";
        handleTransportDisconnected(new Error(message));
      };

      const syncStatus = () => {
        if (
          activeSecureTransportRef.current !== transport ||
          connectionRef.current !== conn
        ) {
          return;
        }

        const snapshot = transport.status.getSnapshot();
        if (snapshot.state === "ready") {
          setError(null);
          setAutoResumeError(null);
          return;
        }
        if (snapshot.state !== "disconnected") return;

        if (
          snapshot.channels.some(
            (channel) =>
              channel.name === "secure-websocket" && channel.lastError,
          )
        ) {
          handleDisconnectedSnapshot();
          return;
        }

        // ConnectionManager emits stateChange("disconnected") before
        // reconnectFailed, which is where the transport records lastError.
        // Let that paired event land so auto-resume errors keep their cause.
        queueMicrotask(handleDisconnectedSnapshot);
      };

      activeTransportStatusUnsubscribeRef.current =
        transport.status.subscribe(syncStatus);
      syncStatus();
    },
    [clearTransportStatusSubscription, handleTransportDisconnected],
  );

  const attachConnectionTransport = useCallback(
    (conn: SecureConnection) => {
      clearTransportStatusSubscription();
      const sourceKey = resolveRemoteConnectionSourceKey({
        hostId: currentHostIdRef.current,
        directUrl: currentDirectUrlRef.current,
      });
      const transport = getSecureSourceTransport(sourceKey);
      if (
        activeSecureTransportRef.current &&
        activeSecureTransportRef.current !== transport
      ) {
        activeSecureTransportRef.current.detach();
      }
      transport.attach(conn);
      activeSecureTransportRef.current = transport;
      return transport;
    },
    [clearTransportStatusSubscription],
  );

  const publishConnection = useCallback(
    (conn: SecureConnection) => {
      const transport = attachConnectionTransport(conn);
      connectionRef.current = conn;
      setConnection(conn);
      subscribeToTransportStatus(transport, conn);
    },
    [attachConnectionTransport, subscribeToTransportStatus],
  );

  const detachTransport = useCallback(() => {
    clearTransportStatusSubscription();
    const transport = activeSecureTransportRef.current;
    activeSecureTransportRef.current = null;
    transport?.detach();
  }, [clearTransportStatusSubscription]);

  const handleSessionEstablished = useCallback(
    (attempt: number, session: StoredSession) => {
      if (!isCurrentConnectionAttempt(attempt)) return;
      console.log("[RemoteConnection] Storing session for resumption");
      updateStoredSession(session);

      const hostId = currentHostIdRef.current;
      if (hostId) {
        console.log("[RemoteConnection] Also updating hostStorage for", hostId);
        updateHostSession(hostId, session);
      }
    },
    [isCurrentConnectionAttempt],
  );

  // Callback for when connection is lost unexpectedly. The attached
  // SourceTransport manager observes the same close before this callback fires,
  // so React state is cleared from the transport status listener only after
  // reconnect is exhausted or a non-retryable error disconnects the source.
  const handleDisconnect = useCallback((error: Error) => {
    console.log("[RemoteConnection] Connection lost:", error.message);
  }, []);

  const connect = useCallback(
    async (
      wsUrl: string,
      username: string,
      password: string,
      rememberMe = false,
    ) => {
      const attempt = beginConnectionAttempt();
      setIsConnecting(true);
      setError(null);
      setIsIntentionalDisconnect(false);
      setCurrentRelayUsername(null);
      setCurrentRelayUrl(null);
      setCurrentDirectUrl(wsUrl);

      try {
        // If rememberMe is true, save credentials BEFORE auth so the onSessionEstablished
        // callback can update them. The callback fires during SRP handshake, before
        // conn.fetch() returns.
        if (rememberMe) {
          saveCredentials(wsUrl, username);
        }

        // Create and authenticate connection
        const conn = new SecureConnection(wsUrl, username, password, {
          onSessionEstablished: rememberMe
            ? (session) => handleSessionEstablished(attempt, session)
            : undefined,
          onDisconnect: handleDisconnect,
        });

        // Test the connection by making a simple request
        // This triggers the SRP handshake and verifies auth
        await conn.fetch("/auth/status");
        if (!isCurrentConnectionAttempt(attempt)) {
          conn.close();
          throw new ConnectionAttemptSupersededError();
        }

        // Attach the transport before setConnection so children rendered by
        // the connected app can route API calls through the source runtime.
        publishConnection(conn);
      } catch (err) {
        if (isCurrentConnectionAttempt(attempt)) {
          const message =
            err instanceof Error ? err.message : "Connection failed";
          setError(message);
          setCurrentDirectUrl(null);
        }
        throw err;
      } finally {
        if (isCurrentConnectionAttempt(attempt)) {
          setIsConnecting(false);
        }
      }
    },
    [
      beginConnectionAttempt,
      handleSessionEstablished,
      handleDisconnect,
      isCurrentConnectionAttempt,
      publishConnection,
      setCurrentDirectUrl,
    ],
  );

  const resumeSession = useCallback(
    async (password: string) => {
      const currentStored = storedRef.current;
      if (!currentStored?.session) {
        throw new Error("No stored session to resume");
      }

      const attempt = beginConnectionAttempt();
      setIsConnecting(true);
      setError(null);
      setCurrentRelayUsername(null);
      setCurrentRelayUrl(null);
      setCurrentDirectUrl(currentStored.wsUrl);

      try {
        // Create connection from stored session
        const conn = SecureConnection.fromStoredSession(
          currentStored.session,
          password,
          {
            onSessionEstablished: (session) =>
              handleSessionEstablished(attempt, session),
            onDisconnect: handleDisconnect,
          },
        );

        // Test the connection - this will try resume, fall back to SRP if needed
        await conn.fetch("/auth/status");
        if (!isCurrentConnectionAttempt(attempt)) {
          conn.close();
          throw new ConnectionAttemptSupersededError();
        }

        // Attach the transport before setConnection so connected children can
        // route API calls through the source runtime.
        publishConnection(conn);
      } catch (err) {
        if (isCurrentConnectionAttempt(attempt)) {
          const message =
            err instanceof Error ? err.message : "Session resume failed";
          setError(message);
          setCurrentDirectUrl(null);
        }
        throw err;
      } finally {
        if (isCurrentConnectionAttempt(attempt)) {
          setIsConnecting(false);
        }
      }
    },
    [
      beginConnectionAttempt,
      handleSessionEstablished,
      handleDisconnect,
      isCurrentConnectionAttempt,
      publishConnection,
      setCurrentDirectUrl,
    ],
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
        session,
      } = options;
      const attempt = beginConnectionAttempt();

      setIsConnecting(true);
      setError(null);
      setIsIntentionalDisconnect(false);
      setCurrentRelayUsername(relayUsername);
      setCurrentRelayUrl(relayUrl);
      setCurrentDirectUrl(null);
      const currentHost = currentHostIdRef.current
        ? getHostById(currentHostIdRef.current)
        : undefined;
      if (
        currentHost?.mode !== "relay" ||
        currentHost.relayUsername !== relayUsername
      ) {
        setCurrentHostId(getHostByRelayUsername(relayUsername)?.id ?? null);
      }
      onStatusChange?.("connecting_relay");

      try {
        // 1. Connect to the relay and claim the server's waiting socket.
        const ws = await openRelayClientSocket({
          relayUrl,
          relayUsername,
          onOpen: () => {
            if (isCurrentConnectionAttempt(attempt)) {
              onStatusChange?.("waiting_server");
            }
          },
        });
        if (!isCurrentConnectionAttempt(attempt)) {
          ws.close();
          throw new ConnectionAttemptSupersededError();
        }

        // 2. Now we have a direct pipe to yepanywhere server - do SRP auth
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
        // If session is provided, use resume-only mode; otherwise do fresh SRP auth
        let conn: SecureConnection;
        if (session) {
          conn = await SecureConnection.forResumeOnlyWithSocket(
            ws,
            session,
            {
              onSessionEstablished: rememberMe
                ? (establishedSession) =>
                    handleSessionEstablished(attempt, establishedSession)
                : undefined,
              onDisconnect: handleDisconnect,
            },
            { relayUrl, relayUsername },
          );
        } else {
          conn = await SecureConnection.connectWithExistingSocket(
            ws,
            srpUsername,
            srpPassword,
            {
              onSessionEstablished: rememberMe
                ? (establishedSession) =>
                    handleSessionEstablished(attempt, establishedSession)
                : undefined,
              onDisconnect: handleDisconnect,
            },
            { relayUrl, relayUsername },
          );
        }

        if (!isCurrentConnectionAttempt(attempt)) {
          conn.close();
          throw new ConnectionAttemptSupersededError();
        }

        // Test the connection
        await conn.fetch("/auth/status");
        if (!isCurrentConnectionAttempt(attempt)) {
          conn.close();
          throw new ConnectionAttemptSupersededError();
        }

        // Attach the source transport before connected routes render.
        publishConnection(conn);
      } catch (err) {
        if (isCurrentConnectionAttempt(attempt)) {
          const message =
            err instanceof Error ? err.message : "Connection failed";
          setError(message);
          onStatusChange?.("error");
        }
        throw err;
      } finally {
        if (isCurrentConnectionAttempt(attempt)) {
          setIsConnecting(false);
        }
      }
    },
    [
      beginConnectionAttempt,
      handleSessionEstablished,
      handleDisconnect,
      isCurrentConnectionAttempt,
      publishConnection,
      setCurrentHostId,
      setCurrentDirectUrl,
    ],
  );

  const disconnect = useCallback(
    (isIntentional = true) => {
      beginConnectionAttempt();
      // Use flushSync to ensure state updates are processed synchronously
      // before any navigation happens. This prevents race conditions where
      // ConnectionGate might redirect back to the host before seeing the disconnect.
      flushSync(() => {
        if (connectionRef.current) {
          connectionRef.current.close();
        }
        detachTransport();
        connectionRef.current = null;
        setConnection(null);
        clearStoredCredentials();
        setError(null);
        setAutoResumeError(null);
        // Clear host ID and optionally mark as intentional disconnect
        // Use isIntentional=false for programmatic host switches (e.g., browser back/forward)
        setCurrentHostId(null);
        setCurrentRelayUsername(null);
        setCurrentRelayUrl(null);
        setCurrentDirectUrl(null);
        setIsIntentionalDisconnect(isIntentional);
      });
    },
    [
      beginConnectionAttempt,
      detachTransport,
      setCurrentHostId,
      setCurrentDirectUrl,
    ],
  );

  const clearAutoResumeError = useCallback(() => {
    setAutoResumeError(null);
  }, []);

  const retryAutoResume = useCallback(() => {
    if (!storedRef.current?.session) {
      setAutoResumeError(null);
      setIsAutoResuming(false);
      return;
    }
    // Enter the retry state immediately so route gates do not briefly treat
    // the cleared error as a terminal auth failure before the effect starts.
    setIsAutoResuming(true);
    setAutoResumeError(null);
    setAutoResumeAttempted(false);
  }, []);

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
      const attempt = beginConnectionAttempt();
      console.log(
        "[RemoteConnection] Attempting auto-resume from stored session",
      );
      setIsConnecting(true);
      setIsAutoResuming(true);
      setError(null);

      try {
        let conn: SecureConnection;

        if (currentStored.mode === "relay") {
          setCurrentDirectUrl(null);
          // Relay mode: reconnect through relay, then resume SRP session
          console.log("[RemoteConnection] Auto-resume via relay");
          const relayUrl = currentStored.wsUrl;
          const relayUsername = currentStored.relayUsername;

          if (!relayUrl || !relayUsername) {
            throw new Error("Missing relay credentials for auto-resume");
          }
          setCurrentRelayUsername(relayUsername);
          setCurrentRelayUrl(relayUrl);

          // 1. Connect to the relay and claim the server's waiting socket.
          const ws = await openRelayClientSocket({
            relayUrl,
            relayUsername,
          });
          if (!isCurrentConnectionAttempt(attempt)) {
            ws.close();
            throw new ConnectionAttemptSupersededError();
          }

          // 2. Create SecureConnection for resume using the existing socket
          conn = await SecureConnection.forResumeOnlyWithSocket(
            ws,
            storedSession,
            {
              onSessionEstablished: (session) =>
                handleSessionEstablished(attempt, session),
              onDisconnect: handleDisconnect,
            },
            { relayUrl, relayUsername },
          );
        } else {
          setCurrentRelayUsername(null);
          setCurrentRelayUrl(null);
          setCurrentDirectUrl(currentStored.wsUrl);
          // Direct mode: just create connection and resume
          conn = SecureConnection.forResumeOnly(storedSession, {
            onSessionEstablished: (session) =>
              handleSessionEstablished(attempt, session),
            onDisconnect: handleDisconnect,
          });
        }

        if (!isCurrentConnectionAttempt(attempt)) {
          conn.close();
          throw new ConnectionAttemptSupersededError();
        }

        // Test the connection - this will try resume only
        await conn.fetch("/auth/status");
        if (!isCurrentConnectionAttempt(attempt)) {
          conn.close();
          throw new ConnectionAttemptSupersededError();
        }

        console.log("[RemoteConnection] Auto-resume successful");
        if (currentStored.mode === "relay") {
          const relayUrl = currentStored.wsUrl;
          const relayUsername = currentStored.relayUsername;

          if (relayUrl && relayUsername) {
            const host = upsertRelayHost({
              relayUrl,
              relayUsername,
              srpUsername: currentStored.username,
              session: storedSession,
            });
            setCurrentHostId(host.id);
          }
        } else if (currentStored.wsUrl) {
          const host = getHostByDirectWsUrl(currentStored.wsUrl);
          setCurrentHostId(host?.id ?? null);
        }
        // Attach the source transport before connected routes render.
        publishConnection(conn);
      } catch (err) {
        if (!isCurrentConnectionAttempt(attempt)) {
          throw err;
        }
        if (currentStored.mode !== "relay") {
          setCurrentHostId(null);
          setCurrentDirectUrl(null);
        }
        const message = err instanceof Error ? err.message : String(err);
        console.log(
          "[RemoteConnection] Auto-resume failed, user will need to re-authenticate:",
          message,
        );

        // Create structured error for the modal
        const reason = categorizeError(message);
        const isRelay = currentStored.mode === "relay";

        if (reason === "resume_incompatible") {
          clearStaleResumeSession(currentStored);
          setError(null);
          setAutoResumeError(null);
          return;
        }

        // Only show the modal for connection failures, not auth failures
        // Auth failures should go straight to login form
        if (reason !== "auth_failed" && reason !== "other") {
          setAutoResumeError({
            reason,
            mode: isRelay ? "relay" : "direct",
            relayUsername: isRelay ? currentStored.relayUsername : undefined,
            serverUrl: currentStored.wsUrl,
            message,
          });
        }
        // If auth_failed or other, just show login form (no modal)
      } finally {
        if (isCurrentConnectionAttempt(attempt)) {
          setIsConnecting(false);
          setIsAutoResuming(false);
        }
      }
    };

    void attemptAutoResume();
  }, [
    autoResumeAttempted,
    beginConnectionAttempt,
    handleSessionEstablished,
    handleDisconnect,
    isCurrentConnectionAttempt,
    publishConnection,
    setCurrentHostId,
    setCurrentDirectUrl,
  ]);

  // Clean up connection on unmount only (not on connection changes)
  // Using empty deps + ref avoids the cleanup running when connection changes
  useEffect(() => {
    return () => {
      beginConnectionAttempt();
      if (connectionRef.current) {
        connectionRef.current.close();
      }
      detachTransport();
    };
  }, [beginConnectionAttempt, detachTransport]);

  const value: RemoteConnectionState = {
    connection,
    isConnecting,
    isAutoResuming,
    error,
    autoResumeError,
    currentHostId,
    currentRelayUsername,
    currentRelayUrl,
    currentDirectUrl,
    setCurrentHostId,
    isIntentionalDisconnect,
    connect,
    connectViaRelay,
    disconnect,
    clearAutoResumeError,
    retryAutoResume,
    storedUrl: storedRef.current?.wsUrl ?? null,
    storedUsername: storedRef.current?.username ?? null,
    hasStoredSession: !!storedRef.current?.session,
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
 * Hook to optionally access remote connection state.
 * Returns null if not within a RemoteConnectionProvider (e.g., non-remote mode).
 */
export function useOptionalRemoteConnection(): RemoteConnectionState | null {
  return useContext(RemoteConnectionContext);
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
