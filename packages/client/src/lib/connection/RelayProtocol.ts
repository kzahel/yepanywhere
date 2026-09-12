import {
  CONVERSATION_API_REVISION,
  CONVERSATION_CHANNEL,
} from "@yep-anywhere/shared/experimental/conversation-protocol";
import type { ConversationQuery } from "@yep-anywhere/shared/experimental/simple-client.generated";
import type {
  ClientPing,
  DeviceServerMessage,
  GitWorktreeCoverage,
  RelayEvent,
  RelayRequest,
  RelayResponse,
  RelaySpeechEvent,
  RelayStagedUploadStart,
  RelaySubscribe,
  RelayUnsubscribe,
  RelayUploadComplete,
  RelayUploadEnd,
  RelayUploadError,
  RelayUploadProgress,
  RelayUploadStart,
  RemoteClientMessage,
  StagedAttachmentRef,
  UploadedFile,
  YepMessage,
} from "@yep-anywhere/shared";
import { API_REQUEST_DEADLINE_MS } from "../../api/requestDeadline";
import { getOrCreateBrowserProfileId } from "../storageKeys";
import { generateUUID } from "../uuid";
import type {
  SessionSubscriptionOptions,
  StreamHandlers,
  Subscription,
  UploadOptions,
} from "./types";
import { SubscriptionError } from "./types";

export type BeginCriticalOperation = (label?: string) => () => void;

/**
 * Transport callbacks injected by the owning connection class.
 * These abstract the difference between plain WS and encrypted WS.
 */
export interface RelayTransport {
  sendMessage(msg: RemoteClientMessage): void;
  sendUploadChunk(
    uploadId: string,
    offset: number,
    chunk: Uint8Array,
  ): void | Promise<void>;
  ensureConnected(): Promise<void>;
  isConnected(): boolean;
}

export type EmulatorMessageHandler = (msg: DeviceServerMessage) => void;
export type SpeechEventHandler = (msg: RelaySpeechEvent["message"]) => void;

export interface RelayProtocolOptions {
  debugEnabled?: () => boolean;
  logPrefix?: string;
  onPong?: (id: string) => void;
  onInboundEvent?: (event: RelayEvent) => void;
  beginCriticalOperation?: BeginCriticalOperation;
}

function generateId(): string {
  return generateUUID();
}

function isActivityDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as Window & { __ACTIVITY_DEBUG__?: boolean };
  if (w.__ACTIVITY_DEBUG__ === true) return true;
  try {
    return localStorage.getItem("yep-anywhere-activity-debug") === "true";
  } catch {
    return false;
  }
}

function getRelayHeader(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const normalizedName = name.toLowerCase();
  return Object.entries(headers).find(
    ([key]) => key.toLowerCase() === normalizedName,
  )?.[1];
}

function getRelayErrorDetail(body: unknown): string | null {
  if (typeof body === "string") {
    const detail = body.trim();
    return detail || null;
  }
  if (body && typeof body === "object" && "error" in body) {
    const detail = String((body as { error: unknown }).error).trim();
    return detail || null;
  }
  return null;
}

function createRelayApiError(
  response: RelayResponse,
): Error & { setupRequired?: boolean; status: number } {
  const detail = getRelayErrorDetail(response.body);
  const error = new Error(
    detail
      ? `API error: ${response.status}: ${detail}`
      : `API error: ${response.status}`,
  ) as Error & { setupRequired?: boolean; status: number };
  error.status = response.status;
  if (getRelayHeader(response.headers, "X-Setup-Required") === "true") {
    error.setupRequired = true;
  }
  return error;
}

const RELAY_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_RELAY_REDIRECTS = 5;
const RELAY_REDIRECT_ORIGIN = "https://yep-relay.invalid";

function resolveRelayRedirectPath(
  currentPath: string,
  location: string | undefined,
): string {
  if (!location) {
    throw new Error("Relay redirect response is missing a Location header");
  }

  const currentUrl = new URL(currentPath, RELAY_REDIRECT_ORIGIN);
  const redirectUrl = new URL(location, currentUrl);
  if (redirectUrl.origin !== RELAY_REDIRECT_ORIGIN) {
    throw new Error("Relay refused a redirect to a different server");
  }
  if (
    redirectUrl.pathname !== "/api" &&
    !redirectUrl.pathname.startsWith("/api/")
  ) {
    throw new Error("Relay refused a redirect outside the API");
  }
  return `${redirectUrl.pathname}${redirectUrl.search}`;
}

function getRedirectedRequestInit(
  status: number,
  init: RequestInit | undefined,
): RequestInit | undefined {
  const method = (init?.method ?? "GET").toUpperCase();
  if (
    status === 303 ||
    ((status === 301 || status === 302) && method === "POST")
  ) {
    return { ...init, method: "GET", body: undefined };
  }
  return init;
}

/** Default chunk size for file uploads (64KB) */
const DEFAULT_CHUNK_SIZE = 64 * 1024;

interface PendingRequest {
  resolve: (response: RelayResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  startTime?: number;
  method?: string;
  path?: string;
}

interface PendingUpload {
  uploadKind: "session" | "draft-staging";
  resolve: (file: UploadedFile | StagedAttachmentRef) => void;
  reject: (error: Error) => void;
  onProgress?: (bytesUploaded: number) => void;
}

type SubscriptionState = "pending" | "sent" | "closed";
type SubscriptionSettlementSource = "connection" | "consumer" | "error";

interface SubscriptionSettlement {
  source: SubscriptionSettlementSource;
  error?: Error;
  notifyClose: boolean;
  sendUnsubscribe: boolean;
}

interface RelaySubscriptionLifecycle {
  beforeSend?: (subscriptionId: string) => void;
  beforeConsumerClose?: (subscriptionId: string) => void;
}

/**
 * Shared relay protocol logic for routing messages, managing subscriptions,
 * and coordinating request/response correlation.
 *
 * Both WebSocketConnection and SecureConnection compose this class,
 * providing transport-specific send/receive via RelayTransport callbacks.
 */
export class RelayProtocol {
  readonly pendingRequests = new Map<string, PendingRequest>();
  readonly pendingUploads = new Map<string, PendingUpload>();
  readonly subscriptions = new Map<string, StreamHandlers>();
  private subscriptionSettlers = new Map<
    string,
    (settlement: SubscriptionSettlement) => void
  >();
  /** Recently-closed subscription IDs — suppresses warnings for in-flight events */
  private recentlyClosed = new Set<string>();
  /** Registered handlers for emulator signaling messages */
  private emulatorHandlers = new Set<EmulatorMessageHandler>();
  /** Registered handlers for relayed speech stream messages */
  private speechHandlers = new Set<SpeechEventHandler>();

  private transport: RelayTransport;
  private options: RelayProtocolOptions;

  constructor(transport: RelayTransport, options: RelayProtocolOptions = {}) {
    this.transport = transport;
    this.options = options;
  }

  private get logPrefix(): string {
    return this.options.logPrefix ?? "[RelayProtocol]";
  }

  private get debugEnabled(): boolean {
    return this.options.debugEnabled?.() ?? false;
  }

  /**
   * Send a keepalive ping to verify the connection is alive.
   * Throws if the transport is not connected.
   */
  sendPing(id: string): void {
    const msg: ClientPing = { type: "ping", id };
    this.transport.sendMessage(msg);
  }

  /**
   * Set the callback for pong responses.
   */
  setOnPong(cb: ((id: string) => void) | undefined): void {
    this.options.onPong = cb;
  }

  /**
   * Set the callback for inbound relay events.
   *
   * Used by source-bound transports to feed their owning ConnectionManager
   * without relying on consumer stream handlers. Existing direct users omit
   * this hook and keep today's handler-owned health feeding.
   */
  setOnInboundEvent(cb: ((event: RelayEvent) => void) | undefined): void {
    this.options.onInboundEvent = cb;
  }

  /**
   * Override the critical-operation guard used by multiplex uploads.
   *
   * Source-owned connections inject their transport manager here. Connections
   * without an owning manager run uploads without a health-check guard.
   */
  setBeginCriticalOperation(cb: BeginCriticalOperation | undefined): void {
    this.options.beginCriticalOperation = cb;
  }

  private createSubscription(
    handlers: StreamHandlers,
    buildMessage: (subscriptionId: string) => RelaySubscribe,
    lifecycle: RelaySubscriptionLifecycle = {},
    subscriptionId = generateId(),
  ): Subscription {
    let state: SubscriptionState = "pending";

    const settle = (settlement: SubscriptionSettlement): void => {
      if (state === "closed") return;
      const wasSent = state === "sent";
      state = "closed";
      this.subscriptions.delete(subscriptionId);
      this.subscriptionSettlers.delete(subscriptionId);
      this.trackRecentlyClosed(subscriptionId);

      if (settlement.source === "consumer") {
        lifecycle.beforeConsumerClose?.(subscriptionId);
      }
      if (
        wasSent &&
        settlement.sendUnsubscribe &&
        this.transport.isConnected()
      ) {
        try {
          const message: RelayUnsubscribe = {
            type: "unsubscribe",
            subscriptionId,
          };
          this.transport.sendMessage(message);
        } catch {
          // Connection teardown releases server-owned subscriptions.
        }
      }
      if (settlement.error) {
        handlers.onError?.(settlement.error);
      }
      if (settlement.notifyClose) {
        handlers.onClose?.(settlement.error);
      }
    };

    this.subscriptions.set(subscriptionId, handlers);
    this.subscriptionSettlers.set(subscriptionId, settle);

    void this.transport.ensureConnected().then(
      () => {
        if (state !== "pending") return;
        state = "sent";
        try {
          lifecycle.beforeSend?.(subscriptionId);
          this.transport.sendMessage(buildMessage(subscriptionId));
        } catch (error) {
          settle({
            source: "error",
            error: error instanceof Error ? error : new Error(String(error)),
            notifyClose: false,
            sendUnsubscribe: false,
          });
        }
      },
      (error) => {
        settle({
          source: "error",
          error: error instanceof Error ? error : new Error(String(error)),
          notifyClose: false,
          sendUnsubscribe: false,
        });
      },
    );

    return {
      close: () => {
        settle({
          source: "consumer",
          notifyClose: true,
          sendUnsubscribe: true,
        });
      },
    };
  }

  /**
   * Route an incoming message to the appropriate handler.
   */
  routeMessage(msg: YepMessage): void {
    switch (msg.type) {
      case "response":
        this.handleResponse(msg);
        break;
      case "event":
        this.handleEvent(msg);
        break;
      case "upload_progress":
        this.handleUploadProgress(msg);
        break;
      case "upload_complete":
        this.handleUploadComplete(msg);
        break;
      case "upload_error":
        this.handleUploadError(msg);
        break;
      case "pong":
        this.options.onPong?.(msg.id);
        break;
      case "speech_event":
        this.handleSpeechEvent(msg);
        break;
      // Emulator signaling messages (server → client push)
      case "device_webrtc_offer":
      case "device_ice_candidate_event":
      case "device_session_state":
      case "device_stream_profile_event":
        this.handleEmulatorMessage(msg as DeviceServerMessage);
        break;
      default:
        console.warn(
          `${this.logPrefix} Unknown message type:`,
          (msg as { type?: string }).type,
        );
    }
  }

  private handleEmulatorMessage(msg: DeviceServerMessage): void {
    for (const handler of this.emulatorHandlers) {
      handler(msg);
    }
  }

  private handleSpeechEvent(msg: RelaySpeechEvent): void {
    for (const handler of this.speechHandlers) {
      handler(msg.message);
    }
  }

  /**
   * Register a handler for emulator signaling messages.
   * Returns an unsubscribe function.
   */
  onDeviceMessage(handler: EmulatorMessageHandler): () => void {
    this.emulatorHandlers.add(handler);
    return () => {
      this.emulatorHandlers.delete(handler);
    };
  }

  onSpeechEvent(handler: SpeechEventHandler): () => void {
    this.speechHandlers.add(handler);
    return () => {
      this.speechHandlers.delete(handler);
    };
  }

  private handleEvent(event: RelayEvent): void {
    this.options.onInboundEvent?.(event);

    const handlers = this.subscriptions.get(event.subscriptionId);
    const logEventDebug = this.debugEnabled || isActivityDebugEnabled();

    if (logEventDebug) {
      console.log(
        `${this.logPrefix} Received event:`,
        event.eventType,
        `sub=${event.subscriptionId}`,
        event.data,
      );
    }

    if (!handlers) {
      // Suppress warnings for subscriptions that were recently closed — the
      // server may still send a few events before it processes our unsubscribe.
      if (!this.recentlyClosed.has(event.subscriptionId)) {
        console.warn(
          `${this.logPrefix} Received event for unknown subscription: ${event.subscriptionId} (${event.eventType})`,
        );
      }
      return;
    }

    if (event.eventType === "connected") {
      handlers.onOpen?.();
    }

    handlers.onEvent(event.eventType, event.eventId, event.data);
  }

  private handleResponse(response: RelayResponse): void {
    // Check if this is a subscription error response.
    // When a session subscription fails (e.g., 404 for no active process),
    // the server sends a response with id=subscriptionId.
    const subscriptionHandlers = this.subscriptions.get(response.id);
    if (subscriptionHandlers && response.status >= 400) {
      const errorMessage =
        typeof response.body === "object" &&
        response.body !== null &&
        "error" in response.body
          ? String((response.body as { error: unknown }).error)
          : `Subscription failed with status ${response.status}`;
      console.log(
        `${this.logPrefix} Subscription ${response.id} failed: ${errorMessage}`,
      );
      this.subscriptionSettlers.get(response.id)?.({
        source: "error",
        error: new SubscriptionError(response.status, errorMessage),
        notifyClose: false,
        sendUnsubscribe: false,
      });
      return;
    }

    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      console.warn(
        `${this.logPrefix} Received response for unknown request:`,
        response.id,
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);

    if (this.debugEnabled && pending.startTime != null) {
      const duration = Date.now() - pending.startTime;
      const statusIcon = response.status >= 400 ? "\u2717" : "\u2190";
      const responseSize = JSON.stringify(response.body).length;
      console.log(
        `[Relay] ${statusIcon} ${pending.method} ${pending.path} ${response.status} (${duration}ms, ${responseSize} bytes)`,
      );
    }

    pending.resolve(response);
  }

  private handleUploadProgress(msg: RelayUploadProgress): void {
    const pending = this.pendingUploads.get(msg.uploadId);
    if (pending?.onProgress) {
      pending.onProgress(msg.bytesReceived);
    }
  }

  private handleUploadComplete(msg: RelayUploadComplete): void {
    const pending = this.pendingUploads.get(msg.uploadId);
    if (pending) {
      this.pendingUploads.delete(msg.uploadId);
      if (pending.uploadKind === "draft-staging") {
        if (msg.stagedRef) {
          pending.resolve(msg.stagedRef);
          return;
        }
        pending.reject(
          new Error("Upload completed without staged attachment metadata"),
        );
        return;
      }

      if (msg.file) {
        pending.resolve(msg.file);
        return;
      }
      pending.reject(new Error("Upload completed without file metadata"));
    }
  }

  private handleUploadError(msg: RelayUploadError): void {
    const pending = this.pendingUploads.get(msg.uploadId);
    if (pending) {
      this.pendingUploads.delete(msg.uploadId);
      const error = new Error(msg.error) as Error & { code?: string };
      if (msg.code) {
        error.code = msg.code;
      }
      pending.reject(error);
    }
  }

  /**
   * Make a JSON API request over the relay transport.
   */
  async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchWithRedirects(path, init, 0);
    if (response.status === 304)
      throw new Error("Unsupported relay response status: 304");
    return response.body as T;
  }

  /** Reconstruct a Response from the relay's existing body representation. */
  async fetchResponse(path: string, init?: RequestInit): Promise<Response> {
    const response = await this.fetchWithRedirects(path, init, 0);
    const headers = new Headers(response.headers);
    let body: BodyInit | null = null;
    if (![204, 205, 304].includes(response.status)) {
      const mediaType =
        headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ??
        "";
      const value = response.body as { _binary?: boolean; data?: string };
      if (mediaType === "application/json" || mediaType.endsWith("+json")) {
        // Match the server's JSON classification before considering a binary
        // envelope: those field names may also occur in an ordinary JSON file.
        body = JSON.stringify(response.body);
      } else if (value?._binary === true && typeof value.data === "string") {
        body = Uint8Array.from(atob(value.data), (char) => char.charCodeAt(0));
      } else if (typeof response.body === "string") body = response.body;
      else if (response.body != null)
        throw new Error("Unexpected relay response body");
    }
    return new Response(body, { status: response.status, headers });
  }

  private async fetchWithRedirects(
    path: string,
    init: RequestInit | undefined,
    redirectCount: number,
  ): Promise<RelayResponse> {
    await this.transport.ensureConnected();

    const id = generateId();
    const method = (init?.method ?? "GET") as RelayRequest["method"];

    let body: unknown;
    if (init?.body) {
      if (typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      } else {
        body = init.body;
      }
    }

    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) {
          headers[key] = value;
        }
      } else {
        Object.assign(headers, init.headers);
      }
    }

    headers["Content-Type"] = "application/json";
    headers["X-Yep-Anywhere"] = "true";

    const request: RelayRequest = {
      type: "request",
      id,
      method,
      path: path.startsWith("/api") ? path : `/api${path}`,
      headers,
      body,
    };

    const startTime = Date.now();

    if (this.debugEnabled) {
      console.log(`[Relay] \u2192 ${method} ${request.path}`);
    }

    return new Promise<RelayResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.debugEnabled) {
          const duration = Date.now() - startTime;
          console.log(
            `[Relay] \u2717 ${method} ${request.path} TIMEOUT (${duration}ms)`,
          );
        }
        this.pendingRequests.delete(id);
        reject(new Error("Request timeout"));
      }, API_REQUEST_DEADLINE_MS);

      this.pendingRequests.set(id, {
        resolve: (response: RelayResponse) => {
          if (RELAY_REDIRECT_STATUSES.has(response.status)) {
            if (redirectCount >= MAX_RELAY_REDIRECTS) {
              reject(
                new Error(
                  `Relay request exceeded ${MAX_RELAY_REDIRECTS} redirects`,
                ),
              );
              return;
            }
            try {
              const redirectPath = resolveRelayRedirectPath(
                request.path,
                getRelayHeader(response.headers, "Location"),
              );
              const redirectInit = getRedirectedRequestInit(
                response.status,
                init,
              );
              void this.fetchWithRedirects(
                redirectPath,
                redirectInit,
                redirectCount + 1,
              ).then(resolve, reject);
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
            return;
          }
          if (response.status >= 400) {
            reject(createRelayApiError(response));
          } else if (response.status >= 300 && response.status !== 304) {
            reject(
              new Error(
                `Unsupported relay response status: ${response.status}`,
              ),
            );
          } else {
            resolve(response);
          }
        },
        reject,
        timeout,
        startTime,
        method,
        path: request.path,
      });

      try {
        this.transport.sendMessage(request);
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Fetch binary data and return as Blob.
   */
  async fetchBlob(path: string): Promise<Blob> {
    await this.transport.ensureConnected();

    const id = generateId();
    const method = "GET";

    const request: RelayRequest = {
      type: "request",
      id,
      method,
      path: path.startsWith("/api") ? path : `/api${path}`,
      headers: { "X-Yep-Anywhere": "true" },
    };

    const startTime = Date.now();

    if (this.debugEnabled) {
      console.log(`[Relay] \u2192 ${method} ${request.path} (blob)`);
    }

    return new Promise<Blob>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.debugEnabled) {
          const duration = Date.now() - startTime;
          console.log(
            `[Relay] \u2717 ${method} ${request.path} TIMEOUT (${duration}ms)`,
          );
        }
        this.pendingRequests.delete(id);
        reject(new Error("Request timeout"));
      }, API_REQUEST_DEADLINE_MS);

      this.pendingRequests.set(id, {
        resolve: (response: RelayResponse) => {
          if (response.status >= 400) {
            reject(createRelayApiError(response));
            return;
          }

          const body = response.body as { _binary?: boolean; data?: string };
          if (body?._binary && typeof body.data === "string") {
            const binary = atob(body.data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            const contentType =
              response.headers?.["content-type"] ||
              response.headers?.["Content-Type"] ||
              "application/octet-stream";
            resolve(new Blob([bytes], { type: contentType }));
          } else {
            reject(new Error("Expected binary response"));
          }
        },
        reject,
        timeout,
        startTime,
        method,
        path: request.path,
      });

      try {
        this.transport.sendMessage(request);
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  /** Subscribe to bounded experimental Conversation snapshots. */
  subscribeConversation(
    subscriptionId: string,
    query: ConversationQuery,
    handlers: StreamHandlers,
  ): Subscription {
    return this.createSubscription(
      handlers,
      (id) => ({
        type: "subscribe",
        subscriptionId: id,
        channel: CONVERSATION_CHANNEL,
        apiRevision: CONVERSATION_API_REVISION,
        query,
      }),
      {},
      subscriptionId,
    );
  }

  subscribeSession(
    sessionId: string,
    handlers: StreamHandlers,
    lastEventId?: string,
    options?: SessionSubscriptionOptions,
  ): Subscription {
    return this.createSubscription(handlers, (subscriptionId) => ({
      type: "subscribe",
      subscriptionId,
      channel: "session",
      sessionId,
      lastEventId,
      wantsLiveDeltas: options?.wantsLiveDeltas,
    }));
  }

  /**
   * Subscribe to activity events.
   */
  subscribeActivity(handlers: StreamHandlers): Subscription {
    const browserProfileId = getOrCreateBrowserProfileId();
    const logEventDebug = this.debugEnabled || isActivityDebugEnabled();

    const originMetadata = {
      origin: window.location.origin,
      scheme: window.location.protocol.replace(":", ""),
      hostname: window.location.hostname,
      port: window.location.port
        ? Number.parseInt(window.location.port, 10)
        : null,
      userAgent: navigator.userAgent,
    };

    return this.createSubscription(
      handlers,
      (subscriptionId) => ({
        type: "subscribe",
        subscriptionId,
        channel: "activity",
        browserProfileId,
        originMetadata,
      }),
      {
        beforeSend: (subscriptionId) => {
          if (logEventDebug) {
            console.log(
              `${this.logPrefix} Sending activity subscribe:`,
              subscriptionId,
            );
          }
        },
        beforeConsumerClose: (subscriptionId) => {
          if (logEventDebug) {
            console.log(
              `${this.logPrefix} Closing activity subscribe:`,
              subscriptionId,
            );
          }
        },
      },
    );
  }

  /** Subscribe to one project's glossary path snapshot and later changes. */
  subscribeGlossary(projectId: string, handlers: StreamHandlers): Subscription {
    return this.createSubscription(handlers, (subscriptionId) => ({
      type: "subscribe",
      subscriptionId,
      channel: "glossary",
      projectId,
    }));
  }

  /** Subscribe to one project's worktree snapshot and revisioned deltas. */
  subscribeWorktree(
    projectId: string,
    coverage: GitWorktreeCoverage,
    handlers: StreamHandlers,
  ): Subscription {
    return this.createSubscription(handlers, (subscriptionId) => ({
      type: "subscribe",
      subscriptionId,
      channel: "worktree",
      projectId,
      coverage,
    }));
  }

  /**
   * Subscribe to focused file-change events for a specific session.
   */
  subscribeSessionWatch(
    sessionId: string,
    handlers: StreamHandlers,
    options?: {
      projectId?: string;
      provider?: string;
    },
  ): Subscription {
    return this.createSubscription(handlers, (subscriptionId) => ({
      type: "subscribe",
      subscriptionId,
      channel: "session-watch",
      sessionId,
      projectId: options?.projectId,
      provider: options?.provider,
    }));
  }

  /**
   * Upload a file via the relay transport.
   */
  async upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile> {
    const endCriticalOperation =
      this.options.beginCriticalOperation?.("upload") ?? (() => undefined);
    try {
      await this.transport.ensureConnected();

      const uploadId = generateId();
      const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;

      const uploadPromise = new Promise<UploadedFile>((resolve, reject) => {
        this.pendingUploads.set(uploadId, {
          uploadKind: "session",
          resolve: (file) => resolve(file as UploadedFile),
          reject,
          onProgress: options?.onProgress,
        });

        if (options?.signal) {
          options.signal.addEventListener("abort", () => {
            this.pendingUploads.delete(uploadId);
            reject(new Error("Upload aborted"));
          });
        }
      });

      try {
        const startMsg: RelayUploadStart = {
          type: "upload_start",
          uploadId,
          projectId,
          sessionId,
          filename: file.name,
          size: file.size,
          mimeType: file.type || "application/octet-stream",
          ...(options?.imageDimensions?.width !== undefined
            ? { width: options.imageDimensions.width }
            : {}),
          ...(options?.imageDimensions?.height !== undefined
            ? { height: options.imageDimensions.height }
            : {}),
        };
        this.transport.sendMessage(startMsg);

        let offset = 0;
        const reader = file.stream().getReader();

        while (true) {
          if (options?.signal?.aborted) {
            reader.cancel();
            throw new Error("Upload aborted");
          }

          const { done, value } = await reader.read();
          if (done) break;

          let chunkOffset = 0;
          while (chunkOffset < value.length) {
            const chunkEnd = Math.min(chunkOffset + chunkSize, value.length);
            const chunk = value.slice(chunkOffset, chunkEnd);

            await this.transport.sendUploadChunk(uploadId, offset, chunk);

            offset += chunk.length;
            chunkOffset = chunkEnd;
          }
        }

        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        this.transport.sendMessage(endMsg);

        return await uploadPromise;
      } catch (err) {
        this.pendingUploads.delete(uploadId);
        throw err;
      }
    } finally {
      endCriticalOperation();
    }
  }

  async uploadStagedAttachment(
    file: File,
    options?: UploadOptions & { batchId?: string },
  ): Promise<StagedAttachmentRef> {
    const endCriticalOperation =
      this.options.beginCriticalOperation?.("upload") ?? (() => undefined);
    try {
      await this.transport.ensureConnected();

      const uploadId = generateId();
      const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;

      const uploadPromise = new Promise<StagedAttachmentRef>(
        (resolve, reject) => {
          this.pendingUploads.set(uploadId, {
            uploadKind: "draft-staging",
            resolve: (file) => resolve(file as StagedAttachmentRef),
            reject,
            onProgress: options?.onProgress,
          });

          if (options?.signal) {
            options.signal.addEventListener("abort", () => {
              this.pendingUploads.delete(uploadId);
              reject(new Error("Upload aborted"));
            });
          }
        },
      );

      try {
        const startMsg: RelayStagedUploadStart = {
          type: "staged_upload_start",
          uploadId,
          ...(options?.batchId !== undefined
            ? { batchId: options.batchId }
            : {}),
          filename: file.name,
          size: file.size,
          mimeType: file.type || "application/octet-stream",
          ...(options?.imageDimensions?.width !== undefined
            ? { width: options.imageDimensions.width }
            : {}),
          ...(options?.imageDimensions?.height !== undefined
            ? { height: options.imageDimensions.height }
            : {}),
        };
        this.transport.sendMessage(startMsg);

        let offset = 0;
        const reader = file.stream().getReader();

        while (true) {
          if (options?.signal?.aborted) {
            reader.cancel();
            throw new Error("Upload aborted");
          }

          const { done, value } = await reader.read();
          if (done) break;

          let chunkOffset = 0;
          while (chunkOffset < value.length) {
            const chunkEnd = Math.min(chunkOffset + chunkSize, value.length);
            const chunk = value.slice(chunkOffset, chunkEnd);

            await this.transport.sendUploadChunk(uploadId, offset, chunk);

            offset += chunk.length;
            chunkOffset = chunkEnd;
          }
        }

        const endMsg: RelayUploadEnd = {
          type: "upload_end",
          uploadId,
        };
        this.transport.sendMessage(endMsg);

        return await uploadPromise;
      } catch (err) {
        this.pendingUploads.delete(uploadId);
        throw err;
      }
    } finally {
      endCriticalOperation();
    }
  }

  /**
   * Reject all pending requests and uploads with the given error.
   */
  rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }

    for (const [id, pending] of this.pendingUploads) {
      pending.reject(error);
      this.pendingUploads.delete(id);
    }
  }

  /**
   * Track a subscription ID as recently closed so in-flight events are
   * silently ignored instead of triggering warnings.
   */
  private trackRecentlyClosed(id: string): void {
    this.recentlyClosed.add(id);
    setTimeout(() => this.recentlyClosed.delete(id), 5_000);
  }

  /**
   * Notify all subscriptions that the connection closed, then clear them.
   */
  notifySubscriptionsClosed(error?: Error): void {
    for (const settle of Array.from(this.subscriptionSettlers.values())) {
      settle({
        source: "connection",
        error,
        notifyClose: true,
        sendUnsubscribe: false,
      });
    }
  }

  /**
   * Clean shutdown: reject all pending, notify subscriptions, clear state.
   */
  close(): void {
    const closeError = new Error("Connection closed");

    for (const settle of Array.from(this.subscriptionSettlers.values())) {
      settle({
        source: "connection",
        notifyClose: true,
        sendUnsubscribe: false,
      });
    }

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(closeError);
    }
    this.pendingRequests.clear();

    for (const pending of this.pendingUploads.values()) {
      pending.reject(closeError);
    }
    this.pendingUploads.clear();
  }
}
