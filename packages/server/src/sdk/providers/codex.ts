/**
 * Codex Provider implementation using @openai/codex-sdk.
 *
 * Uses the official Codex SDK for programmatic agent control.
 * The SDK reads auth from ~/.codex/auth.json automatically.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Codex,
  type CodexOptions,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
} from "@openai/codex-sdk";
import type { ModelInfo } from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { MessageQueue } from "../messageQueue.js";
import type { SDKMessage, UserMessage } from "../types.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";

const log = getLogger().child({ component: "codex-provider" });

/**
 * Configuration for Codex provider.
 */
export interface CodexProviderConfig {
  /** Path to codex binary (auto-detected if not specified) */
  codexPath?: string;
  /** API base URL override */
  baseUrl?: string;
  /** API key override (normally read from ~/.codex/auth.json) */
  apiKey?: string;
}

/**
 * Auth info from ~/.codex/auth.json
 */
interface CodexAuthJson {
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

/**
 * Codex Provider implementation using the official SDK.
 *
 * Uses `@openai/codex-sdk` for streaming agent responses.
 * Auth is handled by the SDK reading from ~/.codex/auth.json.
 */
export class CodexProvider implements AgentProvider {
  readonly name = "codex" as const;
  readonly displayName = "Codex";
  readonly supportsPermissionMode = false;
  readonly supportsThinkingToggle = false;
  readonly supportsSlashCommands = false;

  private readonly config: CodexProviderConfig;
  private codexInstance: Codex | null = null;

  constructor(config: CodexProviderConfig = {}) {
    this.config = config;
  }

  /**
   * Get or create the Codex SDK instance.
   */
  private getCodex(): Codex {
    if (!this.codexInstance) {
      const options: CodexOptions = {};

      if (this.config.codexPath) {
        options.codexPathOverride = this.config.codexPath;
      }
      if (this.config.baseUrl) {
        options.baseUrl = this.config.baseUrl;
      }
      if (this.config.apiKey) {
        options.apiKey = this.config.apiKey;
      }

      this.codexInstance = new Codex(options);
    }
    return this.codexInstance;
  }

  /**
   * Check if the Codex SDK/CLI is available.
   */
  async isInstalled(): Promise<boolean> {
    // The SDK wraps the CLI, so check if auth file exists
    // which indicates the CLI has been set up
    const authPath = join(homedir(), ".codex", "auth.json");
    return existsSync(authPath);
  }

  /**
   * Check if Codex is authenticated.
   */
  async isAuthenticated(): Promise<boolean> {
    const authStatus = await this.getAuthStatus();
    return authStatus.authenticated;
  }

  /**
   * Get detailed authentication status.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    const authPath = join(homedir(), ".codex", "auth.json");

    if (!existsSync(authPath)) {
      return {
        installed: false,
        authenticated: false,
        enabled: false,
      };
    }

    try {
      const authData: CodexAuthJson = JSON.parse(
        readFileSync(authPath, "utf-8"),
      );

      // Check if we have OAuth tokens or API key
      const hasTokens =
        authData.tokens?.access_token || authData.tokens?.refresh_token;
      const hasApiKey =
        authData.OPENAI_API_KEY && authData.OPENAI_API_KEY !== null;

      if (!hasTokens && !hasApiKey) {
        return {
          installed: true,
          authenticated: false,
          enabled: false,
        };
      }

      return {
        installed: true,
        authenticated: true,
        enabled: true,
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
   * Get available models for Codex cloud.
   * Returns hardcoded list of known Codex models.
   * See: https://developers.openai.com/codex/models/
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    // Codex cloud models - see https://developers.openai.com/codex/models/
    return [
      { id: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
      { id: "gpt-5-codex", name: "GPT-5 Codex" },
      { id: "gpt-5-codex-mini", name: "GPT-5 Codex Mini" },
      { id: "codex-mini-latest", name: "Codex Mini" },
    ];
  }

  /**
   * Start a new Codex session.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const queue = new MessageQueue();
    const abortController = new AbortController();

    // Push initial message if provided
    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    const iterator = this.runSession(options, queue, abortController.signal);

    return {
      iterator,
      queue,
      abort: () => abortController.abort(),
    };
  }

  /**
   * Main session loop using the SDK.
   */
  private async *runSession(
    options: StartSessionOptions,
    queue: MessageQueue,
    signal: AbortSignal,
  ): AsyncIterableIterator<SDKMessage> {
    const codex = this.getCodex();

    // Build thread options
    const threadOptions: ThreadOptions = {
      workingDirectory: options.cwd,
    };

    if (options.model) {
      threadOptions.model = options.model;
    }

    // Map permission mode to sandbox mode
    if (options.permissionMode === "bypassPermissions") {
      threadOptions.sandboxMode = "danger-full-access";
      threadOptions.approvalPolicy = "never";
    } else {
      threadOptions.sandboxMode = "workspace-write";
      threadOptions.approvalPolicy = "on-failure";
    }

    // Start or resume thread
    let thread: Thread;
    if (options.resumeSessionId) {
      log.debug(
        { resumeSessionId: options.resumeSessionId },
        "Resuming thread",
      );
      thread = codex.resumeThread(options.resumeSessionId, threadOptions);
    } else {
      log.debug({ threadOptions }, "Starting new thread");
      thread = codex.startThread(threadOptions);
    }

    // Session ID - will be set from thread.started event
    // For resume, we already have the real ID
    let sessionId = options.resumeSessionId ?? "";
    let initEmitted = !!options.resumeSessionId;

    // Turn counter for generating unique UUIDs
    // Codex SDK reuses item_0, item_1, etc. within each turn, so we need
    // to combine with turn number to create globally unique IDs
    let turnNumber = 0;

    // If resuming, emit init immediately with known ID
    if (options.resumeSessionId) {
      yield {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        cwd: options.cwd,
      } as SDKMessage;
    }

    // Process messages from the queue
    log.debug("Starting message queue processing");
    const messageGen = queue.generator();

    for await (const message of messageGen) {
      log.debug({ messageType: typeof message }, "Received message from queue");
      if (signal.aborted) {
        log.debug("Signal aborted, breaking message loop");
        break;
      }

      // Extract text from user message
      const userPrompt = this.extractTextFromMessage(message);
      if (!userPrompt) {
        log.debug("No text extracted from message, skipping");
        continue;
      }
      log.debug(
        { userPromptLength: userPrompt.length },
        "Extracted user prompt",
      );

      // Emit user message with UUID from queue to enable deduplication
      // The UUID was set by Process.queueMessage() and passed through MessageQueue
      const userMsgSessionId = sessionId || `pending-${Date.now()}`;
      yield {
        type: "user",
        uuid: message.uuid,
        session_id: userMsgSessionId,
        message: {
          role: "user",
          content: userPrompt,
        },
      } as SDKMessage;

      // Increment turn number for this new turn
      turnNumber++;

      // Run a turn with the SDK
      try {
        log.debug("Calling thread.runStreamed");
        const { events } = await thread.runStreamed(userPrompt, {
          signal,
        });
        log.debug("Got events iterator, starting event loop");

        // Process streaming events
        let eventCount = 0;
        for await (const event of events) {
          eventCount++;
          log.debug(
            { eventType: event.type, eventCount },
            "Received SDK event",
          );
          if (signal.aborted) {
            log.debug("Signal aborted during event processing");
            break;
          }

          // Update session ID from thread.started and emit init if needed
          if (event.type === "thread.started") {
            sessionId = event.thread_id;
            log.debug(
              { newSessionId: sessionId },
              "Updated session ID from thread.started",
            );

            // Emit init message now that we have the real session ID
            // This is critical - we delay init until we have the real ID so that
            // waitForSessionId() returns the correct ID to the client
            if (!initEmitted) {
              initEmitted = true;
              log.debug({ sessionId }, "Emitting init with real session ID");
              yield {
                type: "system",
                subtype: "init",
                session_id: sessionId,
                cwd: options.cwd,
              } as SDKMessage;
            }
          }

          // Convert event to SDKMessage(s) - skip thread.started as we handle it above
          if (event.type !== "thread.started") {
            const messages = this.convertEventToSDKMessages(
              event,
              sessionId,
              turnNumber,
            );
            log.debug(
              { eventType: event.type, messageCount: messages.length },
              "Converted event to SDKMessages",
            );
            for (const msg of messages) {
              yield msg;
            }
          }
        }
        log.debug(
          { totalEvents: eventCount },
          "Finished processing events for turn",
        );

        // Emit result after each turn to signal the Process that we're idle
        // This matches what the Claude SDK does after each turn
        log.debug({ sessionId }, "Emitting result after turn");
        yield {
          type: "result",
          session_id: sessionId,
        } as SDKMessage;
      } catch (error) {
        log.error({ error }, "Error during turn");
        if (signal.aborted) break;

        yield {
          type: "error",
          session_id: sessionId,
          error: error instanceof Error ? error.message : String(error),
        } as SDKMessage;
      }
    }

    log.debug({ sessionId }, "Message loop ended, emitting result");
    // Emit result message when done
    yield {
      type: "result",
      session_id: sessionId,
    } as SDKMessage;
    log.debug({ sessionId }, "Session complete");
  }

  /**
   * Convert a Codex SDK event to SDKMessage(s).
   */
  private convertEventToSDKMessages(
    event: ThreadEvent,
    sessionId: string,
    turnNumber: number,
  ): SDKMessage[] {
    switch (event.type) {
      case "thread.started": {
        return [
          {
            type: "system",
            subtype: "init",
            session_id: event.thread_id,
          } as SDKMessage,
        ];
      }

      case "turn.started": {
        return [];
      }

      case "turn.completed": {
        return [
          {
            type: "system",
            subtype: "turn_complete",
            session_id: sessionId,
            usage: {
              input_tokens: event.usage.input_tokens,
              output_tokens: event.usage.output_tokens,
              cached_input_tokens: event.usage.cached_input_tokens,
            },
          } as SDKMessage,
        ];
      }

      case "turn.failed": {
        return [
          {
            type: "error",
            session_id: sessionId,
            error: event.error.message,
          } as SDKMessage,
        ];
      }

      case "item.started":
      case "item.updated": {
        // For streaming updates, emit partial messages
        return this.convertItemToSDKMessages(
          event.item,
          sessionId,
          turnNumber,
          false,
        );
      }

      case "item.completed": {
        return this.convertItemToSDKMessages(
          event.item,
          sessionId,
          turnNumber,
          true,
        );
      }

      case "error": {
        return [
          {
            type: "error",
            session_id: sessionId,
            error: event.message,
          } as SDKMessage,
        ];
      }

      default: {
        return [];
      }
    }
  }

  /**
   * Convert a ThreadItem to SDKMessage(s).
   * Uses turnNumber to create unique UUIDs since Codex SDK reuses item_0, item_1 per turn.
   */
  private convertItemToSDKMessages(
    item: ThreadItem,
    sessionId: string,
    turnNumber: number,
    isComplete: boolean,
  ): SDKMessage[] {
    // Create unique UUID by combining item.id with turn number
    // This prevents UUID collisions across turns (item_0-turn1, item_0-turn2, etc.)
    const uuid = `${item.id}-turn${turnNumber}`;

    switch (item.type) {
      case "reasoning": {
        return [
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: item.text,
                },
              ],
            },
          } as SDKMessage,
        ];
      }

      case "agent_message": {
        return [
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: item.text,
            },
          } as SDKMessage,
        ];
      }

      case "command_execution": {
        const messages: SDKMessage[] = [];

        // Emit tool_use for the command
        messages.push({
          type: "assistant",
          session_id: sessionId,
          uuid,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: item.id,
                name: "Bash",
                input: { command: item.command },
              },
            ],
          },
        } as SDKMessage);

        // If completed, emit tool_result
        if (isComplete && item.status !== "in_progress") {
          const output =
            item.exit_code === 0
              ? item.aggregated_output || "(no output)"
              : `Exit code: ${item.exit_code}\n${item.aggregated_output}`;

          messages.push({
            type: "user",
            session_id: sessionId,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: item.id,
                  content: output,
                },
              ],
            },
          } as SDKMessage);
        }

        return messages;
      }

      case "file_change": {
        // Emit as a tool use for file operations
        const changesSummary = item.changes
          .map((c) => `${c.kind}: ${c.path}`)
          .join("\n");

        return [
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: "Edit",
                  input: { changes: item.changes },
                },
              ],
            },
          } as SDKMessage,
          ...(isComplete
            ? [
                {
                  type: "user",
                  session_id: sessionId,
                  message: {
                    role: "user",
                    content: [
                      {
                        type: "tool_result",
                        tool_use_id: item.id,
                        content:
                          item.status === "completed"
                            ? `File changes applied:\n${changesSummary}`
                            : `File changes failed:\n${changesSummary}`,
                      },
                    ],
                  },
                } as SDKMessage,
              ]
            : []),
        ];
      }

      case "mcp_tool_call": {
        const messages: SDKMessage[] = [];

        messages.push({
          type: "assistant",
          session_id: sessionId,
          uuid,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: item.id,
                name: `${item.server}:${item.tool}`,
                input: item.arguments,
              },
            ],
          },
        } as SDKMessage);

        if (isComplete && item.status !== "in_progress") {
          messages.push({
            type: "user",
            session_id: sessionId,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: item.id,
                  content:
                    item.status === "completed"
                      ? JSON.stringify(item.result)
                      : item.error?.message || "MCP tool call failed",
                },
              ],
            },
          } as SDKMessage);
        }

        return messages;
      }

      case "web_search": {
        return [
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: item.id,
                  name: "WebSearch",
                  input: { query: item.query },
                },
              ],
            },
          } as SDKMessage,
        ];
      }

      case "todo_list": {
        // Emit todo list as a system message
        return [
          {
            type: "system",
            subtype: "todo_list",
            session_id: sessionId,
            uuid,
            items: item.items,
          } as SDKMessage,
        ];
      }

      case "error": {
        return [
          {
            type: "error",
            session_id: sessionId,
            uuid,
            error: item.message,
          } as SDKMessage,
        ];
      }

      default: {
        return [];
      }
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
    const userMsg = message as UserMessage;
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
}

/**
 * Default Codex provider instance.
 */
export const codexProvider = new CodexProvider();
