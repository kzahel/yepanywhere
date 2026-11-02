import { nativeStorageScope } from "./native-storage-scope.js";
/**
 * Gemini ACP Provider implementation using Agent Client Protocol.
 *
 * Gemini uses a hybrid model where it executes its own tools internally,
 * but asks for permission on sensitive operations (file writes, shell commands).
 * This provider handles those permission requests by converting them to
 * yepanywhere's InputRequest format and routing through the Process approval flow.
 */

import { exec, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { ModelCatalogStatus, ModelInfo } from "@yep-anywhere/shared";
import { fromUrlProjectId, parseNativeSessionId } from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { selectCommandLookupTarget } from "../cli-detection.js";
import { whichCommand } from "../which-command.js";
const execAsync = promisify(exec);
import { MessageQueue } from "../messageQueue.js";
import type {
  PermissionMode,
  SDKMessage,
  ToolApprovalResult,
} from "../types.js";
import { ACPClient, acpErrorMessage } from "./acp/client.js";
import { stripYaControlPlaneCredentials } from "./env-filter.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  ProviderName,
  StartSessionOptions,
} from "./types.js";
import { assertProviderForkSource } from "./types.js";

/** Standard Gemini models (always available) */
const GEMINI_MODELS: ModelInfo[] = [
  { id: "auto", name: "Auto (recommended)" },
  { id: "gemini-3-pro", name: "Gemini 3 Pro" },
  { id: "gemini-3-flash", name: "Gemini 3 Flash" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
  { id: "gemini-2.0-flash-lite", name: "Gemini 2.0 Flash Lite" },
];

/** Preview models (require previewFeatures enabled in ~/.gemini/settings.json) */
const GEMINI_PREVIEW_MODELS: ModelInfo[] = [];

/**
 * Configuration for Gemini ACP provider.
 */
export interface GeminiACPProviderConfig {
  /** Path to gemini binary (auto-detected if not specified) */
  geminiPath?: string;
}

/**
 * OAuth credentials from ~/.gemini/oauth_creds.json
 */
interface GeminiOAuthCreds {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
}

/**
 * Settings from ~/.gemini/settings.json
 */
interface GeminiSettings {
  general?: {
    previewFeatures?: boolean;
  };
}

/**
 * Gemini ACP Provider implementation.
 *
 * Uses the Gemini CLI's `--experimental-acp` mode for ACP protocol support.
 * The agent controls its own loop; we execute filesystem/terminal operations.
 */
export class GeminiACPProvider implements AgentProvider {
  readonly supportsNativeResumeSource = true;
  readonly name: ProviderName = "gemini-acp";
  readonly displayName = "Gemini (ACP)";
  // In Phase 1, permission modes don't do anything since we have no tools
  // In Phase 2, this will be true and we'll handle approvals
  readonly supportsPermissionMode = true;
  readonly supportsThinkingToggle = false;
  readonly supportsSlashCommands = false;
  readonly supportsSteering = false;

  private readonly geminiPath?: string;
  private log = getLogger();

  constructor(config: GeminiACPProviderConfig = {}) {
    this.geminiPath = config.geminiPath;
  }

  /**
   * Check if the Gemini CLI is installed.
   */
  async isInstalled(): Promise<boolean> {
    const path = await this.findGeminiPath();
    return path !== null;
  }

  /**
   * Check if Gemini is authenticated.
   */
  async isAuthenticated(): Promise<boolean> {
    const authStatus = await this.getAuthStatus();
    return authStatus.authenticated;
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

    // Read OAuth credentials from ~/.gemini/oauth_creds.json
    const credsPath = join(homedir(), ".gemini", "oauth_creds.json");
    if (!existsSync(credsPath)) {
      return {
        installed: true,
        authenticated: false,
        enabled: false,
      };
    }

    try {
      const creds: GeminiOAuthCreds = JSON.parse(
        readFileSync(credsPath, "utf-8"),
      );

      // Check if tokens exist
      if (!creds.access_token && !creds.refresh_token) {
        return {
          installed: true,
          authenticated: false,
          enabled: false,
        };
      }

      // Check expiry
      let expiresAt: Date | undefined;
      let authenticated = true;
      if (creds.expiry_date) {
        expiresAt = new Date(creds.expiry_date);
        // If access token is expired but we have refresh token, still consider authenticated
        // The CLI will handle token refresh
        if (expiresAt < new Date() && !creds.refresh_token) {
          authenticated = false;
        }
      }

      return {
        installed: true,
        authenticated,
        enabled: authenticated,
        expiresAt,
      };
    } catch {
      return {
        installed: true,
        authenticated: false,
        enabled: false,
      };
    }
  }

  getModelCatalogStatus(): ModelCatalogStatus {
    return { source: "static" };
  }

  /**
   * Get available Gemini models.
   * Returns standard models plus preview models if previewFeatures is enabled.
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    const models = [...GEMINI_MODELS];

    // Check if preview features are enabled
    if (this.hasPreviewFeaturesEnabled()) {
      models.push(...GEMINI_PREVIEW_MODELS);
    }

    return models;
  }

  /**
   * Check if preview features are enabled in ~/.gemini/settings.json
   */
  private hasPreviewFeaturesEnabled(): boolean {
    const settingsPath = join(homedir(), ".gemini", "settings.json");
    if (!existsSync(settingsPath)) {
      return false;
    }

    try {
      const settings: GeminiSettings = JSON.parse(
        readFileSync(settingsPath, "utf-8"),
      );
      return settings.general?.previewFeatures === true;
    } catch {
      return false;
    }
  }

  /**
   * Start a new Gemini ACP session.
   */
  async getNewSessionNamespace(cwd: string) {
    return {
      family: "gemini" as const,
      storageScope: await nativeStorageScope(
        resolve(
          await realpath(cwd),
          join(process.env.GEMINI_CLI_HOME || homedir(), ".gemini", "tmp"),
        ),
      ),
    };
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const source = options.nativeResumeSource;
    if (source) {
      if (
        !options.resumeSessionId ||
        !source.filePath ||
        options.executor ||
        options.sessionSandbox
      )
        throw new Error(
          "Gemini scoped continuation requires its local native source",
        );
      assertProviderForkSource(
        {
          nativeSessionId: parseNativeSessionId(options.resumeSessionId),
          nativeSource: source,
        },
        this.name,
      );
      const home = process.env.GEMINI_CLI_HOME || homedir();
      if (!isAbsolute(home))
        throw new Error(
          "Gemini scoped continuation requires an absolute native home",
        );
      const scope = await realpath(join(home, ".gemini", "tmp"));
      const path = relative(scope, await realpath(source.filePath));
      if (
        scope !== source.native.storageScope ||
        !path ||
        path === ".." ||
        path.startsWith(".." + sep) ||
        isAbsolute(path)
      )
        throw new Error(
          "Gemini continuation is outside the launch session store",
        );
      if (
        (await realpath(fromUrlProjectId(source.projectId))) !==
        (await realpath(options.cwd))
      )
        throw new Error(
          "Gemini continuation cannot change its native working project",
        );
    }
    const queue = new MessageQueue();
    const abortController = new AbortController();

    // Push initial message if provided
    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    const client = new ACPClient();
    const iterator = this.runSession(
      client,
      options,
      queue,
      abortController.signal,
    );

    return {
      iterator,
      queue,
      abort: () => {
        abortController.abort();
        return client.close();
      },
      get pid() {
        return client.pid;
      },
      isProcessAlive: () => client.isProcessAlive,
    };
  }

  /**
   * Main session loop using ACP protocol.
   */
  private async *runSession(
    client: ACPClient,
    options: StartSessionOptions,
    queue: MessageQueue,
    signal: AbortSignal,
  ): AsyncIterableIterator<SDKMessage> {
    if (signal.aborted) return;
    const geminiPath = await this.findGeminiPath();
    if (!geminiPath) {
      yield {
        type: "error",
        error:
          "Gemini CLI not found. Install it with: npm install -g @google/gemini-cli",
      } as SDKMessage;
      return;
    }

    // Check if experimental ACP is supported
    const supportsACP = await this.checkACPSupport(geminiPath);
    if (!supportsACP) {
      yield {
        type: "error",
        error:
          "Gemini CLI does not support --experimental-acp. Please update to the latest version.",
      } as SDKMessage;
      return;
    }

    // Build args for ACP mode
    const args = ["--experimental-acp"];
    if (options.model && options.model !== "auto") {
      args.push("--model", options.model);
    }
    // Note: Session resumption is handled via ACP protocol (session/resume),
    // not CLI flags. The --resume flag doesn't work with ACP mode.

    // Collect session updates to convert to SDKMessages
    const updateQueue: SessionNotification[] = [];
    let updateResolver: (() => void) | null = null;

    client.setSessionUpdateCallback((update) => {
      updateQueue.push(update);
      if (updateResolver) {
        updateResolver();
        updateResolver = null;
      }
    });

    // Set up permission request handler if onToolApproval callback provided
    this.log.debug(
      { hasOnToolApproval: !!options.onToolApproval },
      "Setting up ACP permission handler",
    );
    if (options.onToolApproval) {
      client.setPermissionRequestCallback(async (request) => {
        this.log.debug({ request }, "Permission callback invoked");
        return this.handlePermissionRequest(request, options, signal);
      });
    } else {
      this.log.warn(
        "No onToolApproval callback provided - permissions will be auto-denied",
      );
    }

    const input = queue[Symbol.asyncIterator]();
    const stopInput = () => {
      void input.return();
    };
    signal.addEventListener("abort", stopInput);
    void client.closed.then(stopInput);
    if (signal.aborted) stopInput();
    try {
      // Connect to the ACP agent
      const connectStart = Date.now();
      await client.connect({
        command: geminiPath,
        args,
        cwd: options.cwd,
      });
      this.log.info(
        { durationMs: Date.now() - connectStart },
        "Gemini ACP connected (--experimental-acp mode)",
      );

      const initStart = Date.now();
      await client.initialize({});
      this.log.debug(
        { durationMs: Date.now() - initStart },
        "Gemini ACP initialized",
      );

      // Create or resume session with the ACP server.
      // Use session/resume for existing sessions, session/new for fresh sessions.
      let sessionId: string;
      if (options.resumeSessionId) {
        sessionId = await client.resumeSession(
          options.resumeSessionId,
          options.cwd,
        );
        this.log.debug({ sessionId }, "ACP session resumed");
      } else {
        sessionId = await client.newSession(options.cwd);
        this.log.debug({ sessionId }, "ACP session created");
      }

      // Emit init message
      yield {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        cwd: options.cwd,
      } as SDKMessage;

      // Process messages from the queue
      const messageGen = input;
      let isFirstNewMessage = true;
      for await (const message of messageGen) {
        if (signal.aborted) break;

        // Extract text from the message
        let userText = this.extractTextFromMessage(message);

        // Prepend global instructions to the first message of new sessions
        if (isFirstNewMessage && options.globalInstructions) {
          userText = `[Global context]\n${options.globalInstructions}\n\n---\n\n${userText}`;
        }
        isFirstNewMessage = false;

        // Emit user message
        // SDKUserMessage has uuid at top level
        const userUuid = (message as { uuid?: string }).uuid ?? randomUUID();
        yield {
          type: "user",
          uuid: userUuid,
          session_id: sessionId,
          message: {
            role: "user",
            content: userText,
          },
        } as SDKMessage;

        // Clear update queue before sending prompt
        updateQueue.length = 0;

        // Send prompt to agent (this blocks until agent responds)
        // Updates are collected via callback during this time
        const promptStart = Date.now();
        this.log.debug(
          { textLength: userText.length },
          "Sending prompt to Gemini",
        );
        const promptPromise = client.prompt(sessionId, userText);

        // Yield updates from the async generator
        for await (const msg of this.yieldUpdates(
          promptPromise,
          updateQueue,
          sessionId,
          signal,
        )) {
          yield msg;
        }
        await promptPromise;
        if (!signal.aborted)
          options.onNativeInputConsumed?.(sessionId, userUuid);
        this.log.debug(
          { durationMs: Date.now() - promptStart },
          "Gemini prompt complete",
        );

        // Emit result for this turn
        yield {
          type: "result",
          session_id: sessionId,
        } as SDKMessage;
      }
    } catch (err) {
      this.log.error({ err }, "Gemini ACP session error");
      yield {
        type: "error",
        error: acpErrorMessage(err),
      } as SDKMessage;
    } finally {
      signal.removeEventListener("abort", stopInput);
      await input.return();
      await client.close();
    }
  }

  /**
   * Handle ACP permission request by routing to yepanywhere's approval flow.
   *
   * Converts ACP's RequestPermissionRequest to our CanUseTool format,
   * waits for user approval, and converts the result back to ACP format.
   */
  private async handlePermissionRequest(
    request: RequestPermissionRequest,
    options: StartSessionOptions,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    const { onToolApproval, permissionMode } = options;
    if (!onToolApproval) {
      // No approval handler - deny by default
      return { outcome: { outcome: "cancelled" } };
    }

    const toolCall = request.toolCall;
    const kind = toolCall.kind ?? "other";

    // Check if we should auto-approve based on permission mode
    if (this.shouldAutoApprove(kind, permissionMode)) {
      this.log.debug(
        { kind, permissionMode },
        "Auto-approving ACP permission request",
      );
      // Find the "allow_once" option to return
      const allowOnceOption = request.options.find(
        (o) => o.kind === "allow_once",
      );
      return {
        outcome: {
          outcome: "selected",
          optionId: allowOnceOption?.optionId ?? "proceed_once",
        },
      };
    }

    // Map ACP toolCall.kind to a tool name for the approval UI
    const toolName = this.mapKindToToolName(kind, toolCall.title ?? undefined);

    // Build input for the approval dialog
    const toolInput = {
      kind,
      title: toolCall.title,
      locations: toolCall.locations,
      content: toolCall.content,
      rawInput: toolCall.rawInput,
    };

    this.log.debug(
      { toolName, toolInput },
      "Requesting user approval for ACP permission",
    );

    // Call the onToolApproval callback and wait for user response
    const result = await onToolApproval(toolName, toolInput, { signal });

    // Convert result back to ACP format
    return this.convertApprovalResultToACPResponse(result, request);
  }

  /**
   * Check if we should auto-approve based on permission mode and tool kind.
   */
  private shouldAutoApprove(
    kind: ToolKind | null | undefined,
    permissionMode?: PermissionMode,
  ): boolean {
    switch (permissionMode) {
      case "bypassPermissions":
        // Auto-approve all tools
        return true;

      case "acceptEdits":
        // Auto-approve file edits, but not shell commands
        return kind === "edit" || kind === "read" || kind === "search";

      case "plan":
        // Read-only tools only (Gemini shouldn't be asking for reads, but just in case)
        return kind === "read" || kind === "search" || kind === "fetch";

      default:
        // Default mode - no auto-approve, ask for everything
        return false;
    }
  }

  /**
   * Map ACP tool kind to a human-readable tool name for the approval UI.
   */
  private mapKindToToolName(
    kind: ToolKind | null | undefined,
    title?: string,
  ): string {
    switch (kind) {
      case "edit":
        return "Write";
      case "delete":
        return "Delete";
      case "move":
        return "Move";
      case "execute":
        return "Bash";
      case "read":
        return "Read";
      case "search":
        return "Search";
      case "fetch":
        return "WebFetch";
      case "think":
        return "Think";
      case "switch_mode":
        return "SwitchMode";
      default:
        // Use title if available, otherwise generic name
        return title ?? "GeminiTool";
    }
  }

  /**
   * Convert our ToolApprovalResult to ACP's RequestPermissionResponse.
   */
  private convertApprovalResultToACPResponse(
    result: ToolApprovalResult,
    request: RequestPermissionRequest,
  ): RequestPermissionResponse {
    if (result.behavior === "allow") {
      // User approved - find the appropriate option ID
      // Prefer "allow_once" unless we want to remember the choice
      const allowOnceOption = request.options.find(
        (o) => o.kind === "allow_once",
      );
      const allowAlwaysOption = request.options.find(
        (o) => o.kind === "allow_always",
      );

      // TODO: Support "allow_always" when user checks "Remember this choice"
      const selectedOption = allowOnceOption ?? allowAlwaysOption;

      if (selectedOption) {
        return {
          outcome: {
            outcome: "selected",
            optionId: selectedOption.optionId,
          },
        };
      }

      // Fallback if no options found
      return {
        outcome: {
          outcome: "selected",
          optionId: "proceed_once",
        },
      };
    }

    // User denied - return cancelled
    return { outcome: { outcome: "cancelled" } };
  }

  /**
   * Async generator to yield session updates as SDKMessages.
   */
  private async *yieldUpdates(
    promptPromise: Promise<unknown>,
    updateQueue: SessionNotification[],
    sessionId: string,
    signal: AbortSignal,
  ): AsyncIterableIterator<SDKMessage> {
    let promptDone = false;

    // Set up promise to track completion
    promptPromise
      .then(() => {
        promptDone = true;
      })
      .catch((err) => {
        promptDone = true;
        this.log.error({ err }, "Prompt error");
      });

    // Track text content for assistant messages
    let assistantTextBuffer = "";
    let assistantMessageId: string | null = null;

    while (!signal.aborted && !promptDone) {
      // Wait a bit for updates to accumulate
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Process all queued updates
      while (updateQueue.length > 0) {
        const notification = updateQueue.shift();
        if (!notification) break;

        // SessionNotification has { sessionId, update: SessionUpdate }
        const sessionUpdate = notification.update;

        // Handle text chunks - accumulate them
        if (
          sessionUpdate.sessionUpdate === "agent_message_chunk" &&
          "content" in sessionUpdate
        ) {
          const content = sessionUpdate.content;
          if (content && typeof content === "object" && "type" in content) {
            if (content.type === "text" && "text" in content) {
              assistantTextBuffer += content.text;
              if (!assistantMessageId) {
                assistantMessageId = randomUUID();
              }
            }
          }
          continue; // Don't emit yet, wait for more chunks
        }

        // When we see a non-chunk update, flush the buffer
        if (assistantTextBuffer) {
          yield {
            type: "assistant",
            uuid: assistantMessageId ?? undefined,
            session_id: sessionId,
            message: {
              role: "assistant",
              content: assistantTextBuffer,
            },
          } as SDKMessage;
          assistantTextBuffer = "";
          assistantMessageId = null;
        }

        // Now process the current update
        const sdkMessage = this.convertUpdateToSDKMessage(
          sessionUpdate,
          sessionId,
        );
        if (sdkMessage) {
          yield sdkMessage;
        }
      }
    }

    // Flush any remaining text buffer
    if (assistantTextBuffer) {
      yield {
        type: "assistant",
        uuid: assistantMessageId ?? undefined,
        session_id: sessionId,
        message: {
          role: "assistant",
          content: assistantTextBuffer,
        },
      } as SDKMessage;
    }
  }

  /**
   * Convert an ACP session update to an SDKMessage.
   */
  private convertUpdateToSDKMessage(
    update: SessionUpdate,
    sessionId: string,
  ): SDKMessage | null {
    // SessionUpdate has a sessionUpdate field that discriminates the type
    const updateType = update.sessionUpdate;

    switch (updateType) {
      case "agent_message_chunk": {
        // Text content from the agent
        // This is handled specially in yieldUpdates for buffering
        // But if it gets here, convert it directly
        // ContentChunk has `content: ContentBlock` (single block, not array)
        if ("content" in update) {
          const contentBlock = update.content;
          if (
            contentBlock &&
            typeof contentBlock === "object" &&
            "type" in contentBlock &&
            contentBlock.type === "text" &&
            "text" in contentBlock
          ) {
            return {
              type: "assistant",
              session_id: sessionId,
              message: {
                role: "assistant",
                content: contentBlock.text as string,
              },
            } as SDKMessage;
          }
        }
        return null;
      }

      case "tool_call": {
        // Agent wants to use a tool
        const toolUpdate = update as {
          toolCallId?: string;
          title?: string;
          status?: string;
        };
        return {
          type: "assistant",
          session_id: sessionId,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: toolUpdate.toolCallId ?? randomUUID(),
                name: toolUpdate.title ?? "unknown_tool",
                input: {},
              },
            ],
          },
        } as SDKMessage;
      }

      case "tool_call_update": {
        // Tool call status changed (completed, failed, etc.)
        const toolResultUpdate = update as {
          toolCallId?: string;
          status?: string;
          error?: string;
        };
        // Only emit if there's useful info
        if (toolResultUpdate.error) {
          return {
            type: "user",
            session_id: sessionId,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolResultUpdate.toolCallId ?? "",
                  content: toolResultUpdate.error,
                },
              ],
            },
          } as SDKMessage;
        }
        return null;
      }

      case "plan": {
        // Agent's planning/reasoning (could map to thinking)
        const planUpdate = update as { content?: string };
        if (planUpdate.content) {
          return {
            type: "assistant",
            session_id: sessionId,
            message: {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: planUpdate.content,
                },
              ],
            },
          } as SDKMessage;
        }
        return null;
      }

      default:
        this.log.trace({ updateType, update }, "Unhandled ACP update type");
        return null;
    }
  }

  /**
   * Extract text content from a user message.
   */
  private extractTextFromMessage(message: unknown): string {
    if (!message || typeof message !== "object") {
      return "";
    }

    // Handle UserMessage format
    const userMsg = message as { text?: string };
    if (typeof userMsg.text === "string") {
      return userMsg.text;
    }

    // Handle SDK message format
    const sdkMsg = message as {
      message?: { content?: string | unknown[] };
    };
    const content = sdkMsg.message?.content;

    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((block: unknown) => {
          if (typeof block === "string") return block;
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            (block as { type: string }).type === "text" &&
            "text" in block
          ) {
            return (block as { text: string }).text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }

    return "";
  }

  /**
   * Check if the Gemini CLI supports ACP mode.
   */
  private async checkACPSupport(geminiPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      // Try to spawn with --experimental-acp --help to see if it's supported
      // If it fails or doesn't recognize the flag, ACP isn't supported
      const proc = spawn(geminiPath, ["--help"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: stripYaControlPlaneCredentials(process.env),
        shell: process.platform === "win32",
      });

      let output = "";
      proc.stdout?.on("data", (data) => {
        output += data.toString();
      });
      proc.stderr?.on("data", (data) => {
        output += data.toString();
      });

      proc.on("close", () => {
        clearTimeout(timeoutId);
        // Check if the help output mentions experimental-acp
        resolve(output.includes("experimental-acp"));
      });

      proc.on("error", () => {
        clearTimeout(timeoutId);
        resolve(false);
      });

      // Timeout after 5 seconds
      const timeoutId = setTimeout(() => {
        proc.kill();
        resolve(false);
      }, 5000);
    });
  }

  /**
   * Find the Gemini CLI path.
   */
  private async findGeminiPath(): Promise<string | null> {
    // Use configured path if provided
    if (this.geminiPath && existsSync(this.geminiPath)) {
      return this.geminiPath;
    }

    // Check common locations
    const commonPaths = [
      join(homedir(), ".local", "bin", "gemini"),
      "/usr/local/bin/gemini",
      join(homedir(), ".gemini", "bin", "gemini"),
      join(homedir(), "bin", "gemini"),
    ];

    for (const path of commonPaths) {
      if (existsSync(path)) {
        return path;
      }
    }

    // Try to find in PATH using which
    try {
      const { stdout } = await execAsync(whichCommand("gemini"), {
        encoding: "utf-8",
      });
      const result = selectCommandLookupTarget(
        stdout,
        "shell",
        process.platform,
        existsSync,
      );
      if (result) return result;
    } catch {
      // Not in PATH
    }

    return null;
  }
}

/**
 * Default Gemini ACP provider instance.
 */
export const geminiACPProvider = new GeminiACPProvider();
