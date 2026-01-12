/**
 * ACP Client wrapper for Agent Client Protocol connections.
 *
 * Provides a reusable client for spawning and communicating with ACP agents
 * (Gemini, Codex, OpenCode, etc.) over JSON-RPC/stdio.
 *
 * Gemini uses a hybrid model where it executes its own tools internally,
 * but asks for permission on sensitive operations (file writes, shell commands).
 * This client handles those permission requests via a callback mechanism.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  type Agent,
  type Client,
  ClientSideConnection,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { getLogger } from "../../../logging/logger.js";

/**
 * Configuration for spawning an ACP agent.
 */
export interface ACPClientConfig {
  /** Command to spawn (e.g., "gemini", "codex-acp") */
  command: string;
  /** Command arguments (e.g., ["--experimental-acp"]) */
  args?: string[];
  /** Working directory for the agent process */
  cwd: string;
  /** Additional environment variables */
  env?: Record<string, string>;
}

/**
 * Callback for session update notifications from the agent.
 */
export type SessionUpdateCallback = (update: SessionNotification) => void;

/**
 * Callback for permission requests from the agent.
 * The callback should surface the request to UI and wait for user response.
 * Returns a promise that resolves with the user's decision.
 */
export type PermissionRequestCallback = (
  request: RequestPermissionRequest,
) => Promise<RequestPermissionResponse>;

/**
 * ACP Client - manages connection to an ACP-compatible agent.
 *
 * Usage:
 * ```typescript
 * const client = new ACPClient();
 * await client.connect({ command: 'gemini', args: ['--experimental-acp'], cwd: '/path' });
 * const init = await client.initialize();
 * const sessionId = await client.newSession('/path');
 * const result = await client.prompt(sessionId, 'Hello!');
 * client.close();
 * ```
 */
export class ACPClient {
  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private log = getLogger();
  private onSessionUpdate: SessionUpdateCallback | null = null;
  private onPermissionRequest: PermissionRequestCallback | null = null;

  /**
   * Set callback for session update notifications.
   * Must be called before connect() to receive all updates.
   */
  setSessionUpdateCallback(callback: SessionUpdateCallback): void {
    this.onSessionUpdate = callback;
  }

  /**
   * Set callback for permission requests.
   * The callback should surface the request to UI and wait for user response.
   * Must be called before sending prompts to receive permission requests.
   */
  setPermissionRequestCallback(callback: PermissionRequestCallback): void {
    this.log.debug("Permission request callback registered");
    this.onPermissionRequest = callback;
  }

  /**
   * Connect to an ACP agent by spawning it as a subprocess.
   */
  async connect(config: ACPClientConfig): Promise<void> {
    this.log.debug(
      { command: config.command, args: config.args },
      "Spawning ACP agent",
    );

    this.process = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...config.env },
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      const stderr = data.toString().trim();
      if (stderr) {
        this.log.debug({ stderr }, "ACP agent stderr");
      }
    });

    this.process.on("error", (err) => {
      this.log.error({ err }, "ACP agent process error");
    });

    this.process.on("exit", (code, signal) => {
      this.log.debug({ code, signal }, "ACP agent process exited");
    });

    if (!this.process.stdin || !this.process.stdout) {
      throw new Error("Failed to get stdin/stdout from spawned ACP process");
    }

    // Create the NDJSON stream for ACP protocol
    const stream = ndJsonStream(
      Writable.toWeb(this.process.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.process.stdout) as ReadableStream<Uint8Array>,
    );

    // Create client handlers
    const createClient = (_agent: Agent): Client => this.createClientHandlers();

    this.connection = new ClientSideConnection(createClient, stream);
  }

  /**
   * Create client-side handlers for ACP protocol.
   * Handles session updates and permission requests.
   */
  private createClientHandlers(): Client {
    this.log.debug(
      { hasPermissionCallback: !!this.onPermissionRequest },
      "Creating ACP client handlers",
    );
    return {
      sessionUpdate: async (params: SessionNotification) => {
        this.log.trace({ update: params }, "ACP session update");
        this.onSessionUpdate?.(params);
      },
      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        this.log.debug({ params }, "ACP permission request received");

        if (this.onPermissionRequest) {
          // Wait for user to decide - no timeout, waits for user response
          return this.onPermissionRequest(params);
        }

        // No handler configured - deny by default
        this.log.warn("No permission handler configured, cancelling");
        return { outcome: { outcome: "cancelled" } };
      },
    };
  }

  /**
   * Initialize the ACP connection.
   * Must be called after connect() and before newSession().
   */
  async initialize(
    capabilities: Record<string, boolean> = {},
  ): Promise<InitializeResponse> {
    if (!this.connection) {
      throw new Error("ACPClient not connected. Call connect() first.");
    }

    this.log.debug({ capabilities }, "Initializing ACP connection");

    const result = await this.connection.initialize({
      protocolVersion: 1,
      clientInfo: {
        name: "yepanywhere",
        version: "1.0.0",
      },
      clientCapabilities: capabilities,
    });

    this.log.debug({ result }, "ACP initialization complete");
    return result;
  }

  /**
   * Create a new session with the agent.
   * Returns the session ID.
   */
  async newSession(cwd: string): Promise<string> {
    if (!this.connection) {
      throw new Error("ACPClient not connected. Call connect() first.");
    }

    this.log.debug({ cwd }, "Creating new ACP session");

    const result = await this.connection.newSession({
      cwd,
      mcpServers: [],
    });

    this.log.debug({ sessionId: result.sessionId }, "ACP session created");
    return result.sessionId;
  }

  /**
   * Load an existing session by ID.
   * Note: This uses session/load which may not be supported by all agents.
   */
  async loadSession(sessionId: string, cwd: string): Promise<void> {
    if (!this.connection) {
      throw new Error("ACPClient not connected. Call connect() first.");
    }

    this.log.debug({ sessionId, cwd }, "Loading existing ACP session");

    await this.connection.loadSession({
      sessionId,
      cwd,
    });
  }

  /**
   * Resume an existing session by ID.
   * Uses the unstable session/resume method which may be supported even when
   * session/load is not.
   */
  async resumeSession(sessionId: string, cwd: string): Promise<string> {
    if (!this.connection) {
      throw new Error("ACPClient not connected. Call connect() first.");
    }

    this.log.debug({ sessionId, cwd }, "Resuming existing ACP session");

    const result = await this.connection.unstable_resumeSession({
      sessionId,
      cwd,
      mcpServers: [],
    });

    this.log.debug({ result }, "ACP session resumed");
    return sessionId;
  }

  /**
   * Send a prompt to the agent and get a response.
   *
   * Note: In Phase 1, this is a simple request/response pattern.
   * Session updates are delivered via the callback set with setSessionUpdateCallback().
   * Phase 2+ will add streaming support.
   */
  async prompt(sessionId: string, text: string): Promise<unknown> {
    if (!this.connection) {
      throw new Error("ACPClient not connected. Call connect() first.");
    }

    this.log.debug(
      { sessionId, textLength: text.length },
      "Sending ACP prompt",
    );

    const result = await this.connection.prompt({
      sessionId,
      prompt: [{ type: "text", text }],
    });

    this.log.debug({ result }, "ACP prompt complete");
    return result;
  }

  /**
   * Check if the client is connected.
   */
  get isConnected(): boolean {
    return (
      this.connection !== null && this.process !== null && !this.process.killed
    );
  }

  /**
   * Close the connection and kill the agent process.
   */
  close(): void {
    if (this.process && !this.process.killed) {
      this.log.debug("Closing ACP client");
      this.process.kill("SIGTERM");
    }
    this.process = null;
    this.connection = null;
    this.onSessionUpdate = null;
    this.onPermissionRequest = null;
  }
}
