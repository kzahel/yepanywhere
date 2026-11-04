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
import { stripYaControlPlaneCredentials } from "../env-filter.js";
import {
  processTreeSpawnOptions,
  signalProcessTree,
} from "../../../utils/processTree.js";

class ACPConnectionClosedError extends Error {
  constructor() {
    super("ACP connection closed");
  }
}

/** Only our own closed-transport rejection is normal during requested abort. */
export function isRequestedACPClosure(
  error: unknown,
  signal: AbortSignal,
): boolean {
  return signal.aborted && error instanceof ACPConnectionClosedError;
}

/** The ACP SDK can reject with a JSON-RPC error object rather than Error. */
export function acpErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  )
    return error.message;
  return String(error);
}

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
  /**
   * Env var names to strip from the inherited environment before spawning.
   * Applied after the `process.env` + `env` merge, so it can remove ambiently
   * inherited keys that an overlay alone cannot delete. Used to keep a vendor's
   * API key from leaking into a CLI that would honor it (see grok-acp).
   */
  excludeEnv?: string[];
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
 * Callback for provider-specific ACP extension requests.
 *
 * The SDK strips the leading `_` from JSON-RPC extension methods before
 * invoking this callback, so `_x.ai/ask_user_question` arrives as
 * `x.ai/ask_user_question`.
 */
export type ExtensionMethodCallback = (
  method: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

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
  private disposed = false;
  private processExit: Promise<void> = Promise.resolve();
  private processClosed = true;
  private readonly pending = new Set<(error: Error) => void>();
  private resolveClosed!: () => void;
  /** Conversation teardown, independently of actual OS child exit. */
  readonly closed = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });

  /** OS PID of the spawned ACP agent child process */
  get pid(): number | undefined {
    return this.process?.pid;
  }

  get isProcessAlive(): boolean {
    // A launcher can exit before its agent child closes the inherited pipes.
    return !!this.process?.pid && !this.processClosed;
  }
  private onSessionUpdate: SessionUpdateCallback | null = null;
  private onPermissionRequest: PermissionRequestCallback | null = null;
  private onExtensionMethod: ExtensionMethodCallback | null = null;

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
   * Set the provider-specific ACP extension request handler.
   * Must be called before connect() so the client handler includes extMethod.
   */
  setExtensionMethodCallback(callback: ExtensionMethodCallback): void {
    this.log.debug("ACP extension method callback registered");
    this.onExtensionMethod = callback;
  }

  /**
   * Connect to an ACP agent by spawning it as a subprocess.
   */
  async connect(config: ACPClientConfig): Promise<void> {
    if (this.disposed || this.process) {
      throw new Error("ACP client is closed or already owns a process");
    }
    this.log.debug(
      { command: config.command, args: config.args },
      "Spawning ACP agent",
    );

    const childEnv = stripYaControlPlaneCredentials({
      ...process.env,
      ...config.env,
    });
    for (const key of config.excludeEnv ?? []) {
      delete childEnv[key];
    }

    this.process = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
      shell: process.platform === "win32",
      ...processTreeSpawnOptions,
    });
    this.processClosed = false;
    this.processExit = new Promise<void>((resolve) => {
      this.process!.once("close", () => {
        this.processClosed = true;
        resolve();
      });
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      const stderr = data.toString().trim();
      if (stderr) {
        this.log.debug({ stderr }, "ACP agent stderr");
      }
    });

    this.process.on("error", (err) => {
      this.log.error({ err }, "ACP agent process error");
      this.close();
    });

    this.process.on("exit", (code, signal) => {
      this.log.debug({ code, signal }, "ACP agent process exited");
      this.close();
    });

    if (!this.process.stdin || !this.process.stdout) {
      throw new Error("Failed to get stdin/stdout from spawned ACP process");
    }
    this.process.stdin.on("error", () => {
      void this.close();
    });

    // Create the NDJSON stream for ACP protocol
    const stream = ndJsonStream(
      Writable.toWeb(this.process.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.process.stdout) as ReadableStream<Uint8Array>,
    );

    // Create client handlers
    const createClient = (_agent: Agent): Client => this.createClientHandlers();

    this.connection = new ClientSideConnection(createClient, stream);
    void this.connection.closed.then(() => this.close());
  }

  /**
   * Create client-side handlers for ACP protocol.
   * Handles session updates and permission requests.
   */
  private createClientHandlers(): Client {
    this.log.debug(
      {
        hasPermissionCallback: !!this.onPermissionRequest,
        hasExtensionMethodCallback: !!this.onExtensionMethod,
      },
      "Creating ACP client handlers",
    );
    const client: Client = {
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

    const extensionMethod = this.onExtensionMethod;
    if (extensionMethod) {
      client.extMethod = async (method, params) => {
        this.log.debug({ method }, "ACP extension method received");
        return extensionMethod(method, params);
      };
    }

    return client;
  }

  private request<T>(
    operation: (connection: ClientSideConnection) => Promise<T>,
  ): Promise<T> {
    const connection = this.connection;
    if (!connection || this.disposed) {
      return Promise.reject(
        new Error("ACPClient not connected. Call connect() first."),
      );
    }
    // This pinned SDK leaves requests pending after EOF/write failure. Track
    // only in-flight calls; completed calls must not accumulate close listeners.
    return new Promise<T>((resolve, reject) => {
      const closed = (error: Error) => {
        this.pending.delete(closed);
        reject(error);
      };
      this.pending.add(closed);
      try {
        operation(connection).then(
          (value) => {
            this.pending.delete(closed);
            resolve(value);
          },
          (error) => {
            this.pending.delete(closed);
            reject(error);
          },
        );
      } catch (error) {
        this.pending.delete(closed);
        reject(error);
      }
    });
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

    const result = await this.request((connection) =>
      connection.initialize({
        protocolVersion: 1,
        clientInfo: {
          name: "yepanywhere",
          version: "1.0.0",
        },
        clientCapabilities: capabilities,
      }),
    );

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

    const result = await this.request((connection) =>
      connection.newSession({
        cwd,
        mcpServers: [],
      }),
    );

    this.log.debug({ sessionId: result.sessionId }, "ACP session created");
    return result.sessionId;
  }

  /**
   * Load an existing session by ID, the stable ACP continuation method. Agents
   * advertise it as `agentCapabilities.loadSession`; check that before calling.
   *
   * `meta` rides along as the request's `_meta`, which ACP reserves for
   * agent-specific extensions. It stays provider-neutral here: the caller
   * decides which keys its agent understands.
   */
  async loadSession(
    sessionId: string,
    cwd: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.connection) {
      throw new Error("ACPClient not connected. Call connect() first.");
    }

    this.log.debug({ sessionId, cwd, meta }, "Loading existing ACP session");

    await this.request((connection) =>
      connection.loadSession({
        sessionId,
        cwd,
        mcpServers: [],
        ...(meta ? { _meta: meta } : {}),
      }),
    );
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

    const result = await this.request((connection) =>
      connection.unstable_resumeSession({
        sessionId,
        cwd,
        mcpServers: [],
      }),
    );

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

    const result = await this.request((connection) =>
      connection.prompt({
        sessionId,
        prompt: [{ type: "text", text }],
      }),
    );

    this.log.debug({ result }, "ACP prompt complete");
    return result;
  }

  /**
   * Send a provider-specific ACP extension request to the agent.
   * The SDK prefixes `_` on the wire (`x.ai/interject` → `_x.ai/interject`).
   */
  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.connection) {
      throw new Error("ACPClient not connected. Call connect() first.");
    }
    this.log.debug({ method }, "Sending ACP extension method");
    return this.request((connection) => connection.extMethod(method, params));
  }

  /**
   * Check if the client is connected.
   */
  get isConnected(): boolean {
    return this.connection !== null && !this.disposed && this.isProcessAlive;
  }

  /**
   * Close the connection and kill the agent process.
   */
  close(): Promise<void> {
    if (this.disposed) return this.processExit;
    this.disposed = true;
    for (const reject of this.pending) reject(new ACPConnectionClosedError());
    this.pending.clear();
    if (this.isProcessAlive) {
      this.log.debug("Closing ACP client");
      const child = this.process!;
      signalProcessTree(child, "SIGTERM");
      // Native launchers may respawn or leave a worker holding stdio/model
      // connections. Bound shutdown of the owned tree, not only its leader.
      const escalation = setTimeout(
        () => signalProcessTree(child, "SIGKILL"),
        2_000,
      );
      escalation.unref();
      void this.processExit.then(() => clearTimeout(escalation));
    }
    // Keep the actual handle/PID until exit can be observed by the owner.
    this.connection = null;
    this.onSessionUpdate = null;
    this.onPermissionRequest = null;
    this.onExtensionMethod = null;
    this.resolveClosed();
    return this.processExit;
  }
}
