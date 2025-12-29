import {
  type SDKMessage as AgentSDKMessage,
  type CanUseTool as SDKCanUseTool,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { MessageQueue } from "./messageQueue.js";
import type {
  ContentBlock,
  RealClaudeSDKInterface,
  SDKMessage,
  StartSessionOptions,
  StartSessionResult,
} from "./types.js";

/**
 * Real Claude SDK implementation using @anthropic-ai/claude-agent-sdk.
 *
 * This class wraps the SDK's query() function and provides:
 * - MessageQueue for queuing user messages
 * - AbortController for cancellation
 * - Tool approval callbacks
 */
export class RealClaudeSDK implements RealClaudeSDKInterface {
  /**
   * Start a new Claude session.
   *
   * @param options - Session configuration
   * @returns Iterator, message queue, and abort function
   */
  async startSession(
    options: StartSessionOptions,
  ): Promise<StartSessionResult> {
    const queue = new MessageQueue();
    const abortController = new AbortController();

    // Push the initial message into the queue
    queue.push(options.initialMessage);

    // Wrap our canUseTool to match SDK's expected type
    // Capture onToolApproval in local const to satisfy TypeScript
    const onToolApproval = options.onToolApproval;
    const canUseTool: SDKCanUseTool | undefined = onToolApproval
      ? async (toolName, input, opts) => {
          const result = await onToolApproval(toolName, input, opts);
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
          };
        }
      : undefined;

    // Create the SDK query with our message generator
    const iterator = query({
      prompt: queue.generator(),
      options: {
        cwd: options.cwd,
        resume: options.resumeSessionId,
        abortController,
        permissionMode: options.permissionMode ?? "default",
        canUseTool,
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
      },
    });

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
        yield this.convertMessage(message);
      }
    } catch (error) {
      // Handle abort errors gracefully
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      throw error;
    }
  }

  /**
   * Convert an SDK message to our internal SDKMessage format.
   */
  private convertMessage(message: AgentSDKMessage): SDKMessage {
    // The SDK message types map fairly directly to our types
    switch (message.type) {
      case "system":
        return {
          type: "system",
          subtype: (message as { subtype?: string }).subtype,
          session_id: (message as { session_id?: string }).session_id,
        };

      case "assistant":
        return {
          type: "assistant",
          session_id: (message as { session_id?: string }).session_id,
          message: {
            content: this.extractContent(message),
            role: "assistant",
          },
        };

      case "user":
        return {
          type: "user",
          session_id: (message as { session_id?: string }).session_id,
          message: {
            content: this.extractContent(message),
            role: "user",
          },
        };

      case "result":
        return {
          type: "result",
          subtype: (message as { subtype?: string }).subtype,
          session_id: (message as { session_id?: string }).session_id,
        };

      default:
        // For any other message types, pass through as-is
        return message as unknown as SDKMessage;
    }
  }

  /**
   * Extract content from an SDK message.
   */
  private extractContent(message: AgentSDKMessage): string | ContentBlock[] {
    const msg = message as { message?: { content?: unknown } };
    if (!msg.message?.content) {
      return "";
    }

    const content = msg.message.content;

    // If content is a string, return it directly
    if (typeof content === "string") {
      return content;
    }

    // If content is an array, convert to our content block format
    if (Array.isArray(content)) {
      return content.map((block): ContentBlock => {
        if (typeof block === "string") {
          return { type: "text", text: block };
        }
        // Map SDK block types to our ContentBlock type
        const blockType = block.type as string;
        if (
          blockType === "text" ||
          blockType === "tool_use" ||
          blockType === "tool_result" ||
          blockType === "image"
        ) {
          return block as ContentBlock;
        }
        // Default to text for unknown types
        return { type: "text", text: JSON.stringify(block) };
      });
    }

    return "";
  }
}
