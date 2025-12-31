import { randomUUID } from "node:crypto";
import type { UrlProjectId } from "@claude-anywhere/shared";
import type { PermissionMode, UserMessage } from "../sdk/types.js";
import type { EventBus } from "../watcher/EventBus.js";

/** Type of queued request */
export type QueuedRequestType = "new-session" | "resume-session";

/** Result when a queued request is processed */
export type QueuedRequestResult =
  | { status: "started"; processId: string }
  | { status: "cancelled"; reason: string };

/** Entry in the worker queue */
export interface QueuedRequest {
  id: string;
  type: QueuedRequestType;
  projectPath: string;
  projectId: UrlProjectId;
  sessionId?: string; // For resume-session requests
  message: UserMessage;
  permissionMode?: PermissionMode;
  queuedAt: Date;
  /** Resolver to call when request is processed or cancelled */
  resolve: (result: QueuedRequestResult) => void;
}

/** Info about a queued request (for API responses) */
export interface QueuedRequestInfo {
  id: string;
  type: QueuedRequestType;
  projectId: UrlProjectId;
  sessionId?: string;
  position: number;
  queuedAt: string;
}

/** Status returned when request is queued instead of started immediately */
export interface QueuedResponse {
  queued: true;
  queueId: string;
  position: number;
}

export interface WorkerQueueOptions {
  eventBus?: EventBus;
}

export class WorkerQueue {
  private queue: QueuedRequest[] = [];
  private eventBus?: EventBus;

  constructor(options: WorkerQueueOptions = {}) {
    this.eventBus = options.eventBus;
  }

  /**
   * Add a request to the queue.
   * Returns queue ID, position, and a promise that resolves when the request is started or cancelled.
   */
  enqueue(params: {
    type: QueuedRequestType;
    projectPath: string;
    projectId: UrlProjectId;
    sessionId?: string;
    message: UserMessage;
    permissionMode?: PermissionMode;
  }): {
    queueId: string;
    position: number;
    promise: Promise<QueuedRequestResult>;
  } {
    const queueId = randomUUID();

    let resolvePromise!: (result: QueuedRequestResult) => void;

    const promise = new Promise<QueuedRequestResult>((resolve) => {
      resolvePromise = resolve;
    });

    const request: QueuedRequest = {
      id: queueId,
      type: params.type,
      projectPath: params.projectPath,
      projectId: params.projectId,
      sessionId: params.sessionId,
      message: params.message,
      permissionMode: params.permissionMode,
      queuedAt: new Date(),
      resolve: resolvePromise,
    };

    this.queue.push(request);
    const position = this.queue.length;

    this.emitQueueAdded(request, position);

    return { queueId, position, promise };
  }

  /**
   * Get the next request from the queue (FIFO).
   */
  dequeue(): QueuedRequest | undefined {
    const request = this.queue.shift();

    if (request) {
      // Emit position updates for remaining items
      this.emitPositionUpdates();
    }

    return request;
  }

  /**
   * Cancel a queued request by ID.
   * Returns true if found and cancelled.
   */
  cancel(queueId: string): boolean {
    const index = this.queue.findIndex((r) => r.id === queueId);
    if (index === -1) return false;

    const removed = this.queue.splice(index, 1)[0];
    if (!removed) return false;

    removed.resolve({ status: "cancelled", reason: "User cancelled" });

    this.emitQueueRemoved(removed, "cancelled");
    this.emitPositionUpdates();

    return true;
  }

  /**
   * Find a queued request for a specific session.
   * Used to consolidate multiple messages to the same session.
   */
  findBySessionId(sessionId: string): QueuedRequest | undefined {
    return this.queue.find((r) => r.sessionId === sessionId);
  }

  /**
   * Get queue info for API responses.
   */
  getQueueInfo(): QueuedRequestInfo[] {
    return this.queue.map((r, i) => ({
      id: r.id,
      type: r.type,
      projectId: r.projectId,
      sessionId: r.sessionId,
      position: i + 1,
      queuedAt: r.queuedAt.toISOString(),
    }));
  }

  /**
   * Get position for a specific queue ID.
   * Returns undefined if not found.
   */
  getPosition(queueId: string): number | undefined {
    const index = this.queue.findIndex((r) => r.id === queueId);
    return index >= 0 ? index + 1 : undefined;
  }

  /**
   * Peek at the next request without removing it.
   */
  peek(): QueuedRequest | undefined {
    return this.queue[0];
  }

  get length(): number {
    return this.queue.length;
  }

  get isEmpty(): boolean {
    return this.queue.length === 0;
  }

  private emitQueueAdded(request: QueuedRequest, position: number): void {
    this.eventBus?.emit({
      type: "queue-request-added",
      queueId: request.id,
      sessionId: request.sessionId,
      projectId: request.projectId,
      position,
      timestamp: new Date().toISOString(),
    });
  }

  private emitQueueRemoved(
    request: QueuedRequest,
    reason: "started" | "cancelled",
  ): void {
    this.eventBus?.emit({
      type: "queue-request-removed",
      queueId: request.id,
      sessionId: request.sessionId,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  private emitPositionUpdates(): void {
    for (let i = 0; i < this.queue.length; i++) {
      const request = this.queue[i];
      if (!request) continue;
      this.eventBus?.emit({
        type: "queue-position-changed",
        queueId: request.id,
        sessionId: request.sessionId,
        position: i + 1,
        timestamp: new Date().toISOString(),
      });
    }
  }
}
