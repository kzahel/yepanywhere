/**
 * Relay protocol types for remote access via WebSocket.
 *
 * This protocol multiplexes HTTP-like requests, SSE-style event subscriptions,
 * and file uploads over a single WebSocket connection. In secure mode, all
 * messages are encrypted with NaCl secretbox using a session key derived from
 * SRP authentication.
 */

import type { UploadedFile } from "./upload.js";

// ============================================================================
// Request/Response (HTTP-like)
// ============================================================================

/** HTTP method for relay requests */
export type RelayHttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

/** Client -> Server: HTTP-like request */
export interface RelayRequest {
  type: "request";
  /** UUID for matching response */
  id: string;
  /** HTTP method */
  method: RelayHttpMethod;
  /** Request path, e.g., "/api/sessions" */
  path: string;
  /** Optional headers */
  headers?: Record<string, string>;
  /** Optional request body (JSON-serializable) */
  body?: unknown;
}

/** Server -> Client: HTTP-like response */
export interface RelayResponse {
  type: "response";
  /** Matches request.id */
  id: string;
  /** HTTP status code */
  status: number;
  /** Optional headers */
  headers?: Record<string, string>;
  /** Response body (JSON-serializable) */
  body?: unknown;
}

// ============================================================================
// Event Subscriptions (SSE replacement)
// ============================================================================

/** Subscription channel types */
export type RelaySubscriptionChannel = "session" | "activity";

/** Client -> Server: Subscribe to events */
export interface RelaySubscribe {
  type: "subscribe";
  /** Client-generated ID for this subscription (used to unsubscribe) */
  subscriptionId: string;
  /** Channel to subscribe to */
  channel: RelaySubscriptionChannel;
  /** Required for channel: "session" */
  sessionId?: string;
  /** Last event ID for resumption */
  lastEventId?: string;
  /** Device identifier for connection tracking (browser profile ID) */
  deviceId?: string;
}

/** Client -> Server: Unsubscribe from events */
export interface RelayUnsubscribe {
  type: "unsubscribe";
  /** The subscriptionId from the subscribe message */
  subscriptionId: string;
}

/** Server -> Client: Event pushed to subscriber */
export interface RelayEvent {
  type: "event";
  /** The subscriptionId this event belongs to */
  subscriptionId: string;
  /** Event type, e.g., "message", "status", "stream_event" */
  eventType: string;
  /** Event ID for resumption */
  eventId?: string;
  /** Event payload */
  data: unknown;
}

// ============================================================================
// Client Capabilities (Phase 3 - Compression negotiation)
// ============================================================================

import type { BinaryFormatValue } from "./binary-framing.js";

/**
 * Client -> Server: Declare supported binary formats.
 *
 * Sent immediately after SRP authentication completes (first encrypted message).
 * Server records supported formats and uses them for outgoing messages.
 * If no capabilities message is received, server assumes only format 0x01 (JSON).
 */
export interface ClientCapabilities {
  type: "client_capabilities";
  /** Supported format bytes (e.g., [0x01, 0x02, 0x03]) */
  formats: BinaryFormatValue[];
}

/**
 * Type guard for ClientCapabilities messages.
 */
export function isClientCapabilities(msg: unknown): msg is ClientCapabilities {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: unknown }).type === "client_capabilities" &&
    Array.isArray((msg as { formats?: unknown }).formats)
  );
}

// ============================================================================
// File Upload
// ============================================================================

/** Client -> Server: Start a file upload */
export interface RelayUploadStart {
  type: "upload_start";
  /** Client-generated upload ID */
  uploadId: string;
  /** Project ID (URL-encoded) */
  projectId: string;
  /** Session ID */
  sessionId: string;
  /** Original filename */
  filename: string;
  /** Total file size in bytes */
  size: number;
  /** MIME type */
  mimeType: string;
}

/** Client -> Server: Upload chunk */
export interface RelayUploadChunk {
  type: "upload_chunk";
  /** Upload ID from upload_start */
  uploadId: string;
  /** Byte offset of this chunk */
  offset: number;
  /** Base64-encoded chunk data */
  data: string;
}

/** Client -> Server: End upload (all chunks sent) */
export interface RelayUploadEnd {
  type: "upload_end";
  /** Upload ID from upload_start */
  uploadId: string;
}

/** Server -> Client: Upload progress update */
export interface RelayUploadProgress {
  type: "upload_progress";
  /** Upload ID */
  uploadId: string;
  /** Total bytes received so far */
  bytesReceived: number;
}

/** Server -> Client: Upload completed successfully */
export interface RelayUploadComplete {
  type: "upload_complete";
  /** Upload ID */
  uploadId: string;
  /** Uploaded file metadata */
  file: UploadedFile;
}

/** Server -> Client: Upload failed */
export interface RelayUploadError {
  type: "upload_error";
  /** Upload ID */
  uploadId: string;
  /** Error message */
  error: string;
}

// ============================================================================
// Union Types
// ============================================================================

/** All messages from phone/browser -> yepanywhere server */
export type RemoteClientMessage =
  | RelayRequest
  | RelaySubscribe
  | RelayUnsubscribe
  | RelayUploadStart
  | RelayUploadChunk
  | RelayUploadEnd
  | ClientCapabilities;

/** All messages from yepanywhere server -> phone/browser */
export type YepMessage =
  | RelayResponse
  | RelayEvent
  | RelayUploadProgress
  | RelayUploadComplete
  | RelayUploadError;

/** All relay protocol messages */
export type RelayMessage = RemoteClientMessage | YepMessage;

// ============================================================================
// Secure Connection Types (SRP + Encryption)
// ============================================================================

// Re-export SRP types for convenience
export type {
  SrpClientHello,
  SrpServerChallenge,
  SrpClientProof,
  SrpServerVerify,
  SrpError,
  SrpErrorCode,
  SrpClientMessage,
  SrpServerMessage,
  SrpMessage,
  // Session resumption types
  SrpSessionResume,
  SrpSessionResumed,
  SrpSessionInvalid,
  SrpSessionInvalidReason,
} from "./crypto/srp-types.js";

export {
  isSrpClientHello,
  isSrpClientProof,
  isSrpServerChallenge,
  isSrpServerVerify,
  isSrpError,
  // Session resumption type guards
  isSrpSessionResume,
  isSrpSessionResumed,
  isSrpSessionInvalid,
} from "./crypto/srp-types.js";

// Re-export encryption types
export type { EncryptedEnvelope } from "./crypto/encryption-types.js";
export { isEncryptedEnvelope } from "./crypto/encryption-types.js";

/** Connection state for secure WebSocket */
export type SecureConnectionState =
  | "connecting" // WebSocket connecting
  | "srp_hello" // Sent SRP hello, waiting for challenge
  | "srp_proof" // Sent SRP proof, waiting for verify
  | "authenticated" // SRP complete, session key established
  | "error"; // Authentication failed
