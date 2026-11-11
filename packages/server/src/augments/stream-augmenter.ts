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
 * // Process each message before sending its enriched representation. A
 * // low-latency transport may send the raw message first, then send the
 * // mutated message as a same-id update after this resolves.
 * for (const event of events) {
 *   await augmenter.processMessage(event.message);
 *   emit('message', event.message); // message is mutated with augments
 * }
 * ```
 */

import { CitationSources } from "./citation-sources.js";
import {
  augmentFinalizedMessage,
  getFinalMarkdownHtml,
} from "./finalized-message-augmenter.js";
import {
  extractIdFromAssistant,
  extractMessageIdFromStart,
  extractTextDelta,
  extractTextFromAssistant,
  isStreamingComplete,
} from "./message-utils.js";
import type { SafeMarkdownRenderOptions } from "./safe-markdown.js";
import {
  type StreamCoordinator,
  createStreamCoordinator,
} from "./stream-coordinator.js";
import {
  createTaskListAugmenter,
  type TaskListAugmenter,
} from "./task-list-augments.js";

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
  /** Markdown renderer context for authenticated project-scoped links. */
  safeMarkdownOptions?: SafeMarkdownRenderOptions;
  /** Ordered synchronous task correlation shared with the transport. */
  taskListAugmenter?: TaskListAugmenter;
  /** Ordered source facts, including replay messages already held by the client. */
  citationSources?: CitationSources;
}

/** Stream augmenter instance */
export interface StreamAugmenter {
  /**
   * Process a message, computing and embedding augments.
   * This mutates the message object to add augment fields. Call it before
   * sending the enriched representation; the raw message may already have
   * been sent when the transport supports same-id updates.
   *
   * For final assistant messages (with uuid), this also emits a markdown-augment
   * event with the fully rendered HTML.
   */
  processMessage(message: Record<string, unknown>): Promise<void>;

  /** Compute finalized per-message fields without touching coordinator state. */
  processFinalizedMessage(
    message: Record<string, unknown>,
  ): Promise<MarkdownAugmentData | null>;

  /** Process one provider message through the ordered streaming coordinator. */
  processStreamingMessage(message: Record<string, unknown>): Promise<void>;

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
  const {
    onMarkdownAugment,
    onPending,
    onError,
    safeMarkdownOptions: baseMarkdownOptions,
    taskListAugmenter: sharedTaskListAugmenter,
  } = config;

  const citationSources = config.citationSources ?? new CitationSources();
  const safeMarkdownOptions = {
    ...baseMarkdownOptions,
    citationSources: citationSources.sources,
  };

  // Create StreamCoordinator lazily to avoid initialization overhead
  let coordinator: StreamCoordinator | null = null;
  let coordinatorInitPromise: Promise<StreamCoordinator> | null = null;
  let currentStreamingMessageId: string | null = null;
  let streamedText = "";
  const taskListAugmenter =
    sharedTaskListAugmenter ?? createTaskListAugmenter();

  const getCoordinator = async (): Promise<StreamCoordinator> => {
    if (coordinator) return coordinator;
    if (!coordinatorInitPromise) {
      coordinatorInitPromise = createStreamCoordinator({ safeMarkdownOptions });
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
   * Process text through the streaming coordinator.
   */
  const processTextChunk = async (text: string): Promise<void> => {
    const messageId = currentStreamingMessageId;
    streamedText += text;
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

  const getFinalMarkdownAugment = (
    message: Record<string, unknown>,
  ): MarkdownAugmentData | null => {
    if (message.type !== "assistant" || typeof message.uuid !== "string") {
      return null;
    }
    const html = getFinalMarkdownHtml(message);
    return html ? { messageId: message.uuid, html } : null;
  };

  const processFinalizedMessage = async (
    message: Record<string, unknown>,
  ): Promise<MarkdownAugmentData | null> => {
    citationSources.observeMessage(message);
    await augmentFinalizedMessage(message, {
      safeMarkdownOptions,
      onError: handleError,
    });
    return getFinalMarkdownAugment(message);
  };

  const processStreamingMessage = async (
    message: Record<string, unknown>,
  ): Promise<void> => {
    citationSources.observeMessage(message);
    const messageId =
      extractMessageIdFromStart(message) ?? extractIdFromAssistant(message);
    if (messageId && messageId !== currentStreamingMessageId) {
      await flush();
      streamedText = "";
      currentStreamingMessageId = messageId;
    }

    const snapshot = extractTextFromAssistant(message);
    if (snapshot !== null && !snapshot.startsWith(streamedText)) {
      throw new Error(
        "Streaming assistant snapshot does not extend its previous text",
      );
    }
    const textDelta =
      snapshot !== null
        ? snapshot.slice(streamedText.length)
        : extractTextDelta(message);
    if (textDelta) {
      await processTextChunk(textDelta);
    }

    if (
      isStreamingComplete(message) ||
      (snapshot !== null && message._isStreaming !== true)
    ) {
      await flush();
      currentStreamingMessageId = null;
      streamedText = "";
    }
  };

  return {
    async processMessage(message: Record<string, unknown>): Promise<void> {
      const finalMarkdown = await processFinalizedMessage(message);
      if (finalMarkdown) {
        onMarkdownAugment(finalMarkdown);
      }
      taskListAugmenter.processMessage(message);
      await processStreamingMessage(message);
    },

    processFinalizedMessage,

    processStreamingMessage,

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
      streamedText = "";
    },

    getCurrentMessageId(): string | null {
      return currentStreamingMessageId;
    },

    async processCatchUp(text: string, messageId: string): Promise<void> {
      try {
        const coord = await getCoordinator();
        coord.reset();
        currentStreamingMessageId = messageId;
        streamedText = "";
        await processTextChunk(text);
      } catch (err) {
        handleError(err, "Failed to send catch-up pending HTML");
      }
    },
  };
}
