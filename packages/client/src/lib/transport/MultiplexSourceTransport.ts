import type {
  DeviceServerMessage,
  GitWorktreeCoverage,
  RemoteClientMessage,
  StagedAttachmentRef,
  UploadedFile,
} from "@yep-anywhere/shared";
import {
  ConnectionManager,
  type ConnectionManagerConfig,
} from "../connection/ConnectionManager";
import type { SecureConnection } from "../connection/SecureConnection";
import type { WebSocketConnection } from "../connection/WebSocketConnection";
import type {
  Connection,
  ConnectionSpeechSocket,
  SessionSubscriptionOptions,
  StreamHandlers,
  Subscription,
} from "../connection/types";
import type {
  SessionWatchSubscriptionOptions,
  SourceTransport,
  SourceTransportCapabilities,
  SourceTransportChannelName,
  SourceTransportChannelSnapshot,
  SourceTransportChannelState,
  SourceTransportKind,
  SourceTransportState,
  SourceTransportStatus,
  SourceTransportStatusSnapshot,
  UploadOptions,
} from "./types";
import {
  SourceTransportDisconnectedError,
  SourceTransportDisposedError,
  SourceTransportNotReadyError,
  SourceTransportUnsupportedError,
} from "./types";

const SOURCE_TRANSPORT_READY_TIMEOUT_MS = 15_000;

interface MultiplexConnection extends Connection {
  close(): void;
  sendPing(id: string): void;
  setConnectionManager?(manager: ConnectionManager | null): void;
  sendMessage?(msg: RemoteClientMessage): void;
  onDeviceMessage?(handler: (msg: DeviceServerMessage) => void): () => void;
  openSpeechSocket?(): Promise<ConnectionSpeechSocket>;
  reconnect?(): Promise<void>;
  forceReconnect?(): Promise<void>;
}

interface MultiplexTransportOptions {
  connectionManagerConfig?: ConnectionManagerConfig;
  readyTimeoutMs?: number;
}

interface MultiplexTransportConfig<TConnection extends MultiplexConnection> {
  kind: SourceTransportKind;
  channelName: SourceTransportChannelName;
  managerLabel: string;
  sameOriginUrls: boolean;
  device: boolean;
  speech: boolean;
  reconnect(connection: TConnection): Promise<void>;
}

interface AttachOptions {
  /**
   * Use "connecting" only when the backing connection has been installed
   * before its first connect/auth completes. RemoteConnectionContext currently
   * attaches after a successful auth probe, so the default is "ready".
   */
  state?: "connecting" | "ready";
}

class MultiplexTransportStatus implements SourceTransportStatus {
  private readonly listeners = new Set<() => void>();
  private readonly visibilityRestoredListeners = new Set<() => void>();

  constructor(
    private readonly getSnapshotFn: () => SourceTransportStatusSnapshot,
  ) {}

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

abstract class MultiplexSourceTransport<TConnection extends MultiplexConnection>
  implements SourceTransport
{
  readonly kind: SourceTransportKind;
  readonly status: SourceTransportStatus;
  readonly capabilities: SourceTransportCapabilities;

  private readonly channelName: SourceTransportChannelName;
  private readonly managerLabel: string;
  private readonly readyTimeoutMs: number;
  private readonly manager: ConnectionManager;
  private readonly mutableStatus: MultiplexTransportStatus;
  private readonly reconnectConnection: (
    connection: TConnection,
  ) => Promise<void>;
  private connection: TConnection | null = null;
  private slotState: "detached" | "connecting" | "ready" = "detached";
  private activeSubscriptions = 0;
  private lastError: string | undefined;
  /** Original terminal cause for acquisition/authentication owners. */
  failure: Error | undefined;
  private disposed = false;
  private removeManagerStateListener: (() => void) | null = null;
  private removeManagerFailureListener: (() => void) | null = null;
  private removeManagerVisibilityListener: (() => void) | null = null;
  private readonly attachWaiters = new Set<{
    resolve: (connection: TConnection) => void;
    reject: (error: Error) => void;
  }>();
  private readonly deviceHandlers = new Set<
    (msg: DeviceServerMessage) => void
  >();
  private readonly deviceUnsubscribers = new Map<
    (msg: DeviceServerMessage) => void,
    () => void
  >();

  constructor(
    config: MultiplexTransportConfig<TConnection>,
    options: MultiplexTransportOptions = {},
  ) {
    this.kind = config.kind;
    this.channelName = config.channelName;
    this.managerLabel = config.managerLabel;
    this.readyTimeoutMs =
      options.readyTimeoutMs ?? SOURCE_TRANSPORT_READY_TIMEOUT_MS;
    this.manager = new ConnectionManager(options.connectionManagerConfig);
    this.reconnectConnection = config.reconnect;
    this.mutableStatus = new MultiplexTransportStatus(() =>
      this.createSnapshot(),
    );
    this.status = this.mutableStatus;
    this.capabilities = {
      streamedResponses: config.kind === "secure",
      sameOriginUrls: config.sameOriginUrls,
      ...(config.device
        ? {
            device: {
              send: (msg) => this.sendDeviceMessage(msg),
              onMessage: (handler) => this.addDeviceHandler(handler),
            },
          }
        : {}),
      ...(config.speech
        ? { speech: { open: () => this.openSpeechSocket() } }
        : {}),
    };
    this.removeManagerStateListener = this.manager.on("stateChange", () => {
      if (this.manager.state === "connected") {
        this.failure = undefined;
        this.lastError = undefined;
      }
      this.mutableStatus.emit();
    });
    this.removeManagerFailureListener = this.manager.on(
      "reconnectFailed",
      (error) => {
        this.lastError = error.message;
        this.failure = error;
        this.mutableStatus.emit();
      },
    );
    this.removeManagerVisibilityListener = this.manager.on(
      "visibilityRestored",
      () => this.mutableStatus.emitVisibilityRestored(),
    );
  }

  attach(connection: TConnection, options: AttachOptions = {}): void {
    this.assertNotDisposed();
    if (this.connection && this.connection !== connection) {
      this.connection.setConnectionManager?.(null);
      this.detachDeviceHandlers();
      this.manager.stop();
    } else if (this.connection === connection) {
      this.detachDeviceHandlers();
    }

    this.failure = undefined;
    this.lastError = undefined;
    this.connection = connection;
    this.slotState = options.state ?? "ready";
    connection.setConnectionManager?.(this.manager);
    this.startPassiveManager();
    this.attachDeviceHandlers();
    this.resolveAttachWaiters(connection);
    this.mutableStatus.emit();
  }

  detach(): void {
    if (this.disposed) return;
    this.connection?.setConnectionManager?.(null);
    this.detachDeviceHandlers();
    this.connection = null;
    this.slotState = "detached";
    this.manager.stop();
    this.mutableStatus.emit();
  }

  fetch<T>(path: string, init?: RequestInit): Promise<T> {
    this.assertNotDisposed();
    return this.withConnection((connection) => connection.fetch<T>(path, init));
  }

  fetchBlob(path: string): Promise<Blob> {
    this.assertNotDisposed();
    return this.withConnection((connection) => connection.fetchBlob(path));
  }

  fetchResponse(path: string, init?: RequestInit): Promise<Response> {
    this.assertNotDisposed();
    return this.withConnection((connection) =>
      connection.fetchResponse(path, init),
    );
  }

  fetchStream(
    path: string,
    init?: { signal?: AbortSignal | null; headers?: HeadersInit },
  ): Promise<Response> {
    this.assertNotDisposed();
    return this.withConnection((connection) =>
      connection.fetchStream
        ? connection.fetchStream(path, init)
        : connection.fetchResponse(path, init),
    );
  }

  upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile> {
    this.assertNotDisposed();
    return this.withConnection((connection) =>
      connection.upload(projectId, sessionId, file, options),
    );
  }

  uploadStagedAttachment(
    file: File,
    options?: UploadOptions & { batchId?: string },
  ): Promise<StagedAttachmentRef> {
    this.assertNotDisposed();
    return this.withConnection((connection) =>
      connection.uploadStagedAttachment(file, options),
    );
  }

  subscribeSession(
    sessionId: string,
    handlers: StreamHandlers,
    lastEventId?: string,
    options?: SessionSubscriptionOptions,
  ): Subscription {
    return this.subscribeNow(handlers, (connection, wrappedHandlers) =>
      connection.subscribeSession(
        sessionId,
        wrappedHandlers,
        lastEventId,
        options,
      ),
    );
  }

  subscribeSessionWatch(
    sessionId: string,
    handlers: StreamHandlers,
    options?: SessionWatchSubscriptionOptions,
  ): Subscription {
    return this.subscribeNow(handlers, (connection, wrappedHandlers) =>
      connection.subscribeSessionWatch(sessionId, wrappedHandlers, options),
    );
  }

  subscribeActivity(handlers: StreamHandlers): Subscription {
    return this.subscribeNow(handlers, (connection, wrappedHandlers) =>
      connection.subscribeActivity(wrappedHandlers),
    );
  }

  subscribeGlossary(projectId: string, handlers: StreamHandlers): Subscription {
    return this.subscribeNow(handlers, (connection, wrappedHandlers) =>
      connection.subscribeGlossary(projectId, wrappedHandlers),
    );
  }

  subscribeWorktree(
    projectId: string,
    coverage: GitWorktreeCoverage,
    handlers: StreamHandlers,
  ): Subscription {
    return this.subscribeNow(handlers, (connection, wrappedHandlers) =>
      connection.subscribeWorktree(projectId, coverage, wrappedHandlers),
    );
  }

  async reconnect(): Promise<void> {
    this.assertNotDisposed();
    const connection = await this.waitForConnection();
    this.slotState = "connecting";
    this.mutableStatus.emit();
    await this.reconnectConnection(connection);
    this.slotState = "ready";
    this.manager.markConnected();
    this.mutableStatus.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAttachWaiters(new SourceTransportDisposedError(this.kind));
    this.removeManagerStateListener?.();
    this.removeManagerFailureListener?.();
    this.removeManagerVisibilityListener?.();
    this.removeManagerStateListener = null;
    this.removeManagerFailureListener = null;
    this.removeManagerVisibilityListener = null;
    this.detachDeviceHandlers();
    this.connection?.setConnectionManager?.(null);
    this.connection?.close();
    this.connection = null;
    this.slotState = "detached";
    this.manager.stop();
    this.mutableStatus.emit();
  }

  protected getAttachedConnection(): TConnection | null {
    return this.connection;
  }

  private startPassiveManager(): void {
    const connection = this.connection;
    if (!connection) return;
    this.manager.start(
      () => {
        const current = this.connection;
        if (!current) {
          return Promise.reject(this.createNotReadyError());
        }
        return this.reconnectConnection(current);
      },
      {
        sendPing: (id) => this.connection?.sendPing(id),
        label: this.managerLabel,
        // T7 moves the activity stream onto this source transport, making the
        // per-transport manager the only owner of stream reconnect policy.
        driveReconnect: true,
      },
    );
    if (this.slotState === "ready") {
      this.manager.markConnected();
    }
  }

  private subscribeNow(
    handlers: StreamHandlers,
    subscribe: (
      connection: TConnection,
      handlers: StreamHandlers,
    ) => Subscription,
  ): Subscription {
    this.assertNotDisposed();
    const connection = this.connection;
    if (!connection) {
      let closed = false;
      queueMicrotask(() => {
        if (!closed) handlers.onError?.(this.createNotReadyError());
      });
      return {
        close: () => {
          closed = true;
        },
      };
    }

    this.activeSubscriptions += 1;
    this.mutableStatus.emit();

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.activeSubscriptions = Math.max(0, this.activeSubscriptions - 1);
      this.mutableStatus.emit();
    };

    const wrappedHandlers: StreamHandlers = {
      onEvent: (eventType, eventId, data) => {
        handlers.onEvent(eventType, eventId, data);
      },
      onOpen: () => {
        handlers.onOpen?.();
      },
      onError: (error) => {
        this.lastError = error.message;
        release();
        handlers.onError?.(error);
      },
      onClose: (error) => {
        if (error) this.lastError = error.message;
        release();
        handlers.onClose?.(error);
      },
    };

    const subscription = subscribe(connection, wrappedHandlers);
    return {
      close: () => {
        release();
        subscription.close();
      },
    };
  }

  private async withConnection<T>(
    fn: (connection: TConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.waitForConnection();
    if (this.manager.state === "disconnected") {
      throw this.createDisconnectedError();
    }
    return fn(connection);
  }

  private waitForConnection(): Promise<TConnection> {
    if (this.disposed) {
      return Promise.reject(new SourceTransportDisposedError(this.kind));
    }
    if (this.connection) {
      return Promise.resolve(this.connection);
    }

    return new Promise<TConnection>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const waiter = {
        resolve: (connection: TConnection) => {
          clearTimeout(timer);
          this.attachWaiters.delete(waiter);
          resolve(connection);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          this.attachWaiters.delete(waiter);
          reject(error);
        },
      };
      timer = setTimeout(() => {
        this.attachWaiters.delete(waiter);
        reject(this.createNotReadyError());
      }, this.readyTimeoutMs);
      this.attachWaiters.add(waiter);
    });
  }

  private resolveAttachWaiters(connection: TConnection): void {
    const waiters = [...this.attachWaiters];
    for (const waiter of waiters) {
      waiter.resolve(connection);
    }
  }

  private rejectAttachWaiters(error: Error): void {
    const waiters = [...this.attachWaiters];
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  private createNotReadyError(): SourceTransportNotReadyError {
    return new SourceTransportNotReadyError({
      kind: this.kind,
      state: this.getSourceState(),
      channel: this.channelName,
      timeoutMs: this.readyTimeoutMs,
    });
  }

  private createDisconnectedError(): SourceTransportDisconnectedError {
    return new SourceTransportDisconnectedError({
      kind: this.kind,
      channel: this.channelName,
      lastError: this.lastError,
    });
  }

  private createSnapshot(): SourceTransportStatusSnapshot {
    return {
      kind: this.kind,
      state: this.getSourceState(),
      channels: [this.createChannelSnapshot()],
    };
  }

  private createChannelSnapshot(): SourceTransportChannelSnapshot {
    return {
      name: this.channelName,
      state: this.getChannelState(),
      activeSubscriptions: this.activeSubscriptions,
      ...(this.manager.reconnectAttempts > 0
        ? { reconnectAttempts: this.manager.reconnectAttempts }
        : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private getSourceState(): SourceTransportState {
    if (this.disposed || !this.connection) return "disconnected";
    if (this.slotState === "connecting") return "connecting";
    switch (this.manager.state) {
      case "connected":
        return "ready";
      case "reconnecting":
        return "reconnecting";
      case "disconnected":
        return "disconnected";
    }
  }

  private getChannelState(): SourceTransportChannelState {
    if (this.disposed || !this.connection) return "disconnected";
    if (this.slotState === "connecting") return "connecting";
    switch (this.manager.state) {
      case "connected":
        return "connected";
      case "reconnecting":
        return "reconnecting";
      case "disconnected":
        return "disconnected";
    }
  }

  private async sendDeviceMessage(msg: RemoteClientMessage): Promise<void> {
    const connection = await this.waitForConnection();
    if (!connection.sendMessage) {
      throw new SourceTransportUnsupportedError({
        kind: this.kind,
        operation: "device signaling",
        channel: this.channelName,
      });
    }
    connection.sendMessage(msg);
  }

  private addDeviceHandler(
    handler: (msg: DeviceServerMessage) => void,
  ): () => void {
    this.deviceHandlers.add(handler);
    const unsubscribe = this.attachDeviceHandler(handler);
    if (unsubscribe) this.deviceUnsubscribers.set(handler, unsubscribe);
    return () => {
      this.deviceUnsubscribers.get(handler)?.();
      this.deviceUnsubscribers.delete(handler);
      this.deviceHandlers.delete(handler);
    };
  }

  private attachDeviceHandlers(): void {
    for (const handler of this.deviceHandlers) {
      const unsubscribe = this.attachDeviceHandler(handler);
      if (unsubscribe) this.deviceUnsubscribers.set(handler, unsubscribe);
    }
  }

  private detachDeviceHandlers(): void {
    for (const unsubscribe of this.deviceUnsubscribers.values()) {
      unsubscribe();
    }
    this.deviceUnsubscribers.clear();
  }

  private attachDeviceHandler(
    handler: (msg: DeviceServerMessage) => void,
  ): (() => void) | null {
    const connection = this.connection;
    if (!connection?.onDeviceMessage) return null;
    return connection.onDeviceMessage(handler);
  }

  private async openSpeechSocket(): Promise<ConnectionSpeechSocket> {
    const connection = await this.waitForConnection();
    if (!connection.openSpeechSocket) {
      throw new SourceTransportUnsupportedError({
        kind: this.kind,
        operation: "speech socket",
        channel: this.channelName,
      });
    }
    return connection.openSpeechSocket();
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new SourceTransportDisposedError(this.kind);
    }
  }
}

export interface WebSocketSourceTransportOptions
  extends MultiplexTransportOptions {
  sameOriginUrls?: boolean;
}

export class WebSocketSourceTransport extends MultiplexSourceTransport<WebSocketConnection> {
  constructor(options: WebSocketSourceTransportOptions = {}) {
    super(
      {
        kind: "websocket",
        channelName: "multiplex-websocket",
        managerLabel: "source-websocket",
        sameOriginUrls: options.sameOriginUrls ?? true,
        device: true,
        speech: false,
        reconnect: (connection) => connection.reconnect(),
      },
      options,
    );
  }
}

export interface SecureSourceTransportOptions
  extends MultiplexTransportOptions {}

export class SecureSourceTransport extends MultiplexSourceTransport<SecureConnection> {
  constructor(options: SecureSourceTransportOptions = {}) {
    super(
      {
        kind: "secure",
        channelName: "secure-websocket",
        managerLabel: "source-secure",
        sameOriginUrls: false,
        device: true,
        speech: true,
        reconnect: (connection) => connection.forceReconnect(),
      },
      options,
    );
  }
}
