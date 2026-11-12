import type {
  DeviceServerMessage,
  GitWorktreeCoverage,
  RemoteClientMessage,
  StagedAttachmentRef,
  UploadedFile,
} from "@yep-anywhere/shared";
import type {
  ConnectionSpeechSocket,
  SessionSubscriptionOptions,
  StreamHandlers,
  Subscription,
} from "../connection/types";

export type {
  ConnectionSpeechSocket,
  SessionSubscriptionOptions,
  StreamHandlers,
  Subscription,
};

export type SourceTransportKind = "localhost" | "websocket" | "secure";

export type SourceTransportState =
  | "ready"
  | "connecting"
  | "reconnecting"
  | "disconnected";

export type SourceTransportChannelName =
  | "same-origin-http"
  | "upload-websocket"
  | "stream-websocket"
  | "multiplex-websocket"
  | "secure-websocket"
  | "relay";

export type SourceTransportChannelState =
  | "stateless"
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "unsupported";

export interface SourceTransportChannelSnapshot {
  readonly name: SourceTransportChannelName;
  readonly state: SourceTransportChannelState;
  readonly activeSubscriptions?: number;
  readonly reconnectAttempts?: number;
  readonly lastError?: string;
}

/**
 * Observational snapshot for a source-bound transport facade.
 *
 * Source-level state answers "can this source be addressed?" Channel snapshots
 * answer "what is really happening underneath?" Do not infer feature behavior
 * from `kind`; feature code branches on `SourceTransportCapabilities`.
 *
 * State mapping:
 *
 * | Slot or manager condition | Source state |
 * | --- | --- |
 * | No backing connection attached, either never attached or detached | `disconnected` |
 * | Attach accepted and first connect/auth in flight | `connecting` |
 * | Manager state `reconnecting` | `reconnecting` |
 * | Manager state `connected` | `ready` |
 * | Manager state `disconnected`, gave up, or non-retryable | `disconnected` |
 * | Localhost | `ready` |
 */
export interface SourceTransportStatusSnapshot {
  readonly kind: SourceTransportKind;
  readonly state: SourceTransportState;
  readonly channels: readonly SourceTransportChannelSnapshot[];
}

export interface SourceTransportStatus {
  getSnapshot(): SourceTransportStatusSnapshot;

  /**
   * Fires when either source state or any channel snapshot changes. Localhost
   * may remain source-ready while still publishing stream WebSocket changes.
   */
  subscribe(listener: () => void): () => void;

  /**
   * Fires when the transport's health manager observes the tab becoming
   * visible while connected. Consumers use this to refresh data in parallel
   * with the wake ping/pong health check.
   */
  subscribeVisibilityRestored?(listener: () => void): () => void;
}

export interface DeviceSignalingChannel {
  send(msg: RemoteClientMessage): void | Promise<void>;
  onMessage(handler: (msg: DeviceServerMessage) => void): () => void;
}

export interface SpeechChannelFactory {
  open(): Promise<ConnectionSpeechSocket>;
}

export interface SourceTransportCapabilities {
  /** Can deliver and cancel a response before its producer reaches EOF. */
  readonly streamedResponses?: boolean;
  /**
   * True when same-origin URLs, such as image or file URLs under `/api`, reach
   * this source. Media consumers branch on this, never on transport kind.
   */
  readonly sameOriginUrls: boolean;
  /** Fixed isolated shell supplied by the native app; never a fetch grant. */
  readonly packagedArtifactViewerVersion?: 1;
  readonly device?: DeviceSignalingChannel;
  readonly speech?: SpeechChannelFactory;
}

export interface UploadOptions {
  /** Progress callback with bytes uploaded so far. */
  onProgress?: (bytesUploaded: number) => void;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Chunk size in bytes. */
  chunkSize?: number;
  /** Client-side send cap for upload helpers. A value of 0 disables the cap. */
  maxBytesPerSecond?: number;
  /** Image dimensions of the actual uploaded file, if known. */
  imageDimensions?: {
    width: number;
    height: number;
  };
}

export interface SessionWatchSubscriptionOptions {
  projectId?: string;
  provider?: string;
}

/**
 * Source-bound facade for how this browser talks to one YA server.
 *
 * Request semantics:
 *
 * - Demand traffic, caused by user navigation, taps, or mounted screens, calls
 *   `fetch` unconditionally. The transport is the single readiness arbiter. A
 *   backing connection delegates while ready or reconnecting and preserves
 *   request-driven recovery; once the manager reaches terminal disconnected,
 *   demand work rejects immediately with a typed non-retryable disconnected
 *   error. An empty slot waits bounded, then rejects with a typed retryable
 *   not-ready error.
 * - Elective traffic, such as pollers, prefetch, and log flushing, observes
 *   `status` and pauses while not ready instead of queueing optional work.
 * - UI affordances read `status`; they do not reject work that the transport
 *   could complete after a short reconnect.
 * - Raw subscriptions stay dumb: when not ready they report an async retryable
 *   error. The managed-stream layer owns wait-for-ready and resubscribe.
 */
export interface SourceTransport {
  /** Diagnostics only. Feature code must branch on capabilities, not kind. */
  readonly kind: SourceTransportKind;
  readonly status: SourceTransportStatus;
  readonly capabilities: SourceTransportCapabilities;

  fetch<T>(path: string, init?: RequestInit): Promise<T>;
  /** Response body and available headers; a 304 is returned without a body. */
  fetchResponse(path: string, init?: RequestInit): Promise<Response>;
  fetchBlob(path: string): Promise<Blob>;
  /**
   * GET a file body as a Response whose body streams in as it arrives.
   * Present only where the backing connection can stream; rejects for an
   * error status.
   */
  fetchStream?(
    path: string,
    init?: { signal?: AbortSignal | null; headers?: HeadersInit },
  ): Promise<Response>;
  upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile>;
  uploadStagedAttachment(
    file: File,
    options?: UploadOptions & { batchId?: string },
  ): Promise<StagedAttachmentRef>;

  subscribeSession(
    sessionId: string,
    handlers: StreamHandlers,
    lastEventId?: string,
    options?: SessionSubscriptionOptions,
  ): Subscription;
  subscribeSessionWatch(
    sessionId: string,
    handlers: StreamHandlers,
    options?: SessionWatchSubscriptionOptions,
  ): Subscription;
  subscribeActivity(handlers: StreamHandlers): Subscription;
  subscribeGlossary(projectId: string, handlers: StreamHandlers): Subscription;
  subscribeWorktree(
    projectId: string,
    coverage: GitWorktreeCoverage,
    handlers: StreamHandlers,
  ): Subscription;

  /**
   * Source-level reconnect action. Localhost implementations no-op because
   * same-origin HTTP has no source connection to re-establish.
   */
  reconnect(): Promise<void>;

  /**
   * Release channels this transport instance created. A transport must not
   * close channels it merely borrowed.
   */
  dispose(): void;
}

export type SourceTransportErrorCode =
  | "SOURCE_TRANSPORT_NOT_READY"
  | "SOURCE_TRANSPORT_DISCONNECTED"
  | "SOURCE_TRANSPORT_UNSUPPORTED"
  | "SOURCE_TRANSPORT_DISPOSED"
  | "SOURCE_TRANSPORT_SUBSCRIPTION_FAILED";

export interface SourceTransportErrorShape {
  readonly code: SourceTransportErrorCode;
  readonly retryable: boolean;
  readonly transportKind?: SourceTransportKind;
  readonly state?: SourceTransportState;
  readonly channel?: SourceTransportChannelName;
}

interface SourceTransportErrorInit extends SourceTransportErrorShape {
  readonly cause?: unknown;
}

export class SourceTransportError
  extends Error
  implements SourceTransportErrorShape
{
  readonly code: SourceTransportErrorCode;
  readonly retryable: boolean;
  readonly transportKind?: SourceTransportKind;
  readonly state?: SourceTransportState;
  readonly channel?: SourceTransportChannelName;

  constructor(message: string, init: SourceTransportErrorInit) {
    super(message);
    this.name = "SourceTransportError";
    this.code = init.code;
    this.retryable = init.retryable;
    this.transportKind = init.transportKind;
    this.state = init.state;
    this.channel = init.channel;
    if (init.cause !== undefined) {
      this.cause = init.cause;
    }
  }
}

export interface SourceTransportNotReadyErrorInit {
  readonly kind: SourceTransportKind;
  readonly state: SourceTransportState;
  readonly timeoutMs?: number;
  readonly channel?: SourceTransportChannelName;
  readonly message?: string;
  readonly cause?: unknown;
}

export class SourceTransportNotReadyError extends SourceTransportError {
  readonly timeoutMs?: number;

  constructor(init: SourceTransportNotReadyErrorInit) {
    const timeoutText =
      init.timeoutMs === undefined ? "" : ` after ${init.timeoutMs}ms`;
    super(
      init.message ??
        `Source transport is not ready (${init.state})${timeoutText}`,
      {
        code: "SOURCE_TRANSPORT_NOT_READY",
        retryable: true,
        transportKind: init.kind,
        state: init.state,
        channel: init.channel,
        cause: init.cause,
      },
    );
    this.name = "SourceTransportNotReadyError";
    this.timeoutMs = init.timeoutMs;
  }
}

export interface SourceTransportDisconnectedErrorInit {
  readonly kind: SourceTransportKind;
  readonly channel?: SourceTransportChannelName;
  readonly lastError?: string;
  readonly message?: string;
  readonly cause?: unknown;
}

export class SourceTransportDisconnectedError extends SourceTransportError {
  readonly lastError?: string;

  constructor(init: SourceTransportDisconnectedErrorInit) {
    const detail = init.lastError ? `: ${init.lastError}` : "";
    super(
      init.message ?? `Source transport ${init.kind} is disconnected${detail}`,
      {
        code: "SOURCE_TRANSPORT_DISCONNECTED",
        retryable: false,
        transportKind: init.kind,
        state: "disconnected",
        channel: init.channel,
        cause: init.cause,
      },
    );
    this.name = "SourceTransportDisconnectedError";
    this.lastError = init.lastError;
  }
}

export interface SourceTransportUnsupportedErrorInit {
  readonly kind: SourceTransportKind;
  readonly operation: string;
  readonly channel?: SourceTransportChannelName;
  readonly message?: string;
  readonly cause?: unknown;
}

export class SourceTransportUnsupportedError extends SourceTransportError {
  readonly operation: string;

  constructor(init: SourceTransportUnsupportedErrorInit) {
    super(
      init.message ??
        `Source transport ${init.kind} does not support ${init.operation}`,
      {
        code: "SOURCE_TRANSPORT_UNSUPPORTED",
        retryable: false,
        transportKind: init.kind,
        channel: init.channel,
        cause: init.cause,
      },
    );
    this.name = "SourceTransportUnsupportedError";
    this.operation = init.operation;
  }
}

export class SourceTransportDisposedError extends SourceTransportError {
  constructor(kind: SourceTransportKind) {
    super(`Source transport ${kind} has been disposed`, {
      code: "SOURCE_TRANSPORT_DISPOSED",
      retryable: false,
      transportKind: kind,
    });
    this.name = "SourceTransportDisposedError";
  }
}

export function isSourceTransportError(
  error: unknown,
): error is SourceTransportErrorShape {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "retryable" in error
  );
}
