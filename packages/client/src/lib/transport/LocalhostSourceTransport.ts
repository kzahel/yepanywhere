import type {
  GitWorktreeCoverage,
  StagedAttachmentRef,
  UploadedFile,
} from "@yep-anywhere/shared";
import {
  fetchPlainBlob,
  fetchPlainJSON,
  fetchPlainResponse,
} from "../../api/plainFetch";
import {
  uploadFile,
  uploadStagedFile,
  type WebSocketLike,
  type WebSocketFactory,
} from "../../api/upload";
import {
  ConnectionManager,
  type ConnectionManagerConfig,
} from "../connection/ConnectionManager";
import {
  WebSocketConnection,
  type WebSocketConnectionFactory,
  type WebSocketConnectionSocketState,
} from "../connection/WebSocketConnection";
import type {
  SessionSubscriptionOptions,
  StreamHandlers,
  Subscription,
} from "../connection/types";
import type {
  SessionWatchSubscriptionOptions,
  SourceTransport,
  SourceTransportCapabilities,
  SourceTransportChannelSnapshot,
  SourceTransportChannelState,
  SourceTransportStatus,
  SourceTransportStatusSnapshot,
  UploadOptions,
} from "./types";

export interface LocalhostSourceTransportOptions {
  connectionManagerConfig?: ConnectionManagerConfig;
  streamWebSocketFactory?: WebSocketConnectionFactory;
  uploadWebSocketFactory?: WebSocketFactory;
}

function isMutableFileBlobPath(path: string): boolean {
  const pathname = path.split("?", 1)[0] ?? "";
  return (
    pathname === "/local-image" ||
    pathname === "/local-file" ||
    /^\/projects\/[^/]+\/files\/raw$/.test(pathname)
  );
}

class LocalhostTransportStatus implements SourceTransportStatus {
  constructor(
    private readonly getSnapshotFn: () => SourceTransportStatusSnapshot,
  ) {}
  private listeners = new Set<() => void>();
  private visibilityRestoredListeners = new Set<() => void>();

  getSnapshot(): SourceTransportStatusSnapshot {
    return this.getSnapshotFn();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeVisibilityRestored(listener: () => void): () => void {
    this.visibilityRestoredListeners.add(listener);
    return () => {
      this.visibilityRestoredListeners.delete(listener);
    };
  }

  emit(): void {
    const listeners = [...this.listeners];
    for (const listener of listeners) {
      listener();
    }
  }

  emitVisibilityRestored(): void {
    const listeners = [...this.visibilityRestoredListeners];
    for (const listener of listeners) {
      listener();
    }
  }
}

export class LocalhostSourceTransport implements SourceTransport {
  readonly kind = "localhost" as const;
  readonly capabilities: SourceTransportCapabilities = {
    streamedResponses: true,
    sameOriginUrls: true,
    device: {
      send: async (msg) => {
        this.assertNotDisposed();
        await this.streamConnection.ensureConnected();
        this.streamConnection.sendMessage(msg);
      },
      onMessage: (handler) => this.streamConnection.onDeviceMessage(handler),
    },
  };
  readonly status: SourceTransportStatus;

  private readonly streamManager: ConnectionManager;
  private readonly streamConnection: WebSocketConnection;
  private readonly mutableStatus: LocalhostTransportStatus;
  private readonly uploadWebSocketFactory?: WebSocketFactory;
  private streamManagerStarted = false;
  private streamSocketState: SourceTransportChannelState = "idle";
  private readonly uploadSocketStates = new Map<
    WebSocketLike,
    SourceTransportChannelState
  >();
  private activeStreamSubscriptions = 0;
  private activeUploads = 0;
  private lastStreamError: string | undefined;
  private disposed = false;
  private removeManagerStateListener: (() => void) | null = null;
  private removeManagerFailureListener: (() => void) | null = null;
  private removeManagerVisibilityListener: (() => void) | null = null;

  constructor(options: LocalhostSourceTransportOptions = {}) {
    this.streamManager = new ConnectionManager(options.connectionManagerConfig);
    this.uploadWebSocketFactory = options.uploadWebSocketFactory;
    this.streamConnection = new WebSocketConnection({
      createWebSocket: options.streamWebSocketFactory,
      connectionManager: this.streamManager,
      onSocketStateChange: (state) => this.handleStreamSocketState(state),
    });
    this.mutableStatus = new LocalhostTransportStatus(() =>
      this.createSnapshot(),
    );
    this.status = this.mutableStatus;
  }

  fetch<T>(path: string, init?: RequestInit): Promise<T> {
    this.assertNotDisposed();
    return fetchPlainJSON<T>(path, init);
  }

  fetchBlob(path: string): Promise<Blob> {
    this.assertNotDisposed();
    return fetchPlainBlob(
      path,
      isMutableFileBlobPath(path) ? { cache: "no-cache" } : undefined,
    );
  }

  fetchResponse(path: string, init?: RequestInit): Promise<Response> {
    this.assertNotDisposed();
    return fetchPlainResponse(path, init);
  }

  upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile> {
    this.assertNotDisposed();
    return this.withUploadChannel((createWebSocket) =>
      uploadFile(projectId, sessionId, file, options, {
        createWebSocket,
        beginCriticalOperation: (label) =>
          this.streamManager.beginCriticalOperation(label),
      }),
    );
  }

  uploadStagedAttachment(
    file: File,
    options?: UploadOptions & { batchId?: string },
  ): Promise<StagedAttachmentRef> {
    this.assertNotDisposed();
    return this.withUploadChannel((createWebSocket) =>
      uploadStagedFile(file, options, {
        createWebSocket,
        beginCriticalOperation: (label) =>
          this.streamManager.beginCriticalOperation(label),
      }),
    );
  }

  subscribeSession(
    sessionId: string,
    handlers: StreamHandlers,
    lastEventId?: string,
    options?: SessionSubscriptionOptions,
  ): Subscription {
    return this.trackStreamSubscription((wrappedHandlers) =>
      this.streamConnection.subscribeSession(
        sessionId,
        wrappedHandlers,
        lastEventId,
        options,
      ),
    )(handlers);
  }

  subscribeSessionWatch(
    sessionId: string,
    handlers: StreamHandlers,
    options?: SessionWatchSubscriptionOptions,
  ): Subscription {
    return this.trackStreamSubscription((wrappedHandlers) =>
      this.streamConnection.subscribeSessionWatch(
        sessionId,
        wrappedHandlers,
        options,
      ),
    )(handlers);
  }

  subscribeActivity(handlers: StreamHandlers): Subscription {
    return this.trackStreamSubscription((wrappedHandlers) =>
      this.streamConnection.subscribeActivity(wrappedHandlers),
    )(handlers);
  }

  subscribeGlossary(projectId: string, handlers: StreamHandlers): Subscription {
    return this.trackStreamSubscription((wrappedHandlers) =>
      this.streamConnection.subscribeGlossary(projectId, wrappedHandlers),
    )(handlers);
  }

  subscribeWorktree(
    projectId: string,
    coverage: GitWorktreeCoverage,
    handlers: StreamHandlers,
  ): Subscription {
    return this.trackStreamSubscription((wrappedHandlers) =>
      this.streamConnection.subscribeWorktree(
        projectId,
        coverage,
        wrappedHandlers,
      ),
    )(handlers);
  }

  async reconnect(): Promise<void> {
    this.assertNotDisposed();
    // Localhost source-level readiness is same-origin HTTP and always ready.
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeManagerStateListener?.();
    this.removeManagerFailureListener?.();
    this.removeManagerVisibilityListener?.();
    this.removeManagerStateListener = null;
    this.removeManagerFailureListener = null;
    this.removeManagerVisibilityListener = null;
    this.streamManager.stop();
    this.streamConnection.close();
    this.streamSocketState = "disconnected";
    this.mutableStatus.emit();
  }

  private handleStreamSocketState(state: WebSocketConnectionSocketState): void {
    if (this.disposed) return;
    this.streamSocketState = state === "connected" ? "connected" : state;
    if (state === "connected") {
      this.lastStreamError = undefined;
      this.startStreamManager();
    }
    this.mutableStatus.emit();
  }

  private startStreamManager(): void {
    if (this.streamManagerStarted) {
      this.streamManager.markConnected();
      return;
    }

    this.streamManagerStarted = true;
    this.removeManagerStateListener = this.streamManager.on("stateChange", () =>
      this.mutableStatus.emit(),
    );
    this.removeManagerFailureListener = this.streamManager.on(
      "reconnectFailed",
      (error) => {
        this.lastStreamError = error.message;
        this.mutableStatus.emit();
      },
    );
    this.removeManagerVisibilityListener = this.streamManager.on(
      "visibilityRestored",
      () => this.mutableStatus.emitVisibilityRestored(),
    );
    this.streamManager.start(() => this.streamConnection.reconnect(), {
      sendPing: (id) => this.streamConnection.sendPing(id),
      label: "localhost-stream",
    });
  }

  private trackStreamSubscription(
    subscribe: (handlers: StreamHandlers) => Subscription,
  ): (handlers: StreamHandlers) => Subscription {
    return (handlers) => {
      this.assertNotDisposed();
      this.activeStreamSubscriptions += 1;
      this.mutableStatus.emit();

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.activeStreamSubscriptions = Math.max(
          0,
          this.activeStreamSubscriptions - 1,
        );
        this.mutableStatus.emit();
      };

      const wrappedHandlers: StreamHandlers = {
        onEvent: (eventType, eventId, data) => {
          if (eventType === "heartbeat") {
            this.streamManager.recordHeartbeat();
          } else {
            this.streamManager.recordEvent();
          }
          handlers.onEvent(eventType, eventId, data);
        },
        onOpen: () => {
          this.startStreamManager();
          this.streamManager.markConnected();
          handlers.onOpen?.();
        },
        onError: (error) => {
          this.lastStreamError = error.message;
          this.streamManager.handleError(error);
          release();
          handlers.onError?.(error);
        },
        onClose: (error) => {
          if (error) {
            this.lastStreamError = error.message;
            this.streamManager.handleClose(error);
          }
          release();
          handlers.onClose?.(error);
        },
      };

      const subscription = subscribe(wrappedHandlers);
      return {
        close: () => subscription.close(),
      };
    };
  }

  private async withUploadChannel<T>(
    fn: (createWebSocket: WebSocketFactory) => Promise<T>,
  ): Promise<T> {
    this.activeUploads += 1;
    this.mutableStatus.emit();
    const cleanups: Array<() => void> = [];
    const createWebSocket: WebSocketFactory = (url) => {
      const socket = this.uploadWebSocketFactory
        ? this.uploadWebSocketFactory(url)
        : (new WebSocket(url) as WebSocketLike);
      cleanups.push(this.trackUploadSocket(socket));
      return socket;
    };

    try {
      return await fn(createWebSocket);
    } finally {
      for (const cleanup of cleanups) {
        cleanup();
      }
      this.activeUploads = Math.max(0, this.activeUploads - 1);
      this.mutableStatus.emit();
    }
  }

  private trackUploadSocket(socket: WebSocketLike): () => void {
    const setState = (state: SourceTransportChannelState) => {
      if (!this.uploadSocketStates.has(socket)) return;
      this.uploadSocketStates.set(socket, state);
      this.mutableStatus.emit();
    };
    const handleOpen = () => setState("connected");
    const handleClose = () => setState("disconnected");
    const handleError = () => setState("disconnected");

    this.uploadSocketStates.set(
      socket,
      socket.readyState === WebSocket.OPEN ? "connected" : "connecting",
    );
    socket.addEventListener("open", handleOpen);
    socket.addEventListener("close", handleClose);
    socket.addEventListener("error", handleError);
    this.mutableStatus.emit();

    return () => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("close", handleClose);
      socket.removeEventListener("error", handleError);
      this.uploadSocketStates.delete(socket);
      this.mutableStatus.emit();
    };
  }

  private createSnapshot(): SourceTransportStatusSnapshot {
    const channels: SourceTransportChannelSnapshot[] = [
      { name: "same-origin-http", state: "stateless" },
      {
        name: "stream-websocket",
        state: this.getStreamChannelState(),
        activeSubscriptions: this.activeStreamSubscriptions,
        ...(this.streamManager.reconnectAttempts > 0
          ? { reconnectAttempts: this.streamManager.reconnectAttempts }
          : {}),
        ...(this.lastStreamError ? { lastError: this.lastStreamError } : {}),
      },
    ];

    if (this.activeUploads > 0) {
      channels.push({
        name: "upload-websocket",
        state: this.getUploadChannelState(),
        activeSubscriptions: this.activeUploads,
      });
    }

    return {
      kind: this.kind,
      state: "ready",
      channels,
    };
  }

  private getStreamChannelState(): SourceTransportChannelState {
    if (this.disposed) return "disconnected";
    if (!this.streamManagerStarted) return this.streamSocketState;
    switch (this.streamManager.state) {
      case "connected":
        return "connected";
      case "reconnecting":
        return "reconnecting";
      case "disconnected":
        return this.streamSocketState === "connecting"
          ? "connecting"
          : "disconnected";
    }
  }

  private getUploadChannelState(): SourceTransportChannelState {
    if (this.uploadSocketStates.size === 0) return "connecting";
    let hasConnecting = false;
    for (const state of this.uploadSocketStates.values()) {
      if (state === "connected") return "connected";
      if (state === "connecting") hasConnecting = true;
    }
    return hasConnecting ? "connecting" : "disconnected";
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("LocalhostSourceTransport has been disposed");
    }
  }
}
