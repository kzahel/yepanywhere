import type { ConversationQuery } from "./experimental/simple-client.generated.js";
/**
 * Relay protocol types for remote access via WebSocket.
 *
 * This protocol multiplexes HTTP-like requests, SSE-style event subscriptions,
 * and file uploads over a single WebSocket connection. In secure mode, all
 * messages are encrypted with NaCl secretbox using a session key derived from
 * SRP authentication.
 */

import type { OriginMetadata } from "./connection.js";
import type {
  DeviceICECandidate,
  DeviceICECandidateEvent,
  DeviceSessionState,
  DeviceStreamProfileEvent,
  DeviceStreamStart,
  DeviceStreamStop,
  DeviceWebRTCAnswer,
  DeviceWebRTCOffer,
} from "./devices.js";
import type { GitWorktreeCoverage } from "./git-status.js";
import type { StagedAttachmentRef, UploadedFile } from "./upload.js";
import { isCapabilityBitset, type CapabilityBitset } from "./capability-ids.js";

// Re-export OriginMetadata for convenience
export type { OriginMetadata } from "./connection.js";

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
export type RelaySubscriptionChannel =
  | "/api/experimental/conversation/subscribe"
  | "session"
  | "activity"
  | "session-watch"
  | "glossary"
  | "worktree";

/** Client -> Server: Subscribe to events */
export interface RelaySubscribe {
  apiRevision?: string;
  query?: ConversationQuery;
  type: "subscribe";
  /** Client-generated ID for this subscription (used to unsubscribe) */
  subscriptionId: string;
  /** Channel to subscribe to */
  channel: RelaySubscriptionChannel;
  /** Required for channel: "session" */
  sessionId?: string;
  /** Required for channels: "session-watch", "glossary", and "worktree" */
  projectId?: string;
  /** Requested inventory classes for channel: "worktree" */
  coverage?: GitWorktreeCoverage;
  /** Optional provider hint for channel: "session-watch" */
  provider?: string;
  /** Last event ID for resumption */
  lastEventId?: string;
  /** Whether this subscriber wants live provider deltas (default: true) */
  wantsLiveDeltas?: boolean;
  /** Browser profile identifier for connection tracking (stored in localStorage, shared across tabs) */
  browserProfileId?: string;
  /** Origin metadata for connection tracking */
  originMetadata?: OriginMetadata;
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
// Keepalive Ping/Pong
// ============================================================================

/** Client -> Server: Keepalive ping to verify connection is alive */
export interface ClientPing {
  type: "ping";
  /** Client-generated ID to correlate with pong response */
  id: string;
}

/** Server -> Client: Keepalive pong response */
export interface ServerPong {
  type: "pong";
  /** Echoed from the ping request */
  id: string;
}

// ============================================================================
// Speech stream channel
// ============================================================================

export interface RelaySpeechControl {
  type: "speech_control";
  message: unknown;
}

export interface RelaySpeechEvent {
  type: "speech_event";
  message: {
    type?: "ready" | "interim" | "final" | "error";
    text?: string;
    message?: string;
    transcriptionId?: string;
    isFinal?: boolean;
    speechFinal?: boolean;
    words?: Array<Record<string, unknown>>;
  };
}

// ============================================================================
// Client Capabilities (Phase 3 - Compression negotiation)
// ============================================================================

import type { BinaryFormatValue } from "./binary-framing.js";

/**
 * Client -> Server: Identify the client and declare transport capabilities.
 *
 * Sent immediately after SRP authentication completes (first encrypted message).
 * Server records supported formats and uses them for outgoing messages.
 * If no capabilities message is received, server assumes only format 0x01 (JSON).
 */
export interface ClientCapabilities {
  type: "client_capabilities";
  /** YA client version. Added by the 0.7.1 ID protocol. */
  version?: string;
  /** Explicit client capability IDs not implied by `version`. */
  capabilityBits?: CapabilityBitset;
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
    Array.isArray((msg as { formats?: unknown }).formats) &&
    ((msg as { version?: unknown }).version === undefined ||
      (typeof (msg as { version?: unknown }).version === "string" &&
        (msg as { version: string }).version.trim().length > 0)) &&
    ((msg as { capabilityBits?: unknown }).capabilityBits === undefined ||
      isCapabilityBitset((msg as { capabilityBits?: unknown }).capabilityBits))
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
  /** Image width in pixels, if known */
  width?: number;
  /** Image height in pixels, if known */
  height?: number;
}

/** Client -> Server: Start a draft-staged file upload */
export interface RelayStagedUploadStart {
  type: "staged_upload_start";
  /** Client-generated upload ID */
  uploadId: string;
  /** Optional existing draft staging batch ID */
  batchId?: string;
  /** Original filename */
  filename: string;
  /** Total file size in bytes */
  size: number;
  /** MIME type */
  mimeType: string;
  /** Image width in pixels, if known */
  width?: number;
  /** Image height in pixels, if known */
  height?: number;
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
  /** Uploaded file metadata for session-scoped uploads */
  file?: UploadedFile;
  /** Draft-staged attachment ref for staged uploads */
  stagedRef?: StagedAttachmentRef;
  /** Draft staging batch ID for staged uploads */
  batchId?: string;
}

/** Server -> Client: Upload failed */
export interface RelayUploadError {
  type: "upload_error";
  /** Upload ID */
  uploadId: string;
  /** Error message */
  error: string;
  /** Optional machine-readable upload error code, e.g. DISK_FULL. */
  code?: string;
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
  | RelayStagedUploadStart
  | RelayUploadChunk
  | RelayUploadEnd
  | RelaySpeechControl
  | ClientCapabilities
  | ClientPing
  // Device bridge signaling
  | DeviceStreamStart
  | DeviceStreamStop
  | DeviceWebRTCAnswer
  | DeviceICECandidate;

/** All messages from yepanywhere server -> phone/browser */
export type YepMessage =
  | RelayResponse
  | RelayEvent
  | RelayUploadProgress
  | RelayUploadComplete
  | RelayUploadError
  | RelaySpeechEvent
  | ServerPong
  // Device bridge signaling
  | DeviceWebRTCOffer
  | DeviceICECandidateEvent
  | DeviceSessionState
  | DeviceStreamProfileEvent;

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
  SrpSessionResumeInit,
  SrpSessionResumeChallenge,
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
  isSrpSessionResumeInit,
  isSrpSessionResumeChallenge,
  isSrpSessionResume,
  isSrpSessionResumed,
  isSrpSessionInvalid,
} from "./crypto/srp-types.js";

// Re-export encryption types
export type {
  EncryptedEnvelope,
  SequencedEncryptedPayload,
} from "./crypto/encryption-types.js";
export {
  isEncryptedEnvelope,
  isSequencedEncryptedPayload,
} from "./crypto/encryption-types.js";

/** Connection state for secure WebSocket */
export type SecureConnectionState =
  | "connecting" // WebSocket connecting
  | "srp_hello" // Sent SRP hello, waiting for challenge
  | "srp_proof" // Sent SRP proof, waiting for verify
  | "authenticated" // SRP complete, session key established
  | "error"; // Authentication failed
