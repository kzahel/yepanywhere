import type {
  UploadCancelMessage,
  UploadEndMessage,
  UploadServerMessage,
  UploadStartMessage,
  UploadedFile,
} from "@claude-anywhere/shared";

/** Default chunk size (64KB) - matches server progress interval */
const DEFAULT_CHUNK_SIZE = 64 * 1024;

/** Options for upload functions */
export interface UploadOptions {
  /** Called with bytes uploaded so far */
  onProgress?: (bytesUploaded: number) => void;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Chunk size in bytes (default 64KB) */
  chunkSize?: number;
}

/** Error thrown when upload fails */
export class UploadError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

/**
 * Minimal WebSocket interface for testing.
 * Allows mocking without full browser WebSocket.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (ev: WebSocketEventMap[K]) => void,
  ): void;
  removeEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (ev: WebSocketEventMap[K]) => void,
  ): void;
}

/** WebSocket factory function - allows injection for testing */
export type WebSocketFactory = (url: string) => WebSocketLike;

/**
 * Low-level upload function that sends chunks via WebSocket.
 * Accepts async iterable of chunks for testability.
 *
 * @param url - WebSocket URL for upload endpoint
 * @param metadata - File metadata (name, size, mimeType)
 * @param chunks - Async iterable of Uint8Array chunks
 * @param options - Upload options (progress callback, abort signal)
 * @param createWebSocket - WebSocket factory (defaults to browser WebSocket)
 * @returns Promise resolving to UploadedFile on success
 */
export async function uploadChunks(
  url: string,
  metadata: { name: string; size: number; mimeType: string },
  chunks: AsyncIterable<Uint8Array>,
  options: UploadOptions = {},
  createWebSocket: WebSocketFactory = (u) => new WebSocket(u) as WebSocketLike,
): Promise<UploadedFile> {
  const { onProgress, signal } = options;

  return new Promise((resolve, reject) => {
    // Early abort check
    if (signal?.aborted) {
      reject(new UploadError("Upload aborted", "ABORTED"));
      return;
    }

    const ws = createWebSocket(url);
    let aborted = false;
    let resolved = false;

    // Handle abort signal
    const abortHandler = () => {
      if (resolved) return;
      aborted = true;
      const cancelMsg: UploadCancelMessage = { type: "cancel" };
      try {
        ws.send(JSON.stringify(cancelMsg));
      } catch {
        // Ignore - socket may already be closed
      }
      ws.close(1000, "Aborted by user");
      reject(new UploadError("Upload aborted", "ABORTED"));
    };

    signal?.addEventListener("abort", abortHandler);

    // Cleanup function
    const cleanup = () => {
      signal?.removeEventListener("abort", abortHandler);
    };

    // Handle incoming messages
    const messageHandler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data) as UploadServerMessage;

        switch (msg.type) {
          case "progress": {
            onProgress?.(msg.bytesReceived);
            break;
          }
          case "complete": {
            resolved = true;
            cleanup();
            ws.close(1000, "Upload complete");
            resolve(msg.file);
            break;
          }
          case "error": {
            resolved = true;
            cleanup();
            ws.close(1000, "Error received");
            reject(new UploadError(msg.message, msg.code));
            break;
          }
        }
      } catch {
        // Ignore JSON parse errors for non-JSON messages
      }
    };

    const errorHandler = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(new UploadError("WebSocket error", "WS_ERROR"));
    };

    const closeHandler = (event: CloseEvent) => {
      if (resolved) return;
      cleanup();
      // If we haven't resolved/rejected yet, this is unexpected
      if (!aborted) {
        resolved = true;
        reject(
          new UploadError(
            event.reason || "Connection closed unexpectedly",
            "WS_CLOSED",
          ),
        );
      }
    };

    const openHandler = async () => {
      try {
        // Send start message
        const startMsg: UploadStartMessage = {
          type: "start",
          name: metadata.name,
          size: metadata.size,
          mimeType: metadata.mimeType,
        };
        ws.send(JSON.stringify(startMsg));

        // Send chunks
        for await (const chunk of chunks) {
          if (aborted) break;
          ws.send(chunk);
        }

        if (!aborted) {
          // Send end message
          const endMsg: UploadEndMessage = { type: "end" };
          ws.send(JSON.stringify(endMsg));
        }
      } catch (err) {
        if (resolved) return;
        resolved = true;
        cleanup();
        ws.close(1000, "Error during upload");
        reject(
          err instanceof UploadError
            ? err
            : new UploadError(
                err instanceof Error ? err.message : "Upload failed",
                "UPLOAD_ERROR",
              ),
        );
      }
    };

    ws.addEventListener("open", openHandler);
    ws.addEventListener("message", messageHandler);
    ws.addEventListener("error", errorHandler);
    ws.addEventListener("close", closeHandler);
  });
}

/**
 * Async generator that yields chunks from a browser File object.
 * Uses File.slice() to avoid loading entire file into memory.
 *
 * @param file - Browser File object
 * @param chunkSize - Size of each chunk in bytes
 * @yields Uint8Array chunks
 */
export async function* fileToChunks(
  file: File,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): AsyncGenerator<Uint8Array> {
  let offset = 0;

  while (offset < file.size) {
    const slice = file.slice(offset, offset + chunkSize);
    const buffer = await slice.arrayBuffer();
    yield new Uint8Array(buffer);
    offset += chunkSize;
  }
}

/**
 * Build WebSocket URL for upload endpoint.
 * Exported for cases where URL construction is needed separately.
 *
 * @param projectId - Project ID (URL-encoded)
 * @param sessionId - Session ID
 * @param baseUrl - Optional base URL (defaults to current location)
 * @returns WebSocket URL string
 */
export function buildUploadUrl(
  projectId: string,
  sessionId: string,
  baseUrl?: string,
): string {
  if (baseUrl) {
    const url = new URL(baseUrl);
    const protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${url.host}/api/projects/${projectId}/sessions/${sessionId}/upload/ws`;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  return `${protocol}//${host}/api/projects/${projectId}/sessions/${sessionId}/upload/ws`;
}

/**
 * High-level upload function for browser use.
 * Converts File to chunks and calls uploadChunks.
 *
 * @param projectId - Project ID (URL-encoded format)
 * @param sessionId - Session ID
 * @param file - Browser File object to upload
 * @param options - Upload options
 * @returns Promise resolving to UploadedFile
 */
export async function uploadFile(
  projectId: string,
  sessionId: string,
  file: File,
  options: UploadOptions = {},
): Promise<UploadedFile> {
  const { chunkSize = DEFAULT_CHUNK_SIZE, ...restOptions } = options;

  const url = buildUploadUrl(projectId, sessionId);

  const metadata = {
    name: file.name,
    size: file.size,
    mimeType: file.type || "application/octet-stream",
  };

  const chunks = fileToChunks(file, chunkSize);

  return uploadChunks(url, metadata, chunks, restOptions);
}
