import {
  type RelayClientConnected,
  type RelayClientError,
  type RelayServerRegistered,
  type RelayServerRejected,
  isRelayClientConnect,
  isRelayServerRegister,
} from "@yep-anywhere/shared";
import type { WSContext, WSMessageReceive } from "hono/ws";
import type { Logger } from "pino";
import type { RelayConfig } from "./config.js";
import type { ConnectionManager } from "./connections.js";

/** State for each WebSocket connection */
interface ConnectionState {
  /** Username this connection is associated with (after registration) */
  username?: string;
  /** Whether this is a server connection (vs client) */
  isServer?: boolean;
  /** Whether this connection has been paired */
  paired: boolean;
  /** Ping interval timer */
  pingInterval?: ReturnType<typeof setInterval>;
  /** Pong timeout timer */
  pongTimeout?: ReturnType<typeof setTimeout>;
  /** Last pong received */
  lastPong?: number;
}

/** Track connection state by WebSocket */
const connectionStates = new WeakMap<WSContext, ConnectionState>();

function getState(ws: WSContext): ConnectionState {
  let state = connectionStates.get(ws);
  if (!state) {
    state = { paired: false };
    connectionStates.set(ws, state);
  }
  return state;
}

/**
 * Creates the WebSocket message handler for the relay.
 */
export function createWsHandler(
  connectionManager: ConnectionManager,
  config: RelayConfig,
  logger: Logger,
) {
  function sendJson(ws: WSContext, data: object): void {
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      logger.debug({ err }, "Failed to send message");
    }
  }

  function startPingInterval(ws: WSContext, state: ConnectionState): void {
    // Only ping waiting connections (not paired)
    state.pingInterval = setInterval(() => {
      if (state.paired) {
        // Stop pinging paired connections
        if (state.pingInterval) {
          clearInterval(state.pingInterval);
          state.pingInterval = undefined;
        }
        return;
      }

      // Send ping via raw WebSocket if available
      try {
        const raw = ws.raw as { ping?: () => void } | null;
        raw?.ping?.();
      } catch {
        // Ignore ping errors
      }

      // Set pong timeout
      state.pongTimeout = setTimeout(() => {
        logger.debug(
          { username: state.username },
          "Pong timeout, closing connection",
        );
        try {
          ws.close(1000, "Pong timeout");
        } catch {
          // Ignore close errors
        }
      }, config.pongTimeoutMs);
    }, config.pingIntervalMs);
  }

  function stopPingInterval(state: ConnectionState): void {
    if (state.pingInterval) {
      clearInterval(state.pingInterval);
      state.pingInterval = undefined;
    }
    if (state.pongTimeout) {
      clearTimeout(state.pongTimeout);
      state.pongTimeout = undefined;
    }
  }

  function handlePong(state: ConnectionState): void {
    state.lastPong = Date.now();
    if (state.pongTimeout) {
      clearTimeout(state.pongTimeout);
      state.pongTimeout = undefined;
    }
  }

  return {
    onOpen(ws: WSContext): void {
      logger.debug("WebSocket connection opened");
      // State is initialized lazily on first message
    },

    onMessage(ws: WSContext, event: WSMessageReceive): void {
      const state = getState(ws);

      // If already paired, forward everything
      if (state.paired) {
        if (typeof event === "string") {
          connectionManager.forward(ws, event);
        } else if (event instanceof ArrayBuffer) {
          connectionManager.forward(ws, event);
        } else if (ArrayBuffer.isView(event)) {
          // Extract bytes from typed array view into a new ArrayBuffer
          const bytes = new Uint8Array(
            event.buffer,
            event.byteOffset,
            event.byteLength,
          );
          connectionManager.forward(ws, bytes.buffer as ArrayBuffer);
        }
        return;
      }

      // Parse JSON message for protocol handling
      let msg: unknown;
      try {
        if (typeof event !== "string") {
          logger.debug("Received binary message before pairing");
          return;
        }
        msg = JSON.parse(event);
      } catch {
        logger.debug("Failed to parse message as JSON");
        return;
      }

      // Handle server registration
      if (isRelayServerRegister(msg)) {
        const result = connectionManager.registerServer(
          ws,
          msg.username,
          msg.installId,
        );

        if (result === "registered") {
          state.username = msg.username;
          state.isServer = true;
          const response: RelayServerRegistered = { type: "server_registered" };
          sendJson(ws, response);

          // Start ping interval for waiting connections
          startPingInterval(ws, state);

          logger.info({ username: msg.username }, "Server registered");
        } else {
          const response: RelayServerRejected = {
            type: "server_rejected",
            reason: result,
          };
          sendJson(ws, response);
          logger.info(
            { username: msg.username, reason: result },
            "Server registration rejected",
          );
          // Close connection after rejection
          ws.close(1000, `Registration rejected: ${result}`);
        }
        return;
      }

      // Handle client connection
      if (isRelayClientConnect(msg)) {
        const result = connectionManager.connectClient(ws, msg.username);

        if (result.status === "connected") {
          state.username = msg.username;
          state.isServer = false;
          state.paired = true;

          // Also mark the server as paired
          const serverState = getState(result.serverWs);
          serverState.paired = true;

          // Stop ping interval on server (paired connections don't need keepalive from relay)
          stopPingInterval(serverState);

          const response: RelayClientConnected = { type: "client_connected" };
          sendJson(ws, response);

          logger.info({ username: msg.username }, "Client connected");
        } else {
          const response: RelayClientError = {
            type: "client_error",
            reason: result.status,
          };
          sendJson(ws, response);
          logger.info(
            { username: msg.username, reason: result.status },
            "Client connection failed",
          );
          // Close connection after error
          ws.close(1000, `Connection failed: ${result.status}`);
        }
        return;
      }

      // If server is waiting and receives a non-protocol message,
      // this means a client was paired and this is the first forwarded message
      if (state.isServer && state.username && !state.paired) {
        // This shouldn't happen - clients send client_connect first
        // But if we receive data before client_connect, treat it as claim detection
        logger.warn(
          { username: state.username },
          "Received non-protocol message on waiting connection",
        );
      }
    },

    onClose(ws: WSContext): void {
      const state = getState(ws);

      stopPingInterval(state);
      connectionManager.handleClose(ws, state.username);

      if (state.username) {
        logger.info(
          { username: state.username, isServer: state.isServer },
          "Connection closed",
        );
      } else {
        logger.debug("Connection closed (no username)");
      }

      connectionStates.delete(ws);
    },

    onError(ws: WSContext, error: Event): void {
      const state = getState(ws);
      logger.error({ username: state.username, error }, "WebSocket error");
    },

    // Custom handler for pong responses (called by raw WebSocket)
    onPong(ws: WSContext): void {
      const state = getState(ws);
      handlePong(state);
    },
  };
}
