import { toUrlProjectId } from "@claude-anywhere/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerQueue } from "../src/supervisor/WorkerQueue.js";
import type { EventBus } from "../src/watcher/EventBus.js";

const TEST_PROJECT_ID = toUrlProjectId("/test/project");

describe("WorkerQueue", () => {
  let queue: WorkerQueue;
  let mockEventBus: EventBus;

  beforeEach(() => {
    mockEventBus = {
      emit: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      subscriberCount: 0,
    } as unknown as EventBus;

    queue = new WorkerQueue({ eventBus: mockEventBus });
  });

  describe("enqueue", () => {
    it("should add request to queue and return position", () => {
      const { queueId, position } = queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "Hello" },
      });

      expect(queueId).toBeDefined();
      expect(position).toBe(1);
      expect(queue.length).toBe(1);
    });

    it("should increment position for subsequent enqueues", () => {
      const first = queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "First" },
      });

      const second = queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "Second" },
      });

      expect(first.position).toBe(1);
      expect(second.position).toBe(2);
      expect(queue.length).toBe(2);
    });

    it("should emit queue-request-added event", () => {
      queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "Hello" },
      });

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "queue-request-added",
          position: 1,
        }),
      );
    });

    it("should return a promise that can be resolved", async () => {
      const { promise } = queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "Hello" },
      });

      // Get the request and resolve it
      const request = queue.dequeue();
      request?.resolve({ status: "started", processId: "proc-123" });

      const result = await promise;
      expect(result).toEqual({ status: "started", processId: "proc-123" });
    });
  });

  describe("dequeue", () => {
    it("should return undefined for empty queue", () => {
      expect(queue.dequeue()).toBeUndefined();
    });

    it("should return items in FIFO order", () => {
      queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "First" },
      });

      queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "Second" },
      });

      const first = queue.dequeue();
      const second = queue.dequeue();

      expect(first?.message.text).toBe("First");
      expect(second?.message.text).toBe("Second");
    });

    it("should emit position updates for remaining items", () => {
      queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "First" },
      });

      const { queueId } = queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "Second" },
      });

      // Clear previous calls
      vi.mocked(mockEventBus.emit).mockClear();

      queue.dequeue();

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "queue-position-changed",
          queueId,
          position: 1, // Now first in queue
        }),
      );
    });
  });

  describe("cancel", () => {
    it("should return false for non-existent queue ID", () => {
      expect(queue.cancel("non-existent")).toBe(false);
    });

    it("should remove request from queue", () => {
      const { queueId } = queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "Hello" },
      });

      expect(queue.length).toBe(1);
      expect(queue.cancel(queueId)).toBe(true);
      expect(queue.length).toBe(0);
    });

    it("should resolve promise with cancelled status", async () => {
      const { queueId, promise } = queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "Hello" },
      });

      queue.cancel(queueId);

      const result = await promise;
      expect(result).toEqual({
        status: "cancelled",
        reason: "User cancelled",
      });
    });

    it("should emit queue-request-removed event", () => {
      const { queueId } = queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "Hello" },
      });

      vi.mocked(mockEventBus.emit).mockClear();
      queue.cancel(queueId);

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "queue-request-removed",
          queueId,
          reason: "cancelled",
        }),
      );
    });

    it("should update positions for remaining items", () => {
      const first = queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "First" },
      });

      const second = queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "Second" },
      });

      vi.mocked(mockEventBus.emit).mockClear();
      queue.cancel(first.queueId);

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "queue-position-changed",
          queueId: second.queueId,
          position: 1, // Now first in queue
        }),
      );
    });
  });

  describe("findBySessionId", () => {
    it("should return undefined if no matching session", () => {
      queue.enqueue({
        type: "resume-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        sessionId: "session-1",
        message: { text: "Hello" },
      });

      expect(queue.findBySessionId("session-2")).toBeUndefined();
    });

    it("should find request by session ID", () => {
      queue.enqueue({
        type: "resume-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        sessionId: "session-1",
        message: { text: "Hello" },
      });

      const found = queue.findBySessionId("session-1");
      expect(found).toBeDefined();
      expect(found?.sessionId).toBe("session-1");
    });
  });

  describe("getQueueInfo", () => {
    it("should return empty array for empty queue", () => {
      expect(queue.getQueueInfo()).toEqual([]);
    });

    it("should return info for all queued requests", () => {
      queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "First" },
      });

      queue.enqueue({
        type: "resume-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        sessionId: "session-1",
        message: { text: "Second" },
      });

      const info = queue.getQueueInfo();
      expect(info).toHaveLength(2);
      expect(info[0]).toMatchObject({
        type: "new-session",
        position: 1,
      });
      expect(info[1]).toMatchObject({
        type: "resume-session",
        sessionId: "session-1",
        position: 2,
      });
    });
  });

  describe("getPosition", () => {
    it("should return undefined for non-existent queue ID", () => {
      expect(queue.getPosition("non-existent")).toBeUndefined();
    });

    it("should return correct position", () => {
      const first = queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "First" },
      });

      const second = queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "Second" },
      });

      expect(queue.getPosition(first.queueId)).toBe(1);
      expect(queue.getPosition(second.queueId)).toBe(2);
    });

    it("should update positions after dequeue", () => {
      queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "First" },
      });

      const second = queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "Second" },
      });

      queue.dequeue();

      expect(queue.getPosition(second.queueId)).toBe(1);
    });
  });

  describe("peek", () => {
    it("should return undefined for empty queue", () => {
      expect(queue.peek()).toBeUndefined();
    });

    it("should return first item without removing it", () => {
      queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "First" },
      });

      const peeked = queue.peek();
      expect(peeked?.message.text).toBe("First");
      expect(queue.length).toBe(1); // Still in queue
    });
  });

  describe("isEmpty", () => {
    it("should return true for empty queue", () => {
      expect(queue.isEmpty).toBe(true);
    });

    it("should return false for non-empty queue", () => {
      queue.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "Hello" },
      });

      expect(queue.isEmpty).toBe(false);
    });
  });

  describe("without eventBus", () => {
    it("should work without eventBus", () => {
      const queueWithoutBus = new WorkerQueue();

      const { queueId, position } = queueWithoutBus.enqueue({
        type: "new-session",
        projectPath: "/test/project",
        projectId: TEST_PROJECT_ID,
        message: { text: "Hello" },
      });

      expect(queueId).toBeDefined();
      expect(position).toBe(1);

      const dequeued = queueWithoutBus.dequeue();
      expect(dequeued?.message.text).toBe("Hello");
    });
  });
});
