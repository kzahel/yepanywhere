import type {
  GitWorktreeCoverage,
  StagedAttachmentRef,
  UploadedFile,
} from "@yep-anywhere/shared";
import {
  SourceTransportDisposedError,
  SourceTransportNotReadyError,
  SourceTransportUnsupportedError,
  type SessionSubscriptionOptions,
  type SessionWatchSubscriptionOptions,
  type SourceTransport,
  type SourceTransportCapabilities,
  type SourceTransportChannelName,
  type SourceTransportChannelSnapshot,
  type SourceTransportKind,
  type SourceTransportState,
  type SourceTransportStatus,
  type SourceTransportStatusSnapshot,
  type StreamHandlers,
  type Subscription,
  type UploadOptions,
} from "./types";

type FakeFetchHandler = <T>(path: string, init?: RequestInit) => Promise<T>;
type FakeFetchBlobHandler = (path: string) => Promise<Blob>;
type FakeFetchResponseHandler = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;
type FakeUploadHandler = (
  projectId: string,
  sessionId: string,
  file: File,
  options?: UploadOptions,
) => Promise<UploadedFile>;
type FakeStagedUploadHandler = (
  file: File,
  options?: UploadOptions & { batchId?: string },
) => Promise<StagedAttachmentRef>;

export type FakeSourceTransportSubscriptionKind =
  | "session"
  | "session-watch"
  | "glossary"
  | "worktree"
  | "activity";

export interface FakeSourceTransportSubscriptionRecord {
  readonly id: string;
  readonly kind: FakeSourceTransportSubscriptionKind;
  readonly sessionId?: string;
  readonly projectId?: string;
  readonly coverage?: GitWorktreeCoverage;
  readonly lastEventId?: string;
  readonly options?:
    | SessionSubscriptionOptions
    | SessionWatchSubscriptionOptions;
  readonly closed: boolean;
  readonly closeCalls: number;
}

interface MutableFakeSubscriptionRecord
  extends FakeSourceTransportSubscriptionRecord {
  handlers: StreamHandlers;
  closed: boolean;
  closeCalls: number;
}

export interface FakeSourceTransportCallbackOptions {
  readonly allowClosed?: boolean;
}

export interface FakeSourceTransportOptions {
  readonly kind?: SourceTransportKind;
  readonly capabilities?: SourceTransportCapabilities;
  readonly initialSnapshot?: SourceTransportStatusSnapshot;
  readonly fetch?: FakeFetchHandler;
  readonly fetchBlob?: FakeFetchBlobHandler;
  readonly fetchResponse?: FakeFetchResponseHandler;
  readonly upload?: FakeUploadHandler;
  readonly uploadStagedAttachment?: FakeStagedUploadHandler;
  readonly reconnect?: () => Promise<void>;
}

function copyChannel(
  channel: SourceTransportChannelSnapshot,
): SourceTransportChannelSnapshot {
  return { ...channel };
}

function copySnapshot(
  snapshot: SourceTransportStatusSnapshot,
): SourceTransportStatusSnapshot {
  return {
    ...snapshot,
    channels: snapshot.channels.map(copyChannel),
  };
}

function defaultCapabilities(
  kind: SourceTransportKind,
): SourceTransportCapabilities {
  return { sameOriginUrls: kind !== "secure", streamedResponses: true };
}

class FakeSourceTransportStatus implements SourceTransportStatus {
  private listeners = new Set<() => void>();
  private visibilityRestoredListeners = new Set<() => void>();
  private snapshot: SourceTransportStatusSnapshot;

  constructor(snapshot: SourceTransportStatusSnapshot) {
    this.snapshot = copySnapshot(snapshot);
  }

  getSnapshot(): SourceTransportStatusSnapshot {
    return copySnapshot(this.snapshot);
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

  setSnapshot(snapshot: SourceTransportStatusSnapshot): void {
    this.snapshot = copySnapshot(snapshot);
    this.emit();
  }

  setState(state: SourceTransportState): void {
    this.setSnapshot({ ...this.snapshot, state });
  }

  setChannels(channels: readonly SourceTransportChannelSnapshot[]): void {
    this.setSnapshot({ ...this.snapshot, channels });
  }

  upsertChannel(channel: SourceTransportChannelSnapshot): void {
    const channels = [...this.snapshot.channels];
    const index = channels.findIndex(
      (candidate) => candidate.name === channel.name,
    );
    if (index === -1) {
      channels.push(copyChannel(channel));
    } else {
      channels[index] = copyChannel(channel);
    }
    this.setChannels(channels);
  }

  removeChannel(name: SourceTransportChannelName): void {
    this.setChannels(
      this.snapshot.channels.filter((channel) => channel.name !== name),
    );
  }

  private emit(): void {
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

export class FakeSourceTransport implements SourceTransport {
  readonly kind: SourceTransportKind;
  readonly status: SourceTransportStatus;
  readonly capabilities: SourceTransportCapabilities;

  private readonly mutableStatus: FakeSourceTransportStatus;
  private readonly subscriptions = new Map<
    string,
    MutableFakeSubscriptionRecord
  >();
  private nextSubscriptionId = 1;
  private disposed = false;
  private fetchHandler?: FakeFetchHandler;
  private fetchBlobHandler?: FakeFetchBlobHandler;
  private fetchResponseHandler?: FakeFetchResponseHandler;
  private uploadHandler?: FakeUploadHandler;
  private stagedUploadHandler?: FakeStagedUploadHandler;
  private reconnectHandler?: () => Promise<void>;

  constructor(options: FakeSourceTransportOptions = {}) {
    const kind = options.kind ?? options.initialSnapshot?.kind ?? "localhost";
    const initialSnapshot = options.initialSnapshot ?? {
      kind,
      state: "ready",
      channels: [],
    };
    if (initialSnapshot.kind !== kind) {
      throw new Error("FakeSourceTransport kind must match initial snapshot.");
    }

    this.kind = kind;
    this.capabilities = options.capabilities ?? defaultCapabilities(kind);
    this.mutableStatus = new FakeSourceTransportStatus(initialSnapshot);
    this.status = this.mutableStatus;
    this.fetchHandler = options.fetch;
    this.fetchBlobHandler = options.fetchBlob;
    this.fetchResponseHandler = options.fetchResponse;
    this.uploadHandler = options.upload;
    this.stagedUploadHandler = options.uploadStagedAttachment;
    this.reconnectHandler = options.reconnect;
  }

  setFetchHandler(handler: FakeFetchHandler | undefined): void {
    this.fetchHandler = handler;
  }

  setFetchBlobHandler(handler: FakeFetchBlobHandler | undefined): void {
    this.fetchBlobHandler = handler;
  }

  setUploadHandler(handler: FakeUploadHandler | undefined): void {
    this.uploadHandler = handler;
  }

  setStagedUploadHandler(handler: FakeStagedUploadHandler | undefined): void {
    this.stagedUploadHandler = handler;
  }

  setReconnectHandler(handler: (() => Promise<void>) | undefined): void {
    this.reconnectHandler = handler;
  }

  setStatus(snapshot: SourceTransportStatusSnapshot): void {
    this.assertNotDisposed();
    this.mutableStatus.setSnapshot(snapshot);
  }

  setState(state: SourceTransportState): void {
    this.assertNotDisposed();
    this.mutableStatus.setState(state);
  }

  setChannels(channels: readonly SourceTransportChannelSnapshot[]): void {
    this.assertNotDisposed();
    this.mutableStatus.setChannels(channels);
  }

  upsertChannel(channel: SourceTransportChannelSnapshot): void {
    this.assertNotDisposed();
    this.mutableStatus.upsertChannel(channel);
  }

  removeChannel(name: SourceTransportChannelName): void {
    this.assertNotDisposed();
    this.mutableStatus.removeChannel(name);
  }

  emitVisibilityRestored(): void {
    this.assertNotDisposed();
    this.mutableStatus.emitVisibilityRestored();
  }

  async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    this.assertReady("fetch");
    if (!this.fetchHandler) {
      throw new SourceTransportUnsupportedError({
        kind: this.kind,
        operation: "fetch",
      });
    }
    return this.fetchHandler<T>(path, init);
  }

  async fetchBlob(path: string): Promise<Blob> {
    this.assertReady("fetchBlob");
    if (!this.fetchBlobHandler) {
      throw new SourceTransportUnsupportedError({
        kind: this.kind,
        operation: "fetchBlob",
      });
    }
    return this.fetchBlobHandler(path);
  }

  async fetchResponse(path: string, init?: RequestInit): Promise<Response> {
    this.assertReady("fetchResponse");
    if (!this.fetchResponseHandler) {
      throw new SourceTransportUnsupportedError({
        kind: this.kind,
        operation: "fetchResponse",
      });
    }
    return this.fetchResponseHandler(path, init);
  }

  async upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile> {
    this.assertReady("upload");
    if (!this.uploadHandler) {
      throw new SourceTransportUnsupportedError({
        kind: this.kind,
        operation: "upload",
      });
    }
    return this.uploadHandler(projectId, sessionId, file, options);
  }

  async uploadStagedAttachment(
    file: File,
    options?: UploadOptions & { batchId?: string },
  ): Promise<StagedAttachmentRef> {
    this.assertReady("uploadStagedAttachment");
    if (!this.stagedUploadHandler) {
      throw new SourceTransportUnsupportedError({
        kind: this.kind,
        operation: "uploadStagedAttachment",
      });
    }
    return this.stagedUploadHandler(file, options);
  }

  subscribeSession(
    sessionId: string,
    handlers: StreamHandlers,
    lastEventId?: string,
    options?: SessionSubscriptionOptions,
  ): Subscription {
    return this.createSubscription("session", handlers, {
      sessionId,
      lastEventId,
      options,
    });
  }

  subscribeSessionWatch(
    sessionId: string,
    handlers: StreamHandlers,
    options?: SessionWatchSubscriptionOptions,
  ): Subscription {
    return this.createSubscription("session-watch", handlers, {
      sessionId,
      options,
    });
  }

  subscribeActivity(handlers: StreamHandlers): Subscription {
    return this.createSubscription("activity", handlers, {});
  }

  subscribeGlossary(projectId: string, handlers: StreamHandlers): Subscription {
    return this.createSubscription("glossary", handlers, { projectId });
  }

  subscribeWorktree(
    projectId: string,
    coverage: GitWorktreeCoverage,
    handlers: StreamHandlers,
  ): Subscription {
    return this.createSubscription("worktree", handlers, {
      projectId,
      coverage,
    });
  }

  async reconnect(): Promise<void> {
    this.assertNotDisposed();
    await this.reconnectHandler?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new SourceTransportDisposedError(this.kind);
    for (const record of this.subscriptions.values()) {
      this.closeRecord(record, error);
    }
  }

  getSubscriptions(
    kind?: FakeSourceTransportSubscriptionKind,
  ): FakeSourceTransportSubscriptionRecord[] {
    const records = [...this.subscriptions.values()];
    return records
      .filter((record) => kind === undefined || record.kind === kind)
      .map(publicSubscriptionRecord);
  }

  openSubscription(id: string): void {
    const record = this.requireSubscription(id);
    if (!record.closed) {
      record.handlers.onOpen?.();
    }
  }

  emitSubscriptionEvent(
    id: string,
    eventType: string,
    data: unknown,
    eventId?: string,
    options?: FakeSourceTransportCallbackOptions,
  ): void {
    const record = this.requireSubscription(id);
    if (!record.closed || options?.allowClosed) {
      record.handlers.onEvent(eventType, eventId, data);
    }
  }

  failSubscription(
    id: string,
    error: Error,
    options?: FakeSourceTransportCallbackOptions,
  ): void {
    const record = this.requireSubscription(id);
    if (!record.closed || options?.allowClosed) {
      record.handlers.onError?.(error);
    }
  }

  closeSubscription(
    id: string,
    error?: Error,
    options?: FakeSourceTransportCallbackOptions,
  ): void {
    const record = this.requireSubscription(id);
    if (options?.allowClosed && record.closed) {
      record.handlers.onClose?.(error);
      return;
    }
    this.closeRecord(record, error);
  }

  private createSubscription(
    kind: FakeSourceTransportSubscriptionKind,
    handlers: StreamHandlers,
    details: {
      sessionId?: string;
      projectId?: string;
      coverage?: GitWorktreeCoverage;
      lastEventId?: string;
      options?: SessionSubscriptionOptions | SessionWatchSubscriptionOptions;
    },
  ): Subscription {
    this.assertNotDisposed();
    const id = `fake-subscription-${this.nextSubscriptionId++}`;
    const record: MutableFakeSubscriptionRecord = {
      id,
      kind,
      handlers,
      sessionId: details.sessionId,
      projectId: details.projectId,
      coverage: details.coverage,
      lastEventId: details.lastEventId,
      options: details.options,
      closed: false,
      closeCalls: 0,
    };
    this.subscriptions.set(id, record);

    const snapshot = this.status.getSnapshot();
    if (snapshot.state !== "ready") {
      void Promise.resolve().then(() => {
        const current = this.subscriptions.get(id);
        if (!current || current.closed) return;
        current.handlers.onError?.(
          new SourceTransportNotReadyError({
            kind: this.kind,
            state: snapshot.state,
          }),
        );
      });
    }

    return {
      close: () => {
        const current = this.subscriptions.get(id);
        if (!current) return;
        current.closeCalls += 1;
        this.closeRecord(current);
      },
    };
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new SourceTransportDisposedError(this.kind);
    }
  }

  private assertReady(operation: string): void {
    this.assertNotDisposed();
    const snapshot = this.status.getSnapshot();
    if (snapshot.state !== "ready") {
      throw new SourceTransportNotReadyError({
        kind: this.kind,
        state: snapshot.state,
        message: `Cannot ${operation}: source transport is ${snapshot.state}`,
      });
    }
  }

  private requireSubscription(id: string): MutableFakeSubscriptionRecord {
    const record = this.subscriptions.get(id);
    if (!record) {
      throw new Error(`Unknown fake source transport subscription: ${id}`);
    }
    return record;
  }

  private closeRecord(
    record: MutableFakeSubscriptionRecord,
    error?: Error,
  ): void {
    if (record.closed) return;
    record.closed = true;
    record.handlers.onClose?.(error);
  }
}

function publicSubscriptionRecord(
  record: MutableFakeSubscriptionRecord,
): FakeSourceTransportSubscriptionRecord {
  return {
    id: record.id,
    kind: record.kind,
    sessionId: record.sessionId,
    projectId: record.projectId,
    coverage: record.coverage,
    lastEventId: record.lastEventId,
    options: record.options,
    closed: record.closed,
    closeCalls: record.closeCalls,
  };
}
