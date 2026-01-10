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

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ModelInfo,
  OpenCodeMessagePartUpdatedEvent,
  OpenCodePart,
  OpenCodeSSEEvent,
} from "@yep-anywhere/shared";
import { parseOpenCodeSSEEvent } from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { MessageQueue } from "../messageQueue.js";
import type { SDKMessage } from "../types.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";

/**
 * Configuration for OpenCode provider.
 */
export interface OpenCodeProviderConfig {
  /** Path to opencode binary (auto-detected if not specified) */
  opencodePath?: string;
  /** Request timeout in ms (default: 300000 = 5 minutes) */
  timeout?: number;
  /** Base port to start from (auto-selects if not specified) */
  basePort?: number;
}

/** Port counter for unique port assignment */
let nextPort = 14100;

/**
 * Get next available port for OpenCode server.
 */
function getNextPort(): number {
  return nextPort++;
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
  readonly supportsThinkingToggle = false;
  readonly supportsSlashCommands = false;

  private readonly opencodePath?: string;
  private readonly timeout: number;

  constructor(config: OpenCodeProviderConfig = {}) {
    this.opencodePath = config.opencodePath;
    this.timeout = config.timeout ?? 300000; // 5 minutes default
  }

  /**
   * Check if the OpenCode CLI is installed.
   */
  async isInstalled(): Promise<boolean> {
    const path = this.findOpenCodePath();
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
    const opencodePath = this.findOpenCodePath();
    if (!opencodePath) {
      return [];
    }

    try {
      const result = execSync(`${opencodePath} models`, {
        encoding: "utf-8",
        timeout: 10000,
      });

      // Parse model list output (one model per line: provider/model)
      const models: ModelInfo[] = [];
      for (const line of result.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("─")) {
          models.push({
            id: trimmed,
            name: trimmed,
          });
        }
      }

      return models;
    } catch {
      // Return default models if command fails
      return [
        { id: "opencode/big-pickle", name: "Big Pickle (Free)" },
        { id: "auto", name: "Auto (recommended)" },
      ];
    }
  }

  /**
   * Start a new OpenCode session.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const queue = new MessageQueue();
    const abortController = new AbortController();

    // Push initial message if provided
    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    const iterator = this.runSession(
      options.cwd,
      queue,
      abortController.signal,
      options,
    );

    return {
      iterator,
      queue,
      abort: () => abortController.abort(),
    };
  }

  /**
   * Main session loop.
   * Spawns an OpenCode server and manages HTTP/SSE communication.
   */
  private async *runSession(
    cwd: string,
    queue: MessageQueue,
    signal: AbortSignal,
    options: StartSessionOptions,
  ): AsyncIterableIterator<SDKMessage> {
    const log = getLogger();
    const opencodePath = this.findOpenCodePath();

    if (!opencodePath) {
      yield {
        type: "error",
        error: "OpenCode CLI not found",
      } as SDKMessage;
      return;
    }

    // Allocate a unique port for this session
    const port = getNextPort();
    const baseUrl = `http://127.0.0.1:${port}`;

    // Start the OpenCode server
    let serverProcess: ChildProcess;
    try {
      serverProcess = spawn(
        opencodePath,
        ["serve", "--port", String(port), "--print-logs"],
        {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
          },
        },
      );
    } catch (error) {
      yield {
        type: "error",
        error: `Failed to spawn OpenCode server: ${error instanceof Error ? error.message : String(error)}`,
      } as SDKMessage;
      return;
    }

    // Handle abort
    const abortHandler = () => {
      log.info({ port }, "Aborting OpenCode server");
      serverProcess.kill("SIGTERM");
    };
    signal.addEventListener("abort", abortHandler);

    // Wait for server to be ready
    const serverReady = await this.waitForServer(baseUrl, 10000);
    if (!serverReady) {
      serverProcess.kill("SIGTERM");
      signal.removeEventListener("abort", abortHandler);
      yield {
        type: "error",
        error: "OpenCode server failed to start",
      } as SDKMessage;
      return;
    }

    log.info({ port, cwd }, "OpenCode server ready");

    // Create a session on the server
    let opencodeSessionId: string;
    try {
      const sessionResponse = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Yep Anywhere Session" }),
      });

      if (!sessionResponse.ok) {
        throw new Error(`Failed to create session: ${sessionResponse.status}`);
      }

      const sessionData = (await sessionResponse.json()) as { id: string };
      opencodeSessionId = sessionData.id;
    } catch (error) {
      serverProcess.kill("SIGTERM");
      signal.removeEventListener("abort", abortHandler);
      yield {
        type: "error",
        error: `Failed to create OpenCode session: ${error instanceof Error ? error.message : String(error)}`,
      } as SDKMessage;
      return;
    }

    // Generate our session ID (or use resume ID)
    const sessionId =
      options.resumeSessionId ??
      `opencode-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Emit init message
    yield {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      cwd,
    } as SDKMessage;

    try {
      // Process messages from the queue
      const messageGen = queue.generator();
      for await (const message of messageGen) {
        if (signal.aborted) break;

        // Extract text from the user message
        const userPrompt = this.extractTextFromMessage(message);

        // Emit user message
        yield {
          type: "user",
          uuid: message.uuid,
          session_id: sessionId,
          message: {
            role: "user",
            content: userPrompt,
          },
        } as SDKMessage;

        // Send message to OpenCode server and stream response
        yield* this.sendMessageAndStream(
          baseUrl,
          opencodeSessionId,
          sessionId,
          userPrompt,
          signal,
        );
      }
    } finally {
      // Clean up server
      log.info({ port, sessionId }, "Shutting down OpenCode server");
      signal.removeEventListener("abort", abortHandler);

      if (!serverProcess.killed) {
        serverProcess.kill("SIGTERM");
      }
    }
  }

  /**
   * Send a message to OpenCode and stream the response via SSE.
   */
  private async *sendMessageAndStream(
    baseUrl: string,
    opencodeSessionId: string,
    sessionId: string,
    text: string,
    signal: AbortSignal,
  ): AsyncIterableIterator<SDKMessage> {
    const log = getLogger();

    const sseUrl = `${baseUrl}/event`;
    const sseController = new AbortController();

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
        let currentAssistantMessageId: string | null = null;

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

            // Filter to only events for our session
            if (
              "properties" in event &&
              event.properties &&
              "sessionID" in event.properties
            ) {
              if (event.properties.sessionID !== opencodeSessionId) continue;
            }

            // Convert to SDK message
            const sdkMessage = this.convertSSEEventToSDKMessage(
              event,
              sessionId,
              currentAssistantMessageId,
            );

            if (sdkMessage) {
              // Track assistant message ID for consistent streaming
              if (
                sdkMessage.type === "assistant" &&
                "uuid" in sdkMessage &&
                sdkMessage.uuid
              ) {
                currentAssistantMessageId = sdkMessage.uuid as string;
              }
              state.eventBuffer.push(sdkMessage);
              // Wake up consumer if waiting
              state.resolveWaiting?.();
            }

            // Stop on session.idle
            if (event.type === "session.idle") {
              log.debug({ opencodeSessionId }, "Session idle, stopping SSE");
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
        { opencodeSessionId, textLength: text.length },
        "Sending message to OpenCode",
      );
      const response = await fetch(
        `${baseUrl}/session/${opencodeSessionId}/message`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            parts: [{ type: "text", text }],
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
      log.debug({ opencodeSessionId }, "Message sent successfully");
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

    // Emit result message
    yield {
      type: "result",
      session_id: sessionId,
    } as SDKMessage;
  }

  /**
   * Convert an OpenCode SSE event to an SDK message.
   */
  private convertSSEEventToSDKMessage(
    event: OpenCodeSSEEvent,
    sessionId: string,
    currentMessageId: string | null,
  ): SDKMessage | null {
    switch (event.type) {
      case "message.part.updated": {
        const partEvent = event as OpenCodeMessagePartUpdatedEvent;
        const part = partEvent.properties.part;
        const delta = partEvent.properties.delta;

        return this.convertPartToSDKMessage(
          part,
          sessionId,
          delta,
          currentMessageId,
        );
      }

      case "session.idle":
      case "session.status":
      case "session.updated":
      case "session.diff":
      case "message.updated":
      case "server.connected":
        // These are status events, not content - skip
        return null;

      default:
        return null;
    }
  }

  /**
   * Convert an OpenCode part to an SDK message.
   */
  private convertPartToSDKMessage(
    part: OpenCodePart,
    sessionId: string,
    delta: string | undefined,
    currentMessageId: string | null,
  ): SDKMessage | null {
    switch (part.type) {
      case "text": {
        // Use delta if available (streaming), otherwise full text
        const text = delta ?? part.text ?? "";
        if (!text) return null;

        return {
          type: "assistant",
          session_id: sessionId,
          uuid: currentMessageId ?? part.messageID,
          message: {
            role: "assistant",
            content: text,
          },
        } as SDKMessage;
      }

      case "step-start":
        // Start of a processing step - no content to emit
        return null;

      case "step-finish": {
        // End of processing step - emit usage info if available
        if (part.tokens) {
          return {
            type: "result",
            session_id: sessionId,
            usage: {
              input_tokens: part.tokens.input ?? 0,
              output_tokens: part.tokens.output ?? 0,
            },
          } as SDKMessage;
        }
        return null;
      }

      case "tool-use": {
        // Tool invocation
        return {
          type: "assistant",
          session_id: sessionId,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: part.id,
                name: part.tool ?? "unknown",
                input: part.input ?? {},
              },
            ],
          },
        } as SDKMessage;
      }

      case "tool-result": {
        // Tool result
        return {
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
        } as SDKMessage;
      }

      default:
        return null;
    }
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
   * Find the OpenCode CLI path.
   */
  private findOpenCodePath(): string | null {
    // Use configured path if provided
    if (this.opencodePath && existsSync(this.opencodePath)) {
      return this.opencodePath;
    }

    // Check common locations
    const commonPaths = [
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
      const result = execSync("which opencode", { encoding: "utf-8" }).trim();
      if (result && existsSync(result)) {
        return result;
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
