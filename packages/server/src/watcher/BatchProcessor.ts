/**
 * BatchProcessor collects async tasks and processes them with limited concurrency.
 *
 * Designed to prevent memory spikes from processing many file change events simultaneously.
 * Tasks are deduplicated by key - if the same key is enqueued multiple times before
 * the batch flushes, only the last task runs.
 */

type Task<T> = () => Promise<T>;

export interface BatchProcessorOptions<T> {
  /** Max concurrent tasks (default: 5) */
  concurrency?: number;
  /** Batch window in ms - wait this long to collect events before processing (default: 300) */
  batchMs?: number;
  /** Called for each successful result */
  onResult?: (key: string, result: T) => void;
  /** Called on task error */
  onError?: (key: string, error: Error) => void;
}

export class BatchProcessor<T> {
  private pending: Map<string, Task<T>> = new Map();
  private processing = false;
  private flushTimeout: NodeJS.Timeout | null = null;
  private concurrency: number;
  private batchMs: number;
  private onResult?: (key: string, result: T) => void;
  private onError?: (key: string, error: Error) => void;

  constructor(options: BatchProcessorOptions<T> = {}) {
    this.concurrency = options.concurrency ?? 5;
    this.batchMs = options.batchMs ?? 300;
    this.onResult = options.onResult;
    this.onError = options.onError;
  }

  /**
   * Queue a task for processing.
   * If the same key is queued again before the batch flushes, the previous task is replaced.
   */
  enqueue(key: string, task: Task<T>): void {
    this.pending.set(key, task);
    this.scheduleFlush();
  }

  /**
   * Get the number of pending tasks waiting to be processed.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Check if the processor is currently processing a batch.
   */
  get isProcessing(): boolean {
    return this.processing;
  }

  /**
   * Force immediate processing of pending tasks.
   * Useful for testing or shutdown scenarios.
   */
  async flush(): Promise<void> {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }
    await this.processBatch();
  }

  /**
   * Cancel all pending tasks and clear the queue.
   */
  clear(): void {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }
    this.pending.clear();
  }

  /**
   * Dispose of the processor, clearing all pending tasks.
   */
  dispose(): void {
    this.clear();
  }

  private scheduleFlush(): void {
    if (this.flushTimeout) return;

    this.flushTimeout = setTimeout(() => {
      this.flushTimeout = null;
      this.processBatch();
    }, this.batchMs);
  }

  private async processBatch(): Promise<void> {
    if (this.processing || this.pending.size === 0) return;
    this.processing = true;

    // Grab current batch and clear pending
    const batch = new Map(this.pending);
    this.pending.clear();

    const entries = Array.from(batch.entries());

    // Process in chunks of `concurrency` size
    for (let i = 0; i < entries.length; i += this.concurrency) {
      const chunk = entries.slice(i, i + this.concurrency);
      await Promise.all(
        chunk.map(async ([key, task]) => {
          try {
            const result = await task();
            this.onResult?.(key, result);
          } catch (err) {
            this.onError?.(key, err as Error);
          }
        }),
      );
    }

    this.processing = false;

    // If more events arrived during processing, schedule another flush
    if (this.pending.size > 0) {
      this.scheduleFlush();
    }
  }
}
