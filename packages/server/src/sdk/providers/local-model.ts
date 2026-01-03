/**
 * Local Model Provider using Ollama with OpenAI-compatible API.
 *
 * This provider enables E2E testing with local LLMs (e.g., Qwen 2.5 Coder)
 * without API costs. It implements a minimal tool execution loop using
 * OpenAI's function calling format.
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { MessageQueue } from "../messageQueue.js";
import type { ContentBlock, SDKMessage, UserMessage } from "../types.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";

/**
 * Configuration for the local model provider.
 */
export interface LocalModelConfig {
  /** Model name (default: qwen2.5-coder:7b) */
  model?: string;
  /** Ollama base URL (default: http://localhost:11434) */
  baseUrl?: string;
  /** Maximum iterations for tool loop (default: 50) */
  maxIterations?: number;
  /** Request timeout in ms (default: 120000) */
  timeout?: number;
}

/**
 * OpenAI function calling types
 */
interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

interface OpenAIResponse {
  choices: Array<{
    message: OpenAIMessage;
    finish_reason: "stop" | "tool_calls" | "length";
  }>;
}

/**
 * Tool definitions for file operations and shell commands.
 */
const TOOLS: OpenAITool[] = [
  {
    type: "function",
    function: {
      name: "Read",
      description:
        "Read the contents of a file. Use this to examine existing files.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute or relative path to the file to read",
          },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Write",
      description:
        "Write content to a file. Creates the file if it does not exist, or overwrites if it does.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute or relative path to the file to write",
          },
          content: {
            type: "string",
            description: "The content to write to the file",
          },
        },
        required: ["file_path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Edit",
      description:
        "Edit a file by replacing old_string with new_string. Use for modifying existing files.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute or relative path to the file to edit",
          },
          old_string: {
            type: "string",
            description: "The text to replace (must be unique in the file)",
          },
          new_string: {
            type: "string",
            description: "The text to replace it with",
          },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Bash",
      description:
        "Execute a shell command. Use for running scripts, git, npm, etc.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
        },
        required: ["command"],
      },
    },
  },
];

/**
 * Execute a tool and return the result.
 */
function executeTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
): string {
  try {
    switch (name) {
      case "Read": {
        const filePath = resolvePath(args.file_path as string, cwd);
        if (!existsSync(filePath)) {
          return `Error: File not found: ${filePath}`;
        }
        return readFileSync(filePath, "utf-8");
      }

      case "Write": {
        const filePath = resolvePath(args.file_path as string, cwd);
        const content = args.content as string;
        // Create directory if needed
        const dir = dirname(filePath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(filePath, content, "utf-8");
        return `Successfully wrote to ${filePath}`;
      }

      case "Edit": {
        const filePath = resolvePath(args.file_path as string, cwd);
        if (!existsSync(filePath)) {
          return `Error: File not found: ${filePath}`;
        }
        const content = readFileSync(filePath, "utf-8");
        const oldString = args.old_string as string;
        const newString = args.new_string as string;

        const occurrences = content.split(oldString).length - 1;
        if (occurrences === 0) {
          return "Error: old_string not found in file";
        }
        if (occurrences > 1) {
          return `Error: old_string found ${occurrences} times (must be unique)`;
        }

        const newContent = content.replace(oldString, newString);
        writeFileSync(filePath, newContent, "utf-8");
        return `Successfully edited ${filePath}`;
      }

      case "Bash": {
        const command = args.command as string;
        try {
          const output = execSync(command, {
            cwd,
            encoding: "utf-8",
            timeout: 30000,
            maxBuffer: 1024 * 1024, // 1MB
          });
          return output || "(no output)";
        } catch (error) {
          if (error instanceof Error) {
            const execError = error as Error & {
              stderr?: string;
              stdout?: string;
            };
            return `Error: ${execError.message}\n${execError.stderr || ""}\n${execError.stdout || ""}`;
          }
          return `Error: ${String(error)}`;
        }
      }

      default:
        return `Error: Unknown tool: ${name}`;
    }
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Resolve a file path relative to cwd.
 */
function resolvePath(filePath: string, cwd: string): string {
  if (isAbsolute(filePath)) {
    return filePath;
  }
  return resolve(cwd, filePath);
}

/**
 * Generate a unique ID for tool calls.
 */
function generateToolCallId(): string {
  return `call_${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Parsed tool call from text content.
 */
interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Try to extract tool calls from text content.
 * Some local models output tool calls as JSON in text rather than using proper tool_calls.
 */
function parseToolCallsFromText(text: string): ParsedToolCall[] {
  const toolCalls: ParsedToolCall[] = [];

  // Try to find JSON objects with "name" and "arguments" fields
  // Pattern 1: ```json\n{...}\n```
  // Pattern 2: Bare JSON object { "name": ..., "arguments": ... }

  // Remove markdown code blocks
  const cleanText = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "");

  // Try to parse as a single JSON object
  try {
    const parsed = JSON.parse(cleanText.trim());
    if (parsed.name && typeof parsed.name === "string") {
      toolCalls.push({
        name: parsed.name,
        arguments: parsed.arguments ?? {},
      });
      return toolCalls;
    }
  } catch {
    // Not valid JSON, try other patterns
  }

  // Try to find complete JSON objects using balanced brace matching
  const jsonObjects = extractJsonObjects(cleanText);
  for (const jsonStr of jsonObjects) {
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.name && typeof parsed.name === "string") {
        toolCalls.push({
          name: parsed.name,
          arguments: parsed.arguments ?? {},
        });
      }
    } catch {
      // Skip invalid JSON
    }
  }

  return toolCalls;
}

/**
 * Extract complete JSON objects from text using balanced brace matching.
 */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "{") {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return objects;
}

/**
 * Local Model Provider implementation.
 *
 * Uses Ollama's OpenAI-compatible endpoint for inference and implements
 * a tool execution loop for file operations and shell commands.
 */
export class LocalModelProvider implements AgentProvider {
  readonly name = "local" as const;
  readonly displayName = "Local Model";

  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxIterations: number;
  private readonly timeout: number;

  constructor(config: LocalModelConfig = {}) {
    this.model = config.model ?? "qwen2.5-coder:7b";
    this.baseUrl = config.baseUrl ?? "http://localhost:11434";
    this.maxIterations = config.maxIterations ?? 50;
    this.timeout = config.timeout ?? 120000;
  }

  /**
   * Check if Ollama is running and available.
   */
  async isInstalled(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Local models don't require authentication.
   */
  async isAuthenticated(): Promise<boolean> {
    return true;
  }

  /**
   * Get authentication status.
   */
  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isInstalled();
    return {
      installed,
      authenticated: true,
      enabled: installed,
    };
  }

  /**
   * Start a session with the local model.
   */
  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const queue = new MessageQueue();
    const abortController = new AbortController();
    const sessionId = `local-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Push initial message if provided
    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    const iterator = this.runSession(
      options.cwd,
      queue,
      sessionId,
      abortController.signal,
    );

    return {
      iterator,
      queue,
      abort: () => abortController.abort(),
      sessionId,
    };
  }

  /**
   * Main session loop.
   */
  private async *runSession(
    cwd: string,
    queue: MessageQueue,
    sessionId: string,
    signal: AbortSignal,
  ): AsyncIterableIterator<SDKMessage> {
    // Emit init message
    yield {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      cwd,
    } as SDKMessage;

    // Wait for initial message from queue
    const messageGen = queue.generator();
    const firstMessage = await messageGen.next();
    if (firstMessage.done) {
      yield {
        type: "result",
        session_id: sessionId,
        result: "No message provided",
      } as SDKMessage;
      return;
    }

    // Get the user's prompt
    const userPrompt = this.extractTextFromMessage(firstMessage.value);

    // Emit user message
    yield {
      type: "user",
      session_id: sessionId,
      message: {
        role: "user",
        content: userPrompt,
      },
    } as SDKMessage;

    // Build conversation history for OpenAI API
    const messages: OpenAIMessage[] = [
      {
        role: "system",
        content: `You are a helpful coding assistant. You have access to tools for reading files, writing files, editing files, and running shell commands. Use these tools to complete the user's request.

Working directory: ${cwd}

Be concise and complete tasks efficiently. When you're done, explain what you did.`,
      },
      {
        role: "user",
        content: userPrompt,
      },
    ];

    // Tool execution loop
    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      if (signal.aborted) {
        yield {
          type: "result",
          session_id: sessionId,
          result: "Session aborted",
        } as SDKMessage;
        return;
      }

      // Call the model
      const response = await this.callModel(messages, signal);
      if (!response) {
        yield {
          type: "result",
          session_id: sessionId,
          result: "Model call failed",
        } as SDKMessage;
        return;
      }

      const choice = response.choices[0];
      if (!choice) {
        yield {
          type: "result",
          session_id: sessionId,
          result: "No response from model",
        } as SDKMessage;
        return;
      }

      const assistantMessage = choice.message;

      // Check for tool calls - either proper tool_calls or parsed from text
      let toolCalls = assistantMessage.tool_calls ?? [];

      // If no proper tool_calls, try to parse from text content
      if (toolCalls.length === 0 && assistantMessage.content) {
        const parsedCalls = parseToolCallsFromText(assistantMessage.content);
        if (parsedCalls.length > 0) {
          // Convert parsed calls to tool_calls format
          toolCalls = parsedCalls.map((call) => ({
            id: generateToolCallId(),
            type: "function" as const,
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          }));
        }
      }

      // Build the message for conversation history
      const messageForHistory: OpenAIMessage = {
        role: "assistant",
        content: assistantMessage.content,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      };
      messages.push(messageForHistory);

      // Emit assistant message
      const contentBlocks: ContentBlock[] = [];

      if (assistantMessage.content && toolCalls.length === 0) {
        // Only add text content if no tool calls (to avoid duplicating the JSON)
        contentBlocks.push({
          type: "text",
          text: assistantMessage.content,
        });
      }

      if (toolCalls.length > 0) {
        for (const toolCall of toolCalls) {
          let input: unknown;
          try {
            input = JSON.parse(toolCall.function.arguments);
          } catch {
            input = {};
          }
          contentBlocks.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input,
          } as ContentBlock);
        }
      }

      yield {
        type: "assistant",
        session_id: sessionId,
        message: {
          role: "assistant",
          content:
            contentBlocks.length > 0
              ? contentBlocks
              : (assistantMessage.content ?? ""),
        },
      } as SDKMessage;

      // Check if we're done (no tool calls)
      // Only finish if there are no tool calls to execute
      if (toolCalls.length === 0) {
        yield {
          type: "result",
          session_id: sessionId,
          result: assistantMessage.content ?? "Task completed",
        } as SDKMessage;
        return;
      }

      // Execute tool calls
      for (const toolCall of toolCalls) {
        if (signal.aborted) {
          yield {
            type: "result",
            session_id: sessionId,
            result: "Session aborted",
          } as SDKMessage;
          return;
        }

        const toolName = toolCall.function.name;
        let toolArgs: Record<string, unknown>;
        try {
          toolArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          toolArgs = {};
        }

        // Execute the tool
        const toolResult = executeTool(toolName, toolArgs, cwd);

        // Add tool result to conversation
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResult,
        });

        // Emit tool result message
        yield {
          type: "user",
          session_id: sessionId,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolCall.id,
                content: toolResult,
              },
            ],
          },
        } as SDKMessage;
      }
    }

    // Max iterations reached
    yield {
      type: "result",
      session_id: sessionId,
      result: "Max iterations reached",
    } as SDKMessage;
  }

  /**
   * Call the Ollama model using OpenAI-compatible API.
   */
  private async callModel(
    messages: OpenAIMessage[],
    signal: AbortSignal,
  ): Promise<OpenAIResponse | null> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          tools: TOOLS,
          tool_choice: "auto",
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeout)]),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error(`Model call failed: ${response.status} ${text}`);
        return null;
      }

      return await response.json();
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return null;
      }
      console.error("Model call error:", error);
      return null;
    }
  }

  /**
   * Extract text content from a user message.
   * Handles both SDK format ({ message: { content: ... } }) and direct content.
   */
  private extractTextFromMessage(message: unknown): string {
    if (!message || typeof message !== "object") {
      return "";
    }

    // Check for SDK message format: { message: { content: ... } }
    const sdkMsg = message as { message?: { content?: string | unknown[] } };
    const content =
      sdkMsg.message?.content ??
      (message as { content?: string | unknown[] }).content;

    // Handle string content
    if (typeof content === "string") {
      return content;
    }

    // Handle array content
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
 * Default local model provider instance.
 */
export const localModelProvider = new LocalModelProvider();
