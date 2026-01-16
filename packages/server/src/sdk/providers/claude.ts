import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type SDKMessage as AgentSDKMessage,
  type Query,
  type CanUseTool as SDKCanUseTool,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import type { ModelInfo, SlashCommand } from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { logSDKMessage } from "../messageLogger.js";
import { MessageQueue } from "../messageQueue.js";
import {
  checkRemotePath,
  createRemoteSpawn,
  testSSHConnection,
} from "../remote-spawn.js";
import { getProjectDirFromCwd, syncSessionFile } from "../session-sync.js";
import type { ContentBlock, SDKMessage } from "../types.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";

/** Static fallback list of Claude models (used if probe fails) */
const CLAUDE_MODELS_FALLBACK: ModelInfo[] = [
  {
    id: "sonnet",
    name: "Sonnet",
    description: "Best balance of speed and capability",
  },
  {
    id: "opus",
    name: "Opus",
    description: "Most capable model for complex tasks",
  },
  { id: "haiku", name: "Haiku", description: "Fastest model for simple tasks" },
];

/** Cached models from SDK probe */
let cachedModels: ModelInfo[] | null = null;

/** Promise for in-flight probe (to avoid duplicate probes) */
let probePromise: Promise<ModelInfo[]> | null = null;

/**
 * OAuth credentials from ~/.claude/.credentials.json
 */
interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
  };
}

/**
 * Claude provider implementation using @anthropic-ai/claude-agent-sdk.
 *
 * This class wraps the SDK's query() function and provides:
 * - MessageQueue for queuing user messages
 * - AbortController for cancellation
 * - Tool approval callbacks
 */
export class ClaudeProvider implements AgentProvider {
  readonly name = "claude" as const;
  readonly displayName = "Claude";
  readonly supportsPermissionMode = true;
  readonly supportsThinkingToggle = true;
  readonly supportsSlashCommands = true;

  /**
   * Check if Claude SDK is available.
   * Since we bundle the SDK, this is always true.
   */
  async isInstalled(): Promise<boolean> {
    return true;
  }

  /**
   * Check if Claude is authenticated.
   * Returns true if ANTHROPIC_API_KEY is set or OAuth credentials exist.
   */
  async isAuthenticated(): Promise<boolean> {
    const authStatus = await this.getAuthStatus();
    return authStatus.authenticated;
  }

  /**
   * Get detailed authentication status.
   * Checks for API key env var or OAuth credentials file.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    // Check for API key first
    if (process.env.ANTHROPIC_API_KEY) {
      return {
        installed: true,
        authenticated: true,
        enabled: true,
      };
    }

    // Check for OAuth credentials file
    const credsPath = join(homedir(), ".claude", ".credentials.json");
    if (!existsSync(credsPath)) {
      return {
        installed: true,
        authenticated: false,
        enabled: false,
      };
    }

    try {
      const creds: ClaudeCredentials = JSON.parse(
        readFileSync(credsPath, "utf-8"),
      );

      const oauth = creds.claudeAiOauth;
      if (!oauth?.accessToken && !oauth?.refreshToken) {
        return {
          installed: true,
          authenticated: false,
          enabled: false,
        };
      }

      // Check expiry - if expired but has refresh token, still authenticated
      // The SDK will handle token refresh
      let expiresAt: Date | undefined;
      let authenticated = true;
      if (oauth.expiresAt) {
        expiresAt = new Date(oauth.expiresAt);
        if (expiresAt < new Date() && !oauth.refreshToken) {
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

  /**
   * Get available Claude models.
   * Fetches dynamically from SDK via a probe session, with caching.
   * Falls back to static list if probe fails or user is not authenticated.
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    // Return cached models if available
    if (cachedModels) {
      return cachedModels;
    }

    // Check if user is authenticated before trying to probe
    const authStatus = await this.getAuthStatus();
    if (!authStatus.authenticated) {
      return CLAUDE_MODELS_FALLBACK;
    }

    // If probe is already in progress, wait for it
    if (probePromise) {
      return probePromise;
    }

    // Start a new probe
    probePromise = this.probeModels();
    try {
      const models = await probePromise;
      cachedModels = models;
      return models;
    } catch (error) {
      console.warn("[Claude] Failed to probe models, using fallback:", error);
      return CLAUDE_MODELS_FALLBACK;
    } finally {
      probePromise = null;
    }
  }

  /**
   * Probe for available models by starting a minimal session.
   * The session doesn't send any messages - it just calls supportedModels()
   * on the SDK query and then aborts.
   */
  private async probeModels(): Promise<ModelInfo[]> {
    const abortController = new AbortController();

    // Create a generator that never yields (session waits for messages)
    async function* emptyGenerator(): AsyncGenerator<never> {
      // Never yield - just wait indefinitely
      await new Promise(() => {});
    }

    try {
      const sdkQuery = query({
        prompt: emptyGenerator(),
        options: {
          cwd: homedir(), // Use home dir as neutral working directory
          abortController,
          permissionMode: "default",
          // Don't persist this probe session to disk
          persistSession: false,
        },
      });

      // Get models from SDK initialization
      const models = await sdkQuery.supportedModels();

      // Map SDK ModelInfo to our ModelInfo format
      return models.map((m) => ({
        id: m.value,
        name: m.displayName,
        description: m.description,
      }));
    } finally {
      // Always abort the probe session
      abortController.abort();
    }
  }

  /**
   * Start a new Claude session.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const log = getLogger();
    const queue = new MessageQueue();
    const abortController = new AbortController();

    // If remote executor specified, test connection first
    if (options.executor) {
      log.info(
        {
          event: "remote_session_start",
          executor: options.executor,
          cwd: options.cwd,
        },
        `Starting remote session on ${options.executor}`,
      );

      const testResult = await testSSHConnection(options.executor);
      if (!testResult.success) {
        throw new Error(
          `SSH connection to ${options.executor} failed: ${testResult.error}`,
        );
      }
      if (!testResult.claudeAvailable) {
        throw new Error(
          `Claude CLI not found on ${options.executor}. Install with: curl -fsSL https://claude.ai/install.sh | bash`,
        );
      }

      // Check if the working directory exists on the remote
      if (options.cwd) {
        const pathCheck = await checkRemotePath(options.executor, options.cwd);
        if (!pathCheck.exists) {
          throw new Error(
            `Directory does not exist on ${options.executor}: ${options.cwd}`,
          );
        }
      }
    }

    // Push the initial message into the queue (if provided)
    // If no message, the agent will wait until one is pushed
    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    // Wrap our canUseTool to match SDK's expected type
    const onToolApproval = options.onToolApproval;
    const canUseTool: SDKCanUseTool | undefined = onToolApproval
      ? async (toolName, input, opts) => {
          console.log(`[canUseTool] Called for tool: ${toolName}`);
          const result = await onToolApproval(toolName, input, opts);
          console.log(
            `[canUseTool] Result for ${toolName}: ${result.behavior}`,
          );
          // Convert our result to SDK's PermissionResult format
          if (result.behavior === "allow") {
            return {
              behavior: "allow" as const,
              updatedInput: (result.updatedInput ?? input) as Record<
                string,
                unknown
              >,
            };
          }
          return {
            behavior: "deny" as const,
            message: result.message ?? "Permission denied",
            interrupt: result.interrupt,
          };
        }
      : undefined;

    // Create remote spawn function if executor specified
    const spawnClaudeCodeProcess = options.executor
      ? createRemoteSpawn({
          host: options.executor,
          remoteEnv: options.remoteEnv,
        })
      : undefined;

    // Create the SDK query with our message generator
    let sdkQuery: Query;
    try {
      sdkQuery = query({
        prompt: queue.generator(),
        options: {
          cwd: options.cwd,
          resume: options.resumeSessionId,
          abortController,
          // Pass permission mode to SDK for system prompt configuration.
          // However, for "bypassPermissions" we pass "default" to the SDK so it always
          // calls our canUseTool callback - we handle the bypass logic ourselves to
          // allow exceptions (e.g., always prompting for AskUserQuestion/ExitPlanMode).
          permissionMode:
            options.permissionMode === "bypassPermissions"
              ? "default"
              : (options.permissionMode ?? "default"),
          canUseTool,
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: ["user", "project", "local"],
          includePartialMessages: true,
          // Model and thinking options
          model: options.model,
          maxThinkingTokens: options.maxThinkingTokens,
          // Remote execution via SSH
          spawnClaudeCodeProcess,
        },
      });
    } catch (error) {
      // Handle common SDK initialization errors
      if (error instanceof Error) {
        if (error.message.includes("Claude Code executable not found")) {
          throw new Error(
            "Claude CLI not installed. Run: curl -fsSL https://claude.ai/install.sh | bash",
          );
        }
        if (
          error.message.includes("SPAWN") ||
          error.message.includes("spawn")
        ) {
          throw new Error(
            `Failed to spawn Claude CLI process: ${error.message}`,
          );
        }
      }
      throw error;
    }

    // Wrap the iterator to convert SDK message types to our internal types
    // Pass executor info for session sync after result messages
    const wrappedIterator = this.wrapIterator(sdkQuery, {
      executor: options.executor,
      cwd: options.cwd,
      remoteEnv: options.remoteEnv,
    });

    return {
      iterator: wrappedIterator,
      queue,
      abort: () => abortController.abort(),
      setMaxThinkingTokens: (tokens: number | null) =>
        sdkQuery.setMaxThinkingTokens(tokens),
      interrupt: () => sdkQuery.interrupt(),
      supportedModels: async (): Promise<ModelInfo[]> => {
        const models = await sdkQuery.supportedModels();
        // Map SDK ModelInfo (value, displayName, description) to our ModelInfo (id, name, description)
        const mappedModels = models.map((m) => ({
          id: m.value,
          name: m.displayName,
          description: m.description,
        }));
        // Update cache for future getAvailableModels() calls
        cachedModels = mappedModels;
        return mappedModels;
      },
      supportedCommands: async (): Promise<SlashCommand[]> => {
        const commands = await sdkQuery.supportedCommands();
        // Map SDK SlashCommand to our SlashCommand (same fields, just normalize)
        return commands.map((c) => ({
          name: c.name,
          description: c.description,
          argumentHint: c.argumentHint || undefined,
        }));
      },
      setModel: (model?: string) => sdkQuery.setModel(model),
    };
  }

  /**
   * Wrap the SDK iterator to convert message types.
   * The SDK emits its own message types which we convert to our SDKMessage type.
   *
   * For remote sessions, syncs session files after each result message.
   */
  private async *wrapIterator(
    iterator: AsyncIterable<AgentSDKMessage>,
    remoteOptions?: {
      executor?: string;
      cwd: string;
      remoteEnv?: Record<string, string>;
    },
  ): AsyncIterableIterator<SDKMessage> {
    const log = getLogger();
    let sessionId = "unknown";

    try {
      for await (const message of iterator) {
        // Log raw SDK message for analysis (if LOG_SDK_MESSAGES=true)
        sessionId =
          (message as { session_id?: string }).session_id ?? sessionId;
        logSDKMessage(sessionId, message);

        const converted = this.convertMessage(message);
        yield converted;

        // For remote sessions, sync session files after result messages
        // This keeps the local UI up-to-date with remote progress
        if (
          remoteOptions?.executor &&
          converted.type === "result" &&
          sessionId !== "unknown"
        ) {
          const projectDir = getProjectDirFromCwd(remoteOptions.cwd);
          log.debug(
            {
              event: "remote_session_sync",
              executor: remoteOptions.executor,
              sessionId,
              projectDir,
            },
            "Syncing session from remote after turn",
          );

          // Sync in background - don't block the iterator
          syncSessionFile(
            remoteOptions.executor,
            projectDir,
            sessionId,
            undefined,
            remoteOptions.remoteEnv?.CLAUDE_SESSIONS_DIR,
          ).catch((error) => {
            log.warn(
              {
                event: "remote_session_sync_error",
                executor: remoteOptions.executor,
                sessionId,
                error: error instanceof Error ? error.message : String(error),
              },
              `Failed to sync session from remote: ${error}`,
            );
          });
        }
      }
    } catch (error) {
      // Handle abort errors gracefully
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      // Re-throw process termination errors for Process to handle
      // These include: "ProcessTransport is not ready for writing"
      throw error;
    }
  }

  /**
   * Convert an SDK message to our internal SDKMessage format.
   *
   * We pass through all fields from the SDK without stripping.
   * This preserves debugging info, DAG structure, and metadata.
   */
  private convertMessage(message: AgentSDKMessage): SDKMessage {
    // Pass through all fields, only normalize content blocks
    const sdkMessage = message as unknown as SDKMessage;

    // For messages with content, normalize the content blocks
    if (sdkMessage.message?.content) {
      return {
        ...sdkMessage,
        message: {
          ...sdkMessage.message,
          content: this.normalizeContent(sdkMessage.message.content),
        },
      };
    }

    // Pass through as-is for messages without content
    return sdkMessage;
  }

  /**
   * Normalize content to ensure consistent format.
   * Preserves all fields, only converts strings to text blocks.
   */
  private normalizeContent(
    content: string | ContentBlock[] | unknown,
  ): string | ContentBlock[] {
    // String content stays as string
    if (typeof content === "string") {
      return content;
    }

    // Array content - normalize each block
    if (Array.isArray(content)) {
      return content.map((block): ContentBlock => {
        if (typeof block === "string") {
          return { type: "text", text: block };
        }
        // Pass through all block fields - don't strip anything
        return block as ContentBlock;
      });
    }

    // Unknown content type - stringify for safety
    return String(content);
  }
}

/**
 * Default Claude provider instance.
 * Can be imported for convenience or instantiated directly.
 */
export const claudeProvider = new ClaudeProvider();
