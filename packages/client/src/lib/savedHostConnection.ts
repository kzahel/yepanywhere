import {
  SecureConnection,
  type RelaySocketFactory,
} from "./connection/SecureConnection";
import { openRelayClientSocket } from "./connection/RelayClientSocket";
import { updateHostSession, type SavedHost } from "./hostStorage";

export class MultiHostSignInRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultiHostSignInRequiredError";
  }
}

export function isSavedHostSignInRequiredError(error: unknown): boolean {
  if (error instanceof MultiHostSignInRequiredError) return true;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("authentication") ||
    normalized.includes("invalid_identity") ||
    normalized.includes("resume_incompatible") ||
    normalized.includes("session invalid") ||
    normalized.includes("session resume") ||
    normalized.includes("unauthorized")
  );
}

export async function connectSavedHost(
  host: SavedHost,
  signal: AbortSignal,
  relaySocketFactory?: RelaySocketFactory,
  onDisconnect?: (error: Error) => void,
): Promise<SecureConnection> {
  signal.throwIfAborted();
  const session = host.session;
  if (!session) {
    throw new MultiHostSignInRequiredError("A saved session is required");
  }

  const callbacks = {
    onDisconnect,
    onSessionEstablished: (nextSession: typeof session) => {
      updateHostSession(host.id, nextSession);
    },
  };

  if (host.mode === "direct") {
    if (!host.wsUrl) {
      throw new MultiHostSignInRequiredError(
        "The saved direct host has no WebSocket URL",
      );
    }
    const connection = SecureConnection.forResumeOnly(session, callbacks);
    const abort = () => connection.close();
    signal.addEventListener("abort", abort, { once: true });
    try {
      await connection.fetch("/auth/status");
      signal.throwIfAborted();
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  if (!host.relayUrl || !host.relayUsername) {
    throw new MultiHostSignInRequiredError(
      "The saved relay host is incomplete",
    );
  }
  const openSocket = relaySocketFactory ?? openRelayClientSocket;
  const ws = await openSocket({
    relayUrl: host.relayUrl,
    relayUsername: host.relayUsername,
    signal,
  });
  if (signal.aborted) {
    ws.close();
    signal.throwIfAborted();
  }
  const abort = () => ws.close();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const connection = await SecureConnection.forResumeOnlyWithSocket(
      ws,
      session,
      callbacks,
      {
        relayUrl: host.relayUrl,
        relayUsername: host.relayUsername,
        openSocket: relaySocketFactory,
      },
    );
    await connection.fetch("/auth/status");
    signal.throwIfAborted();
    return connection;
  } catch (error) {
    ws.close();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
