import type {
  UploadCompleteMessage,
  UploadErrorMessage,
  UploadProgressMessage,
  UploadedFile,
} from "@claude-anywhere/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UploadError,
  type WebSocketFactory,
  type WebSocketLike,
  buildUploadUrl,
  fileToChunks,
  uploadChunks,
} from "./upload";

/** Mock WebSocket for testing */
class MockWebSocket implements WebSocketLike {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  sentMessages: (string | ArrayBuffer | Uint8Array)[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: Test helper needs flexibility
  private listeners = new Map<string, Set<(ev: any) => void>>();

  constructor(public url: string) {
    // Simulate async open
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.emit("open", new Event("open"));
    }, 0);
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    this.sentMessages.push(data);
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  addEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (ev: WebSocketEventMap[K]) => void,
  ): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (ev: WebSocketEventMap[K]) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  // Test helpers
  emit(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) || []) {
      fn(event);
    }
  }

  simulateMessage(data: unknown): void {
    this.emit("message", { data: JSON.stringify(data) } as MessageEvent);
  }

  simulateError(): void {
    this.emit("error", new Event("error"));
  }

  simulateClose(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code, reason } as CloseEvent);
  }
}

describe("uploadChunks", () => {
  let mockWs: MockWebSocket;
  const createMockWebSocket: WebSocketFactory = (url) => {
    mockWs = new MockWebSocket(url);
    return mockWs;
  };

  const testMetadata = {
    name: "test.txt",
    size: 100,
    mimeType: "text/plain",
  };

  const testFile: UploadedFile = {
    id: "uuid-123",
    name: "uuid-123_test.txt",
    originalName: "test.txt",
    path: "/uploads/uuid-123_test.txt",
    size: 100,
    mimeType: "text/plain",
  };

  async function* testChunks(): AsyncGenerator<Uint8Array> {
    yield new Uint8Array([1, 2, 3]);
    yield new Uint8Array([4, 5, 6]);
  }

  it("sends start message with metadata on open", async () => {
    const uploadPromise = uploadChunks(
      "ws://test/upload",
      testMetadata,
      testChunks(),
      {},
      createMockWebSocket,
    );

    // Wait for connection and messages
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify start message
    expect(mockWs.sentMessages.length).toBeGreaterThan(0);
    const startMsg = JSON.parse(mockWs.sentMessages[0] as string);
    expect(startMsg).toEqual({
      type: "start",
      name: "test.txt",
      size: 100,
      mimeType: "text/plain",
    });

    // Complete the upload
    mockWs.simulateMessage({
      type: "complete",
      file: testFile,
    } as UploadCompleteMessage);

    await uploadPromise;
  });

  it("sends binary chunks after start", async () => {
    const uploadPromise = uploadChunks(
      "ws://test/upload",
      testMetadata,
      testChunks(),
      {},
      createMockWebSocket,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should have: start, chunk1, chunk2, end
    expect(mockWs.sentMessages.length).toBe(4);
    expect(mockWs.sentMessages[1]).toBeInstanceOf(Uint8Array);
    expect(mockWs.sentMessages[2]).toBeInstanceOf(Uint8Array);

    // Verify end message
    const endMsg = JSON.parse(mockWs.sentMessages[3] as string);
    expect(endMsg).toEqual({ type: "end" });

    mockWs.simulateMessage({
      type: "complete",
      file: testFile,
    });

    await uploadPromise;
  });

  it("calls onProgress callback with progress messages", async () => {
    const onProgress = vi.fn();

    const uploadPromise = uploadChunks(
      "ws://test/upload",
      testMetadata,
      testChunks(),
      { onProgress },
      createMockWebSocket,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Simulate progress
    mockWs.simulateMessage({
      type: "progress",
      bytesReceived: 50,
    } as UploadProgressMessage);
    mockWs.simulateMessage({
      type: "progress",
      bytesReceived: 100,
    } as UploadProgressMessage);

    expect(onProgress).toHaveBeenCalledWith(50);
    expect(onProgress).toHaveBeenCalledWith(100);

    mockWs.simulateMessage({
      type: "complete",
      file: testFile,
    });

    await uploadPromise;
  });

  it("resolves with UploadedFile on complete", async () => {
    const uploadPromise = uploadChunks(
      "ws://test/upload",
      testMetadata,
      testChunks(),
      {},
      createMockWebSocket,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    mockWs.simulateMessage({ type: "complete", file: testFile });

    const result = await uploadPromise;
    expect(result).toEqual(testFile);
  });

  it("rejects with UploadError on error message", async () => {
    const uploadPromise = uploadChunks(
      "ws://test/upload",
      testMetadata,
      testChunks(),
      {},
      createMockWebSocket,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    mockWs.simulateMessage({
      type: "error",
      message: "File too large",
      code: "SIZE_LIMIT",
    } as UploadErrorMessage);

    await expect(uploadPromise).rejects.toThrow(UploadError);
    await expect(uploadPromise).rejects.toMatchObject({
      message: "File too large",
      code: "SIZE_LIMIT",
    });
  });

  it("sends cancel message when abort signal fires", async () => {
    const controller = new AbortController();

    const uploadPromise = uploadChunks(
      "ws://test/upload",
      testMetadata,
      testChunks(),
      { signal: controller.signal },
      createMockWebSocket,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    controller.abort();

    await expect(uploadPromise).rejects.toThrow("Upload aborted");

    // Verify cancel message was sent
    const sentStrings = mockWs.sentMessages.filter(
      (m) => typeof m === "string",
    );
    const cancelMsg = sentStrings.find(
      (m) => JSON.parse(m as string).type === "cancel",
    );
    expect(cancelMsg).toBeDefined();
  });

  it("rejects immediately if already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      uploadChunks(
        "ws://test/upload",
        testMetadata,
        testChunks(),
        { signal: controller.signal },
        createMockWebSocket,
      ),
    ).rejects.toThrow("Upload aborted");
  });

  it("rejects on WebSocket error", async () => {
    const uploadPromise = uploadChunks(
      "ws://test/upload",
      testMetadata,
      testChunks(),
      {},
      createMockWebSocket,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    mockWs.simulateError();

    await expect(uploadPromise).rejects.toThrow("WebSocket error");
  });

  it("rejects on unexpected WebSocket close", async () => {
    const uploadPromise = uploadChunks(
      "ws://test/upload",
      testMetadata,
      testChunks(),
      {},
      createMockWebSocket,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    mockWs.simulateClose(1006, "Connection lost");

    await expect(uploadPromise).rejects.toThrow("Connection lost");
  });
});

// Note: fileToChunks tests are skipped because jsdom doesn't support Blob.arrayBuffer()
// This function is a thin wrapper around File.slice() and is tested via E2E tests
describe("fileToChunks", () => {
  it.skip("yields chunks of specified size (requires browser File API)", async () => {
    // Create a mock File
    const content = new Uint8Array(150);
    for (let i = 0; i < 150; i++) content[i] = i;
    const file = new File([content], "test.bin", {
      type: "application/octet-stream",
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of fileToChunks(file, 64)) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(3); // 64 + 64 + 22
    expect(chunks[0]?.length).toBe(64);
    expect(chunks[1]?.length).toBe(64);
    expect(chunks[2]?.length).toBe(22);

    // Verify content is preserved
    expect(chunks[0]?.[0]).toBe(0);
    expect(chunks[0]?.[63]).toBe(63);
    expect(chunks[1]?.[0]).toBe(64);
    expect(chunks[2]?.[0]).toBe(128);
  });

  it("handles empty file", async () => {
    const file = new File([], "empty.txt", { type: "text/plain" });

    const chunks: Uint8Array[] = [];
    for await (const chunk of fileToChunks(file)) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(0);
  });

  it.skip("handles file smaller than chunk size (requires browser File API)", async () => {
    const content = new Uint8Array([1, 2, 3, 4, 5]);
    const file = new File([content], "small.bin");

    const chunks: Uint8Array[] = [];
    for await (const chunk of fileToChunks(file, 64 * 1024)) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(1);
    expect(chunks[0]?.length).toBe(5);
    expect(chunks[0] && Array.from(chunks[0])).toEqual([1, 2, 3, 4, 5]);
  });

  it.skip("handles file exactly divisible by chunk size (requires browser File API)", async () => {
    const content = new Uint8Array(128);
    const file = new File([content], "exact.bin");

    const chunks: Uint8Array[] = [];
    for await (const chunk of fileToChunks(file, 64)) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(2);
    expect(chunks[0]?.length).toBe(64);
    expect(chunks[1]?.length).toBe(64);
  });
});

describe("buildUploadUrl", () => {
  // Store original window.location
  const originalLocation = window.location;

  beforeEach(() => {
    // Reset to original after each test
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
    });
  });

  it("builds correct WebSocket URL with https base", () => {
    const url = buildUploadUrl("proj-123", "sess-456", "https://example.com");
    expect(url).toBe(
      "wss://example.com/api/projects/proj-123/sessions/sess-456/upload/ws",
    );
  });

  it("builds correct WebSocket URL with http base", () => {
    const url = buildUploadUrl("proj-123", "sess-456", "http://localhost:3000");
    expect(url).toBe(
      "ws://localhost:3000/api/projects/proj-123/sessions/sess-456/upload/ws",
    );
  });

  it("handles URL-encoded project IDs", () => {
    const url = buildUploadUrl(
      "L2hvbWUvdXNlci9wcm9qZWN0",
      "sess-456",
      "https://example.com",
    );
    expect(url).toBe(
      "wss://example.com/api/projects/L2hvbWUvdXNlci9wcm9qZWN0/sessions/sess-456/upload/ws",
    );
  });

  it("uses window.location when no base URL provided", () => {
    // Mock window.location
    Object.defineProperty(window, "location", {
      value: {
        protocol: "https:",
        host: "myapp.com:8080",
      },
      writable: true,
    });

    const url = buildUploadUrl("proj-123", "sess-456");
    expect(url).toBe(
      "wss://myapp.com:8080/api/projects/proj-123/sessions/sess-456/upload/ws",
    );
  });
});

describe("UploadError", () => {
  it("has correct name and properties", () => {
    const error = new UploadError("Test error", "TEST_CODE");
    expect(error.name).toBe("UploadError");
    expect(error.message).toBe("Test error");
    expect(error.code).toBe("TEST_CODE");
  });

  it("works without code", () => {
    const error = new UploadError("Test error");
    expect(error.name).toBe("UploadError");
    expect(error.message).toBe("Test error");
    expect(error.code).toBeUndefined();
  });

  it("is instanceof Error", () => {
    const error = new UploadError("Test error");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(UploadError);
  });
});
