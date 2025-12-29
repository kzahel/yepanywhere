import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UserMessage } from "./types.js";

/**
 * MessageQueue provides an async generator pattern for queuing user messages
 * to be sent to the Claude SDK.
 *
 * The SDK expects an AsyncGenerator that yields SDKUserMessage objects.
 * This queue allows messages to be pushed at any time, and the generator
 * will yield them as they become available (blocking when empty).
 */
export class MessageQueue {
  private queue: UserMessage[] = [];
  private waiting: ((msg: UserMessage) => void) | null = null;

  /**
   * Push a message onto the queue.
   * If the generator is waiting for a message, resolves immediately.
   * Otherwise, adds to the queue.
   *
   * @returns The new queue depth (0 if resolved immediately)
   */
  push(message: UserMessage): number {
    if (this.waiting) {
      this.waiting(message);
      this.waiting = null;
      return 0;
    }
    this.queue.push(message);
    return this.queue.length;
  }

  /**
   * Async generator that yields SDK-formatted user messages.
   * Blocks when the queue is empty, waiting for push() to be called.
   */
  async *generator(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const message = await this.next();
      yield this.toSDKMessage(message);
    }
  }

  /**
   * Get the next message from the queue.
   * If the queue is empty, returns a promise that resolves when push() is called.
   */
  private next(): Promise<UserMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  /**
   * Convert a UserMessage to the SDK's SDKUserMessage format.
   */
  private toSDKMessage(msg: UserMessage): SDKUserMessage {
    // If message has images or documents, use array content format
    if (msg.images?.length || msg.documents?.length) {
      const content: Array<
        | { type: "text"; text: string }
        | {
            type: "image";
            source: { type: "base64"; media_type: string; data: string };
          }
      > = [{ type: "text", text: msg.text }];

      // Add images as base64 content blocks
      for (const image of msg.images ?? []) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png", // TODO: detect actual media type
            data: image,
          },
        });
      }

      // Documents would need similar handling
      // For now, we'll just include them in text
      if (msg.documents?.length) {
        content[0] = {
          type: "text",
          text: `${msg.text}\n\nAttached documents: ${msg.documents.join(", ")}`,
        };
      }

      return {
        type: "user",
        message: {
          role: "user",
          content,
        },
      } as SDKUserMessage;
    }

    // Simple text message
    return {
      type: "user",
      message: {
        role: "user",
        content: msg.text,
      },
    } as SDKUserMessage;
  }

  /**
   * Current number of messages waiting in the queue.
   */
  get depth(): number {
    return this.queue.length;
  }

  /**
   * Whether the generator is currently waiting for a message.
   */
  get isWaiting(): boolean {
    return this.waiting !== null;
  }
}
