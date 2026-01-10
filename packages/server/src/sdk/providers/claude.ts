import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type SDKMessage as AgentSDKMessage,
  type CanUseTool as SDKCanUseTool,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import type { ModelInfo } from "@yep-anywhere/shared";
import { logSDKMessage } from "../messageLogger.js";
import { MessageQueue } from "../messageQueue.js";
import type { ContentBlock, SDKMessage } from "../types.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";

/** Static list of Claude models */
const CLAUDE_MODELS: ModelInfo[] = [
  { id: "sonnet", name: "Sonnet" },
  { id: "opus", name: "Opus" },
  { id: "haiku", name: "Haiku" },
];

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
   * Returns a static list of known models.
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    return CLAUDE_MODELS;
  }

  /**
   * Start a new Claude session.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const queue = new MessageQueue();
    const abortController = new AbortController();

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

    // Create the SDK query with our message generator
    let iterator: AsyncGenerator<AgentSDKMessage>;
    try {
      iterator = query({
        prompt: queue.generator(),
        options: {
          cwd: options.cwd,
          resume: options.resumeSessionId,
          abortController,
          // Pass permission mode to SDK so Claude gets the appropriate system prompt.
          // Modes like "plan" need to be passed through for Claude to know it's in plan mode.
          // Our canUseTool callback handles the permission checking for custom modes.
          permissionMode: options.permissionMode ?? "default",
          canUseTool,
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: ["user", "project", "local"],
          includePartialMessages: true,
          // Model and thinking options
          model: options.model,
          maxThinkingTokens: options.maxThinkingTokens,
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
    const wrappedIterator = this.wrapIterator(iterator);

    return {
      iterator: wrappedIterator,
      queue,
      abort: () => abortController.abort(),
    };
  }

  /**
   * Wrap the SDK iterator to convert message types.
   * The SDK emits its own message types which we convert to our SDKMessage type.
   */
  private async *wrapIterator(
    iterator: AsyncGenerator<AgentSDKMessage>,
  ): AsyncIterableIterator<SDKMessage> {
    try {
      for await (const message of iterator) {
        // Log raw SDK message for analysis (if LOG_SDK_MESSAGES=true)
        const sessionId =
          (message as { session_id?: string }).session_id ?? "unknown";
        logSDKMessage(sessionId, message);
        yield this.convertMessage(message);
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
