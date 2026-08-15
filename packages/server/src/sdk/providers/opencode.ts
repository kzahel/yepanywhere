/**
 * OpenCode Provider implementation using `opencode serve`.
 *
 * This provider enables using OpenCode as an agent backend.
 * It spawns a per-session OpenCode server and communicates via HTTP/SSE.
 *
 * Architecture:
 * - Each session gets its own `opencode serve` process on a unique port
 * - Messages are sent via HTTP POST to /session/:id/message
 * - Responses are streamed via SSE from /event
 * - Server is killed when session is aborted or times out
 */

import { type ChildProcess, exec, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  EffortLevel,
  ModelInfo,
  OpenCodeMessagePartDeltaEvent,
  OpenCodeMessagePartUpdatedEvent,
  OpenCodeMessageUpdatedEvent,
  OpenCodePart,
  OpenCodePermissionAskedEvent,
  OpenCodeQuestionAskedEvent,
  OpenCodeSSEEvent,
  OpenCodeSessionStatus,
  OpenCodeSessionStatusEvent,
} from "@yep-anywhere/shared";
import { parseOpenCodeSSEEvent } from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { whichCommand } from "../cli-detection.js";
import { MessageQueue } from "../messageQueue.js";
import { selectOpenCodeBinary } from "./opencode-binary-selection.js";
import {
  mapOpenCodeQuestionAnswers,
  normalizeOpenCodeTool,
  normalizeOpenCodeToolResult,
} from "./opencode-tools.js";
import {
  getLocalGlmModelDescription,
  LOCAL_GLM_MODEL_PREFIX,
  type OpenCodeModelSelection,
  parseOpenCodeModelSelection,
  parseOpenCodeVerboseModels,
} from "./opencode-models.js";
import type {
  CanUseTool,
  ContentBlock,
  ProviderActivitySnapshot,
  ProviderLivenessProbeResult,
  SDKMessage,
} from "../types.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";
import {
  resolveProviderSessionOptions,
  unknownProviderSessionOptionsResult,
} from "./types.js";
const execAsync = promisify(exec);
const PROVIDER_MANAGED_SESSION_TITLE = "Yep Anywhere Session";

function execFileUtf8(
  file: string,
  args: string[],
  options: { encoding: BufferEncoding; timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Configuration for OpenCode provider.
 */
export interface OpenCodeProviderConfig {
  /** Path to opencode binary (auto-detected if not specified) */
  opencodePath?: string;
  /** Base port to start from (auto-selects if not specified) */
  basePort?: number;
}

/** Port counter for unique port assignment */
let nextPort = 14100;

interface OpenCodeRuntimeState {
  baseUrl: string;
  cwd: string;
  opencodeSessionId: string;
  serverProcess: ChildProcess;
  lastRawProviderEventAt: Date | null;
  lastRawProviderEventSource: string | null;
  lastSessionStatus: OpenCodeSessionStatus | null;
  lastSessionStatusAt: Date | null;
}

interface OpenCodeStreamState {
  messageRolesById: Map<string, "user" | "assistant">;
  partMessageIdsById: Map<string, string>;
  partTypesById: Map<string, string>;
  partTextById: Map<string, string>;
  partSentLengthsById: Map<string, number>;
  // Unified tool parts stream pending->running->completed; dedupe the tool_use
  // and tool_result emissions per callID so they appear exactly once.
  toolUseEmitted: Set<string>;
  toolResultEmitted: Set<string>;
  // A turn may contain many model/tool steps. step-finish is not terminal;
  // retain the latest usage for each part and report the aggregate once the
  // session.idle boundary ends the turn.
  stepUsageByPartId: Map<string, OpenCodeUsage>;
  sawAssistantContent: boolean;
  usedPostBodyFallback: boolean;
}

interface OpenCodeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

function aggregateOpenCodeUsage(
  usageByPartId: ReadonlyMap<string, OpenCodeUsage>,
): OpenCodeUsage | undefined {
  if (usageByPartId.size === 0) return undefined;
  const aggregate: OpenCodeUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  for (const usage of usageByPartId.values()) {
    aggregate.input_tokens += usage.input_tokens;
    aggregate.output_tokens += usage.output_tokens;
    aggregate.cache_read_input_tokens += usage.cache_read_input_tokens;
    aggregate.cache_creation_input_tokens += usage.cache_creation_input_tokens;
  }
  return aggregate;
}

interface OpenCodeMessageResponse {
  info?: {
    id?: string;
    sessionID?: string;
    role?: "user" | "assistant";
    modelID?: string;
    providerID?: string;
  };
  message?: {
    id?: string;
    sessionID?: string;
    role?: "user" | "assistant";
    modelID?: string;
    providerID?: string;
  };
  parts?: OpenCodePart[];
}

/** OpenCode file part for the message POST (used to carry inline images). */
interface OpenCodeFilePartInput {
  type: "file";
  mime: string;
  url: string;
  filename?: string;
}

/**
 * Get next available port for OpenCode server.
 */
function getNextPort(): number {
  return nextPort++;
}

function isProcessStillAlive(process: ChildProcess): boolean {
  return (
    !process.killed && process.exitCode === null && process.signalCode === null
  );
}

function updateOpenCodeRuntimeEvent(
  runtime: OpenCodeRuntimeState,
  event: OpenCodeSSEEvent,
): void {
  const now = new Date();
  runtime.lastRawProviderEventAt = now;
  runtime.lastRawProviderEventSource = `opencode:sse:${event.type}`;

  if (event.type === "session.status") {
    const statusEvent = event as OpenCodeSessionStatusEvent;
    runtime.lastSessionStatus = statusEvent.properties.status;
    runtime.lastSessionStatusAt = now;
  } else if (event.type === "session.idle") {
    runtime.lastSessionStatus = { type: "idle" };
    runtime.lastSessionStatusAt = now;
  }
}

function getOpenCodeEventSessionId(
  event: OpenCodeSSEEvent,
): string | undefined {
  switch (event.type) {
    case "session.status":
    case "session.idle":
    case "session.diff":
      return event.properties.sessionID;
    case "session.updated":
      return event.properties.info.id;
    case "message.updated":
      return event.properties.info.sessionID;
    case "message.part.updated":
      return event.properties.part.sessionID;
    case "message.part.delta":
      return event.properties.sessionID;
    case "permission.asked":
    case "question.asked":
      return event.properties.sessionID;
    default:
      return undefined;
  }
}

/**
 * OpenCode Provider implementation.
 *
 * Uses `opencode serve` to run a per-session server, communicating via HTTP/SSE.
 */
export class OpenCodeProvider implements AgentProvider {
  readonly name = "opencode" as const;
  readonly displayName = "OpenCode";
  readonly supportsPermissionMode = false; // OpenCode has its own permission model
  // OpenCode exposes per-model reasoning effort via model "variants"
  // (low/medium/high/xhigh/max); the effort selector is gated per-model by
  // ModelInfo.supportsEffort/supportedEffortLevels from getAvailableModels.
  readonly supportsThinkingToggle = true;
  readonly supportsSlashCommands = false;
  readonly supportsSteering = false;

  private readonly opencodePath?: string;

  constructor(config: OpenCodeProviderConfig = {}) {
    this.opencodePath = config.opencodePath;
  }

  /**
   * Check if the OpenCode CLI is installed.
   */
  async isInstalled(): Promise<boolean> {
    const path = await this.findOpenCodePath();
    return path !== null;
  }

  /**
   * Check if OpenCode is authenticated.
   * OpenCode handles auth internally via `opencode auth`.
   */
  async isAuthenticated(): Promise<boolean> {
    // OpenCode is authenticated if installed - it has built-in free models
    return this.isInstalled();
  }

  /**
   * Get detailed authentication status.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isInstalled();
    if (!installed) {
      return {
        installed: false,
        authenticated: false,
        enabled: false,
      };
    }

    // OpenCode is always authenticated if installed (has free models)
    return {
      installed: true,
      authenticated: true,
      enabled: true,
    };
  }

  /**
   * Get available OpenCode models.
   * Queries the OpenCode CLI for available models.
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    const opencodePath = await this.findOpenCodePath();
    if (!opencodePath) {
      return [];
    }

    try {
      // `models --verbose` prints the same model list as `models` plus each
      // model's variant defs, so one invocation answers both. Running them in
      // series doubled this provider's discovery cost, and `/api/providers`
      // waits for its slowest provider.
      const verbose = await this.getVerboseModels(opencodePath);
      const variantMap = verbose?.variants ?? new Map<string, EffortLevel[]>();
      const modelIds = verbose?.ids.length
        ? verbose.ids
        : await this.listModelIds(opencodePath);

      const discoveredModels: ModelInfo[] = modelIds.map((id) => {
        const model: ModelInfo = { id, name: id };
        const effortLevels = variantMap.get(id);
        if (effortLevels && effortLevels.length > 0) {
          model.supportsEffort = true;
          model.supportedEffortLevels = effortLevels;
        }
        return model;
      });

      const localGlmModels = discoveredModels
        .filter((model) => model.id.startsWith(LOCAL_GLM_MODEL_PREFIX))
        .map((model, index) => ({
          ...model,
          description: getLocalGlmModelDescription(model.id),
          isDefault: index === 0,
        }));
      const otherModels = discoveredModels.filter(
        (model) => !model.id.startsWith(LOCAL_GLM_MODEL_PREFIX),
      );
      const defaultModel: ModelInfo = {
        id: "default",
        name: "Default",
        description: "Use the default configured in opencode.json",
      };

      return localGlmModels.length > 0
        ? [...localGlmModels, defaultModel, ...otherModels]
        : [defaultModel, ...otherModels];
    } catch {
      // Return default models if command fails
      return [
        { id: "opencode/big-pickle", name: "Big Pickle (Free)" },
        { id: "auto", name: "Auto (recommended)" },
      ];
    }
  }

  /** Plain `opencode models` ids, for a CLI whose verbose output we cannot use. */
  private async listModelIds(opencodePath: string): Promise<string[]> {
    const { stdout } = await execFileUtf8(opencodePath, ["models"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("─"));
  }

  /**
   * Best-effort `opencode models --verbose` catalog: advertised model ids in
   * listing order plus their reasoning-effort variants. Returns null on any
   * failure so model discovery falls back to the plain list.
   */
  private async getVerboseModels(
    opencodePath: string,
  ): Promise<{ ids: string[]; variants: Map<string, EffortLevel[]> } | null> {
    try {
      const { stdout } = await execFileUtf8(
        opencodePath,
        ["models", "--verbose"],
        { encoding: "utf-8", timeout: 15000 },
      );
      return parseOpenCodeVerboseModels(stdout);
    } catch {
      return null;
    }
  }

  /**
   * Start a new OpenCode session.
   *
   * This method is intentionally blocking: it spawns the opencode server,
   * waits for it to be ready, and creates the session via HTTP before
   * returning. This ensures the real ses_* session ID is known before the
   * iterator is handed to the Supervisor, so waitForSessionId() resolves
   * immediately on the first init yield rather than racing a 5-second timeout.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const providerSessionOptions = resolveProviderSessionOptions(
      options.sessionOptions,
    );
    const log = getLogger();
    const opencodePath = await this.findOpenCodePath();

    if (!opencodePath) {
      return this.errorSession("OpenCode CLI not found");
    }

    const port = getNextPort();
    const baseUrl = `http://127.0.0.1:${port}`;

    let serverProcess: ChildProcess;
    try {
      serverProcess = spawn(
        opencodePath,
        ["serve", "--port", String(port), "--print-logs"],
        {
          cwd: options.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
          shell: process.platform === "win32",
        },
      );

      serverProcess.stdout?.on("data", (chunk: Buffer) => {
        log.debug(
          { port, line: chunk.toString().trim() },
          "OpenCode server stdout",
        );
      });
      serverProcess.stderr?.on("data", (chunk: Buffer) => {
        log.debug(
          { port, line: chunk.toString().trim() },
          "OpenCode server stderr",
        );
      });
    } catch (error) {
      return this.errorSession(
        `Failed to spawn OpenCode server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Block until server is ready before returning to the Supervisor
    const serverReady = await this.waitForServer(baseUrl, 10000);
    if (!serverReady) {
      serverProcess.kill("SIGTERM");
      return this.errorSession("OpenCode server failed to start");
    }

    log.info({ port, cwd: options.cwd }, "OpenCode server ready");

    // Resolve the opencode session ID synchronously (relative to Supervisor startup)
    let opencodeSessionId: string;
    if (options.resumeSessionId?.startsWith("ses_")) {
      opencodeSessionId = options.resumeSessionId;
      log.info({ opencodeSessionId }, "Resuming existing OpenCode session");
    } else {
      try {
        const sessionResponse = await fetch(`${baseUrl}/session`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            providerSessionOptions.automaticTitle
              ? {}
              : { title: PROVIDER_MANAGED_SESSION_TITLE },
          ),
        });

        if (!sessionResponse.ok) {
          throw new Error(
            `Failed to create session: ${sessionResponse.status}`,
          );
        }

        const sessionData = (await sessionResponse.json()) as { id: string };
        opencodeSessionId = sessionData.id;
        log.info({ opencodeSessionId, port }, "OpenCode session created");
      } catch (error) {
        serverProcess.kill("SIGTERM");
        return this.errorSession(
          `Failed to create OpenCode session: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const queue = new MessageQueue();
    const abortController = new AbortController();
    const pidRef = { value: serverProcess.pid };
    const runtime: OpenCodeRuntimeState = {
      baseUrl,
      cwd: options.cwd,
      opencodeSessionId,
      serverProcess,
      lastRawProviderEventAt: null,
      lastRawProviderEventSource: null,
      lastSessionStatus: null,
      lastSessionStatusAt: null,
    };

    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    const iterator = this.runSession(
      options.cwd,
      queue,
      abortController.signal,
      options,
      port,
      runtime,
    );

    return {
      iterator,
      queue,
      abort: () => abortController.abort(),
      // Graceful turn interrupt: stop the in-flight turn via the server's own
      // abort endpoint and keep the per-session `opencode serve` alive so the
      // session can continue. (abort(), by contrast, ends the session by
      // killing the server.) The SSE loop already treats the resulting
      // session.idle as turn-complete.
      interrupt: () => this.interruptTurn(runtime),
      isProcessAlive: () => isProcessStillAlive(serverProcess),
      probeLiveness: () => this.probeLiveness(runtime),
      getProviderActivity: () => this.getProviderActivity(runtime),
      setSessionOptions: async (requested) => {
        const result = unknownProviderSessionOptionsResult(
          requested,
          "No OpenCode control mechanism was located for this session option",
        );
        if (requested.automaticTitle !== undefined) {
          result.automaticTitle = {
            requested: requested.automaticTitle,
            status:
              requested.automaticTitle === providerSessionOptions.automaticTitle
                ? "applied"
                : "restart-required",
            detail:
              requested.automaticTitle === providerSessionOptions.automaticTitle
                ? "The OpenCode session was created with this title policy"
                : "OpenCode title generation is controlled at session creation",
          };
        }
        return result;
      },
      get pid() {
        return pidRef.value;
      },
    };
  }

  /**
   * Stop the current OpenCode turn without killing the per-session server,
   * via POST /session/:id/abort. Returns true when the request succeeds.
   */
  private async interruptTurn(runtime: OpenCodeRuntimeState): Promise<boolean> {
    const log = getLogger();
    try {
      const response = await fetch(
        `${runtime.baseUrl}/session/${runtime.opencodeSessionId}/abort`,
        {
          method: "POST",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) {
        log.warn(
          { status: response.status, sessionId: runtime.opencodeSessionId },
          "OpenCode turn abort request failed",
        );
        return false;
      }
      return true;
    } catch (error) {
      log.warn(
        { error, sessionId: runtime.opencodeSessionId },
        "OpenCode turn abort request errored",
      );
      return false;
    }
  }

  /**
   * Return a minimal AgentSession whose iterator immediately yields one error message.
   */
  private errorSession(errorMsg: string): AgentSession {
    const queue = new MessageQueue();
    return {
      iterator: (async function* () {
        yield { type: "error", error: errorMsg } as SDKMessage;
      })(),
      queue,
      abort: () => {},
    };
  }

  private getProviderActivity(
    runtime: OpenCodeRuntimeState,
  ): ProviderActivitySnapshot {
    return {
      lastRawProviderEventAt: runtime.lastRawProviderEventAt,
      lastRawProviderEventSource: runtime.lastRawProviderEventSource,
    };
  }

  private async probeLiveness(
    runtime: OpenCodeRuntimeState,
  ): Promise<ProviderLivenessProbeResult> {
    const checkedAt = new Date();
    const source = "opencode:session/status";

    if (!isProcessStillAlive(runtime.serverProcess)) {
      return {
        status: "unavailable",
        source: "opencode:process",
        detail: "OpenCode server process is not alive",
        checkedAt,
      };
    }

    try {
      const response = await fetch(`${runtime.baseUrl}/session/status`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return {
          status: "error",
          source,
          detail: `OpenCode status request failed with HTTP ${response.status}`,
          checkedAt,
        };
      }

      const statuses = await response.json();
      if (
        !statuses ||
        typeof statuses !== "object" ||
        Array.isArray(statuses)
      ) {
        return {
          status: "error",
          source,
          detail: "OpenCode status response was not a session status map",
          checkedAt,
        };
      }

      const statusMap = statuses as Record<string, unknown>;
      const hasStatus = Object.hasOwn(statusMap, runtime.opencodeSessionId);
      if (!hasStatus) {
        return {
          status: "idle",
          source,
          detail: "OpenCode status map has no active entry for this session",
          checkedAt,
        };
      }

      const status = this.parseSessionStatus(
        statusMap[runtime.opencodeSessionId],
      );

      if (!status) {
        return {
          status: "error",
          source,
          detail: "OpenCode status entry for this session was not recognized",
          checkedAt,
        };
      }

      runtime.lastSessionStatus = status;
      runtime.lastSessionStatusAt = checkedAt;

      if (status.type === "busy") {
        return {
          status: "active",
          source,
          detail: "OpenCode reports the session is busy",
          checkedAt,
        };
      }

      if (status.type === "retry") {
        return {
          status: "active",
          source,
          detail: `OpenCode is retrying attempt ${status.attempt}: ${status.message}`,
          checkedAt,
        };
      }

      return {
        status: "idle",
        source,
        detail: "OpenCode reports the session is idle",
        checkedAt,
      };
    } catch (error) {
      return {
        status: "error",
        source,
        detail: error instanceof Error ? error.message : String(error),
        checkedAt,
      };
    }
  }

  private parseSessionStatus(value: unknown): OpenCodeSessionStatus | null {
    if (!value || typeof value !== "object" || !("type" in value)) {
      return null;
    }

    const status = value as {
      type?: unknown;
      attempt?: unknown;
      message?: unknown;
      next?: unknown;
    };
    if (status.type === "busy" || status.type === "idle") {
      return { type: status.type };
    }
    if (status.type === "retry") {
      return {
        type: "retry",
        attempt: typeof status.attempt === "number" ? status.attempt : 0,
        message:
          typeof status.message === "string"
            ? status.message
            : "retrying request",
        next: typeof status.next === "number" ? status.next : 0,
      };
    }
    return null;
  }

  /**
   * Main session loop.
   * Server is already started and opencodeSessionId is already known
   * (resolved in startSession before the iterator was constructed).
   * The first yield is always the init message, so waitForSessionId() in
   * Process resolves immediately.
   */
  private async *runSession(
    cwd: string,
    queue: MessageQueue,
    signal: AbortSignal,
    options: StartSessionOptions,
    port: number,
    runtime: OpenCodeRuntimeState,
  ): AsyncIterableIterator<SDKMessage> {
    const log = getLogger();
    // opencode session ID is the YA session ID for opencode sessions
    const sessionId = runtime.opencodeSessionId;

    // Handle abort
    const abortHandler = () => {
      log.info({ port }, "Aborting OpenCode server");
      runtime.serverProcess.kill("SIGTERM");
    };
    signal.addEventListener("abort", abortHandler);

    // Emit init message immediately — this is what resolves waitForSessionId()
    yield {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      cwd,
    } as SDKMessage;

    try {
      let isFirstNewMessage = true;
      for await (const message of queue) {
        if (signal.aborted) break;

        let userPrompt = this.extractTextFromMessage(message);
        const imageParts = this.extractImageFileParts(message);

        if (isFirstNewMessage && options.globalInstructions) {
          userPrompt = `[Global context]\n${options.globalInstructions}\n\n---\n\n${userPrompt}`;
        }
        isFirstNewMessage = false;

        yield {
          type: "user",
          uuid: message.uuid,
          session_id: sessionId,
          message: {
            role: "user",
            content: userPrompt,
          },
        } as SDKMessage;

        yield* this.sendMessageAndStream(
          runtime,
          sessionId,
          userPrompt,
          options.model,
          signal,
          options.onToolApproval,
          options.effort,
          imageParts,
        );
      }
    } finally {
      log.info({ port, sessionId }, "Shutting down OpenCode server");
      signal.removeEventListener("abort", abortHandler);

      if (!runtime.serverProcess.killed) {
        runtime.serverProcess.kill("SIGTERM");
      }
    }
  }

  /**
   * Send a message to OpenCode and stream the response via SSE.
   */
  private async *sendMessageAndStream(
    runtime: OpenCodeRuntimeState,
    sessionId: string,
    text: string,
    model: string | undefined,
    signal: AbortSignal,
    onToolApproval: CanUseTool | undefined,
    effort: EffortLevel | undefined,
    imageParts: OpenCodeFilePartInput[] = [],
  ): AsyncIterableIterator<SDKMessage> {
    const log = getLogger();
    let modelSelection: OpenCodeModelSelection | undefined;
    try {
      modelSelection = parseOpenCodeModelSelection(model);
    } catch (error) {
      yield {
        type: "error",
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      } as SDKMessage;
      return;
    }

    const sseUrl = `${runtime.baseUrl}/event?directory=${encodeURIComponent(runtime.cwd)}`;
    const sseController = new AbortController();
    const streamState: OpenCodeStreamState = {
      messageRolesById: new Map(),
      partMessageIdsById: new Map(),
      partTypesById: new Map(),
      partTextById: new Map(),
      partSentLengthsById: new Map(),
      toolUseEmitted: new Set(),
      toolResultEmitted: new Set(),
      stepUsageByPartId: new Map(),
      sawAssistantContent: false,
      usedPostBodyFallback: false,
    };

    // Event buffer and signaling for producer/consumer pattern
    // Using an object to avoid TypeScript control flow issues across async boundaries
    const state = {
      eventBuffer: [] as SDKMessage[],
      sseError: null as Error | null,
      sseComplete: false,
      resolveWaiting: null as (() => void) | null,
    };

    // Start SSE connection immediately (runs in background)
    const ssePromise = (async () => {
      try {
        const response = await fetch(sseUrl, {
          headers: { Accept: "text/event-stream" },
          signal: sseController.signal,
        });

        if (!response.ok || !response.body) {
          log.error({ status: response.status }, "Failed to connect to SSE");
          state.sseError = new Error(
            `SSE connection failed: ${response.status}`,
          );
          return;
        }

        log.debug({ sseUrl }, "SSE connected");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!sseController.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete lines
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;

            const data = line.slice(6);
            const event = parseOpenCodeSSEEvent(data);
            if (!event) continue;

            log.trace({ event }, "SSE event received");

            const eventSessionId = getOpenCodeEventSessionId(event);
            if (
              eventSessionId !== undefined &&
              eventSessionId !== runtime.opencodeSessionId
            ) {
              continue;
            }

            updateOpenCodeRuntimeEvent(runtime, event);
            if (event.type === "message.updated") {
              const messageEvent = event as OpenCodeMessageUpdatedEvent;
              streamState.messageRolesById.set(
                messageEvent.properties.info.id,
                messageEvent.properties.info.role,
              );
            }

            // Interactive prompts: route to YA's approval/question UI and POST
            // the reply back to opencode. Fire-and-forget so the SSE read loop
            // keeps draining (the tool's own progress/result events follow the
            // reply). The handlers never throw into the loop.
            if (event.type === "permission.asked") {
              void this.handlePermissionAsked(
                runtime,
                event,
                onToolApproval,
                signal,
              );
              continue;
            }
            if (event.type === "question.asked") {
              void this.handleQuestionAsked(
                runtime,
                event,
                onToolApproval,
                signal,
              );
              continue;
            }

            // Convert to SDK messages (a single unified tool part can yield
            // both a tool_use and a tool_result, so this is an array).
            const sdkMessages = this.convertSSEEventToSDKMessage(
              event,
              sessionId,
              streamState,
            );

            for (const sdkMessage of sdkMessages) {
              if (sdkMessage.type === "assistant") {
                if (streamState.usedPostBodyFallback) {
                  continue;
                }
                streamState.sawAssistantContent = true;
              }
              state.eventBuffer.push(sdkMessage);
              // Wake up consumer if waiting
              state.resolveWaiting?.();
            }

            // Stop on session.idle
            if (event.type === "session.idle") {
              log.debug(
                { opencodeSessionId: runtime.opencodeSessionId },
                "Session idle, stopping SSE",
              );
              return;
            }
          }
        }
      } catch (error) {
        if (!sseController.signal.aborted) {
          log.error({ error }, "SSE connection error");
          state.sseError =
            error instanceof Error ? error : new Error(String(error));
        }
      } finally {
        state.sseComplete = true;
        state.resolveWaiting?.();
      }
    })();

    // Wait briefly for SSE connection to establish
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Send the message
    try {
      log.debug(
        {
          opencodeSessionId: runtime.opencodeSessionId,
          textLength: text.length,
          model: modelSelection,
        },
        "Sending message to OpenCode",
      );
      const response = await fetch(
        `${runtime.baseUrl}/session/${runtime.opencodeSessionId}/message`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...(modelSelection ? { model: modelSelection } : {}),
            // OpenCode selects reasoning effort by naming a model variant; the
            // variant keys (low/medium/high/xhigh/max) coincide with YA's
            // EffortLevel. Only sent when YA provides an effort (the UI gates
            // this to models advertised with supportedEffortLevels).
            ...(effort ? { variant: effort } : {}),
            parts: [{ type: "text", text }, ...imageParts],
          }),
          signal,
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to send message: ${response.status} ${errorText}`,
        );
      }
      const responsePayload = (await response
        .json()
        .catch(() => null)) as OpenCodeMessageResponse | null;
      if (!streamState.sawAssistantContent) {
        const fallbackMessages =
          this.convertOpenCodeMessageResponseToSDKMessages(
            responsePayload,
            sessionId,
          );
        if (fallbackMessages.length > 0) {
          streamState.sawAssistantContent = true;
          streamState.usedPostBodyFallback = true;
          state.eventBuffer.push(...fallbackMessages);
          state.resolveWaiting?.();
        }
      }
      log.debug(
        { opencodeSessionId: runtime.opencodeSessionId },
        "Message sent successfully",
      );
    } catch (error) {
      sseController.abort();
      if (signal.aborted) {
        return;
      }
      log.error({ error }, "Failed to send message to OpenCode");
      yield {
        type: "error",
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      } as SDKMessage;
      return;
    }

    // Yield events from buffer as they arrive
    try {
      while (!signal.aborted) {
        // Yield any buffered events
        while (state.eventBuffer.length > 0) {
          const event = state.eventBuffer.shift();
          if (event) yield event;
        }

        // Check if done
        if (state.sseComplete) break;
        if (state.sseError) {
          yield {
            type: "error",
            session_id: sessionId,
            error: state.sseError.message,
          } as SDKMessage;
          break;
        }

        // Wait for more events
        await new Promise<void>((resolve) => {
          state.resolveWaiting = resolve;
          // Also resolve after a short timeout to check conditions
          setTimeout(resolve, 100);
        });
        state.resolveWaiting = null;
      }
    } finally {
      sseController.abort();
      await ssePromise; // Ensure SSE task completes
    }

    // session.idle is OpenCode's turn boundary. Individual step-finish parts
    // above are nonterminal model/tool-step boundaries.
    const usage = aggregateOpenCodeUsage(streamState.stepUsageByPartId);
    yield {
      type: "result",
      session_id: sessionId,
      ...(usage ? { usage } : {}),
    } as SDKMessage;
  }

  /**
   * Bridge an opencode permission request to YA's approval UI, then reply.
   * allow -> "once", deny -> "reject". Never throws; on any failure or missing
   * approver, reject so the gated tool does not hang.
   */
  private async handlePermissionAsked(
    runtime: OpenCodeRuntimeState,
    event: OpenCodePermissionAskedEvent,
    onToolApproval: CanUseTool | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const log = getLogger();
    const { id: requestId, permission, metadata } = event.properties;
    let reply: "once" | "reject" = "reject";
    try {
      if (onToolApproval) {
        const { name, input } = normalizeOpenCodeTool(permission, metadata);
        const result = await onToolApproval(name, input, { signal });
        reply = result.behavior === "allow" ? "once" : "reject";
      }
    } catch (error) {
      log.warn(
        { error, requestId },
        "OpenCode permission approval failed; rejecting",
      );
    }
    await this.postOpenCodeReply(
      runtime,
      `/permission/${requestId}/reply`,
      { reply },
      requestId,
    );
  }

  /**
   * Bridge an opencode interactive question to YA's AskUserQuestion UI, then
   * reply with the selected option labels per question (or reject). The
   * opencode question shape matches YA's AskUserQuestion input, so the existing
   * pending-input UI handles it. Never throws.
   */
  private async handleQuestionAsked(
    runtime: OpenCodeRuntimeState,
    event: OpenCodeQuestionAskedEvent,
    onToolApproval: CanUseTool | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const log = getLogger();
    const { id: requestId, questions } = event.properties;
    try {
      if (onToolApproval) {
        const result = await onToolApproval(
          "AskUserQuestion",
          { questions },
          { signal },
        );
        if (result.behavior === "allow") {
          const answers = mapOpenCodeQuestionAnswers(
            questions,
            this.extractQuestionAnswers(result.updatedInput),
          );
          await this.postOpenCodeReply(
            runtime,
            `/question/${requestId}/reply`,
            { answers },
            requestId,
          );
          return;
        }
      }
    } catch (error) {
      log.warn(
        { error, requestId },
        "OpenCode question handling failed; rejecting",
      );
    }
    await this.postOpenCodeReply(
      runtime,
      `/question/${requestId}/reject`,
      {},
      requestId,
    );
  }

  private extractQuestionAnswers(
    updatedInput: unknown,
  ): Record<string, string | string[]> | undefined {
    if (
      updatedInput &&
      typeof updatedInput === "object" &&
      "answers" in updatedInput
    ) {
      const answers = (updatedInput as { answers?: unknown }).answers;
      if (answers && typeof answers === "object" && !Array.isArray(answers)) {
        return answers as Record<string, string | string[]>;
      }
    }
    return undefined;
  }

  private async postOpenCodeReply(
    runtime: OpenCodeRuntimeState,
    path: string,
    body: unknown,
    requestId: string,
  ): Promise<void> {
    const log = getLogger();
    try {
      const response = await fetch(`${runtime.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        log.warn(
          { requestId, status: response.status, path },
          "OpenCode interactive reply failed",
        );
      }
    } catch (error) {
      log.warn(
        { error, requestId, path },
        "OpenCode interactive reply request errored",
      );
    }
  }

  /**
   * Convert an OpenCode SSE event to an SDK message.
   */
  private convertSSEEventToSDKMessage(
    event: OpenCodeSSEEvent,
    sessionId: string,
    streamState: OpenCodeStreamState,
  ): SDKMessage[] {
    switch (event.type) {
      case "message.part.updated": {
        const partEvent = event as OpenCodeMessagePartUpdatedEvent;
        const part = partEvent.properties.part;
        const delta = partEvent.properties.delta;
        streamState.partMessageIdsById.set(part.id, part.messageID);
        streamState.partTypesById.set(part.id, part.type);

        return this.convertPartToSDKMessage(
          part,
          sessionId,
          delta,
          streamState,
          streamState.messageRolesById.get(part.messageID),
        );
      }

      case "message.part.delta": {
        const deltaEvent = event as OpenCodeMessagePartDeltaEvent;
        const messageId =
          deltaEvent.properties.messageID ??
          streamState.partMessageIdsById.get(deltaEvent.properties.partID);
        const partType = streamState.partTypesById.get(
          deltaEvent.properties.partID,
        );

        if (!messageId || !partType || deltaEvent.properties.field !== "text") {
          return [];
        }

        const message = this.convertTextLikePartToSDKMessage(
          {
            partId: deltaEvent.properties.partID,
            messageId,
            partType,
            delta: deltaEvent.properties.delta,
          },
          sessionId,
          streamState,
          streamState.messageRolesById.get(messageId),
        );
        return message ? [message] : [];
      }

      case "session.idle":
      case "session.status":
      case "session.updated":
      case "session.diff":
      case "message.updated":
      case "server.connected":
        // These are status events, not content - skip
        return [];

      default:
        return [];
    }
  }

  private convertTextLikePartToSDKMessage(
    part: {
      partId: string;
      messageId: string;
      partType: string;
      fullText?: string;
      delta?: string;
    },
    sessionId: string,
    streamState: OpenCodeStreamState,
    messageRole: "user" | "assistant" | undefined,
  ): SDKMessage | null {
    if (messageRole === "user") {
      return null;
    }

    const previousText = streamState.partTextById.get(part.partId) ?? "";
    const nextText =
      part.delta !== undefined
        ? previousText + part.delta
        : (part.fullText ?? previousText);
    streamState.partTextById.set(part.partId, nextText);

    const sentLength = streamState.partSentLengthsById.get(part.partId) ?? 0;
    const text = nextText.slice(sentLength);
    if (!text) return null;
    streamState.partSentLengthsById.set(part.partId, nextText.length);

    const content =
      part.partType === "reasoning"
        ? ([{ type: "thinking", thinking: text }] satisfies ContentBlock[])
        : text;

    return {
      type: "assistant",
      session_id: sessionId,
      // Use the part's own OpenCode message id (== the durable message.id), so
      // the streamed assistant uuid matches the persisted row and the client
      // dedups by id instead of re-appending the backfilled copy. (Previously a
      // carried-over "current" id could attribute a later message's parts to an
      // earlier message, diverging from the durable id.)
      uuid: part.messageId,
      message: {
        role: "assistant",
        content,
      },
    } as SDKMessage;
  }

  private convertOpenCodeMessageResponseToSDKMessages(
    response: OpenCodeMessageResponse | null,
    sessionId: string,
  ): SDKMessage[] {
    const info = response?.info ?? response?.message;
    if (info?.role !== "assistant" || !Array.isArray(response?.parts)) {
      return [];
    }

    const contentBlocks: ContentBlock[] = [];
    for (const part of response.parts) {
      if (part.type === "reasoning" && part.text) {
        contentBlocks.push({ type: "thinking", thinking: part.text });
      } else if (part.type === "text" && part.text) {
        contentBlocks.push({ type: "text", text: part.text });
      }
    }

    if (contentBlocks.length === 0) return [];

    const content =
      contentBlocks.length === 1 && contentBlocks[0]?.type === "text"
        ? (contentBlocks[0].text ?? "")
        : contentBlocks;

    return [
      {
        type: "assistant",
        session_id: sessionId,
        uuid: info.id,
        message: {
          role: "assistant",
          model:
            info.providerID && info.modelID
              ? `${info.providerID}/${info.modelID}`
              : info.modelID,
          content,
        },
      } as SDKMessage,
    ];
  }

  /**
   * Convert an OpenCode part to an SDK message.
   */
  private convertPartToSDKMessage(
    part: OpenCodePart,
    sessionId: string,
    delta: string | undefined,
    streamState: OpenCodeStreamState,
    messageRole: "user" | "assistant" | undefined,
  ): SDKMessage[] {
    switch (part.type) {
      case "text":
      case "reasoning": {
        const message = this.convertTextLikePartToSDKMessage(
          {
            partId: part.id,
            messageId: part.messageID,
            partType: part.type,
            fullText: part.text,
            delta,
          },
          sessionId,
          streamState,
          messageRole,
        );
        return message ? [message] : [];
      }

      case "step-start":
        // Start of a processing step - no content to emit
        return [];

      case "step-finish": {
        // End of one model/tool step, not the end of the user turn.
        if (part.tokens) {
          streamState.stepUsageByPartId.set(part.id, {
            input_tokens: part.tokens.input ?? 0,
            output_tokens: part.tokens.output ?? 0,
            cache_read_input_tokens: part.tokens.cache?.read ?? 0,
            cache_creation_input_tokens: part.tokens.cache?.write ?? 0,
          });
        }
        return [];
      }

      // Unified tool part (opencode 1.16+): one type:"tool" part streams
      // pending -> running -> completed/error. Emit the tool_use once the call
      // is underway, then the tool_result once it settles, deduped by callID.
      case "tool":
        return this.convertUnifiedToolPart(part, sessionId, streamState);

      case "tool-use": {
        // Legacy split tool invocation (older opencode)
        const normalized = normalizeOpenCodeTool(part.tool, part.input);
        return [
          {
            type: "assistant",
            session_id: sessionId,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: part.id,
                  name: normalized.name,
                  input: normalized.input,
                },
              ],
            },
          } as SDKMessage,
        ];
      }

      case "tool-result": {
        // Legacy split tool result (older opencode)
        return [
          {
            type: "user",
            session_id: sessionId,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: part.id,
                  content: part.error ?? String(part.output ?? ""),
                },
              ],
            },
          } as SDKMessage,
        ];
      }

      default:
        return [];
    }
  }

  /**
   * Convert a unified `type:"tool"` part into YA tool_use/tool_result messages.
   *
   * The same part is delivered repeatedly as its `state.status` advances
   * (pending -> running -> completed/error) and `state.input`/`state.output`
   * fill in. Emit the tool_use once the call is underway (running or settled)
   * and the tool_result once it settles, each deduped by callID so a streamed
   * tool appears exactly once. A fast tool whose first update is already
   * completed yields both messages at once.
   */
  private convertUnifiedToolPart(
    part: OpenCodePart,
    sessionId: string,
    streamState: OpenCodeStreamState,
  ): SDKMessage[] {
    const callId = part.callID;
    if (!callId) return [];

    const status = part.state?.status;
    const settled = status === "completed" || status === "error";
    const underway = status === "running" || settled;
    const messages: SDKMessage[] = [];

    if (underway && !streamState.toolUseEmitted.has(callId)) {
      streamState.toolUseEmitted.add(callId);
      const normalized = normalizeOpenCodeTool(part.tool, part.state?.input);
      messages.push({
        type: "assistant",
        session_id: sessionId,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: callId,
              name: normalized.name,
              input: normalized.input,
            },
          ],
        },
      } as SDKMessage);
    }

    if (settled && !streamState.toolResultEmitted.has(callId)) {
      streamState.toolResultEmitted.add(callId);
      const error = part.state?.error;
      const output = part.state?.output;
      const content =
        error ??
        (typeof output === "string" ? output : JSON.stringify(output ?? ""));
      const toolUseResult = normalizeOpenCodeToolResult(
        part.tool,
        part.state?.attachments,
      );
      messages.push({
        type: "user",
        session_id: sessionId,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: callId,
              content,
              is_error: status === "error" || Boolean(error),
            },
          ],
        },
        ...(toolUseResult !== undefined ? { toolUseResult } : {}),
      } as SDKMessage);
    }

    return messages;
  }

  /**
   * Wait for server to be ready.
   */
  private async waitForServer(
    baseUrl: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(`${baseUrl}/session`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) {
          return true;
        }
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    return false;
  }

  /**
   * Extract text content from a user message.
   */
  private extractTextFromMessage(message: SDKUserMessage): string {
    const content = message.message?.content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      // Extract text from content blocks
      return content
        .filter(
          (block): block is { type: "text"; text: string } =>
            typeof block === "object" && block.type === "text",
        )
        .map((block) => block.text)
        .join("\n");
    }
    return "";
  }

  /**
   * Convert any base64 image content blocks on a user message into OpenCode
   * file parts (a data-URL `url` + mime), so pasted/uploaded images are sent to
   * OpenCode instead of being dropped. Non-image content is untouched.
   */
  private extractImageFileParts(
    message: SDKUserMessage,
  ): OpenCodeFilePartInput[] {
    const content = message.message?.content;
    if (!Array.isArray(content)) return [];
    const parts: OpenCodeFilePartInput[] = [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as {
        type?: string;
        source?: { type?: string; media_type?: string; data?: string };
      };
      if (b.type === "image" && b.source?.type === "base64" && b.source.data) {
        const mime = b.source.media_type || "image/png";
        parts.push({
          type: "file",
          mime,
          url: `data:${mime};base64,${b.source.data}`,
        });
      }
    }
    return parts;
  }

  /**
   * Find the OpenCode CLI path.
   */
  private async findOpenCodePath(): Promise<string | null> {
    // Use configured path if provided
    if (this.opencodePath && existsSync(this.opencodePath)) {
      return this.opencodePath;
    }

    // Check common locations. `~/.opencode/bin` is the official installer
    // location (curl opencode.ai/install); it is on PATH for login shells but
    // a server not launched through one may miss it, so check it explicitly.
    const commonPaths = [
      join(homedir(), ".opencode", "bin", "opencode"),
      join(homedir(), ".local", "bin", "opencode"),
      "/usr/local/bin/opencode",
      join(homedir(), "bin", "opencode"),
    ];

    for (const path of commonPaths) {
      if (existsSync(path)) {
        return path;
      }
    }

    // Try to find in PATH using which
    try {
      const { stdout } = await execAsync(whichCommand("opencode"), {
        encoding: "utf-8",
      });
      const resolved = selectOpenCodeBinary(stdout);
      if (resolved) {
        return resolved;
      }
    } catch {
      // Not in PATH
    }

    return null;
  }
}

/**
 * Default OpenCode provider instance.
 */
export const opencodeProvider = new OpenCodeProvider();
