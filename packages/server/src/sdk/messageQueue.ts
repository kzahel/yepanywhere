import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TurnEffort, UploadedFile } from "@yep-anywhere/shared";
import type { UserMessage } from "./types.js";

/** Internal server-stamped identities survive native interrupt concatenation. */
export function apiInputIds(message: UserMessage): string[] {
  const scalar = message.metadata?.apiSubmissionId;
  return [
    ...new Set([
      ...(scalar && scalar === message.uuid ? [scalar] : []),
      ...(message.metadata?.apiSubmissionIds ?? []).slice(0, 1024),
    ]),
  ].filter((id) => typeof id === "string" && id.length > 0 && id.length <= 128);
}

export const CONCAT_SEPARATOR = "--------";
export const INTERRUPT_PREAMBLE = "interrupt resumable after:";

/** Claude CLI command-queue lanes, most to least urgent. */
const PRIORITY_RANK = { now: 0, next: 1, later: 2 } as const;

function mostUrgentPriority(messages: UserMessage[]): UserMessage["priority"] {
  let result: UserMessage["priority"];
  for (const msg of messages) {
    if (!msg.priority) continue;
    if (!result || PRIORITY_RANK[msg.priority] < PRIORITY_RANK[result]) {
      result = msg.priority;
    }
  }
  return result;
}

export type QueuedSDKUserMessage = SDKUserMessage & { turnEffort?: TurnEffort };

type CancellableMessageIterator = AsyncIterator<QueuedSDKUserMessage> &
  AsyncIterable<QueuedSDKUserMessage> & {
    return(): Promise<IteratorResult<QueuedSDKUserMessage>>;
  };

/** Queue surface consumed by Process; remote runtime proxies implement it too. */
export interface AgentMessageQueue {
  push(message: UserMessage): number;
  drain(): UserMessage[];
  /** Remote queues use this to return the worker's authoritative drain. */
  drainAsync?(): Promise<UserMessage[]>;
  removeByTempId(tempId: string): UserMessage[];
  /** Observe messages when the provider input iterator actually consumes them. */
  subscribeYielded?(listener: (messages: UserMessage[]) => void): () => void;
  /** Positive bounded API-input evidence; false never proves nondelivery. */
  hasYieldedApiInput?(id: string): boolean;
  readonly depth: number;
}

/**
 * Concatenate multiple UserMessages into one, joined by separator lines.
 * Shared by MessageQueue and Process to avoid duplicating the merge logic.
 */
export function concatUserMessages(
  messages: UserMessage[],
  preamble?: string,
): UserMessage {
  if (
    messages.length > 1 &&
    messages.some((message) => message.metadata?.turnEffort)
  ) {
    throw new Error("Effort-modified messages must remain separate turns");
  }
  const first = messages[0]!;
  const parts: string[] = [];
  const allImages: string[] = [];
  const allDocs: string[] = [];
  const allAttachments: UploadedFile[] = [];

  if (preamble) {
    parts.push(preamble);
    parts.push(CONCAT_SEPARATOR);
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (i > 0) parts.push(CONCAT_SEPARATOR);
    parts.push(msg.text);
    if (msg.images?.length) allImages.push(...msg.images);
    if (msg.documents?.length) allDocs.push(...msg.documents);
    if (msg.attachments?.length) allAttachments.push(...msg.attachments);
  }

  const combined: UserMessage = {
    text: parts.join("\n\n"),
    uuid: first.uuid,
    tempId: first.tempId,
    ...(first.metadata ? { metadata: first.metadata } : {}),
    ...(first.mode ? { mode: first.mode } : {}),
  };
  const apiSubmissionIds = [...new Set(messages.flatMap(apiInputIds))].slice(
    0,
    1024,
  );
  if (apiSubmissionIds.length)
    combined.metadata = { ...combined.metadata, apiSubmissionIds };
  const sourceSessionId = [...messages]
    .reverse()
    .find((message) => message.metadata?.sourceSessionId)
    ?.metadata?.sourceSessionId;
  if (sourceSessionId) {
    combined.metadata = { ...combined.metadata, sourceSessionId };
  }
  // Record every chunk's temp id so the delivered-turn echo can clear all of
  // the queued chips by identity (the merged text is time-marked and would not
  // match the originally-typed chunk text).
  const tempIds = messages
    .map((msg) => msg.tempId)
    .filter((id): id is string => Boolean(id));
  if (tempIds.length) combined.tempIds = tempIds;
  const priority = mostUrgentPriority(messages);
  if (priority) combined.priority = priority;
  if (
    messages.every(
      (message) =>
        message.recapResumeHandled === true ||
        message.automaticSource !== undefined,
    )
  ) {
    combined.recapResumeHandled = true;
  }
  if (allImages.length) combined.images = allImages;
  if (allDocs.length) combined.documents = allDocs;
  if (allAttachments.length) combined.attachments = allAttachments;
  return combined;
}

function escapeMarkdownLinkText(text: string): string {
  return text.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function formatUploadedFileReference(
  file: {
    originalName: string;
    size: number;
    mimeType: string;
    path: string;
    width?: number;
    height?: number;
  },
  formatSize: (bytes: number) => string,
): string {
  const dimensions =
    file.width && file.height ? `, ${file.width}x${file.height}` : "";
  return `- [${escapeMarkdownLinkText(file.originalName)}](<${file.path}>) (${formatSize(file.size)}, ${file.mimeType}${dimensions})`;
}

/**
 * Detect the media type from base64 image data.
 * Supports data URLs (data:image/png;base64,...) and raw base64 with magic byte detection.
 */
function detectImageMediaType(base64Data: string): string {
  const dataUrlMatch = base64Data.match(/^data:([^;]+);base64,/);
  if (dataUrlMatch?.[1]) {
    return dataUrlMatch[1];
  }

  try {
    const rawBase64 = base64Data.replace(/^data:[^;]+;base64,/, "");
    const bytes = Buffer.from(rawBase64.slice(0, 24), "base64");

    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      return "image/png";
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
    if (
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38
    ) {
      return "image/gif";
    }
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return "image/webp";
    }
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
      return "image/bmp";
    }
  } catch {
    // Fall back to PNG
  }

  return "image/png";
}

/**
 * MessageQueue holds user messages and exposes two interfaces:
 *
 * 1. AsyncIterable — consumed by the SDK's `query()` loop. Each `.next()`
 *    yields one supplied message per `.next()`, preserving its input identity
 *    and delivery priority. Native providers may group inputs themselves.
 *
 * 2. concatDrain() — synchronous drain for stop/interrupt paths. Consumed
 *    by Process to deliver queued messages with an interruption preamble.
 */
export class MessageQueue
  implements AsyncIterable<QueuedSDKUserMessage>, AgentMessageQueue
{
  private queue: UserMessage[] = [];
  private waiting: (() => void) | null = null;
  private depthListeners = new Set<(depth: number) => void>();
  private removalListeners = new Set<(messages: UserMessage[]) => void>();
  private yieldedListeners = new Set<(messages: UserMessage[]) => void>();
  private readonly apiInputs = new Set<string>();
  /** Set when concatDrain() is called to prevent generator from yielding stale data */
  private drainedByExternal = false;

  constructor(
    private readonly prepareInput: (message: UserMessage) => UserMessage = (
      message,
    ) => message,
  ) {}

  /**
   * Push a message onto the queue.
   * If the consumer is waiting, resolves immediately.
   * Otherwise, adds to the buffer.
   *
   * @returns The new queue depth (0 if resolved immediately)
   */
  push(message: UserMessage): number {
    message = this.prepareInput(message);
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      this.queue.push(message);
      resolve();
      this.emitDepth();
      return 0;
    }
    this.queue.push(message);
    this.emitDepth();
    return this.queue.length;
  }

  /**
   * Synchronously drain and concatenate all queued messages into a single
   * UserMessage. Used by Process for stop/interrupt delivery.
   *
   * @param options.interrupted - if true, prepend interrupt preamble
   */
  concatDrain(options?: { interrupted?: boolean }): UserMessage | null {
    this.drainedByExternal = true;
    const drained = this.queue.splice(0);
    this.emitRemoved(drained);
    this.emitDepth();
    if (drained.length === 0) return null;

    return concatUserMessages(
      drained,
      options?.interrupted ? INTERRUPT_PREAMBLE : undefined,
    );
  }

  /**
   * Remove and return messages that have been queued but not yet yielded.
   */
  drain(): UserMessage[] {
    const drained = this.queue.splice(0);
    this.emitRemoved(drained);
    this.emitDepth();
    return drained;
  }

  /**
   * Remove queued messages matching a client temp id before the SDK iterator
   * has yielded them to the provider.
   */
  removeByTempId(tempId: string): UserMessage[] {
    const removed: UserMessage[] = [];
    const kept: UserMessage[] = [];
    for (const message of this.queue) {
      const matches =
        message.tempId === tempId || message.tempIds?.includes(tempId) === true;
      if (matches) {
        removed.push(message);
      } else {
        kept.push(message);
      }
    }
    if (removed.length > 0) {
      this.queue = kept;
      this.emitRemoved(removed);
      this.emitDepth();
    }
    return removed;
  }

  /* ------------------------------------------------------------------ */
  /* AsyncIterable interface (consumed by SDK query loop)               */
  /* ------------------------------------------------------------------ */

  [Symbol.asyncIterator](): CancellableMessageIterator {
    return this.createIterator();
  }

  private createIterator(): CancellableMessageIterator {
    let closed = false;
    const iterator: CancellableMessageIterator = {
      [Symbol.asyncIterator]: () => iterator,

      next: async (): Promise<IteratorResult<QueuedSDKUserMessage>> => {
        while (!closed) {
          // Wait until at least one message is available.
          await this.waitForMessage();
          if (closed) break;

          // Check if external drain stole our messages.
          if (this.drainedByExternal) {
            this.drainedByExternal = false;
            continue;
          }

          const message = this.queue.shift();
          if (!message) continue;
          this.emitYielded([message]);
          this.emitRemoved([message]);
          this.emitDepth();
          return { done: false, value: this.toSDKMessage(message) };
        }

        return { done: true, value: undefined };
      },

      return: (): Promise<IteratorResult<QueuedSDKUserMessage>> => {
        closed = true;
        this.wakeWaitingIterator();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
    return iterator;
  }

  /** Wait until at least one message is available */
  private waitForMessage(): Promise<void> {
    if (this.queue.length > 0) return Promise.resolve();

    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  private wakeWaitingIterator(): void {
    if (!this.waiting) return;
    const resolve = this.waiting;
    this.waiting = null;
    resolve();
  }

  /* ------------------------------------------------------------------ */
  /* Formatting                                                         */
  /* ------------------------------------------------------------------ */

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}\u202fb`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}\u202fkb`;
    if (bytes < 1024 * 1024 * 1024)
      return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}\u202fmb`;
    return `${Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10}\u202fgb`;
  }

  private toSDKMessage(msg: UserMessage): QueuedSDKUserMessage {
    let text = msg.text;

    if (msg.attachments?.length) {
      const lines = msg.attachments.map((f) =>
        formatUploadedFileReference(f, this.formatSize.bind(this)),
      );
      text += `\n\nUser uploaded files:\n${lines.join("\n")}`;
    }

    if (msg.images?.length || msg.documents?.length) {
      const content: Array<
        | { type: "text"; text: string }
        | {
            type: "image";
            source: { type: "base64"; media_type: string; data: string };
          }
      > = [{ type: "text", text }];

      for (const image of msg.images ?? []) {
        const mediaType = detectImageMediaType(image);
        const rawBase64 = image.replace(/^data:[^;]+;base64,/, "");
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: rawBase64,
          },
        });
      }

      if (msg.documents?.length) {
        content[0] = {
          type: "text",
          text: `${text}\n\nAttached documents: ${msg.documents.join(", ")}`,
        };
      }

      return {
        type: "user",
        uuid: msg.uuid,
        ...(msg.metadata?.turnEffort
          ? { turnEffort: msg.metadata.turnEffort }
          : {}),
        ...(msg.mode ? { mode: msg.mode } : {}),
        ...(msg.priority ? { priority: msg.priority } : {}),
        message: {
          role: "user",
          content,
        },
      } as SDKUserMessage;
    }

    return {
      type: "user",
      uuid: msg.uuid,
      ...(msg.metadata?.turnEffort
        ? { turnEffort: msg.metadata.turnEffort }
        : {}),
      ...(msg.mode ? { mode: msg.mode } : {}),
      ...(msg.priority ? { priority: msg.priority } : {}),
      message: {
        role: "user",
        content: text,
      },
    } as SDKUserMessage;
  }

  /** Current number of messages waiting in the queue. */
  get depth(): number {
    return this.queue.length;
  }

  /** Whether the iterator is currently waiting for a message. */
  get isWaiting(): boolean {
    return this.waiting !== null;
  }

  subscribeDepth(listener: (depth: number) => void): () => void {
    this.depthListeners.add(listener);
    listener(this.queue.length);
    return () => this.depthListeners.delete(listener);
  }

  subscribeRemoved(listener: (messages: UserMessage[]) => void): () => void {
    this.removalListeners.add(listener);
    return () => this.removalListeners.delete(listener);
  }

  /** Observe only messages yielded to the SDK input stream, not external drains. */
  subscribeYielded(listener: (messages: UserMessage[]) => void): () => void {
    this.yieldedListeners.add(listener);
    return () => this.yieldedListeners.delete(listener);
  }

  private emitDepth(): void {
    for (const listener of this.depthListeners) listener(this.queue.length);
  }

  private emitRemoved(messages: UserMessage[]): void {
    if (messages.length === 0) return;
    for (const listener of this.removalListeners) listener(messages);
  }

  hasYieldedApiInput(id: string) {
    return this.apiInputs.has(id);
  }
  private emitYielded(messages: UserMessage[]): void {
    if (messages.length === 0) return;
    for (const message of messages) {
      for (const id of apiInputIds(message)) {
        this.apiInputs.add(id);
        while (this.apiInputs.size > 512)
          this.apiInputs.delete(this.apiInputs.values().next().value!);
      }
    }
    for (const listener of this.yieldedListeners) listener(messages);
  }

  /** Backward-compatible alias for the async iterator (used by existing callers). */
  generator(): CancellableMessageIterator {
    return this.createIterator();
  }
}
