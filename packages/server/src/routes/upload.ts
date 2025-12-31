import {
  type UploadClientMessage,
  type UploadCompleteMessage,
  type UploadErrorMessage,
  type UploadProgressMessage,
  type UploadServerMessage,
  isUrlProjectId,
} from "@claude-anywhere/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import type { ProjectScanner } from "../projects/scanner.js";
import { UploadManager } from "../uploads/index.js";

/** Progress update interval in bytes (64KB) */
const PROGRESS_INTERVAL_BYTES = 64 * 1024;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UpgradeWebSocketFn = (createEvents: (c: Context) => WSEvents) => any;

export interface UploadDeps {
  scanner: ProjectScanner;
  upgradeWebSocket: UpgradeWebSocketFn;
}

export function createUploadRoutes(deps: UploadDeps): Hono {
  const routes = new Hono();
  const uploadManager = new UploadManager();

  const sendMessage = (ws: WSContext, msg: UploadServerMessage) => {
    ws.send(JSON.stringify(msg));
  };

  const sendError = (ws: WSContext, message: string, code?: string) => {
    const errorMsg: UploadErrorMessage = { type: "error", message, code };
    sendMessage(ws, errorMsg);
  };

  // WebSocket endpoint: /projects/:projectId/sessions/:sessionId/upload/ws
  routes.get(
    "/projects/:projectId/sessions/:sessionId/upload/ws",
    deps.upgradeWebSocket((c) => {
      console.log("[Upload WS] Route matched! Setting up WebSocket handler");
      const projectId = c.req.param("projectId");
      const sessionId = c.req.param("sessionId");
      console.log("[Upload WS] Project:", projectId, "Session:", sessionId);

      // Track current upload for this connection
      let currentUploadId: string | null = null;
      let lastProgressSent = 0;

      // Validation promise - we need to await this before processing messages
      // because onOpen can be async but @hono/node-ws doesn't wait for it
      let validationPromise: Promise<boolean> | null = null;
      let validationResult: boolean | null = null;

      // Message queue to serialize async message handling
      // This prevents race conditions where binary chunks arrive before
      // the async startUpload() completes
      let messageQueue: Promise<void> = Promise.resolve();

      const validate = async (): Promise<boolean> => {
        // Validate projectId format
        if (!isUrlProjectId(projectId)) {
          return false;
        }

        // Validate project exists
        const project = await deps.scanner.getProject(projectId);
        if (!project) {
          return false;
        }

        return true;
      };

      // Process a single message - must be called sequentially via the queue
      const processMessage = async (
        data: string | ArrayBuffer | SharedArrayBuffer | Buffer | Blob,
        ws: WSContext,
      ): Promise<void> => {
        // Wait for validation to complete if it hasn't yet
        if (validationResult === null && validationPromise) {
          validationResult = await validationPromise;
        }

        if (!validationResult) {
          sendError(ws, "Connection not validated", "NOT_VALIDATED");
          return;
        }

        // When using the unified upgrade handler with wss.handleUpgrade,
        // the 'ws' library delivers ALL messages as Buffer by default,
        // bypassing @hono/node-ws's text/binary conversion.
        // We need to handle both Buffer and string data types.

        // Convert Buffer/ArrayBuffer to string for potential JSON parsing
        let stringData: string | null = null;
        let bufferData: Buffer | null = null;

        if (typeof data === "string") {
          stringData = data;
        } else if (
          data instanceof ArrayBuffer ||
          data instanceof SharedArrayBuffer ||
          Buffer.isBuffer(data)
        ) {
          bufferData = Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer);
          // Try to interpret as UTF-8 string for JSON control messages
          stringData = bufferData.toString("utf8");
        } else if (data instanceof Blob) {
          // Blob handling (rare in Node.js WebSocket but possible)
          const arrayBuffer = await data.arrayBuffer();
          bufferData = Buffer.from(arrayBuffer);
          stringData = bufferData.toString("utf8");
        }

        console.log(
          "[Upload WS] Message received, typeof:",
          typeof data,
          "isBuffer:",
          Buffer.isBuffer(data),
          "preview:",
          stringData?.substring(0, 50),
        );

        // Try to parse as JSON control message first
        let msg: UploadClientMessage | null = null;
        if (stringData) {
          const trimmed = stringData.trim();
          if (trimmed.startsWith("{")) {
            try {
              msg = JSON.parse(trimmed) as UploadClientMessage;
              console.log("[Upload WS] Parsed control message:", msg.type);
            } catch {
              // Not valid JSON - treat as binary data
              msg = null;
            }
          }
        }

        // If we parsed a control message, handle it
        if (msg !== null) {
          switch (msg.type) {
            case "start": {
              // Clean up any previous upload
              if (currentUploadId) {
                await uploadManager.cancelUpload(currentUploadId);
              }

              try {
                const { uploadId } = await uploadManager.startUpload(
                  projectId,
                  sessionId,
                  msg.name,
                  msg.size,
                  msg.mimeType,
                );
                currentUploadId = uploadId;
                lastProgressSent = 0;
                console.log("[Upload WS] Upload started:", uploadId);
              } catch (err) {
                const message =
                  err instanceof Error
                    ? err.message
                    : "Failed to start upload";
                sendError(ws, message, "START_ERROR");
              }
              break;
            }

            case "end": {
              if (!currentUploadId) {
                sendError(ws, "No upload in progress", "NO_UPLOAD");
                return;
              }

              const uploadId = currentUploadId;
              try {
                const file = await uploadManager.completeUpload(uploadId);
                const complete: UploadCompleteMessage = {
                  type: "complete",
                  file,
                };
                sendMessage(ws, complete);
                currentUploadId = null;
                console.log("[Upload WS] Upload completed:", file.name);
              } catch (err) {
                const message =
                  err instanceof Error
                    ? err.message
                    : "Failed to complete upload";
                sendError(ws, message, "COMPLETE_ERROR");
                await uploadManager.cancelUpload(uploadId);
                currentUploadId = null;
              }
              break;
            }

            case "cancel": {
              if (currentUploadId) {
                await uploadManager.cancelUpload(currentUploadId);
                currentUploadId = null;
                console.log("[Upload WS] Upload cancelled");
              }
              break;
            }
          }
          return;
        }

        // Otherwise, treat as binary chunk data
        if (!currentUploadId) {
          sendError(
            ws,
            "No upload started - send start message first",
            "NO_UPLOAD",
          );
          return;
        }

        const uploadId = currentUploadId;
        try {
          // Convert to Buffer if needed (bufferData should already be set at this point)
          const chunk =
            bufferData ?? (typeof data === "string" ? Buffer.from(data) : null);
          if (!chunk) {
            sendError(ws, "Invalid chunk data", "INVALID_CHUNK");
            return;
          }

          const bytesReceived = await uploadManager.writeChunk(
            uploadId,
            chunk,
          );

          // Send progress updates periodically
          if (bytesReceived - lastProgressSent >= PROGRESS_INTERVAL_BYTES) {
            const progress: UploadProgressMessage = {
              type: "progress",
              bytesReceived,
            };
            sendMessage(ws, progress);
            lastProgressSent = bytesReceived;
          }
        } catch (err) {
          console.error("[Upload WS] Write error:", err);
          const message =
            err instanceof Error ? err.message : "Write failed";
          sendError(ws, message, "WRITE_ERROR");
          await uploadManager.cancelUpload(uploadId);
          currentUploadId = null;
        }
      };

      return {
        onOpen(_evt, ws) {
          // Start validation (don't await - @hono/node-ws doesn't support async onOpen)
          validationPromise = validate();
          validationPromise.then((result) => {
            validationResult = result;
            if (!result) {
              sendError(ws, "Project validation failed", "VALIDATION_FAILED");
              ws.close(1008, "Validation failed");
            }
          });
        },

        onMessage(evt, ws) {
          // Queue this message to be processed after all previous messages complete
          // This serializes async processing and prevents race conditions
          messageQueue = messageQueue.then(() =>
            processMessage(evt.data, ws).catch((err) => {
              console.error("[Upload WS] Unexpected error:", err);
              sendError(ws, "Internal error", "INTERNAL_ERROR");
            }),
          );
        },

        async onClose(_evt, _ws) {
          // Wait for any pending messages to complete
          await messageQueue;
          // Clean up partial uploads on disconnect
          if (currentUploadId) {
            await uploadManager.cancelUpload(currentUploadId);
          }
        },

        onError(_evt, _ws) {
          // Clean up on error
          if (currentUploadId) {
            uploadManager.cancelUpload(currentUploadId).catch(() => {});
          }
        },
      };
    }),
  );

  return routes;
}
