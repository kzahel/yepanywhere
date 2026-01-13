/**
 * Transport-agnostic stream augmenter for real-time message processing.
 * Handles Edit, Write, Read, ExitPlanMode augmentations and streaming markdown.
 *
 * Usage:
 * ```typescript
 * const augmenter = await createStreamAugmenter({
 *   onMarkdownAugment: (data) => emit('markdown-augment', data),
 *   onPending: (data) => emit('pending', data),
 *   onError: (err, context) => log.warn({ err }, context),
 * });
 *
 * // Process each message
 * for (const event of events) {
 *   await augmenter.processMessage(event.message);
 *   emit('message', event.message); // message is mutated with augments
 * }
 * ```
 */

import { computeEditAugment } from "./edit-augments.js";
import { renderMarkdownToHtml } from "./markdown-augments.js";
import {
  extractIdFromAssistant,
  extractMessageIdFromStart,
  extractTextDelta,
  extractTextForFinalRender,
  extractTextFromAssistant,
  getMessageContent,
  isStreamingComplete,
} from "./message-utils.js";
import { computeReadAugment } from "./read-augments.js";
import {
  type StreamCoordinator,
  createStreamCoordinator,
} from "./stream-coordinator.js";
import type {
  EditInputWithAugment,
  ExitPlanModeInput,
  ExitPlanModeResult,
  ReadResultWithAugment,
  WriteInputWithAugment,
} from "./types.js";
import { computeWriteAugment } from "./write-augments.js";

/** Markdown augment event data */
export interface MarkdownAugmentData {
  blockIndex?: number;
  html: string;
  type?: string;
  messageId?: string;
}

/** Pending HTML event data */
export interface PendingData {
  html: string;
  messageId?: string;
}

/** Configuration for stream augmenter */
export interface StreamAugmenterConfig {
  /** Emit a markdown augment event */
  onMarkdownAugment: (data: MarkdownAugmentData) => void;
  /** Emit a pending HTML event */
  onPending: (data: PendingData) => void;
  /** Handle augmentation errors (optional, defaults to silent) */
  onError?: (error: unknown, context: string) => void;
}

/** Stream augmenter instance */
export interface StreamAugmenter {
  /**
   * Process a message, computing and embedding augments.
   * This mutates the message object to add augment fields.
   * Call this BEFORE sending the message to the client.
   *
   * For final assistant messages (with uuid), this also emits a markdown-augment
   * event with the fully rendered HTML.
   */
  processMessage(message: Record<string, unknown>): Promise<void>;

  /**
   * Process text through the streaming coordinator.
   * Call this after extracting text deltas from streaming events.
   * This does NOT need to be called directly if using processMessage,
   * which handles text delta extraction automatically.
   */
  processTextChunk(text: string): Promise<void>;

  /**
   * Flush the coordinator on message completion.
   * Called automatically by processMessage when it detects stream end.
   */
  flush(): Promise<void>;

  /**
   * Reset the coordinator state for a new message.
   * Called automatically by processMessage when it detects stream end.
   */
  reset(): void;

  /**
   * Get the current streaming message ID.
   * Useful for accumulating text for late-joining clients.
   */
  getCurrentMessageId(): string | null;

  /**
   * Process accumulated text for catch-up (late-joining clients).
   * Emits a pending event with rendered HTML.
   */
  processCatchUp(text: string, messageId: string): Promise<void>;
}

/**
 * Create a stream augmenter for processing messages with real-time augmentations.
 */
export async function createStreamAugmenter(
  config: StreamAugmenterConfig,
): Promise<StreamAugmenter> {
  const { onMarkdownAugment, onPending, onError } = config;

  // Create StreamCoordinator lazily to avoid initialization overhead
  let coordinator: StreamCoordinator | null = null;
  let coordinatorInitPromise: Promise<StreamCoordinator> | null = null;
  let currentStreamingMessageId: string | null = null;

  const getCoordinator = async (): Promise<StreamCoordinator> => {
    if (coordinator) return coordinator;
    if (!coordinatorInitPromise) {
      coordinatorInitPromise = createStreamCoordinator();
    }
    coordinator = await coordinatorInitPromise;
    return coordinator;
  };

  const handleError = (error: unknown, context: string): void => {
    if (onError) {
      onError(error, context);
    }
    // Silent by default - augments are non-critical
  };

  /**
   * Augment Edit tool_use inputs with diff data.
   */
  const augmentEditInputs = async (
    message: Record<string, unknown>,
  ): Promise<void> => {
    if (message.type !== "assistant") return;

    const content = getMessageContent(message);
    if (!content) return;

    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "tool_use" &&
        (block as Record<string, unknown>).name === "Edit"
      ) {
        const toolUseBlock = block as Record<string, unknown>;
        const input = toolUseBlock.input as EditInputWithAugment;

        if (
          typeof toolUseBlock.id === "string" &&
          typeof input?.file_path === "string" &&
          typeof input?.old_string === "string" &&
          typeof input?.new_string === "string" &&
          !input._structuredPatch
        ) {
          try {
            const augment = await computeEditAugment(toolUseBlock.id, {
              file_path: input.file_path,
              old_string: input.old_string,
              new_string: input.new_string,
            });
            input._structuredPatch = augment.structuredPatch;
            input._diffHtml = augment.diffHtml;
          } catch (err) {
            handleError(err, "Failed to compute edit augment");
          }
        }
      }
    }
  };

  /**
   * Augment Write tool_use inputs with syntax highlighting.
   */
  const augmentWriteInputs = async (
    message: Record<string, unknown>,
  ): Promise<void> => {
    if (message.type !== "assistant") return;

    const content = getMessageContent(message);
    if (!content) return;

    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "tool_use" &&
        (block as Record<string, unknown>).name === "Write"
      ) {
        const toolUseBlock = block as Record<string, unknown>;
        const input = toolUseBlock.input as WriteInputWithAugment;

        if (
          typeof input?.file_path === "string" &&
          typeof input?.content === "string" &&
          !input._highlightedContentHtml
        ) {
          try {
            const augment = await computeWriteAugment({
              file_path: input.file_path,
              content: input.content,
            });
            if (augment) {
              input._highlightedContentHtml = augment.highlightedHtml;
              input._highlightedLanguage = augment.language;
              input._highlightedTruncated = augment.truncated;
              if (augment.renderedMarkdownHtml) {
                input._renderedMarkdownHtml = augment.renderedMarkdownHtml;
              }
            }
          } catch (err) {
            handleError(err, "Failed to compute write augment");
          }
        }
      }
    }
  };

  /**
   * Augment ExitPlanMode with rendered HTML.
   * Also handles Read tool_result augmentation.
   */
  const augmentExitPlanMode = async (
    message: Record<string, unknown>,
  ): Promise<void> => {
    // Check for assistant message with ExitPlanMode tool_use
    if (message.type === "assistant") {
      const content = getMessageContent(message);
      if (!content) return;

      for (const block of content) {
        if (
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "tool_use" &&
          (block as Record<string, unknown>).name === "ExitPlanMode"
        ) {
          const input = (block as Record<string, unknown>)
            .input as ExitPlanModeInput;
          if (input?.plan && !input._renderedHtml) {
            try {
              input._renderedHtml = await renderMarkdownToHtml(input.plan);
            } catch (err) {
              handleError(err, "Failed to render ExitPlanMode plan HTML");
            }
          }
        }
      }
    }

    // Check for user message with tool_result and tool_use_result
    if (message.type === "user") {
      const toolUseResult = message.tool_use_result as
        | ExitPlanModeResult
        | undefined;
      if (toolUseResult?.plan && !toolUseResult._renderedHtml) {
        try {
          toolUseResult._renderedHtml = await renderMarkdownToHtml(
            toolUseResult.plan,
          );
        } catch (err) {
          handleError(err, "Failed to render ExitPlanMode result plan HTML");
        }
      }

      // Check for Read tool_result and augment with syntax highlighting
      const readResult = message.tool_use_result as
        | ReadResultWithAugment
        | undefined;
      if (
        readResult?.type === "text" &&
        readResult.file?.filePath &&
        readResult.file?.content &&
        !readResult._highlightedContentHtml
      ) {
        try {
          const augment = await computeReadAugment({
            file_path: readResult.file.filePath,
            content: readResult.file.content,
          });
          if (augment) {
            readResult._highlightedContentHtml = augment.highlightedHtml;
            readResult._highlightedLanguage = augment.language;
            readResult._highlightedTruncated = augment.truncated;
            if (augment.renderedMarkdownHtml) {
              readResult._renderedMarkdownHtml = augment.renderedMarkdownHtml;
            }
          }
        } catch (err) {
          handleError(err, "Failed to compute read augment");
        }
      }
    }
  };

  /**
   * Process text through the streaming coordinator.
   */
  const processTextChunk = async (text: string): Promise<void> => {
    const messageId = currentStreamingMessageId;
    try {
      const coord = await getCoordinator();
      const result = await coord.onChunk(text);

      for (const augment of result.augments) {
        onMarkdownAugment({
          blockIndex: augment.blockIndex,
          html: augment.html,
          type: augment.type,
          ...(messageId ? { messageId } : {}),
        });
      }

      if (result.pendingHtml) {
        onPending({
          html: result.pendingHtml,
          ...(messageId ? { messageId } : {}),
        });
      }
    } catch (err) {
      handleError(err, "Failed to process text chunk for augments");
    }
  };

  /**
   * Flush the coordinator on message completion.
   */
  const flush = async (): Promise<void> => {
    if (!coordinator) return;
    const messageId = currentStreamingMessageId;
    try {
      const result = await coordinator.flush();
      for (const augment of result.augments) {
        onMarkdownAugment({
          blockIndex: augment.blockIndex,
          html: augment.html,
          type: augment.type,
          ...(messageId ? { messageId } : {}),
        });
      }
      coordinator.reset();
    } catch (err) {
      handleError(err, "Failed to flush coordinator");
    }
  };

  /**
   * Render final markdown augment for completed assistant messages.
   * This sends a markdown-augment event with the complete rendered HTML,
   * keyed by the message's uuid so it survives component remounts.
   */
  const renderFinalMarkdown = async (
    message: Record<string, unknown>,
  ): Promise<void> => {
    // Only for assistant messages with uuid (final messages)
    if (message.type !== "assistant" || !message.uuid) return;

    const textToRender = extractTextForFinalRender(message);
    if (!textToRender) return;

    try {
      const html = await renderMarkdownToHtml(textToRender);
      onMarkdownAugment({
        messageId: message.uuid as string,
        html,
      });
    } catch (err) {
      handleError(err, "Failed to render final markdown augment");
    }
  };

  return {
    async processMessage(message: Record<string, unknown>): Promise<void> {
      // Track message ID from message_start or assistant messages
      const messageId =
        extractMessageIdFromStart(message) ?? extractIdFromAssistant(message);
      if (messageId) {
        currentStreamingMessageId = messageId;
      }

      // Render final markdown augment BEFORE the message is sent
      // This ensures client has the complete HTML when the message arrives
      await renderFinalMarkdown(message);

      // Compute augments for Edit, Write, Read, ExitPlanMode
      await augmentEditInputs(message);
      await augmentWriteInputs(message);
      await augmentExitPlanMode(message);

      // Process text deltas for streaming markdown
      const textDelta =
        extractTextDelta(message) ?? extractTextFromAssistant(message);
      if (textDelta) {
        await processTextChunk(textDelta);
      }

      // Flush coordinator when message stream ends
      if (isStreamingComplete(message)) {
        await flush();
        currentStreamingMessageId = null;
      }
    },

    async processTextChunk(text: string): Promise<void> {
      await processTextChunk(text);
    },

    async flush(): Promise<void> {
      await flush();
    },

    reset(): void {
      if (coordinator) {
        coordinator.reset();
      }
      currentStreamingMessageId = null;
    },

    getCurrentMessageId(): string | null {
      return currentStreamingMessageId;
    },

    async processCatchUp(text: string, messageId: string): Promise<void> {
      try {
        const coord = await getCoordinator();
        const result = await coord.onChunk(text);
        if (result.pendingHtml) {
          onPending({
            html: result.pendingHtml,
            messageId,
          });
        }
      } catch (err) {
        handleError(err, "Failed to send catch-up pending HTML");
      }
    },
  };
}
