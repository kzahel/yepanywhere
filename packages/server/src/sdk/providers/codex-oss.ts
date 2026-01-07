/**
 * CodexOSS Provider - Local models via Codex CLI with --oss flag.
 *
 * Spawns `codex exec --oss` for local model support (Ollama/LMStudio).
 * Uses the same session format as the SDK-based Codex provider.
 *
 * Multi-turn conversations use `codex exec resume <session_id>` to continue
 * sessions. This requires models with sufficient context window (32K+ recommended)
 * since Codex's system prompt is ~5-6K tokens.
 *
 * See docs/research/codex-local-models.md for background.
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { ModelInfo } from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { MessageQueue } from "../messageQueue.js";
import type { SDKMessage } from "../types.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";

const log = getLogger().child({ component: "codex-oss-provider" });
const execAsync = promisify(exec);

/**
 * Configuration for CodexOSS provider.
 */
export interface CodexOSSProviderConfig {
  /** Path to codex binary (auto-detected if not specified) */
  codexPath?: string;
  /** Local provider: "ollama" or "lmstudio" */
  localProvider?: "ollama" | "lmstudio";
  /** Request timeout in ms (default: 300000 = 5 minutes) */
  timeout?: number;
}

/**
 * Codex CLI JSON event types (from --experimental-json output).
 */
interface CodexThreadStarted {
  type: "thread.started";
  thread_id: string;
}

interface CodexTurnStarted {
  type: "turn.started";
}

interface CodexTurnCompleted {
  type: "turn.completed";
  usage: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens?: number;
  };
}

interface CodexTurnFailed {
  type: "turn.failed";
  error: { message: string };
}

interface CodexItemEvent {
  type: "item.started" | "item.updated" | "item.completed";
  item: CodexItem;
}

interface CodexErrorEvent {
  type: "error";
  message: string;
}

type CodexEvent =
  | CodexThreadStarted
  | CodexTurnStarted
  | CodexTurnCompleted
  | CodexTurnFailed
  | CodexItemEvent
  | CodexErrorEvent;

interface CodexAgentMessage {
  id: string;
  type: "agent_message";
  text: string;
}

interface CodexReasoning {
  id: string;
  type: "reasoning";
  text: string;
}

interface CodexCommandExecution {
  id: string;
  type: "command_execution";
  command: string;
  aggregated_output: string;
  exit_code?: number;
  status: "in_progress" | "completed" | "failed";
}

interface CodexFileChange {
  id: string;
  type: "file_change";
  changes: Array<{ path: string; kind: "add" | "delete" | "update" }>;
  status: "completed" | "failed";
}

interface CodexMcpToolCall {
  id: string;
  type: "mcp_tool_call";
  server: string;
  tool: string;
  arguments: unknown;
  result?: unknown;
  error?: { message: string };
  status: "in_progress" | "completed" | "failed";
}

interface CodexWebSearch {
  id: string;
  type: "web_search";
  query: string;
}

interface CodexTodoList {
  id: string;
  type: "todo_list";
  items: Array<{ text: string; completed: boolean }>;
}

interface CodexErrorItem {
  id: string;
  type: "error";
  message: string;
}

type CodexItem =
  | CodexAgentMessage
  | CodexReasoning
  | CodexCommandExecution
  | CodexFileChange
  | CodexMcpToolCall
  | CodexWebSearch
  | CodexTodoList
  | CodexErrorItem;

/**
 * CodexOSS Provider - spawns Codex CLI with --oss for local models.
 */
export class CodexOSSProvider implements AgentProvider {
  readonly name = "codex-oss" as const;
  readonly displayName = "CodexOSS";
  readonly supportsPermissionMode = false;
  readonly supportsThinkingToggle = false;

  private readonly codexPath?: string;
  private readonly localProvider: "ollama" | "lmstudio";
  private readonly timeout: number;

  constructor(config: CodexOSSProviderConfig = {}) {
    this.codexPath = config.codexPath;
    this.localProvider = config.localProvider ?? "ollama";
    this.timeout = config.timeout ?? 300000;
  }

  /**
   * Check if Codex CLI is installed.
   */
  async isInstalled(): Promise<boolean> {
    return this.findCodexPath() !== null;
  }

  /**
   * Check if local provider (Ollama) is available.
   */
  async isAuthenticated(): Promise<boolean> {
    // For OSS mode, we just need Ollama running
    if (this.localProvider === "ollama") {
      try {
        await execAsync("ollama list", { timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    }
    // TODO: LMStudio check
    return false;
  }

  /**
   * Get authentication status.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isInstalled();
    if (!installed) {
      return { installed: false, authenticated: false, enabled: false };
    }

    const authenticated = await this.isAuthenticated();
    return {
      installed: true,
      authenticated,
      enabled: authenticated,
    };
  }

  /**
   * Get available models from Ollama.
   */
  async getAvailableModels(): Promise<ModelInfo[]> {
    if (this.localProvider !== "ollama") {
      return [];
    }

    try {
      const { stdout } = await execAsync("ollama list", { timeout: 5000 });
      const lines = stdout.trim().split("\n");

      if (lines.length < 2) {
        return [];
      }

      const models: ModelInfo[] = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;

        // Parse: NAME ID SIZE MODIFIED
        const parts = line.split(/\s+/);
        if (parts.length >= 3) {
          const name = parts[0] ?? "";
          const sizeNum = Number.parseFloat(parts[2] ?? "0");
          const sizeUnit = parts[3]?.toUpperCase() ?? "";
          let sizeBytes: number | undefined;
          if (sizeUnit === "GB") {
            sizeBytes = Math.round(sizeNum * 1024 * 1024 * 1024);
          } else if (sizeUnit === "MB") {
            sizeBytes = Math.round(sizeNum * 1024 * 1024);
          }

          models.push({
            id: name,
            name: name,
            size: sizeBytes,
          });
        }
      }

      return models;
    } catch (error) {
      log.warn({ error }, "Failed to get Ollama models");
      return [];
    }
  }

  /**
   * Start a new CodexOSS session.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const queue = new MessageQueue();
    const abortController = new AbortController();

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
   * Main session loop - uses `codex exec` for first turn, then `codex exec resume`
   * for subsequent turns.
   *
   * Important: Models must have sufficient context window (32K+ recommended) since
   * Codex's system prompt is ~5-6K tokens. With default 4K context, Ollama truncates
   * the prompt and loses conversation history.
   *
   * Create models with larger context via Modelfile:
   *   FROM qwen2.5-coder:32b-instruct-q4_K_M
   *   PARAMETER num_ctx 32768
   */
  private async *runSession(
    options: StartSessionOptions,
    queue: MessageQueue,
    signal: AbortSignal,
  ): AsyncIterableIterator<SDKMessage> {
    const codexPath = this.findCodexPath();
    if (!codexPath) {
      yield {
        type: "error",
        error: "Codex CLI not found",
      } as SDKMessage;
      return;
    }

    let currentSessionId = options.resumeSessionId ?? "";
    let initEmitted = !!options.resumeSessionId;

    // Turn counter for generating unique UUIDs per turn
    let turnNumber = 0;

    // Accumulator for streaming tokens within a turn
    // Codex-oss emits each token as a separate item with incrementing IDs,
    // but we want to merge them into a single message per response
    let accumulatedText = "";
    let accumulatedThinking = "";

    // If resuming, emit init immediately
    if (options.resumeSessionId) {
      yield {
        type: "system",
        subtype: "init",
        session_id: currentSessionId,
        cwd: options.cwd,
      } as SDKMessage;
    }

    const messageGen = queue.generator();
    for await (const message of messageGen) {
      if (signal.aborted) break;

      const userPrompt = this.extractTextFromMessage(message);
      if (!userPrompt) continue;

      // Emit user message with UUID from queue to enable deduplication
      // The UUID was set by Process.queueMessage() and passed through MessageQueue
      yield {
        type: "user",
        uuid: message.uuid,
        session_id: currentSessionId || `pending-${Date.now()}`,
        message: { role: "user", content: userPrompt },
      } as SDKMessage;

      // Increment turn number and reset accumulators for this new turn
      turnNumber++;
      accumulatedText = "";
      accumulatedThinking = "";

      // Build CLI arguments - use resume for subsequent turns
      const isFirstTurn = turnNumber === 1 && !options.resumeSessionId;
      const args = isFirstTurn
        ? this.buildFirstTurnArgs(options)
        : this.buildResumeTurnArgs(options, currentSessionId, userPrompt);

      // Spawn codex process
      let codexProcess: ChildProcess;
      try {
        log.debug(
          {
            args,
            cwd: options.cwd,
            turnNumber,
            isFirstTurn,
            sessionId: currentSessionId,
          },
          isFirstTurn
            ? "Spawning codex exec --oss"
            : "Spawning codex exec resume",
        );
        codexProcess = spawn(codexPath, args, {
          cwd: options.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });

        // For first turn, send prompt via stdin
        // For resume, prompt is passed as argument
        if (isFirstTurn && codexProcess.stdin) {
          codexProcess.stdin.write(userPrompt);
          codexProcess.stdin.end();
        } else if (codexProcess.stdin) {
          codexProcess.stdin.end();
        }
      } catch (error) {
        yield {
          type: "error",
          session_id: currentSessionId,
          error: `Failed to spawn Codex: ${error instanceof Error ? error.message : String(error)}`,
        } as SDKMessage;
        return;
      }

      // Handle abort
      const abortHandler = () => codexProcess.kill("SIGTERM");
      signal.addEventListener("abort", abortHandler);

      const timeoutId = setTimeout(() => {
        codexProcess.kill("SIGTERM");
      }, this.timeout);

      try {
        if (!codexProcess.stdout) {
          yield {
            type: "error",
            session_id: currentSessionId,
            error: "Codex process has no stdout",
          } as SDKMessage;
          return;
        }

        const rl = createInterface({
          input: codexProcess.stdout,
          crlfDelay: Number.POSITIVE_INFINITY,
        });

        // Collect stderr for debugging
        let stderr = "";
        codexProcess.stderr?.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        // For resume turns (no JSON), we need to parse text output
        // The format is: header lines, then "codex" line, then response text
        let inCodexResponse = false;
        const textResponseLines: string[] = [];

        for await (const line of rl) {
          if (signal.aborted) break;

          // First try JSON parsing (works for first turn with --json)
          const event = this.parseEvent(line);
          if (event) {
            // Update session ID from thread.started (only on first turn)
            if (event.type === "thread.started") {
              log.debug(
                { threadId: event.thread_id, turnNumber },
                "Captured thread_id from thread.started",
              );
              currentSessionId = event.thread_id;
              if (!initEmitted) {
                initEmitted = true;
                yield {
                  type: "system",
                  subtype: "init",
                  session_id: currentSessionId,
                  cwd: options.cwd,
                } as SDKMessage;
              }
              continue;
            }

            // Handle item events specially to accumulate streaming tokens
            // Codex-oss emits each token as a separate item with incrementing IDs,
            // but we want to merge agent_message tokens into a single message
            if (
              event.type === "item.started" ||
              event.type === "item.updated" ||
              event.type === "item.completed"
            ) {
              const item = event.item;

              // For agent_message, accumulate text and emit with stable UUID
              if (item.type === "agent_message") {
                accumulatedText += item.text;
                yield {
                  type: "assistant",
                  session_id: currentSessionId,
                  uuid: `response-turn${turnNumber}`,
                  message: { role: "assistant", content: accumulatedText },
                } as SDKMessage;
                continue;
              }

              // For reasoning, accumulate thinking and emit with stable UUID
              if (item.type === "reasoning") {
                accumulatedThinking += item.text;
                yield {
                  type: "assistant",
                  session_id: currentSessionId,
                  uuid: `thinking-turn${turnNumber}`,
                  message: {
                    role: "assistant",
                    content: [
                      { type: "thinking", thinking: accumulatedThinking },
                    ],
                  },
                } as SDKMessage;
                continue;
              }

              // For other item types (tool calls, etc.), use per-turn unique UUID
              const messages = this.convertItemToSDKMessages(
                item,
                currentSessionId,
                `${item.id}-turn${turnNumber}`,
                event.type === "item.completed",
              );
              for (const msg of messages) {
                yield msg;
              }
              continue;
            }

            // Convert other events to SDKMessages
            const messages = this.convertEventToSDKMessages(
              event,
              currentSessionId,
            );
            for (const msg of messages) {
              yield msg;
            }
            continue;
          }

          // Text output parsing for resume turns (no JSON)
          // Format: header, "codex", response lines, duplicate of response
          if (line === "codex") {
            inCodexResponse = true;
            continue;
          }

          if (inCodexResponse) {
            // Accumulate response lines
            textResponseLines.push(line);
            // Emit progressive updates
            accumulatedText = textResponseLines.join("\n");
            yield {
              type: "assistant",
              session_id: currentSessionId,
              uuid: `response-turn${turnNumber}`,
              message: { role: "assistant", content: accumulatedText },
            } as SDKMessage;
          }
        }

        // For text output, deduplicate the response (it appears twice)
        if (!isFirstTurn && textResponseLines.length > 0) {
          // The response is duplicated, so take first half
          const halfLen = Math.floor(textResponseLines.length / 2);
          if (
            halfLen > 0 &&
            textResponseLines.slice(0, halfLen).join("\n") ===
              textResponseLines.slice(halfLen).join("\n")
          ) {
            accumulatedText = textResponseLines.slice(0, halfLen).join("\n");
            yield {
              type: "assistant",
              session_id: currentSessionId,
              uuid: `response-turn${turnNumber}`,
              message: { role: "assistant", content: accumulatedText },
            } as SDKMessage;
          }
        }

        // Wait for exit
        const exitCode = await new Promise<number | null>((resolve) => {
          codexProcess.on("close", resolve);
          codexProcess.on("error", () => resolve(null));
        });

        if (exitCode !== 0 && stderr) {
          log.warn(
            { exitCode, stderr: stderr.slice(0, 500) },
            "Codex exited with error",
          );
        }

        // Emit result
        yield {
          type: "result",
          session_id: currentSessionId,
        } as SDKMessage;
      } finally {
        clearTimeout(timeoutId);
        signal.removeEventListener("abort", abortHandler);
        if (!codexProcess.killed) {
          codexProcess.kill("SIGTERM");
        }
      }
    }
  }

  /**
   * Build CLI arguments for first turn: `codex exec --oss --json ...`
   */
  private buildFirstTurnArgs(options: StartSessionOptions): string[] {
    const args: string[] = [
      "exec",
      "--oss",
      "--local-provider",
      this.localProvider,
      "--json",
    ];

    if (options.model) {
      args.push("--model", options.model);
    }

    // Sandbox mode
    if (options.permissionMode === "bypassPermissions") {
      args.push("-s", "danger-full-access");
    } else {
      args.push("-s", "workspace-write");
    }

    return args;
  }

  /**
   * Build CLI arguments for subsequent turns: `codex exec resume <session_id> <prompt> -c ...`
   *
   * Note: The resume subcommand doesn't support --oss or --json flags directly.
   * We must use -c config overrides to specify the model provider and model.
   */
  private buildResumeTurnArgs(
    options: StartSessionOptions,
    sessionId: string,
    prompt: string,
  ): string[] {
    const args: string[] = [
      "exec",
      "resume",
      sessionId,
      prompt,
      "-c",
      `model_provider="${this.localProvider}"`,
    ];

    if (options.model) {
      args.push("-c", `model="${options.model}"`);
    }

    return args;
  }

  /**
   * Parse a JSON line from CLI output.
   */
  private parseEvent(line: string): CodexEvent | null {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) {
      return null;
    }

    try {
      return JSON.parse(trimmed) as CodexEvent;
    } catch {
      log.debug({ line: trimmed.slice(0, 100) }, "Failed to parse event");
      return null;
    }
  }

  /**
   * Convert Codex event to SDKMessage(s).
   */
  private convertEventToSDKMessages(
    event: CodexEvent,
    sessionId: string,
  ): SDKMessage[] {
    switch (event.type) {
      case "turn.started":
        return [];

      case "turn.completed":
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

      case "turn.failed":
        return [
          {
            type: "error",
            session_id: sessionId,
            error: event.error.message,
          } as SDKMessage,
        ];

      // item.started, item.updated, item.completed are handled in runSession
      // to support token accumulation with stable UUIDs

      case "error":
        return [
          {
            type: "error",
            session_id: sessionId,
            error: event.message,
          } as SDKMessage,
        ];

      default:
        return [];
    }
  }

  /**
   * Convert a Codex item to SDKMessage(s).
   * UUID is passed in to ensure uniqueness across turns.
   */
  private convertItemToSDKMessages(
    item: CodexItem,
    sessionId: string,
    uuid: string,
    isComplete: boolean,
  ): SDKMessage[] {
    switch (item.type) {
      // reasoning and agent_message are handled by accumulator in runSession
      case "reasoning":
        return [
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: {
              role: "assistant",
              content: [{ type: "thinking", thinking: item.text }],
            },
          } as SDKMessage,
        ];

      case "agent_message":
        return [
          {
            type: "assistant",
            session_id: sessionId,
            uuid,
            message: { role: "assistant", content: item.text },
          } as SDKMessage,
        ];

      case "command_execution": {
        const messages: SDKMessage[] = [
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
                  name: "Bash",
                  input: { command: item.command },
                },
              ],
            },
          } as SDKMessage,
        ];

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
                { type: "tool_result", tool_use_id: item.id, content: output },
              ],
            },
          } as SDKMessage);
        }

        return messages;
      }

      case "file_change": {
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
        const messages: SDKMessage[] = [
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
                  name: `${item.server}:${item.tool}`,
                  input: item.arguments,
                },
              ],
            },
          } as SDKMessage,
        ];

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

      case "web_search":
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

      case "todo_list":
        return [
          {
            type: "system",
            subtype: "todo_list",
            session_id: sessionId,
            uuid,
            items: item.items,
          } as SDKMessage,
        ];

      case "error":
        return [
          {
            type: "error",
            session_id: sessionId,
            uuid,
            error: item.message,
          } as SDKMessage,
        ];

      default:
        return [];
    }
  }

  /**
   * Extract text from user message.
   */
  private extractTextFromMessage(message: unknown): string {
    if (!message || typeof message !== "object") return "";

    const userMsg = message as { text?: string };
    if (typeof userMsg.text === "string") return userMsg.text;

    const sdkMsg = message as { message?: { content?: string | unknown[] } };
    const content = sdkMsg.message?.content;

    if (typeof content === "string") return content;

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
   * Find codex binary path.
   */
  private findCodexPath(): string | null {
    if (this.codexPath && existsSync(this.codexPath)) {
      return this.codexPath;
    }

    const commonPaths = [
      join(homedir(), ".local", "bin", "codex"),
      "/usr/local/bin/codex",
      join(homedir(), ".codex", "bin", "codex"),
    ];

    for (const path of commonPaths) {
      if (existsSync(path)) return path;
    }

    try {
      const result = execSync("which codex", { encoding: "utf-8" }).trim();
      if (result && existsSync(result)) return result;
    } catch {
      // Not in PATH
    }

    return null;
  }
}

/**
 * Default CodexOSS provider instance.
 */
export const codexOSSProvider = new CodexOSSProvider();
