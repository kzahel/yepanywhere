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
    let iterator: AsyncGenerator<AgentSDKMessage>;
    try {
      iterator = query({
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
