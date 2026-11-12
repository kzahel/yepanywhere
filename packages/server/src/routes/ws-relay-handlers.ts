import * as responsePolicy from "./ws-stream-policy.js";
import type { ConversationSubscriptions } from "../experimental/conversation-subscriptions.js";
import { subscribeConversationRelay } from "../experimental/conversation-relay.js";
/**
 * Shared WebSocket relay handler logic.
 *
 * This module contains the core message handling logic used by both:
 * - createWsRelayRoutes (Hono's upgradeWebSocket for direct connections)
 * - createAcceptRelayConnection (raw WebSocket for relay connections)
 *
 * The handlers are parameterized by dependencies and connection state,
 * allowing both entry points to share the same implementation.
 */

import { randomUUID } from "node:crypto";
import type { HttpBindings } from "@hono/node-server";
import type {
  BinaryFormatValue,
  CapabilityBitset,
  GitWorktreeCoverage,
  OriginMetadata,
  RelayRequest,
  RelayUploadError,
  RelaySpeechEvent,
  RelaySubscribe,
  RelayStagedUploadStart,
  RelayUnsubscribe,
  RelayUploadChunk,
  RelayUploadEnd,
  RelayUploadStart,
  RemoteClientMessage,
  UrlProjectId,
  YepMessage,
} from "@yep-anywhere/shared";
import {
  BinaryFormat,
  RELAY_RESPONSE_STREAM_CHUNK_BYTES,
  RELAY_RESPONSE_STREAM_IDLE_TIMEOUT_MS,
  RELAY_RESPONSE_STREAM_WINDOW_BYTES,
  TRANSPORT_CHUNK_PAYLOAD_MAX_BYTES,
  TRANSPORT_REASSEMBLY_MAX_BYTES,
  TransportChunkError,
  UploadChunkError,
  decodeUploadChunkPayload,
  encodeJsonBytesFrame,
  encodeJsonFrame,
  encodeResponseChunkPayload,
  encodeTransportChunkFrames,
  isUrlProjectId,
  isSrpClientHello,
  isSrpClientProof,
  isSrpSessionResume,
  isSrpSessionResumeInit,
} from "@yep-anywhere/shared";
import type { Hono } from "hono";
import {
  encryptBytesToBinaryEnvelope,
  encryptBytesToBinaryEnvelopeWithCompression,
  encryptToBinaryEnvelopeWithCompression,
} from "../crypto/index.js";
import type { SrpServerSession } from "../crypto/index.js";
import type { DeviceBridgeService } from "../device/DeviceBridgeService.js";
import { getLogger } from "../logging/logger.js";
import type { ProjectGlossarySubscriptionManager } from "../projects/projectGlossarySubscriptionManager.js";
import {
  type ProjectWorktreeSubscriptionManager,
  WorktreeMonitoringDisabledError,
} from "../projects/projectWorktreeSubscriptionManager.js";
import type {
  RemoteAccessService,
  RemoteSessionService,
} from "../remote-access/index.js";
import type {
  BrowserProfileService,
  ConnectedBrowsersService,
} from "../services/index.js";
import type { SecurityClientService } from "../services/SecurityClientService.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import type { SessionQueuePersistenceService } from "../services/SessionQueuePersistenceService.js";
import {
  LEGACY_PUBLIC_SHARE_RELAY_MAX_BYTES as PUBLIC_SHARE_RELAY_LIMIT_BYTES,
  LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES,
} from "../services/PublicShareService.js";
import type { SpeechBackendRegistry } from "../services/voice/registry.js";
import {
  createActivitySubscription,
  createSessionSubscription,
} from "../subscriptions.js";
import type { AttachmentStagingService } from "../uploads/AttachmentStagingService.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { UploadManager } from "../uploads/manager.js";
import type {
  BusEvent,
  EventBus,
  FocusedSessionWatchManager,
} from "../watcher/index.js";
import { isPolicySrpRequired } from "./ws-auth-policy.js";
import {
  type SpeechWebSocketSession,
  createSpeechWebSocketSession,
  type SpeechWsData,
} from "./speech.js";
import {
  decodeFrameToParsedMessage,
  routeClientMessageSafely,
} from "./ws-message-router.js";
import {
  cleanupSrpConnectionState,
  createInitialSrpLimiterState,
  handleSrpHello,
  type SrpLimitedUserLookup,
  handleSrpProof,
  handleSrpResume,
  handleSrpResumeInit,
} from "./ws-srp-handlers.js";
import {
  type WsTransportAuthState,
  hasEstablishedSrpTransport,
  tryLockWsConnectionMode,
} from "./ws-transport-auth.js";
import { parseApplicationClientMessage } from "./ws-transport-message-auth.js";

/** Progress report interval in bytes (64KB) */
export const PROGRESS_INTERVAL = 64 * 1024;
export const LEGACY_PUBLIC_SHARE_RELAY_MAX_BYTES =
  PUBLIC_SHARE_RELAY_LIMIT_BYTES;
export { LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES };

function isJsonMediaType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

const relayJsonDecoder = new TextDecoder("utf-8", { fatal: true });

function parseRelayJsonBody(
  bytes: Uint8Array,
): { valid: true; text: string; value: unknown } | { valid: false } {
  try {
    const text = relayJsonDecoder.decode(bytes);
    return { valid: true, text, value: JSON.parse(text) };
  } catch {
    return { valid: false };
  }
}

/** Connection authentication state */
export type ConnectionAuthState = WsTransportAuthState["authState"];

interface SrpTokenBucket {
  capacity: number;
  refillPerMs: number;
  tokens: number;
  lastRefillAt: number;
}

interface SrpLimiterState {
  helloBucket: SrpTokenBucket;
  blockedUntil: number;
  failedProofCount: number;
}

interface SrpConnectionLimiterState extends SrpLimiterState {
  handshakeTimeout: ReturnType<typeof setTimeout> | null;
}

/** Per-connection state for secure connections */
export interface ConnectionState extends WsTransportAuthState {
  /** Process-unique id used to bind audit clients and active socket teardown. */
  connectionId: string;
  /** SRP session during handshake */
  srpSession: SrpServerSession | null;
  srpHandshakeCurrent?: () => boolean;
  /** Long-lived base key derived from SRP/session key for resume proofs. */
  baseSessionKey: Uint8Array | null;
  /**
   * Whether this authenticated connection must use encrypted envelopes.
   * Set for SRP-authenticated connections; false for trusted local cookie auth.
   */
  requiresEncryptedMessages: boolean;
  /** Username if authenticated */
  username: string | null;
  /**
   * Limited username on the cookie session that upgraded a trusted-local
   * socket, bound once at upgrade; null for the superuser or an SRP socket.
   */
  directLoginUsername: string | null;
  /** Persistent session ID for resumption (set after successful auth) */
  sessionId: string | null;
  /** Transport nonce retained for the lifetime of an established SRP socket. */
  transportNonce: string | null;
  /** Whether this SRP socket used a full password proof or resume proof. */
  authenticationMethod: "srp-full" | "srp-resume" | null;
  /** Whether the client reached this YA server directly or through the relay. */
  transport: "direct" | "relay";
  /** Direct TCP peer address; absent for relay-mediated phone/browser peers. */
  peerAddress: string | null;
  /** Whether client sent binary frames (respond with binary if true) - Phase 0 */
  useBinaryFrames: boolean;
  /** Client's supported binary formats (Phase 3 capabilities) - defaults to [0x01] */
  supportedFormats: Set<BinaryFormatValue>;
  /** Client build version learned from the first application notification. */
  clientVersion: string | null;
  /** Explicit client capability IDs not implied by clientVersion. */
  clientCapabilityBits: CapabilityBitset;
  /** Browser profile ID from SRP hello (for session tracking) */
  browserProfileId: string | null;
  /** Origin metadata from SRP hello (for session tracking) */
  originMetadata: OriginMetadata | null;
  /** Pending one-time challenge for session resume (if any) */
  pendingResumeChallenge: {
    nonce: string;
    clientNonce: string;
    sessionId: string;
    username: string;
    issuedAt: number;
  } | null;
  /** SRP rate-limit and handshake timeout state */
  srpLimiter: SrpConnectionLimiterState;
  /** Next sequence number for encrypted messages sent to the peer */
  nextOutboundSeq: number;
  /** Next identifier for a complete binary message split across transport chunks. */
  nextOutboundChunkMessageId: number;
  /** Last accepted inbound encrypted sequence from the peer */
  lastInboundSeq: number | null;
  /** One browser-tab registration shared by this socket's activity streams. */
  browserTabConnection: {
    browserProfileId: string;
    connectionId: number;
    activitySubscriptionCount: number;
  } | null;
  /** The sole unauthenticated public-share request allowed on this socket. */
  preauthPublicShareRequest: {
    requestId: string;
    controller: AbortController;
  } | null;
  /** Whether connection teardown has already released owned resources. */
  cleanupStarted: boolean;
  /** Streamed response bodies in flight, by request id. */
  responseStreams: Map<string, RelayResponseStreamState>;
  /** Unacknowledged bytes across native connection-window streams, including tails. */
  responseStreamBytes: number;
  responseStreamWaiters: RelayResponseStreamState[];
  responseStreamBorrowers: Set<RelayResponseStreamState>;
}

/** A streamed response body's position in the client's send window. */
export interface RelayResponseStreamState {
  /** Total body bytes the client reports having consumed. */
  ackedBytes: number;
  sentBytes: number;
  connectionWindow: boolean;
  ended: boolean;
  receiptTimer: ReturnType<typeof setTimeout> | null;
  receiptExpired: () => void;
  /** Set when the client cancels or the connection closes. */
  cancelled: boolean;
  /** Resumes a sender waiting for the window to open. */
  wake: (() => void) | null;
  /** Cancels a pending body read when the client leaves during a quiet part. */
  cancelRead: () => Promise<void>;
}

/** Tracks an active upload over WebSocket relay */
export interface RelayUploadState {
  /** Client-provided upload ID */
  clientUploadId: string;
  /** Upload storage backend */
  uploadKind: "session" | "draft-staging";
  stagingService?: AttachmentStagingService;
  /** Server-generated upload ID from UploadManager */
  serverUploadId: string;
  /** Expected total size */
  expectedSize: number;
  /** Bytes received (for offset validation) */
  bytesReceived: number;
  /** Last progress report sent */
  lastProgressReport: number;
  /** Pending chunk write promises (awaited before completing upload) */
  pendingWrites: Promise<void>[];
}

/**
 * Adapter interface for WebSocket send/close operations.
 * Both Hono's WSContext and raw ws.WebSocket can be adapted to this interface.
 * Note: Hono's WSContext.send uses Uint8Array<ArrayBuffer> (not ArrayBufferLike)
 */
export interface WSAdapter {
  /** Live transport state for owner-authorized work spanning async requests. */
  isOpen?(): boolean;
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
}

/**
 * Encryption-aware send function type.
 * Created per-connection, captures connection state for automatic encryption.
 */
export type RequestResponseFrameMode =
  | { kind: "plaintext"; useBinaryFrames: boolean }
  | { kind: "srp_encrypted" };

export interface ValidatedJsonRelayResponse {
  type: "response";
  id: string;
  status: number;
  headers?: Record<string, string>;
  bodyBytes: Uint8Array;
  bodyText: string;
}

export interface SendFn {
  (msg: YepMessage, frameMode?: RequestResponseFrameMode): void;
  /** Internal fast path; the public relay message shape stays unchanged. */
  sendValidatedJsonResponse?: (
    response: ValidatedJsonRelayResponse,
    frameMode?: RequestResponseFrameMode,
  ) => void;
  /**
   * Sends raw bytes of a streamed response body, encrypted and sequenced like
   * any other message. Returns false when the bytes could not be sent; the
   * socket is then closing. Available only on an encrypted connection.
   */
  sendResponseChunk?: (requestId: string, bytes: Uint8Array) => boolean;
}

export interface RelayResponseSerializationStats {
  eligibleJsonResponses: number;
  rawFastPathHits: number;
  rawBodyBytes: number;
  fallbackResponses: number;
  invalidJsonFallbacks: number;
  unsupportedSenderFallbacks: number;
  rawSendFailures: number;
}

const relayResponseSerializationStats: RelayResponseSerializationStats = {
  eligibleJsonResponses: 0,
  rawFastPathHits: 0,
  rawBodyBytes: 0,
  fallbackResponses: 0,
  invalidJsonFallbacks: 0,
  unsupportedSenderFallbacks: 0,
  rawSendFailures: 0,
};

export function relayResponseSerializationDiagnostics(): RelayResponseSerializationStats {
  return { ...relayResponseSerializationStats };
}

export const __relayResponseSerializationTest = {
  reset(): void {
    for (const key of Object.keys(relayResponseSerializationStats) as Array<
      keyof RelayResponseSerializationStats
    >) {
      relayResponseSerializationStats[key] = 0;
    }
  },
};

function relayUploadErrorCode(error: unknown): string | undefined {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOSPC") {
    return "DISK_FULL";
  }
  return undefined;
}

function relayUploadError(
  uploadId: string,
  error: string,
  cause: unknown,
): RelayUploadError {
  const code = relayUploadErrorCode(cause);
  return {
    type: "upload_error",
    uploadId,
    error,
    ...(code ? { code } : {}),
  };
}

/**
 * Dependencies for relay handlers.
 */
export interface RelayHandlerDeps {
  conversationSubscriptions?: ConversationSubscriptions;
  /** The main Hono app to route requests through */
  app: Hono<{ Bindings: HttpBindings }>;
  /** Base URL for internal requests (e.g., "http://localhost:3400") */
  baseUrl: string;
  /** Supervisor for subscribing to session events */
  supervisor: Supervisor;
  /** Event bus for subscribing to activity events */
  eventBus: EventBus;
  /** Upload manager for handling file uploads */
  uploadManager: UploadManager;
  /** Attachment staging service for draft-staged uploads */
  attachmentStagingService?: AttachmentStagingService;
  /** Remote access service for SRP authentication (optional for direct, required for relay) */
  remoteAccessService?: RemoteAccessService;
  /** Limited-user SRP verifiers, selected by srp_hello identity. */
  limitedUsers?: SrpLimitedUserLookup;
  /**
   * One activity event as an authenticated identity may receive it, or null
   * when it is hidden from them.
   */
  activityEventForIdentity?: (
    username: string | null,
    event: BusEvent,
  ) => BusEvent | null;
  /**
   * Whether the authenticated identity may open this subscription. Absent
   * means every authenticated connection may (the single-superuser case).
   * See topics/limited-users.md § Delivery v1 — Authorization.
   */
  authorizeSubscription?: (params: {
    username: string | null;
    target: SubscriptionAccessTarget;
  }) => Promise<boolean>;
  /** Remote session service for session persistence (optional for direct, required for relay) */
  remoteSessionService?: RemoteSessionService;
  /** Registered-client continuity and security audit service. */
  securityClientService?: SecurityClientService;
  /** Durable patient queue state included in session snapshots. */
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
  /** Connected browsers service for tracking WS connections (optional) */
  connectedBrowsers?: ConnectedBrowsersService;
  /** Browser profile service for tracking connection origins (optional) */
  browserProfileService?: BrowserProfileService;
  /** Focused session watch manager for per-session targeted file watching (optional) */
  focusedSessionWatchManager?: FocusedSessionWatchManager;
  /** Project glossary path subscriptions and their reference-counted watchers. */
  projectGlossarySubscriptionManager?: ProjectGlossarySubscriptionManager;
  /** Project worktree snapshots and their reference-counted watchers. */
  projectWorktreeSubscriptionManager?: ProjectWorktreeSubscriptionManager;
  /** Emulator bridge service for Android emulator streaming (optional) */
  deviceBridgeService?: DeviceBridgeService;
  /** Speech backend registry for relayed streaming STT (optional) */
  speechBackendRegistry?: SpeechBackendRegistry;
  /** Server data dir for relayed speech audio retention (optional) */
  dataDir?: string;
  /** Server settings service for relayed speech retention settings (optional) */
  serverSettingsService?: ServerSettingsService;
  /** Authenticated exact probes for bare absolute-path viewer links. */
  resolveAbsoluteFilePaths?: (
    paths: readonly string[],
  ) => Promise<ReadonlySet<string>>;
}

/**
 * The identity whose grants govern what this socket may subscribe to: the
 * SRP identity once its proof established the transport, else the direct
 * login bound at upgrade. Null means the superuser. An `srp_hello` identity
 * that is still awaiting proof counts for nothing.
 */
export function authenticatedConnectionIdentity(
  connState: ConnectionState,
): string | null {
  if (hasEstablishedSrpTransport(connState)) return connState.username;
  return connState.directLoginUsername;
}

/**
 * The account whose draft-staging store this socket's uploads enter: the
 * limited username, or null for the superuser. The owner's relay identity is
 * the superuser, exactly as the tunneled routes resolve it, so a draft staged
 * here is the one those routes validate, materialize, and queue.
 */
export function draftStagingOwnerForConnection(
  connState: ConnectionState,
  superuserIdentity: string | null,
): string | null {
  const identity = authenticatedConnectionIdentity(connState);
  if (
    identity !== null &&
    hasEstablishedSrpTransport(connState) &&
    identity === superuserIdentity
  ) {
    return null;
  }
  return identity;
}

/**
 * Create an initial connection state.
 */
export function createConnectionState(options?: {
  transport?: "direct" | "relay";
  peerAddress?: string | null;
}): ConnectionState {
  return {
    connectionId: randomUUID(),
    srpSession: null,
    sessionKey: null,
    baseSessionKey: null,
    authState: "unauthenticated",
    connectionPolicy: "srp_required",
    connectionMode: "unselected",
    requiresEncryptedMessages: false,
    username: null,
    directLoginUsername: null,
    sessionId: null,
    transportNonce: null,
    authenticationMethod: null,
    transport: options?.transport ?? "direct",
    peerAddress: options?.peerAddress ?? null,
    useBinaryFrames: false,
    supportedFormats: new Set([BinaryFormat.JSON]),
    clientVersion: null,
    clientCapabilityBits: [],
    browserProfileId: null,
    originMetadata: null,
    pendingResumeChallenge: null,
    srpLimiter: createInitialSrpLimiterState(),
    nextOutboundSeq: 0,
    nextOutboundChunkMessageId: 0,
    lastInboundSeq: null,
    browserTabConnection: null,
    preauthPublicShareRequest: null,
    cleanupStarted: false,
    responseStreams: new Map(),
    responseStreamBytes: 0,
    responseStreamWaiters: [],
    responseStreamBorrowers: new Set(),
  };
}

export function cleanupConnectionState(connState: ConnectionState): void {
  if (connState.cleanupStarted) return;
  connState.cleanupStarted = true;
  responsePolicy.abortCollections(connState);
  const activeRequest = connState.preauthPublicShareRequest;
  connState.preauthPublicShareRequest = null;
  activeRequest?.controller.abort();
  for (const stream of connState.responseStreams.values()) {
    if (stream.receiptTimer) clearTimeout(stream.receiptTimer);
    cancelResponseStream(stream);
  }
  connState.responseStreams.clear();
  connState.responseStreamBytes = 0;
  connState.responseStreamWaiters.length = 0;
  connState.responseStreamBorrowers.clear();
  cleanupSrpConnectionState(connState);
}

function cancelResponseStream(stream: RelayResponseStreamState): void {
  stream.cancelled = true;
  stream.wake?.();
  // The sender's finally block also awaits cancellation and releases the lock.
  void stream.cancelRead().catch(() => undefined);
}

/** Records a client's acknowledgement of streamed body bytes. */
export function handleResponseStreamAck(
  connState: ConnectionState,
  id: string,
  bytes: unknown,
): void {
  const stream = connState.responseStreams.get(id);
  if (!stream || !Number.isSafeInteger(bytes)) return;
  if (
    typeof bytes !== "number" ||
    bytes <= stream.ackedBytes ||
    bytes > stream.sentBytes
  )
    return;
  if (stream.connectionWindow)
    connState.responseStreamBytes -= bytes - stream.ackedBytes;
  stream.ackedBytes = bytes;
  if (stream.connectionWindow) {
    if (stream.ended) {
      if (stream.receiptTimer) clearTimeout(stream.receiptTimer);
      if (bytes === stream.sentBytes) connState.responseStreams.delete(id);
      else armResponseReceiptDeadline(stream);
    }
    wakeNativeResponseStreams(connState);
    stream.wake?.();
  } else {
    stream.wake?.();
  }
}

/** Stops a streamed body the client no longer wants. */
export function handleResponseStreamCancel(
  connState: ConnectionState,
  id: string,
): void {
  const stream = connState.responseStreams.get(id);
  if (stream) {
    cancelResponseStream(stream);
    if (stream.connectionWindow) wakeNativeResponseStreams(connState);
  }
}

function sendBinaryMessage(
  ws: WSAdapter,
  connState: ConnectionState,
  message: ArrayBuffer,
): void {
  if (
    message.byteLength <= TRANSPORT_CHUNK_PAYLOAD_MAX_BYTES ||
    !connState.supportedFormats.has(BinaryFormat.TRANSPORT_CHUNK)
  ) {
    ws.send(message);
    return;
  }

  const messageId = connState.nextOutboundChunkMessageId;
  connState.nextOutboundChunkMessageId = (messageId + 1) >>> 0;
  for (const frame of encodeTransportChunkFrames(messageId, message)) {
    ws.send(frame);
  }
}

const relayJsonEncoder = new TextEncoder();

function relayResponseJsonPrefix(response: ValidatedJsonRelayResponse): string {
  const headers = response.headers
    ? `,"headers":${JSON.stringify(response.headers)}`
    : "";
  return (
    `{"type":"response","id":${JSON.stringify(response.id)},` +
    `"status":${response.status}${headers},"body":`
  );
}

function concatenateJsonBytes(
  prefix: string,
  body: Uint8Array,
  suffix: string,
): Uint8Array {
  const prefixBytes = relayJsonEncoder.encode(prefix);
  const suffixBytes = relayJsonEncoder.encode(suffix);
  const result = new Uint8Array(
    prefixBytes.byteLength + body.byteLength + suffixBytes.byteLength,
  );
  result.set(prefixBytes, 0);
  result.set(body, prefixBytes.byteLength);
  result.set(suffixBytes, prefixBytes.byteLength + body.byteLength);
  return result;
}

/**
 * Largest file body relayed as one response. A relayed file arrives whole in
 * one transport message, so a body past the reassembly limit cannot be
 * delivered; refusing it before reading also bounds what the server buffers.
 */
export const RELAY_BINARY_RESPONSE_MAX_BYTES = TRANSPORT_REASSEMBLY_MAX_BYTES;

const RELAY_RESPONSE_TOO_LARGE_ERROR =
  "This file is too large to transfer over a relay connection; open Yep Anywhere directly to download it";

function isTransportMessageTooLarge(error: unknown): boolean {
  return (
    error instanceof TransportChunkError && error.code === "MESSAGE_TOO_LARGE"
  );
}

function responseTooLarge(id: string): YepMessage {
  return {
    type: "response",
    id,
    status: 413,
    headers: { "content-type": "application/json; charset=UTF-8" },
    body: { error: RELAY_RESPONSE_TOO_LARGE_ERROR, retryable: false },
  };
}

function reportSendFailure(ws: WSAdapter, error: unknown): void {
  console.warn("[WS Relay] Failed to send message, closing socket:", error);
  try {
    ws.close(1011, "Send failed");
  } catch {
    // Socket already closing/closed
  }
}

/**
 * Create an encryption-aware send function for a connection.
 * Automatically encrypts messages when the connection is authenticated with a session key.
 * Uses binary frames when the client has sent binary frames (Phase 0/1 binary protocol).
 * Compresses large payloads when client supports format 0x03 (Phase 3).
 * Splits large binary messages when client supports format 0x05 (Phase 4).
 */
export function createSendFn(
  ws: WSAdapter,
  connState: ConnectionState,
): SendFn {
  const send: SendFn = (
    msg: YepMessage,
    frameMode?: RequestResponseFrameMode,
  ) => {
    try {
      const encryptResponse =
        frameMode?.kind === "srp_encrypted" ||
        (frameMode === undefined && hasEstablishedSrpTransport(connState));
      if (encryptResponse) {
        if (!hasEstablishedSrpTransport(connState)) {
          ws.close(1011, "SRP response key unavailable");
          return;
        }
        const seq = connState.nextOutboundSeq;
        connState.nextOutboundSeq += 1;
        const plaintext = JSON.stringify({ seq, msg });

        const supportsCompression = connState.supportedFormats.has(
          BinaryFormat.COMPRESSED_JSON,
        );
        const envelope = encryptToBinaryEnvelopeWithCompression(
          plaintext,
          connState.sessionKey,
          supportsCompression,
        );
        sendBinaryMessage(ws, connState, envelope);
        return;
      }

      const useBinaryFrames =
        frameMode?.kind === "plaintext"
          ? frameMode.useBinaryFrames
          : connState.useBinaryFrames;
      if (useBinaryFrames) {
        // Client sent binary frames, respond with binary
        sendBinaryMessage(ws, connState, encodeJsonFrame(msg));
      } else {
        // Text frame fallback (backwards compat)
        ws.send(JSON.stringify(msg));
      }
    } catch (err) {
      // An undeliverable response fails its own request; closing the socket
      // would also drop every other request and subscription on it.
      if (msg.type === "response" && isTransportMessageTooLarge(err)) {
        send(responseTooLarge(msg.id), frameMode);
        return;
      }
      reportSendFailure(ws, err);
    }
  };

  send.sendValidatedJsonResponse = (
    response: ValidatedJsonRelayResponse,
    frameMode?: RequestResponseFrameMode,
  ): void => {
    try {
      const encryptResponse =
        frameMode?.kind === "srp_encrypted" ||
        (frameMode === undefined && hasEstablishedSrpTransport(connState));
      const responsePrefix = relayResponseJsonPrefix(response);
      if (encryptResponse) {
        if (!hasEstablishedSrpTransport(connState)) {
          ws.close(1011, "SRP response key unavailable");
          return;
        }
        const seq = connState.nextOutboundSeq;
        connState.nextOutboundSeq += 1;
        const plaintext = concatenateJsonBytes(
          `{"seq":${seq},"msg":${responsePrefix}`,
          response.bodyBytes,
          "}}",
        );
        const supportsCompression = connState.supportedFormats.has(
          BinaryFormat.COMPRESSED_JSON,
        );
        const envelope = encryptBytesToBinaryEnvelopeWithCompression(
          plaintext,
          connState.sessionKey,
          supportsCompression,
        );
        sendBinaryMessage(ws, connState, envelope);
        return;
      }

      const useBinaryFrames =
        frameMode?.kind === "plaintext"
          ? frameMode.useBinaryFrames
          : connState.useBinaryFrames;
      if (useBinaryFrames) {
        const serialized = concatenateJsonBytes(
          responsePrefix,
          response.bodyBytes,
          "}",
        );
        sendBinaryMessage(ws, connState, encodeJsonBytesFrame(serialized));
      } else {
        ws.send(`${responsePrefix}${response.bodyText}}`);
      }
    } catch (error) {
      relayResponseSerializationStats.rawSendFailures += 1;
      if (isTransportMessageTooLarge(error)) {
        send(responseTooLarge(response.id), frameMode);
        return;
      }
      reportSendFailure(ws, error);
    }
  };

  send.sendResponseChunk = (requestId: string, bytes: Uint8Array): boolean => {
    if (!hasEstablishedSrpTransport(connState)) return false;
    try {
      const seq = connState.nextOutboundSeq;
      connState.nextOutboundSeq += 1;
      const envelope = encryptBytesToBinaryEnvelope(
        encodeResponseChunkPayload(seq, requestId, bytes),
        BinaryFormat.RESPONSE_CHUNK,
        connState.sessionKey,
      );
      sendBinaryMessage(ws, connState, envelope);
      return true;
    } catch (error) {
      reportSendFailure(ws, error);
      return false;
    }
  };

  return send;
}

function isLegacyPublicShareSessionRequest(request: RelayRequest): boolean {
  if (request.method !== "GET") return false;
  try {
    const pathname = new URL(request.path, "http://relay.internal").pathname;
    return /^\/public-api\/shares\/[^/]+$/.test(pathname);
  } catch {
    return false;
  }
}

class RelayResponseProducerInvariantError extends Error {
  constructor() {
    super("Relay response producer emitted an unbounded chunk");
    this.name = "RelayResponseProducerInvariantError";
  }
}

function responseReadAbortError(): Error {
  const error = new Error("Relay response read aborted");
  error.name = "AbortError";
  return error;
}

async function readResponseBody(
  response: Response,
  options: {
    maxBytes?: number;
    maxProducerChunkBytes?: number;
    signal?: AbortSignal;
  } = {},
): Promise<{ bytes: Uint8Array; overflow: boolean; observedBytes: number }> {
  if (options.signal?.aborted) throw responseReadAbortError();
  if (!response.body) {
    return {
      bytes: new Uint8Array(),
      overflow: false,
      observedBytes: 0,
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  let observedBytes = 0;
  let overflow = false;
  let cancelPromise: Promise<void> | null = null;
  const cancelReader = (reason: string): Promise<void> => {
    cancelPromise ??= reader.cancel(reason).catch(() => undefined);
    return cancelPromise;
  };
  const onAbort = () => {
    void cancelReader("Relay connection closed");
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (options.signal?.aborted) throw responseReadAbortError();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      observedBytes += bytes.byteLength;

      if (
        options.maxProducerChunkBytes !== undefined &&
        bytes.byteLength > options.maxProducerChunkBytes
      ) {
        await cancelReader("Relay response producer chunk exceeded limit");
        throw new RelayResponseProducerInvariantError();
      }
      if (
        options.maxBytes !== undefined &&
        retainedBytes + bytes.byteLength > options.maxBytes
      ) {
        overflow = true;
        await cancelReader("Relay response exceeded limit");
        break;
      }

      if (bytes.byteLength > 0) {
        chunks.push(bytes);
        retainedBytes += bytes.byteLength;
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  if (overflow) {
    return { bytes: new Uint8Array(), overflow, observedBytes };
  }

  const bytes = new Uint8Array(retainedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, overflow, observedBytes };
}

/** Media types relayed as base64 bytes rather than decoded as text. */
function isRelayBinaryMediaType(contentType: string): boolean {
  return (
    contentType.startsWith("image/") ||
    contentType.startsWith("audio/") ||
    contentType.startsWith("video/") ||
    contentType.startsWith("font/") ||
    contentType === "application/pdf" ||
    contentType === "application/octet-stream"
  );
}

function declaredResponseExceedsLimit(
  response: Response,
  maxBytes: number,
): boolean {
  const contentLength = response.headers.get("Content-Length");
  if (!contentLength || !/^\d+$/.test(contentLength)) return false;
  return Number(contentLength) > maxBytes;
}

/** The response headers a relayed response carries to the client. */
function relayedResponseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.startsWith("x-") ||
      normalizedKey === "content-type" ||
      normalizedKey === "content-range" ||
      normalizedKey === "accept-ranges" ||
      normalizedKey === "etag" ||
      normalizedKey === "location" ||
      normalizedKey === "server-timing"
    ) {
      headers[key] = value;
    }
  }
  return headers;
}

class ResponseStreamStalledError extends Error {
  constructor() {
    super("The client stopped reading the streamed response");
    this.name = "ResponseStreamStalledError";
  }
}

function armResponseReceiptDeadline(stream: RelayResponseStreamState): void {
  // Let native's own idle discard/ACK finish before closing an abandoned source.
  stream.receiptTimer = setTimeout(
    stream.receiptExpired,
    RELAY_RESPONSE_STREAM_IDLE_TIMEOUT_MS + 15_000,
  );
}

function wakeNativeResponseStreams(connState: ConnectionState): void {
  connState.responseStreamWaiters[0]?.wake?.();
  for (const stream of connState.responseStreamBorrowers) stream.wake?.();
}

// The native source admits eight readers. Reserve one 64 KiB bridge-sized
// piece for every other current or future slot; lend the rest to active reads.
// Retained tails also cover their slot's floor until receipt transfers that
// reservation back to the future-slot pool; ending must not lend it away.
function nativeResponseReservation(
  connState: ConnectionState,
  current: RelayResponseStreamState,
): number {
  let count = 0;
  let reserved = 0;
  const floor = RELAY_RESPONSE_STREAM_CHUNK_BYTES / 2;
  for (const stream of connState.responseStreams.values()) {
    if (!stream.connectionWindow) continue;
    count++;
    if (stream !== current)
      reserved += Math.max(0, floor - (stream.sentBytes - stream.ackedBytes));
  }
  return reserved + Math.max(0, 8 - count) * floor;
}

/**
 * Waits until `sentBytes` fits the client's window. Returns false when the
 * stream was cancelled; throws when the client makes no progress in time.
 */
async function waitForResponseStreamWindow(
  connState: ConnectionState,
  stream: RelayResponseStreamState,
  bytes: number,
): Promise<boolean> {
  const idleBudget =
    RELAY_RESPONSE_STREAM_IDLE_TIMEOUT_MS +
    (stream.connectionWindow ? 15_000 : 0);
  let deadline = Date.now() + idleBudget;
  const waiters = connState.responseStreamWaiters;
  const removeWaiter = () => {
    const index = waiters.indexOf(stream);
    if (index >= 0) waiters.splice(index, 1);
    waiters[0]?.wake?.();
  };
  try {
    while (!stream.cancelled) {
      const blocked =
        (stream.connectionWindow
          ? connState.responseStreamBytes
          : stream.sentBytes - stream.ackedBytes) +
          bytes >
        RELAY_RESPONSE_STREAM_WINDOW_BYTES;
      const bodyBlocked =
        stream.connectionWindow &&
        connState.responseStreamBytes +
          bytes +
          nativeResponseReservation(connState, stream) >
          RELAY_RESPONSE_STREAM_WINDOW_BYTES;
      const behindPeer =
        stream.connectionWindow && waiters.length > 0 && waiters[0] !== stream;
      if (!blocked && !bodyBlocked && !behindPeer) {
        stream.sentBytes += bytes;
        if (stream.connectionWindow) connState.responseStreamBytes += bytes;
        return true;
      }
      // A reader withholding its own credit cannot sit at the connection FIFO
      // head and block peers that still have per-body capacity.
      if (bodyBlocked && waiters.includes(stream)) removeWaiter();
      if (bodyBlocked) connState.responseStreamBorrowers.add(stream);
      else connState.responseStreamBorrowers.delete(stream);
      if (stream.connectionWindow && !bodyBlocked && !waiters.includes(stream))
        waiters.push(stream);
      const acked = stream.ackedBytes;
      const timedOut = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(
          () => resolve(true),
          Math.max(0, deadline - Date.now()),
        );
        stream.wake = () => {
          clearTimeout(timer);
          resolve(false);
        };
      });
      stream.wake = null;
      if (stream.ackedBytes > acked) deadline = Date.now() + idleBudget;
      if (!stream.cancelled && timedOut) {
        throw new ResponseStreamStalledError();
      }
    }
    return false;
  } finally {
    if (stream.connectionWindow) {
      connState.responseStreamBorrowers.delete(stream);
      removeWaiter();
    }
  }
}

/**
 * Sends a successful body as a stream: a start message, raw chunks no further
 * ahead of the client's acknowledgements than the send window, and an end
 * message. Nothing beyond one read is buffered, and the body has no size
 * limit. Never throws: a failure after the start is reported in the end
 * message, since the client has already accepted the status.
 */
async function streamRelayResponse(
  id: string,
  response: Response,
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string> | undefined,
  send: SendFn,
  sendChunk: (requestId: string, bytes: Uint8Array) => boolean,
  connState: ConnectionState,
  frameMode: RequestResponseFrameMode,
  connectionWindow: boolean,
  ws: WSAdapter,
): Promise<void> {
  const declaredLength = response.headers.get("Content-Length");
  if (responsePolicy.dropClosedBody(connState, body)) return;
  const reader = body.getReader();
  if (
    connState.responseStreams.has(id) ||
    (connectionWindow && connState.responseStreams.size >= 128)
  ) {
    await reader.cancel();
    reader.releaseLock();
    send(
      {
        type: "response",
        id,
        status: 503,
        body: {
          error: connState.responseStreams.has(id)
            ? "Duplicate response stream ID"
            : "Too many retained response streams",
        },
      },
      frameMode,
    );
    return;
  }
  const stream: RelayResponseStreamState = {
    ackedBytes: 0,
    sentBytes: 0,
    connectionWindow,
    ended: false,
    receiptTimer: null,
    receiptExpired: () => {
      cleanupConnectionState(connState);
      ws.close(1008, "Response receipt deadline exceeded");
    },
    cancelled: false,
    wake: null,
    cancelRead: () => reader.cancel(),
  };
  connState.responseStreams.set(id, stream);
  send(
    {
      type: "response_stream_start",
      id,
      status: response.status,
      headers,
      ...(declaredLength && /^\d+$/.test(declaredLength)
        ? { length: Number(declaredLength) }
        : {}),
    },
    frameMode,
  );

  let sentBytes = 0;
  const chunkBytes = connectionWindow
    ? RELAY_RESPONSE_STREAM_CHUNK_BYTES / 2
    : RELAY_RESPONSE_STREAM_CHUNK_BYTES;
  let completed = false;
  let error: string | undefined;
  try {
    reading: while (!stream.cancelled) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      for (let offset = 0; offset < value.byteLength; offset += chunkBytes) {
        const piece = value.subarray(offset, offset + chunkBytes);
        if (
          !(await waitForResponseStreamWindow(
            connState,
            stream,
            piece.byteLength,
          ))
        ) {
          break reading;
        }
        if (!sendChunk(id, piece)) {
          stream.cancelled = true;
          break reading;
        }
        sentBytes += piece.byteLength;
      }
    }
  } catch (err) {
    error =
      err instanceof ResponseStreamStalledError
        ? err.message
        : "The file could not be read completely";
    getLogger().warn(
      `[WS Relay] Streamed response stopped: bytes=${sentBytes}, reason=${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    stream.ended = true;
    if (connectionWindow) wakeNativeResponseStreams(connState);
    if (
      !connectionWindow ||
      stream.ackedBytes === stream.sentBytes ||
      connState.cleanupStarted
    ) {
      connState.responseStreams.delete(id);
    } else {
      // Completed/cancelled data may still be queued in the relay. Only receipt
      // releases its credit; expiry closes the connection rather than guessing.
      armResponseReceiptDeadline(stream);
    }
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  if (!connState.cleanupStarted && (!stream.cancelled || connectionWindow)) {
    send(
      { type: "response_stream_end", id, ...(error ? { error } : {}) },
      frameMode,
    );
  }
}

async function cancelOversizedResponseBody(response: Response): Promise<void> {
  await response.body
    ?.cancel("Relay response exceeded declared limit")
    .catch(() => undefined);
}

/**
 * Handle a RelayRequest by routing it through the Hono app.
 */
export async function handleRequest(
  request: RelayRequest,
  send: SendFn,
  ws: WSAdapter,
  app: Hono<{ Bindings: HttpBindings }>,
  baseUrl: string,
  connState: ConnectionState,
  remoteSessionService?: Pick<RemoteSessionService, "getResumeSessionFailure">,
): Promise<void> {
  const responseFrameMode: RequestResponseFrameMode =
    hasEstablishedSrpTransport(connState)
      ? { kind: "srp_encrypted" }
      : { kind: "plaintext", useBinaryFrames: connState.useBinaryFrames };
  const legacyPublicShareRequest = isLegacyPublicShareSessionRequest(request);
  const publicShareRequest = request.path.startsWith("/public-api/shares/");
  const preauthPublicShareCandidate =
    publicShareRequest &&
    isPolicySrpRequired(connState.connectionPolicy) &&
    !hasEstablishedSrpTransport(connState);
  const isPreauthPublicShareRequest =
    preauthPublicShareCandidate &&
    tryLockWsConnectionMode(connState, "public_read_only");
  if (preauthPublicShareCandidate && !isPreauthPublicShareRequest) {
    ws.close(1008, "Connection mode already selected");
    return;
  }

  let preauthController: AbortController | null = null;
  if (isPreauthPublicShareRequest) {
    if (connState.cleanupStarted || connState.preauthPublicShareRequest) {
      cleanupConnectionState(connState);
      ws.close(1008, "Public-share requests must be sequential");
      return;
    }
    preauthController = new AbortController();
    connState.preauthPublicShareRequest = {
      requestId: request.id,
      controller: preauthController,
    };
  }

  try {
    const url = new URL(request.path, baseUrl);
    const requestHeaders = new Headers(request.headers);
    requestHeaders.delete("Accept-Encoding");
    requestHeaders.set("X-Yep-Anywhere", "true");
    requestHeaders.set("X-Ws-Relay", "true");
    if (connState.clientVersion) {
      requestHeaders.set("X-Yep-Client-Version", connState.clientVersion);
    }
    if (request.body !== undefined) {
      requestHeaders.set("Content-Type", "application/json");
    }

    const fetchInit: RequestInit = {
      method: request.method,
      headers: requestHeaders,
      ...(preauthController ? { signal: preauthController.signal } : {}),
    };

    if (
      request.body !== undefined &&
      request.method !== "GET" &&
      request.method !== "DELETE"
    ) {
      fetchInit.body = JSON.stringify(request.body);
    }

    const fetchRequest = new Request(url.toString(), fetchInit);
    // Mark requests from authenticated websocket transport as internal auth so
    // cookie middleware does not re-challenge routed API requests.
    let closeAfterResponse = false;
    const afterResponseTasks: Array<() => Promise<void> | void> = [];
    const ownerSessionId = connState.sessionId;
    const srpTransport =
      hasEstablishedSrpTransport(connState) &&
      connState.username &&
      connState.sessionId &&
      connState.transportNonce &&
      connState.authenticationMethod
        ? {
            kind: "srp" as const,
            username: connState.username,
            sessionId: connState.sessionId,
            transportNonce: connState.transportNonce,
            authenticationMethod: connState.authenticationMethod,
            transport: connState.transport,
            connectionId: connState.connectionId,
            isActive: () =>
              !connState.cleanupStarted &&
              hasEstablishedSrpTransport(connState) &&
              connState.sessionId === ownerSessionId &&
              typeof ownerSessionId === "string" &&
              remoteSessionService?.getResumeSessionFailure(ownerSessionId) ===
                null &&
              ws.isOpen?.() === true,
            ...(connState.peerAddress
              ? { peerAddress: connState.peerAddress }
              : {}),
            closeConnection: () => ws.close(4004, "Security client revoked"),
            closeAfterResponse: () => {
              closeAfterResponse = true;
            },
            deferAfterResponse: (task: () => Promise<void> | void) => {
              afterResponseTasks.push(task);
            },
          }
        : null;
    const response = await responsePolicy.dispatchRelay(
      request,
      fetchRequest,
      srpTransport,
      app,
      connState,
      responseFrameMode.kind === "srp_encrypted" && !!send.sendResponseChunk,
    );
    const runAfterResponseTasks = async (): Promise<void> => {
      for (const task of afterResponseTasks) {
        try {
          await task();
        } catch (error) {
          console.error("[WS Relay] After-response task failed:", error);
        }
      }
      if (closeAfterResponse) {
        ws.close(4004, "Security client revoked");
      }
    };

    let responseStatus = response.status;
    let body: unknown;
    let validatedJsonBody: { bytes: Uint8Array; text: string } | undefined;
    const contentType = response.headers.get("Content-Type") ?? "";
    const jsonResponse = isJsonMediaType(contentType);
    const downloadResponse =
      response.ok &&
      (url.searchParams.get("download") === "true" ||
        response.headers
          .get("Content-Disposition")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() === "attachment");
    const binaryResponse =
      !(legacyPublicShareRequest && !jsonResponse) &&
      (downloadResponse ||
        (!jsonResponse && isRelayBinaryMediaType(contentType)));
    const streamedBody = responsePolicy.relayStreamBody(
      request,
      response,
      responseFrameMode.kind === "srp_encrypted" &&
        !isPreauthPublicShareRequest,
      binaryResponse,
    );
    if (streamedBody && send.sendResponseChunk) {
      const headers = relayedResponseHeaders(response);
      await streamRelayResponse(
        request.id,
        response,
        streamedBody,
        Object.keys(headers).length > 0 ? headers : undefined,
        send,
        send.sendResponseChunk,
        connState,
        responseFrameMode,
        request.stream === "connection",
        ws,
      );
      await runAfterResponseTasks();
      return;
    }
    const maxBytes = isPreauthPublicShareRequest
      ? LEGACY_PUBLIC_SHARE_RELAY_MAX_BYTES
      : binaryResponse
        ? RELAY_BINARY_RESPONSE_MAX_BYTES
        : undefined;
    const declaredOverflow =
      maxBytes !== undefined &&
      declaredResponseExceedsLimit(response, maxBytes);
    if (declaredOverflow) {
      await cancelOversizedResponseBody(response);
    }
    const responseBody = declaredOverflow
      ? {
          bytes: new Uint8Array(),
          overflow: true,
          observedBytes: Number(response.headers.get("Content-Length")),
        }
      : await readResponseBody(response, {
          ...(maxBytes !== undefined ? { maxBytes } : {}),
          ...(isPreauthPublicShareRequest && legacyPublicShareRequest
            ? {
                maxProducerChunkBytes:
                  LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES,
              }
            : {}),
          signal: preauthController?.signal,
        });

    if (responseBody.overflow) {
      responseStatus = 413;
      const kind = !isPreauthPublicShareRequest
        ? "file"
        : legacyPublicShareRequest
          ? "legacy-session"
          : "public-resource";
      body =
        kind === "file"
          ? { error: RELAY_RESPONSE_TOO_LARGE_ERROR, retryable: false }
          : kind === "legacy-session"
            ? {
                error:
                  "This public share is too large for the legacy relay response; update the public viewer and YA server",
                retryable: false,
                updateRequired: true,
              }
            : {
                error:
                  "This public share resource is too large for relay access; use a direct connection or request a smaller file",
                retryable: false,
              };
      getLogger().warn(
        `[WS Relay] ${kind === "file" ? "File" : "Public share"} response capped: method=${request.method}, kind=${kind}, status=${response.status}, bytes=${responseBody.observedBytes}`,
      );
    } else if (legacyPublicShareRequest && !jsonResponse) {
      const text = new TextDecoder().decode(responseBody.bytes);
      body = text || null;
    } else if (downloadResponse) {
      // Downloads preserve original bytes, including JSON formatting and
      // integers that parsing would round. Keep errors on their normal path.
      body = {
        _binary: true,
        data: Buffer.from(responseBody.bytes).toString("base64"),
      };
    } else if (jsonResponse) {
      relayResponseSerializationStats.eligibleJsonResponses += 1;
      const parsed = parseRelayJsonBody(responseBody.bytes);
      if (!parsed.valid) {
        relayResponseSerializationStats.fallbackResponses += 1;
        relayResponseSerializationStats.invalidJsonFallbacks += 1;
        body = null;
      } else if (send.sendValidatedJsonResponse) {
        validatedJsonBody = {
          bytes: responseBody.bytes,
          text: parsed.text,
        };
      } else {
        relayResponseSerializationStats.fallbackResponses += 1;
        relayResponseSerializationStats.unsupportedSenderFallbacks += 1;
        body = parsed.value;
      }
    } else if (isRelayBinaryMediaType(contentType)) {
      body = {
        _binary: true,
        data: Buffer.from(responseBody.bytes).toString("base64"),
      };
    } else {
      const text = new TextDecoder().decode(responseBody.bytes);
      body = text || null;
    }

    const responseHeaders = relayedResponseHeaders(response);
    if (responseBody.overflow) {
      responseHeaders["content-type"] = "application/json; charset=UTF-8";
    }

    const relayHeaders =
      Object.keys(responseHeaders).length > 0 ? responseHeaders : undefined;
    if (validatedJsonBody && send.sendValidatedJsonResponse) {
      relayResponseSerializationStats.rawFastPathHits += 1;
      relayResponseSerializationStats.rawBodyBytes +=
        validatedJsonBody.bytes.byteLength;
      send.sendValidatedJsonResponse(
        {
          type: "response",
          id: request.id,
          status: responseStatus,
          headers: relayHeaders,
          bodyBytes: validatedJsonBody.bytes,
          bodyText: validatedJsonBody.text,
        },
        responseFrameMode,
      );
    } else {
      send(
        {
          type: "response",
          id: request.id,
          status: responseStatus,
          headers: relayHeaders,
          body,
        },
        responseFrameMode,
      );
    }
    await runAfterResponseTasks();
  } catch (err) {
    if (preauthController?.signal.aborted) return;
    if (publicShareRequest) {
      getLogger().error(
        `[WS Relay] Public share request failed: method=${request.method}`,
      );
    } else {
      console.error("[WS Relay] Request error:", err);
    }
    send(
      {
        type: "response",
        id: request.id,
        status: 500,
        body: { error: "Internal server error" },
      },
      responseFrameMode,
    );
  } finally {
    if (
      preauthController &&
      connState.preauthPublicShareRequest?.controller === preauthController
    ) {
      connState.preauthPublicShareRequest = null;
    }
  }
}

/**
 * Handle a session subscription.
 * Subscribes to process events, computes augments, and forwards them as RelayEvent messages.
 */
export function handleSessionSubscribe(
  subscriptions: Map<string, () => void>,
  msg: RelaySubscribe,
  send: SendFn,
  supervisor: Supervisor,
  sessionQueuePersistenceService?: SessionQueuePersistenceService,
  resolveAbsoluteFilePaths?: (
    paths: readonly string[],
  ) => Promise<ReadonlySet<string>>,
): void {
  const { subscriptionId, sessionId } = msg;
  const wantsLiveDeltas = msg.wantsLiveDeltas !== false;
  const wantsLiveToolOutput = msg.wantsLiveToolOutput !== false;

  if (!sessionId) {
    send({
      type: "response",
      id: subscriptionId,
      status: 400,
      body: { error: "sessionId required for session channel" },
    });
    return;
  }

  const process = supervisor.getProcessForSession(sessionId);
  if (!process) {
    send({
      type: "response",
      id: subscriptionId,
      status: 404,
      body: { error: "No active process for session" },
    });
    return;
  }

  const sendEvent = (eventType: string, data: unknown, eventId: string) => {
    send({
      type: "event",
      subscriptionId,
      eventType,
      eventId,
      data,
    });
  };

  const { cleanup } = createSessionSubscription(process, sendEvent, {
    wantsLiveDeltas,
    wantsLiveToolOutput,
    lastEventId: msg.lastEventId,
    sessionQueuePersistenceService,
    sessionMetadataService: supervisor.getSessionMetadataService(),
    resolveAbsoluteFilePaths,
    onError: (err) => {
      console.error("[WS Relay] Error in session subscription:", err);
    },
  });
  const cleanupPromptCacheKeepalive =
    supervisor.registerPromptCacheKeepaliveViewer(process);

  subscriptions.set(subscriptionId, () => {
    cleanupPromptCacheKeepalive();
    cleanup();
  });

  console.log(
    `[WS Relay] Subscribed to session ${sessionId} (${subscriptionId})`,
  );
}

/**
 * Handle an activity subscription.
 * Subscribes to event bus and forwards events as RelayEvent messages.
 */
export function handleActivitySubscribe(
  subscriptions: Map<string, () => void>,
  msg: RelaySubscribe,
  send: SendFn,
  eventBus: EventBus,
  connState: ConnectionState,
  connectedBrowsers?: ConnectedBrowsersService,
  browserProfileService?: BrowserProfileService,
  closeConnection?: () => void,
  /**
   * One activity event as this connection's identity may receive it, or null
   * when hidden. Absent means every event is delivered as is, which is the
   * single-superuser case.
   * See topics/limited-users.md § Delivery v1 — Authorization.
   */
  eventForViewer?: (event: BusEvent) => BusEvent | null,
): void {
  const { subscriptionId, browserProfileId, originMetadata } = msg;

  const releaseBrowserTabConnection = retainBrowserTabConnection(
    connState,
    browserProfileId,
    connectedBrowsers,
    closeConnection,
  );

  // Record origin metadata if available
  if (browserProfileService && browserProfileId && originMetadata) {
    browserProfileService
      .recordConnection(browserProfileId, originMetadata)
      .catch((err) => {
        console.warn(
          "[WS Relay] Failed to record browser profile origin:",
          err,
        );
      });
  }

  let eventId = 0;
  const sendEvent = (eventType: string, data: unknown) => {
    send({
      type: "event",
      subscriptionId,
      eventType,
      eventId: String(eventId++),
      data,
    });
  };

  const { cleanup } = createActivitySubscription(eventBus, sendEvent, {
    eventForSubscriber: eventForViewer,
    logLabel: subscriptionId,
    onError: (err) => {
      console.error("[WS Relay] Error in activity subscription:", err);
    },
  });

  subscriptions.set(subscriptionId, () => {
    cleanup();
    releaseBrowserTabConnection();
  });

  getLogger().debug(`[WS Relay] Subscribed to activity (${subscriptionId})`);
}

function retainBrowserTabConnection(
  connState: ConnectionState,
  browserProfileId: string | undefined,
  connectedBrowsers: ConnectedBrowsersService | undefined,
  closeConnection: (() => void) | undefined,
): () => void {
  if (!connectedBrowsers || !browserProfileId) return () => {};

  let registration = connState.browserTabConnection;
  if (!registration) {
    registration = {
      browserProfileId,
      connectionId: connectedBrowsers.connect(
        browserProfileId,
        "ws",
        closeConnection,
      ),
      activitySubscriptionCount: 0,
    };
    connState.browserTabConnection = registration;
  } else if (registration.browserProfileId !== browserProfileId) {
    console.warn(
      "[WS Relay] Ignoring a second browser profile on one WebSocket connection",
    );
    return () => {};
  }

  registration.activitySubscriptionCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (connState.browserTabConnection !== registration) return;
    registration.activitySubscriptionCount = Math.max(
      0,
      registration.activitySubscriptionCount - 1,
    );
    if (registration.activitySubscriptionCount > 0) return;
    connectedBrowsers.disconnect(registration.connectionId);
    connState.browserTabConnection = null;
  };
}

/**
 * Handle a focused session-watch subscription.
 * Subscribes to targeted file-change events for a single session file.
 */
export function handleSessionWatchSubscribe(
  subscriptions: Map<string, () => void>,
  msg: RelaySubscribe,
  send: SendFn,
  focusedSessionWatchManager?: FocusedSessionWatchManager,
): void {
  const { subscriptionId, sessionId, projectId, provider } = msg;

  if (!focusedSessionWatchManager) {
    send({
      type: "response",
      id: subscriptionId,
      status: 503,
      body: { error: "Session watch service unavailable" },
    });
    return;
  }

  if (!sessionId || !projectId) {
    send({
      type: "response",
      id: subscriptionId,
      status: 400,
      body: {
        error: "sessionId and projectId required for session-watch channel",
      },
    });
    return;
  }

  let eventId = 0;
  const sendEvent = (eventType: string, data: unknown) => {
    send({
      type: "event",
      subscriptionId,
      eventType,
      eventId: String(eventId++),
      data,
    });
  };

  sendEvent("connected", { timestamp: new Date().toISOString() });

  const heartbeatInterval = setInterval(() => {
    sendEvent("heartbeat", { timestamp: new Date().toISOString() });
  }, 30_000);

  const cleanupFocusedWatch = focusedSessionWatchManager.subscribe(
    {
      sessionId,
      projectId: projectId as UrlProjectId,
      providerHint: provider,
    },
    (event) => {
      sendEvent("session-watch-change", event);
    },
  );

  subscriptions.set(subscriptionId, () => {
    clearInterval(heartbeatInterval);
    cleanupFocusedWatch();
  });

  getLogger().debug(
    `[WS Relay] Subscribed to session-watch ${sessionId} (${subscriptionId})`,
  );
}

/** Subscribe to the complete glossary-path set and later changes for a project. */
export function handleGlossarySubscribe(
  subscriptions: Map<string, () => void>,
  msg: RelaySubscribe,
  send: SendFn,
  manager?: ProjectGlossarySubscriptionManager,
): void {
  const { subscriptionId, projectId } = msg;
  if (!manager) {
    send({
      type: "response",
      id: subscriptionId,
      status: 503,
      body: { error: "Glossary subscription service unavailable" },
    });
    return;
  }
  if (!projectId || !isUrlProjectId(projectId)) {
    send({
      type: "response",
      id: subscriptionId,
      status: 400,
      body: { error: "Valid projectId required for glossary channel" },
    });
    return;
  }

  let eventId = 0;
  let opened = false;
  let cancelled = false;
  let heartbeatInterval: NodeJS.Timeout | null = null;
  let release: (() => void) | null = null;
  const buffered: Array<{ eventType: string; data: unknown }> = [];
  const sendEvent = (eventType: string, data: unknown) => {
    if (!opened) {
      buffered.push({ eventType, data });
      return;
    }
    send({
      type: "event",
      subscriptionId,
      eventType,
      eventId: String(eventId++),
      data,
    });
  };

  const cleanup = () => {
    cancelled = true;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    release?.();
    release = null;
  };
  subscriptions.set(subscriptionId, cleanup);

  const fail = (error: unknown) => {
    const ownsSubscription = subscriptions.get(subscriptionId) === cleanup;
    if (ownsSubscription) subscriptions.delete(subscriptionId);
    const shouldReport = !cancelled && ownsSubscription;
    cancelled = true;
    release?.();
    release = null;
    if (!shouldReport) return;
    try {
      send({
        type: "response",
        id: subscriptionId,
        status:
          error instanceof Error && error.message === "Project not found"
            ? 404
            : 500,
        body: {
          error:
            error instanceof Error
              ? error.message
              : "Glossary subscription failed",
        },
      });
    } catch (sendError) {
      getLogger().warn(
        { error: sendError, subscriptionId },
        "[WS Relay] Failed to send glossary subscription error",
      );
    }
  };
  const open = () => {
    if (cancelled || subscriptions.get(subscriptionId) !== cleanup) {
      cancelled = true;
      release?.();
      release = null;
      return;
    }

    opened = true;
    send({
      type: "event",
      subscriptionId,
      eventType: "connected",
      eventId: String(eventId++),
      data: { timestamp: new Date().toISOString() },
    });
    for (const event of buffered) sendEvent(event.eventType, event.data);
    heartbeatInterval = setInterval(() => {
      sendEvent("heartbeat", { timestamp: new Date().toISOString() });
    }, 30_000);
    getLogger().debug(
      `[WS Relay] Subscribed to glossary project=${projectId} (${subscriptionId})`,
    );
  };

  try {
    const subscription = manager.subscribe(projectId, (event) => {
      sendEvent(event.type, event);
    });
    release = subscription.release;
    void subscription.ready.then(open).catch(fail);
  } catch (error) {
    fail(error);
  }
}

const MAX_WORKTREE_EXPANDED_PREFIXES = 256;
const MAX_WORKTREE_PREFIX_LENGTH = 4_096;

function parseExpandedPrefixes(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_WORKTREE_EXPANDED_PREFIXES) {
    return null;
  }

  const prefixes = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") return null;
    if (candidate === "") continue;
    if (
      candidate.length > MAX_WORKTREE_PREFIX_LENGTH ||
      candidate.startsWith("/") ||
      candidate.includes("\\") ||
      candidate.includes("\0")
    ) {
      return null;
    }
    const segments = candidate.split("/");
    if (
      segments.some(
        (segment) =>
          segment === "" ||
          segment === "." ||
          segment === ".." ||
          segment.toLowerCase() === ".git",
      ) ||
      /^[a-z]:$/iu.test(segments[0] ?? "")
    ) {
      return null;
    }
    for (let length = 1; length <= segments.length; length += 1) {
      prefixes.add(segments.slice(0, length).join("/"));
      if (prefixes.size > MAX_WORKTREE_EXPANDED_PREFIXES) return null;
    }
  }
  return [...prefixes].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth !== 0 ? depth : left < right ? -1 : left > right ? 1 : 0;
  });
}

function parseWorktreeCoverage(value: unknown): GitWorktreeCoverage | null {
  if (!value || typeof value !== "object") return null;
  const coverage = value as {
    tracked?: unknown;
    untracked?: unknown;
    ignored?: unknown;
    expandedPrefixes?: unknown;
    filesystemScan?: unknown;
  };
  const expandedPrefixes = parseExpandedPrefixes(coverage.expandedPrefixes);
  const filesystemScan = coverage.filesystemScan;
  return typeof coverage.tracked === "boolean" &&
    typeof coverage.untracked === "boolean" &&
    typeof coverage.ignored === "boolean" &&
    expandedPrefixes !== null &&
    (filesystemScan === undefined ||
      (expandedPrefixes !== undefined &&
        (filesystemScan === "bounded" || filesystemScan === "complete")))
    ? {
        tracked: coverage.tracked,
        untracked: coverage.untracked,
        ignored: coverage.ignored,
        ...(expandedPrefixes === undefined ? {} : { expandedPrefixes }),
        ...(filesystemScan === undefined ? {} : { filesystemScan }),
      }
    : null;
}

/** Subscribe to one maintained worktree snapshot and its revisioned deltas. */
export function handleWorktreeSubscribe(
  subscriptions: Map<string, () => void>,
  msg: RelaySubscribe,
  send: SendFn,
  manager?: ProjectWorktreeSubscriptionManager,
): void {
  const { subscriptionId, projectId } = msg;
  const coverage = parseWorktreeCoverage(msg.coverage);
  if (!manager) {
    send({
      type: "response",
      id: subscriptionId,
      status: 503,
      body: { error: "Worktree subscription service unavailable" },
    });
    return;
  }
  if (manager.isEnabled?.() === false) {
    send({
      type: "response",
      id: subscriptionId,
      status: 503,
      body: { error: "Live worktree monitoring is disabled" },
    });
    return;
  }
  if (!projectId || !isUrlProjectId(projectId)) {
    send({
      type: "response",
      id: subscriptionId,
      status: 400,
      body: { error: "Valid projectId required for worktree channel" },
    });
    return;
  }
  if (!coverage) {
    send({
      type: "response",
      id: subscriptionId,
      status: 400,
      body: { error: "Valid coverage required for worktree channel" },
    });
    return;
  }

  let eventId = 0;
  let opened = false;
  let cancelled = false;
  let heartbeatInterval: NodeJS.Timeout | null = null;
  let release: (() => void) | null = null;
  const buffered: Array<{ eventType: string; data: unknown }> = [];
  const sendEvent = (eventType: string, data: unknown) => {
    if (!opened) {
      buffered.push({ eventType, data });
      return;
    }
    send({
      type: "event",
      subscriptionId,
      eventType,
      eventId: String(eventId++),
      data,
    });
  };

  const cleanup = () => {
    cancelled = true;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    release?.();
    release = null;
  };
  subscriptions.set(subscriptionId, cleanup);

  const fail = (error: unknown) => {
    const ownsSubscription = subscriptions.get(subscriptionId) === cleanup;
    if (ownsSubscription) subscriptions.delete(subscriptionId);
    const shouldReport = !cancelled && ownsSubscription;
    cleanup();
    if (!shouldReport) return;
    try {
      send({
        type: "response",
        id: subscriptionId,
        status:
          error instanceof WorktreeMonitoringDisabledError
            ? 503
            : error instanceof Error && error.message === "Project not found"
              ? 404
              : 500,
        body: {
          error:
            error instanceof Error
              ? error.message
              : "Worktree subscription failed",
        },
      });
    } catch (sendError) {
      getLogger().warn(
        { error: sendError, subscriptionId },
        "[WS Relay] Failed to send worktree subscription error",
      );
    }
  };
  const open = () => {
    if (cancelled || subscriptions.get(subscriptionId) !== cleanup) {
      cleanup();
      return;
    }

    opened = true;
    send({
      type: "event",
      subscriptionId,
      eventType: "connected",
      eventId: String(eventId++),
      data: { timestamp: new Date().toISOString() },
    });
    for (const event of buffered) sendEvent(event.eventType, event.data);
    heartbeatInterval = setInterval(() => {
      sendEvent("heartbeat", { timestamp: new Date().toISOString() });
    }, 30_000);
    getLogger().debug(
      `[WS Relay] Subscribed to worktree project=${projectId} (${subscriptionId})`,
    );
  };

  try {
    const subscription = manager.subscribe(projectId, coverage, (event) => {
      sendEvent(event.type, event);
    });
    release = subscription.release;
    void subscription.ready.then(open).catch(fail);
  } catch (error) {
    fail(error);
  }
}

/**
 * Handle a subscribe message.
 */
/**
 * The projects and sessions a subscription reads: exactly the ids its channel
 * handler below uses, so authorization judges what the stream will deliver
 * rather than whichever id a client puts beside it. `global` is the activity
 * channel, whose events are filtered one by one; `unknown` is a channel this
 * server does not serve.
 */
export type SubscriptionAccessTarget =
  | { kind: "global" }
  | { kind: "scoped"; projectIds: string[]; sessionIds: string[] }
  | { kind: "unknown" };

export function subscriptionAccessTarget(
  msg: RelaySubscribe,
): SubscriptionAccessTarget {
  const ids = (...values: unknown[]): string[] =>
    values.filter(
      (value): value is string => typeof value === "string" && value !== "",
    );
  switch (msg.channel) {
    case "activity":
      return { kind: "global" };
    case "session":
      return { kind: "scoped", projectIds: [], sessionIds: ids(msg.sessionId) };
    case "/api/experimental/conversation/subscribe":
      return {
        kind: "scoped",
        projectIds: [],
        sessionIds: ids(msg.query?.sessionId),
      };
    case "session-watch":
      return {
        kind: "scoped",
        projectIds: ids(msg.projectId),
        sessionIds: ids(msg.sessionId),
      };
    case "glossary":
    case "worktree":
      return { kind: "scoped", projectIds: ids(msg.projectId), sessionIds: [] };
    default:
      return { kind: "unknown" };
  }
}

export function handleSubscribe(
  subscriptions: Map<string, () => void>,
  msg: RelaySubscribe,
  send: SendFn,
  supervisor: Supervisor,
  sessionQueuePersistenceService: SessionQueuePersistenceService | undefined,
  eventBus: EventBus,
  connState: ConnectionState,
  focusedSessionWatchManager?: FocusedSessionWatchManager,
  projectGlossarySubscriptionManager?: ProjectGlossarySubscriptionManager,
  projectWorktreeSubscriptionManager?: ProjectWorktreeSubscriptionManager,
  connectedBrowsers?: ConnectedBrowsersService,
  browserProfileService?: BrowserProfileService,
  closeConnection?: () => void,
  resolveAbsoluteFilePaths?: (
    paths: readonly string[],
  ) => Promise<ReadonlySet<string>>,
  conversationSubscriptions?: ConversationSubscriptions,
  activityEventForViewer?: (event: BusEvent) => BusEvent | null,
): void {
  const { subscriptionId, channel } = msg;

  if (subscriptions.has(subscriptionId)) {
    send({
      type: "response",
      id: subscriptionId,
      status: 400,
      body: { error: "Subscription ID already in use" },
    });
    return;
  }

  switch (channel) {
    case "/api/experimental/conversation/subscribe":
      subscribeConversationRelay(
        subscriptions,
        msg,
        send,
        conversationSubscriptions,
      );
      break;
    case "session":
      handleSessionSubscribe(
        subscriptions,
        msg,
        send,
        supervisor,
        sessionQueuePersistenceService,
        resolveAbsoluteFilePaths,
      );
      break;

    case "activity":
      handleActivitySubscribe(
        subscriptions,
        msg,
        send,
        eventBus,
        connState,
        connectedBrowsers,
        browserProfileService,
        closeConnection,
        activityEventForViewer,
      );
      break;

    case "session-watch":
      handleSessionWatchSubscribe(
        subscriptions,
        msg,
        send,
        focusedSessionWatchManager,
      );
      break;

    case "glossary":
      handleGlossarySubscribe(
        subscriptions,
        msg,
        send,
        projectGlossarySubscriptionManager,
      );
      break;

    case "worktree":
      handleWorktreeSubscribe(
        subscriptions,
        msg,
        send,
        projectWorktreeSubscriptionManager,
      );
      break;

    default:
      send({
        type: "response",
        id: subscriptionId,
        status: 400,
        body: { error: `Unknown channel: ${channel}` },
      });
  }
}

/**
 * Handle an unsubscribe message.
 */
export function handleUnsubscribe(
  subscriptions: Map<string, () => void>,
  msg: RelayUnsubscribe,
): void {
  const { subscriptionId } = msg;
  const cleanup = subscriptions.get(subscriptionId);
  if (cleanup) {
    cleanup();
    subscriptions.delete(subscriptionId);
    getLogger().debug(`[WS Relay] Unsubscribed (${subscriptionId})`);
  }
}

async function writeRelayUploadChunk(
  state: RelayUploadState,
  chunk: Buffer,
  uploadManager: UploadManager,
  attachmentStagingService?: AttachmentStagingService,
): Promise<number> {
  if (state.uploadKind === "draft-staging") {
    attachmentStagingService = state.stagingService ?? attachmentStagingService;
    if (!attachmentStagingService) {
      throw new Error("Attachment staging is unavailable");
    }
    return attachmentStagingService.writeChunk(state.serverUploadId, chunk);
  }

  return uploadManager.writeChunk(state.serverUploadId, chunk);
}

async function cancelRelayUpload(
  state: RelayUploadState,
  uploadManager: UploadManager,
  attachmentStagingService?: AttachmentStagingService,
): Promise<void> {
  if (state.uploadKind === "draft-staging") {
    await (state.stagingService ?? attachmentStagingService)?.cancelUpload(
      state.serverUploadId,
    );
    return;
  }

  await uploadManager.cancelUpload(state.serverUploadId);
}

/**
 * Handle upload_start message.
 */
export async function handleUploadStart(
  uploads: Map<string, RelayUploadState>,
  msg: RelayUploadStart,
  send: SendFn,
  uploadManager: UploadManager,
): Promise<void> {
  const {
    uploadId,
    projectId,
    sessionId,
    filename,
    size,
    mimeType,
    width,
    height,
  } = msg;

  if (uploads.has(uploadId)) {
    send({
      type: "upload_error",
      uploadId,
      error: "Upload ID already in use",
    });
    return;
  }

  try {
    const { uploadId: serverUploadId } = await uploadManager.startUpload(
      projectId,
      sessionId,
      filename,
      size,
      mimeType,
      undefined,
      width !== undefined && height !== undefined
        ? { width, height }
        : undefined,
    );

    uploads.set(uploadId, {
      clientUploadId: uploadId,
      uploadKind: "session",
      serverUploadId,
      expectedSize: size,
      bytesReceived: 0,
      lastProgressReport: 0,
      pendingWrites: [],
    });

    send({ type: "upload_progress", uploadId, bytesReceived: 0 });

    console.log(
      `[WS Relay] Upload started: ${uploadId} (${filename}, ${size} bytes)`,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to start upload";
    send(relayUploadError(uploadId, message, err));
  }
}

/**
 * Handle staged_upload_start message.
 */
export async function handleStagedUploadStart(
  uploads: Map<string, RelayUploadState>,
  msg: RelayStagedUploadStart,
  send: SendFn,
  attachmentStagingService?: AttachmentStagingService,
): Promise<void> {
  const { uploadId, batchId, filename, size, mimeType, width, height } = msg;

  if (uploads.has(uploadId)) {
    send({
      type: "upload_error",
      uploadId,
      error: "Upload ID already in use",
    });
    return;
  }

  if (!attachmentStagingService) {
    send({
      type: "upload_error",
      uploadId,
      error: "Attachment staging is unavailable",
    });
    return;
  }

  try {
    const { uploadId: serverUploadId } =
      await attachmentStagingService.startDraftUpload({
        batchId,
        originalName: filename,
        size,
        mimeType,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
      });

    uploads.set(uploadId, {
      clientUploadId: uploadId,
      uploadKind: "draft-staging",
      stagingService: attachmentStagingService,
      serverUploadId,
      expectedSize: size,
      bytesReceived: 0,
      lastProgressReport: 0,
      pendingWrites: [],
    });

    send({ type: "upload_progress", uploadId, bytesReceived: 0 });

    console.log(
      `[WS Relay] Staged upload started: ${uploadId} (${filename}, ${size} bytes)`,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to start staged upload";
    send(relayUploadError(uploadId, message, err));
  }
}

/**
 * Handle upload_chunk message.
 */
export async function handleUploadChunk(
  uploads: Map<string, RelayUploadState>,
  msg: RelayUploadChunk,
  send: SendFn,
  uploadManager: UploadManager,
  attachmentStagingService?: AttachmentStagingService,
): Promise<void> {
  const { uploadId, offset, data } = msg;

  const state = uploads.get(uploadId);
  if (!state) {
    send({ type: "upload_error", uploadId, error: "Upload not found" });
    return;
  }

  if (offset !== state.bytesReceived) {
    send({
      type: "upload_error",
      uploadId,
      error: `Invalid offset: expected ${state.bytesReceived}, got ${offset}`,
    });
    return;
  }

  // Track this write so handleUploadEnd can wait for it
  let writeResolve!: () => void;
  const writeTracker = new Promise<void>((resolve) => {
    writeResolve = resolve;
  });
  state.pendingWrites.push(writeTracker);

  try {
    const chunk = Buffer.from(data, "base64");
    const bytesReceived = await writeRelayUploadChunk(
      state,
      chunk,
      uploadManager,
      attachmentStagingService,
    );

    state.bytesReceived = bytesReceived;

    if (
      bytesReceived - state.lastProgressReport >= PROGRESS_INTERVAL ||
      bytesReceived === state.expectedSize
    ) {
      send({ type: "upload_progress", uploadId, bytesReceived });
      state.lastProgressReport = bytesReceived;
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to write chunk";
    send(relayUploadError(uploadId, message, err));
    uploads.delete(uploadId);
    try {
      await cancelRelayUpload(state, uploadManager, attachmentStagingService);
    } catch {
      // Ignore cleanup errors
    }
  } finally {
    writeResolve?.();
  }
}

/**
 * Handle binary upload chunk (format 0x02).
 * Payload format: [16 bytes UUID][8 bytes offset big-endian][chunk data]
 */
export async function handleBinaryUploadChunk(
  uploads: Map<string, RelayUploadState>,
  payload: Uint8Array,
  send: SendFn,
  uploadManager: UploadManager,
  attachmentStagingService?: AttachmentStagingService,
): Promise<void> {
  let uploadId: string;
  let offset: number;
  let data: Uint8Array;
  try {
    ({ uploadId, offset, data } = decodeUploadChunkPayload(payload));
  } catch (e) {
    const message =
      e instanceof UploadChunkError
        ? `Invalid upload chunk: ${e.message}`
        : "Invalid binary upload chunk format";
    console.warn(`[WS Relay] ${message}`, e);
    send({
      type: "response",
      id: "binary-upload-error",
      status: 400,
      body: { error: message },
    });
    return;
  }

  const state = uploads.get(uploadId);
  if (!state) {
    send({ type: "upload_error", uploadId, error: "Upload not found" });
    return;
  }

  if (offset !== state.bytesReceived) {
    send({
      type: "upload_error",
      uploadId,
      error: `Invalid offset: expected ${state.bytesReceived}, got ${offset}`,
    });
    return;
  }

  // Track this write so handleUploadEnd can wait for it
  let writeResolve!: () => void;
  const writeTracker = new Promise<void>((resolve) => {
    writeResolve = resolve;
  });
  state.pendingWrites.push(writeTracker);

  try {
    const bytesReceived = await writeRelayUploadChunk(
      state,
      Buffer.from(data),
      uploadManager,
      attachmentStagingService,
    );

    state.bytesReceived = bytesReceived;

    if (
      bytesReceived - state.lastProgressReport >= PROGRESS_INTERVAL ||
      bytesReceived === state.expectedSize
    ) {
      send({ type: "upload_progress", uploadId, bytesReceived });
      state.lastProgressReport = bytesReceived;
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to write chunk";
    send(relayUploadError(uploadId, message, err));
    uploads.delete(uploadId);
    try {
      await cancelRelayUpload(state, uploadManager, attachmentStagingService);
    } catch {
      // Ignore cleanup errors
    }
  } finally {
    writeResolve?.();
  }
}

/**
 * Handle upload_end message.
 */
export async function handleUploadEnd(
  uploads: Map<string, RelayUploadState>,
  msg: RelayUploadEnd,
  send: SendFn,
  uploadManager: UploadManager,
  attachmentStagingService?: AttachmentStagingService,
): Promise<void> {
  const { uploadId } = msg;

  const state = uploads.get(uploadId);
  if (!state) {
    send({ type: "upload_error", uploadId, error: "Upload not found" });
    return;
  }

  // Wait for any pending chunk writes to complete before finalizing
  await Promise.all(state.pendingWrites);

  try {
    if (state.uploadKind === "draft-staging") {
      attachmentStagingService =
        state.stagingService ?? attachmentStagingService;
      if (!attachmentStagingService) {
        throw new Error("Attachment staging is unavailable");
      }
      const stagedRef = await attachmentStagingService.completeUpload(
        state.serverUploadId,
      );
      uploads.delete(uploadId);
      send({
        type: "upload_complete",
        uploadId,
        stagedRef,
        batchId: stagedRef.batchId,
      });
      getLogger().debug(
        `[WS Relay] Staged upload complete: ${uploadId} (${stagedRef.size} bytes)`,
      );
      return;
    }

    const file = await uploadManager.completeUpload(state.serverUploadId);
    uploads.delete(uploadId);
    send({ type: "upload_complete", uploadId, file });
    getLogger().debug(
      `[WS Relay] Upload complete: ${uploadId} (${file.size} bytes)`,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to complete upload";
    send(relayUploadError(uploadId, message, err));
    uploads.delete(uploadId);
    try {
      await cancelRelayUpload(state, uploadManager, attachmentStagingService);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Clean up all active uploads for a connection.
 */
export async function cleanupUploads(
  uploads: Map<string, RelayUploadState>,
  uploadManager: UploadManager,
  attachmentStagingService?: AttachmentStagingService,
): Promise<void> {
  for (const [clientId, state] of uploads) {
    try {
      await cancelRelayUpload(state, uploadManager, attachmentStagingService);
      console.log(`[WS Relay] Cancelled upload on disconnect: ${clientId}`);
    } catch (err) {
      console.error(`[WS Relay] Error cancelling upload ${clientId}:`, err);
    }
  }
  uploads.clear();
}

/**
 * Options for handleMessage that differ between direct and relay connections.
 */
export interface HandleMessageOptions {
  /**
   * Whether the message was received as a binary frame.
   * If provided, this takes precedence over isBinaryData() check.
   * Required for raw ws connections where all data arrives as Buffers.
   */
  isBinary?: boolean;
  /** Per-connection relayed speech session holder. */
  speechSessionRef?: { current: SpeechWebSocketSession | null };
}

function isSrpControlAttempt(parsed: unknown): parsed is {
  type: "srp_resume_init" | "srp_resume" | "srp_hello" | "srp_proof";
} {
  if (!parsed || typeof parsed !== "object") return false;
  const type = (parsed as { type?: unknown }).type;
  return (
    type === "srp_resume_init" ||
    type === "srp_resume" ||
    type === "srp_hello" ||
    type === "srp_proof"
  );
}

/**
 * Handle incoming WebSocket messages.
 * Supports both text frames (JSON) and binary frames (format byte + payload or encrypted envelope).
 */
export async function handleMessage(
  ws: WSAdapter,
  subscriptions: Map<string, () => void>,
  uploads: Map<string, RelayUploadState>,
  connState: ConnectionState,
  send: SendFn,
  data: unknown,
  deps: RelayHandlerDeps,
  options: HandleMessageOptions,
  deviceSessions?: Set<string>,
): Promise<void> {
  const {
    app,
    baseUrl,
    supervisor,
    eventBus,
    uploadManager,
    attachmentStagingService: sharedAttachmentStagingService,
    remoteAccessService,
    remoteSessionService,
    securityClientService,
    limitedUsers,
  } = deps;
  const attachmentStagingService = sharedAttachmentStagingService?.forUser(
    draftStagingOwnerForConnection(
      connState,
      remoteAccessService?.getUsername() ?? null,
    ),
  );
  const srpRequiredPolicy = isPolicySrpRequired(connState.connectionPolicy);
  const getSpeechSession = (): SpeechWebSocketSession | null => {
    if (!options.speechSessionRef) {
      send({
        type: "speech_event",
        message: {
          type: "error",
          message: "Speech relay is unavailable on this connection",
        },
      });
      return null;
    }

    if (!deps.speechBackendRegistry) {
      send({
        type: "speech_event",
        message: {
          type: "error",
          message: "Speech relay is not configured",
        },
      });
      return null;
    }

    if (!options.speechSessionRef.current) {
      options.speechSessionRef.current = createSpeechWebSocketSession(
        {
          speechBackendRegistry: deps.speechBackendRegistry,
          dataDir: deps.dataDir,
          serverSettingsService: deps.serverSettingsService,
        },
        (message) =>
          send({
            type: "speech_event",
            message: message as RelaySpeechEvent["message"],
          }),
      );
      send({
        type: "speech_event",
        message: { type: "ready" },
      });
    }

    return options.speechSessionRef.current;
  };

  // Log only the frame shape. Plaintext previews can contain bearer paths.
  // Check Buffer BEFORE Uint8Array since Buffer extends Uint8Array.
  const dataType =
    data === null
      ? "null"
      : data === undefined
        ? "undefined"
        : typeof data === "string"
          ? `string(${data.length})`
          : Buffer.isBuffer(data)
            ? `Buffer(${data.length})`
            : data instanceof ArrayBuffer
              ? `ArrayBuffer(${data.byteLength})`
              : data instanceof Uint8Array
                ? `Uint8Array(${data.length})`
                : `unknown(${typeof data})`;
  getLogger().debug(
    `[WS Relay] handleMessage: type=${dataType}, isBinary=${options.isBinary}`,
  );

  const routeClientMessage = async (msg: RemoteClientMessage): Promise<void> =>
    routeClientMessageSafely(msg, send, {
      onClientCapabilities: (capabilities) => {
        connState.supportedFormats = new Set(capabilities.formats);
        connState.clientVersion = capabilities.version ?? null;
        connState.clientCapabilityBits = capabilities.capabilityBits ?? [];
        console.log(
          `[WS Relay] Client capabilities: version=${connState.clientVersion ?? "legacy"}, formats=${[...connState.supportedFormats].map((format) => `0x${format.toString(16).padStart(2, "0")}`).join(", ")}`,
        );
      },
      onRequest: async (requestMsg) => {
        // Tunneled HTTP requests are independent: each carries its own id and
        // handleRequest always answers (it never throws). Do not await here —
        // the per-connection message queue must keep decrypt/auth/route order,
        // but a slow request (e.g. a session index revalidation behind
        // /api/sessions) must not head-of-line block later tunneled requests
        // the way it never would over plain HTTP.
        void handleRequest(
          requestMsg,
          send,
          ws,
          app,
          baseUrl,
          connState,
          remoteSessionService,
        );
      },
      onResponseStreamAck: (ackMsg) =>
        handleResponseStreamAck(connState, ackMsg.id, ackMsg.bytes),
      onResponseStreamCancel: (cancelMsg) =>
        handleResponseStreamCancel(connState, cancelMsg.id),
      onSubscribe: async (subscribeMsg) => {
        if (deps.authorizeSubscription) {
          const permitted = await deps.authorizeSubscription({
            username: authenticatedConnectionIdentity(connState),
            target: subscriptionAccessTarget(subscribeMsg),
          });
          if (!permitted) {
            send({
              type: "response",
              id: subscribeMsg.subscriptionId,
              status: 403,
              body: { error: "Not permitted for this user" },
            });
            return;
          }
        }
        return handleSubscribe(
          subscriptions,
          subscribeMsg,
          send,
          supervisor,
          deps.sessionQueuePersistenceService,
          eventBus,
          connState,
          deps.focusedSessionWatchManager,
          deps.projectGlossarySubscriptionManager,
          deps.projectWorktreeSubscriptionManager,
          deps.connectedBrowsers,
          deps.browserProfileService,
          () => ws.close(4004, "Legacy browser profile revoked"),
          deps.resolveAbsoluteFilePaths,
          deps.conversationSubscriptions,
          deps.activityEventForIdentity
            ? (event) =>
                (
                  deps.activityEventForIdentity as NonNullable<
                    RelayHandlerDeps["activityEventForIdentity"]
                  >
                )(authenticatedConnectionIdentity(connState), event)
            : undefined,
        );
      },
      onUnsubscribe: async (unsubscribeMsg) =>
        handleUnsubscribe(subscriptions, unsubscribeMsg),
      onUploadStart: async (uploadStartMsg) =>
        handleUploadStart(uploads, uploadStartMsg, send, uploadManager),
      onStagedUploadStart: async (uploadStartMsg) =>
        handleStagedUploadStart(
          uploads,
          uploadStartMsg,
          send,
          attachmentStagingService,
        ),
      onUploadChunk: async (uploadChunkMsg) =>
        handleUploadChunk(
          uploads,
          uploadChunkMsg,
          send,
          uploadManager,
          attachmentStagingService,
        ),
      onUploadEnd: async (uploadEndMsg) =>
        handleUploadEnd(
          uploads,
          uploadEndMsg,
          send,
          uploadManager,
          attachmentStagingService,
        ),
      onPing: async (pingMsg) => send({ type: "pong", id: pingMsg.id }),
      onSpeechControl: async (speechMsg) => {
        const session = getSpeechSession();
        if (!session) return;
        session.handleMessage(JSON.stringify(speechMsg.message));
      },
      onDeviceMessage: deps.deviceBridgeService
        ? (() => {
            const bridge = deps.deviceBridgeService;
            return async (emulatorMsg: RemoteClientMessage) => {
              switch (emulatorMsg.type) {
                case "device_stream_start":
                  deviceSessions?.add(emulatorMsg.sessionId);
                  await bridge.startStream(emulatorMsg, send);
                  break;
                case "device_stream_stop":
                  deviceSessions?.delete(emulatorMsg.sessionId);
                  bridge.stopStream(emulatorMsg);
                  break;
                case "device_webrtc_answer":
                  bridge.handleAnswer(emulatorMsg);
                  break;
                case "device_ice_candidate":
                  bridge.handleICE(emulatorMsg);
                  break;
              }
            };
          })()
        : undefined,
    });

  const parsed = await decodeFrameToParsedMessage(
    ws,
    data,
    options,
    connState,
    srpRequiredPolicy,
    {
      uploads,
      send,
      uploadManager,
      attachmentStagingService,
      routeClientMessage,
      handleSpeechAudio: async (payload) => {
        const session = getSpeechSession();
        if (!session) return;
        session.handleMessage(Buffer.from(payload) as SpeechWsData);
      },
      handleBinaryUploadChunk,
    },
  );
  if (parsed === null) {
    return;
  }

  if (
    isSrpControlAttempt(parsed) &&
    !tryLockWsConnectionMode(connState, "srp")
  ) {
    ws.close(1008, "Connection mode already selected");
    return;
  }

  // Handle SRP messages first (always plaintext)
  if (isSrpSessionResumeInit(parsed)) {
    await handleSrpResumeInit(ws, connState, parsed, remoteSessionService);
    return;
  }

  if (isSrpSessionResume(parsed)) {
    await handleSrpResume(ws, connState, parsed, remoteSessionService);
    return;
  }

  if (isSrpClientHello(parsed)) {
    await handleSrpHello(
      ws,
      connState,
      parsed,
      remoteAccessService,
      limitedUsers,
    );
    return;
  }

  if (isSrpClientProof(parsed)) {
    await handleSrpProof(
      ws,
      connState,
      parsed,
      parsed.A,
      remoteSessionService,
      securityClientService,
    );
    return;
  }

  const msg = parseApplicationClientMessage(
    ws,
    connState,
    srpRequiredPolicy,
    parsed,
  );
  if (!msg) {
    return;
  }

  await routeClientMessage(msg);
}

/**
 * Clean up emulator streaming sessions on connection close.
 */
export function cleanupDeviceSessions(
  deviceSessions: Set<string>,
  deviceBridgeService?: DeviceBridgeService,
): void {
  if (!deviceBridgeService || deviceSessions.size === 0) return;
  for (const sessionId of deviceSessions) {
    try {
      deviceBridgeService.stopStream({
        type: "device_stream_stop",
        sessionId,
      });
    } catch (err) {
      console.error(
        `[WS Relay] Error cleaning up emulator session ${sessionId}:`,
        err,
      );
    }
  }
  deviceSessions.clear();
}

/**
 * Clean up subscriptions on connection close.
 */
export function cleanupSubscriptions(
  subscriptions: Map<string, () => void>,
): void {
  for (const [id, cleanup] of subscriptions) {
    try {
      cleanup();
    } catch (err) {
      console.error(`[WS Relay] Error cleaning up subscription ${id}:`, err);
    }
  }
  subscriptions.clear();
}
