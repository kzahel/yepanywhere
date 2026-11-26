import {
  encodeUploadChunkPayload,
  type GitWorktreeCoverage,
  type RemoteClientMessage,
  type UploadedFile,
  type StagedAttachmentRef,
  type YepMessage,
} from "@yep-anywhere/shared";
import { generateUUID } from "../uuid";
import { NativeResponseBodies } from "./nativeResponseBodies";
import { RelayProtocol } from "../connection/RelayProtocol";
import {
  NATIVE_RECOVERY_POLICY,
  RecoveryScheduler,
  observePageRecovery,
  realRecoveryClock,
} from "../connection/RecoveryScheduler";
import {
  ConnectionReconnectingError,
  type Connection,
} from "../connection/types";
import {
  NativeTransportBridge,
  NativeOperationError,
  type NativeTransportChannel,
} from "../nativeTransportBridge";
import {
  SourceTransportDisconnectedError,
  SourceTransportDisposedError,
  type SourceTransport,
  type SourceTransportStatusSnapshot,
  type StreamHandlers,
  type SessionSubscriptionOptions,
  type SessionWatchSubscriptionOptions,
  type UploadOptions,
} from "./types";

/** The native core alone owns SRP, encryption, reconnect and socket capabilities. */
export class NativeSourceTransport implements SourceTransport, Connection {
  readonly kind = "secure" as const;
  readonly mode = "secure" as const;
  readonly capabilities: {
    sameOriginUrls: boolean;
    packagedArtifactViewerVersion?: 1;
  } = { sameOriginUrls: false };
  readonly bridge: NativeTransportBridge;
  private readonly responseBodies: NativeResponseBodies;
  readonly ready: NativeTransportBridge["ready"];
  private readonly protocol: RelayProtocol;
  private readonly listeners = new Set<() => void>();
  private readonly uploads = new Map<
    string,
    {
      resolve: (file: unknown) => void;
      reject: (error: Error) => void;
      onProgress?: (bytes: number) => void;
    }
  >();
  private snapshot: SourceTransportStatusSnapshot = {
    kind: "secure",
    state: "connecting",
    channels: [{ name: "secure-websocket", state: "connecting" }],
  };
  private disposed = false;
  private phase = "CONNECTING";
  private bridgeClosed = false;
  private explicitRecovery = false;
  private wasReady = false;
  private queryingState: Promise<void> | null = null;
  private nativeStateRevision = 0;
  private leaseGeneration: number | undefined;
  private connectionEpoch: number | undefined;
  private recovery: Promise<void> | null = null;
  // Native owns its short retry cycle. After exhaustion, only visible demand
  // can request another cycle; no duplicate sockets or hidden polling.
  private readonly recoveryScheduler = new RecoveryScheduler(
    () => void this.reconnect().catch(() => {}),
    {
      clock: realRecoveryClock,
      isVisible: () => !document.hidden,
      policy: NATIVE_RECOVERY_POLICY,
    },
  );
  private removeRecoverySignals: () => void = () => {};
  onAuthenticationRequired: () => void = () => {};
  readonly status = {
    getSnapshot: () => this.snapshot,
    subscribe: (listener: () => void) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    },
  };

  constructor(channel: NativeTransportChannel) {
    this.bridge = new NativeTransportBridge(channel);
    this.responseBodies = new NativeResponseBodies(this.bridge);
    this.ready = this.bridge.ready.then((descriptor) => {
      if (descriptor.packagedArtifactViewerVersion === 1)
        this.capabilities.packagedArtifactViewerVersion = 1;
      return descriptor;
    });
    this.protocol = new RelayProtocol(
      {
        sendMessage: (message) => this.send(message),
        sendUploadChunk: async () => {
          throw new Error("Use the native upload operation");
        },
        ensureConnected: () => this.ensureReady(),
        isConnected: () => this.snapshot.state === "ready",
        cancelRequest: (id) => this.bridge.cancelRequest(id),
        cancelSubscription: (subscriptionId) =>
          this.send({ type: "unsubscribe", subscriptionId }),
      },
      { logPrefix: "[NativeSource]", debugEnabled: () => false },
    );
    this.bridge.onEvent = (message) => {
      if (message.type === "state") {
        this.observeNativeState(message);
        return;
      }
      if (message.type === "networkAvailable") {
        this.recoveryScheduler.signal();
        return;
      }
      if (message.type === "subscriptionError") {
        const id = String(message.subscriptionId);
        if (
          typeof message.errorCode === "string" ||
          !(Number(message.status) > 0)
        ) {
          void this.failSubscription(
            id,
            typeof message.errorCode === "string"
              ? new NativeOperationError(
                  message.errorCode,
                  String(message.error),
                )
              : new Error(String(message.error)),
          );
        } else {
          this.protocol.routeMessage({
            type: "response",
            id,
            status: Number(message.status),
            body: { error: message.error },
          });
        }
        return;
      }
      if (
        message.type === "upload_progress" ||
        message.type === "upload_complete" ||
        message.type === "upload_error"
      ) {
        const upload = this.uploads.get(String(message.uploadId));
        if (message.type === "upload_progress")
          upload?.onProgress?.(Number(message.bytesReceived));
        else if (message.type === "upload_complete")
          upload?.resolve(message.stagedRef ?? message.file);
        else upload?.reject(new Error(String(message.error)));
        return;
      }
      this.protocol.routeMessage(message as unknown as YepMessage);
    };
    this.bridge.onClose = (error) => {
      this.bridgeClosed = true;
      this.setPhase("FAILED");
      this.protocol.rejectAllPending(error);
      this.protocol.notifySubscriptionsClosed(error);
    };
    this.removeRecoverySignals = observePageRecovery(this.recoveryScheduler);
  }

  private observeNativeState(message: Record<string, unknown>): void {
    const generation =
      typeof message.leaseGeneration === "number"
        ? message.leaseGeneration
        : undefined;
    const epoch =
      typeof message.connectionEpoch === "number" && message.connectionEpoch > 0
        ? message.connectionEpoch
        : undefined;
    if (
      (generation !== undefined &&
        this.leaseGeneration !== undefined &&
        generation < this.leaseGeneration) ||
      (epoch !== undefined &&
        this.connectionEpoch !== undefined &&
        epoch < this.connectionEpoch)
    )
      return;
    const replaced =
      (generation !== undefined &&
        this.leaseGeneration !== undefined &&
        generation !== this.leaseGeneration) ||
      (epoch !== undefined &&
        this.connectionEpoch !== undefined &&
        epoch !== this.connectionEpoch);
    this.nativeStateRevision++;
    if (replaced && this.phase === "CONNECTED" && message.phase === "CONNECTED")
      this.setPhase("CONNECTING");
    if (generation !== undefined) this.leaseGeneration = generation;
    if (epoch !== undefined) this.connectionEpoch = epoch;
    let phase = String(message.phase);
    if (typeof message.recoverable === "boolean") this.explicitRecovery = true;
    if (phase === "FAILED" && typeof message.recoverable === "boolean")
      phase = message.recoverable ? "EXHAUSTED" : "TERMINAL_FAILED";
    // Native reachability is authoritative. WebView navigator.onLine describes
    // its browser network stack, not the authenticated native socket.
    this.setPhase(phase);
    if (phase === "SUSPENDED") {
      this.responseBodies.cancelAll(new ConnectionReconnectingError());
      this.bridge.rejectPending(new ConnectionReconnectingError());
    }
  }

  private refreshNativeState(): Promise<void> {
    if (this.queryingState) return this.queryingState;
    const revision = this.nativeStateRevision;
    const query = this.bridge
      .request<Record<string, unknown>>("status")
      .then((state) => {
        if (revision === this.nativeStateRevision && this.canRecover()) {
          if (
            ![
              "IDLE",
              "CONNECTING",
              "CONNECTED",
              "RETRYING",
              "FAILED",
              "REAUTHENTICATION_REQUIRED",
              "REVOKED",
            ].includes(String(state.phase))
          )
            throw new Error("Invalid native state response");
          this.observeNativeState(state);
        }
      })
      .catch(() => {
        if (revision === this.nativeStateRevision && this.canRecover())
          this.setPhase("EXHAUSTED");
      })
      .finally(() => {
        if (this.queryingState === query) this.queryingState = null;
      });
    this.queryingState = query;
    return query;
  }

  private canRecover(): boolean {
    return (
      !this.disposed &&
      !this.bridgeClosed &&
      !this.authenticationRequired &&
      this.phase !== "SUSPENDED" &&
      this.phase !== "TERMINAL_FAILED"
    );
  }

  private syncRecovery(): void {
    if (this.canRecover() && ["FAILED", "EXHAUSTED"].includes(this.phase))
      this.recoveryScheduler.arm();
    else this.recoveryScheduler.disarm();
  }

  private setPhase(phase: string): void {
    const changedPhase = phase !== this.phase;
    if (phase === "CONNECTED") this.wasReady = true;
    const state =
      phase === "CONNECTED"
        ? "ready"
        : ["CONNECTING", "IDLE", "SUSPENDED", "RETRYING", "EXHAUSTED"].includes(
              phase,
            )
          ? this.wasReady || ["RETRYING", "EXHAUSTED"].includes(phase)
            ? "reconnecting"
            : "connecting"
          : "disconnected";
    this.phase = phase;
    this.syncRecovery();
    const previous = this.snapshot.state;
    if (state === previous) {
      if (
        changedPhase &&
        ["REAUTHENTICATION_REQUIRED", "REVOKED"].includes(phase)
      )
        this.onAuthenticationRequired();
      return;
    }
    this.snapshot = {
      kind: "secure",
      state,
      channels: [
        {
          name: "secure-websocket",
          state: state === "ready" ? "connected" : state,
        },
      ],
    };
    if (previous === "ready" && state !== "ready") {
      const error = new ConnectionReconnectingError();
      this.responseBodies.cancelAll(error);
      this.protocol?.rejectAllPending(error);
      for (const upload of this.uploads.values()) upload.reject(error);
    }
    // Snapshot: callbacks may remove/re-add subscriptions during notification.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const listener of [...this.listeners]) listener();
    if (phase === "REAUTHENTICATION_REQUIRED" || phase === "REVOKED")
      this.onAuthenticationRequired();
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
    if (this.disposed) throw new SourceTransportDisposedError("secure");
    if (this.snapshot.state === "ready") return;
    if (this.phase === "SUSPENDED" && document.hidden)
      throw new ConnectionReconnectingError();
    this.recoveryScheduler.signal();
    if (this.snapshot.state === "disconnected")
      throw new SourceTransportDisconnectedError({ kind: "secure" });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        release();
        reject(new ConnectionReconnectingError());
      }, 15_000);
      const release = this.status.subscribe(() => {
        if (
          this.snapshot.state === "ready" ||
          this.snapshot.state === "disconnected"
        ) {
          clearTimeout(timeout);
          release();
          if (this.snapshot.state === "ready") resolve();
          else reject(new SourceTransportDisconnectedError({ kind: "secure" }));
        }
      });
    });
  }

  private send(message: RemoteClientMessage): void {
    if (this.disposed) throw new SourceTransportDisposedError("secure");
    switch (message.type) {
      case "request": {
        const revision = this.nativeStateRevision;
        void this.bridge
          .request<{
            status: number;
            headers: Record<string, string>;
            body: unknown;
          }>("request", message, undefined, message.id)
          .then(
            (result) =>
              this.protocol.routeMessage({
                type: "response",
                id: message.id,
                ...result,
              }),
            async (error: Error) => {
              const pending = this.protocol.pendingRequests.get(message.id);
              if (pending) {
                if (
                  error instanceof NativeOperationError &&
                  error.code === "CONNECTION_UNAVAILABLE"
                ) {
                  // The operation reply can beat native's state notification.
                  // Admit the safe-read retry only after native is ready again.
                  // An abandoned request cannot regress a newer ready state.
                  if (
                    revision === this.nativeStateRevision &&
                    this.phase === "CONNECTED" &&
                    this.canRecover()
                  ) {
                    if (this.bridge.descriptor?.stateQuery) {
                      await this.refreshNativeState();
                      if (
                        this.protocol.pendingRequests.get(message.id) !==
                        pending
                      )
                        return;
                    } else {
                      this.setPhase("RETRYING");
                      return; // Older shells notify readiness asynchronously.
                    }
                  }
                  error = new ConnectionReconnectingError();
                }
                clearTimeout(pending.timeout);
                this.protocol.pendingRequests.delete(message.id);
                pending.reject(error);
              }
            },
          );
        break;
      }
      case "subscribe": {
        const revision = this.nativeStateRevision;
        // Only source operations cross the bridge; web browser metadata is not native identity.
        void this.bridge
          .request("subscribe", {
            subscriptionId: message.subscriptionId,
            channel: message.channel,
            ...("sessionId" in message ? { sessionId: message.sessionId } : {}),
            ...("projectId" in message ? { projectId: message.projectId } : {}),
            ...("provider" in message ? { provider: message.provider } : {}),
            ...("lastEventId" in message
              ? { lastEventId: message.lastEventId }
              : {}),
            ...("wantsLiveDeltas" in message
              ? { wantsLiveDeltas: message.wantsLiveDeltas }
              : {}),
            // Native bridges do not forward this yet; the web client still
            // drops live tool output itself.
            ...("wantsLiveToolOutput" in message
              ? { wantsLiveToolOutput: message.wantsLiveToolOutput }
              : {}),
            ...("coverage" in message ? { coverage: message.coverage } : {}),
          })
          .catch((error: Error) => {
            void this.failSubscription(message.subscriptionId, error, revision);
          });
        break;
      }
      case "unsubscribe":
        void this.bridge
          .request("unsubscribe", { subscriptionId: message.subscriptionId })
          .catch(() => {});
        break;
      default:
        throw new Error("Unsupported native source operation");
    }
  }

  private async failSubscription(
    id: string,
    error: Error,
    revision = this.nativeStateRevision,
  ): Promise<void> {
    // Late setup errors cannot change a newer subscription or ready state.
    if (!this.protocol.subscriptions.has(id)) return;
    const unavailable =
      error instanceof NativeOperationError &&
      error.code === "CONNECTION_UNAVAILABLE";
    if (
      unavailable &&
      revision === this.nativeStateRevision &&
      this.phase === "CONNECTED" &&
      this.canRecover()
    ) {
      if (this.bridge.descriptor?.stateQuery) await this.refreshNativeState();
      else this.setPhase("RETRYING");
    }
    this.protocol.rejectSubscription(
      id,
      unavailable ? new ConnectionReconnectingError() : error,
    );
  }

  fetch<T>(path: string, init?: RequestInit): Promise<T> {
    return this.protocol.fetch<T>(path, init);
  }
  async fetchResponse(path: string, init?: RequestInit): Promise<Response> {
    await this.ready;
    if (
      this.bridge.descriptor?.responseStreams &&
      (init?.method ?? "GET") === "GET"
    ) {
      for (let attempt = 0; ; attempt++) {
        await this.ensureReady();
        const revision = this.nativeStateRevision;
        try {
          return await this.responseBodies.fetch(path, init);
        } catch (error) {
          if (
            attempt ||
            init?.signal?.aborted ||
            !(
              error instanceof ConnectionReconnectingError ||
              (error instanceof NativeOperationError &&
                error.code === "CONNECTION_UNAVAILABLE")
            )
          )
            throw error;
          if (
            revision === this.nativeStateRevision &&
            this.canRecover() &&
            this.bridge.descriptor?.stateQuery
          )
            await this.refreshNativeState();
        }
      }
    }
    return this.protocol.fetchResponse(path, init);
  }
  fetchStream(path: string, init?: RequestInit): Promise<Response> {
    return this.fetchResponse(path, init);
  }
  async fetchBlob(path: string): Promise<Blob> {
    await this.ready;
    if (this.bridge.descriptor?.responseStreams)
      return (await this.fetchStream(path)).blob();
    return this.protocol.fetchBlob(path);
  }
  subscribeSession(
    id: string,
    handlers: StreamHandlers,
    lastEventId?: string,
    options?: SessionSubscriptionOptions,
  ) {
    return this.protocol.subscribeSession(id, handlers, lastEventId, options);
  }
  subscribeSessionWatch(
    id: string,
    handlers: StreamHandlers,
    options?: SessionWatchSubscriptionOptions,
  ) {
    return this.protocol.subscribeSessionWatch(id, handlers, options);
  }
  subscribeActivity(handlers: StreamHandlers) {
    return this.protocol.subscribeActivity(handlers);
  }
  subscribeGlossary(id: string, handlers: StreamHandlers) {
    return this.protocol.subscribeGlossary(id, handlers);
  }
  subscribeWorktree(
    id: string,
    coverage: GitWorktreeCoverage,
    handlers: StreamHandlers,
  ) {
    return this.protocol.subscribeWorktree(id, coverage, handlers);
  }

  upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile> {
    return this.runUpload(
      file,
      { type: "upload_start", projectId, sessionId },
      options,
    );
  }
  uploadStagedAttachment(
    file: File,
    options?: UploadOptions & { batchId?: string },
  ): Promise<StagedAttachmentRef> {
    return this.runUpload(
      file,
      { type: "staged_upload_start", batchId: options?.batchId },
      options,
    );
  }
  private async runUpload<T>(
    file: File,
    params: Record<string, unknown>,
    options?: UploadOptions,
  ): Promise<T> {
    if (options?.signal?.aborted)
      throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    if (file.size > 100 * 1024 * 1024)
      throw new Error("Native upload exceeds 100 MiB");
    await this.ensureReady();
    if (this.uploads.size >= 4) throw new Error("Native upload limit exceeded");
    const uploadId = generateUUID();
    let rejectUpload!: (error: Error) => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const progress = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => rejectUpload(new Error("Native upload timed out")),
        120_000,
      );
    };
    let acknowledged = 0;
    const completion = new Promise<T>((resolve, reject) => {
      rejectUpload = reject;
      this.uploads.set(uploadId, {
        resolve: (value) => resolve(value as T),
        reject,
        onProgress: (bytes) => {
          // Only new server-acknowledged bytes renew the inactivity deadline.
          // Slow credited transfers can take longer than two minutes overall.
          if (
            Number.isSafeInteger(bytes) &&
            bytes > acknowledged &&
            bytes <= file.size
          ) {
            acknowledged = bytes;
            progress();
          }
          options?.onProgress?.(bytes);
        },
      });
    });
    const operation = new AbortController();
    const failed = new Promise<never>((_, reject) => {
      void completion.catch((error: Error) => {
        operation.abort(error);
        reject(error);
      });
    });
    // Stop producing immediately on cancellation, timeout or connection loss.
    void failed.catch(() => {});
    const interruptible = <R>(work: Promise<R>): Promise<R> =>
      Promise.race([work, failed]);
    const abort = () =>
      rejectUpload(
        options?.signal?.reason ?? new DOMException("Aborted", "AbortError"),
      );
    options?.signal?.addEventListener("abort", abort, { once: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    progress();
    try {
      if (options?.signal?.aborted)
        throw (
          options.signal.reason ?? new DOMException("Aborted", "AbortError")
        );
      await interruptible(
        this.bridge.request(
          "uploadStart",
          {
            ...params,
            uploadId,
            filename: file.name,
            size: file.size,
            mimeType: file.type || "application/octet-stream",
            width: options?.imageDimensions?.width,
            height: options?.imageDimensions?.height,
          },
          operation.signal,
        ),
      );
      reader = file.stream().getReader();
      let offset = 0;
      while (true) {
        if (options?.signal?.aborted)
          throw (
            options.signal.reason ?? new DOMException("Aborted", "AbortError")
          );
        const { done, value } = await interruptible(reader.read());
        if (done) break;
        // Include the 24-byte upload header in one credited bridge frame.
        for (let start = 0; start < value.length; start += 65_512) {
          if (options?.signal?.aborted)
            throw (
              options.signal.reason ?? new DOMException("Aborted", "AbortError")
            );
          const chunk = value.subarray(
            start,
            Math.min(start + 65_512, value.length),
          );
          await interruptible(
            this.bridge.send(
              2,
              encodeUploadChunkPayload(uploadId, offset, chunk),
            ),
          );
          offset += chunk.length;
        }
      }
      await interruptible(
        this.bridge.request("uploadEnd", { uploadId }, operation.signal),
      );
      return await completion;
    } catch (error) {
      void this.bridge.request("uploadCancel", { uploadId }).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", abort);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      this.uploads.delete(uploadId);
    }
  }
  reconnect(): Promise<void> {
    if (this.recovery) return this.recovery;
    if (!this.canRecover())
      return Promise.reject(
        new SourceTransportDisconnectedError({ kind: "secure" }),
      );
    this.recoveryScheduler.recordProbe();
    this.setPhase("RETRYING");
    const nativeStateRevision = this.nativeStateRevision;
    const recovery = this.bridge.request<void>("reconnect");
    this.recovery = recovery;
    void recovery
      .then(
        () => {
          if (
            this.nativeStateRevision === nativeStateRevision &&
            this.canRecover() &&
            this.phase === "RETRYING"
          )
            this.setPhase("CONNECTED");
        },
        () => {
          // State events can overtake an operation reply across resume. Native
          // observations supersede both success and failure of that old call.
          if (
            this.nativeStateRevision === nativeStateRevision &&
            this.canRecover()
          )
            this.setPhase(this.explicitRecovery ? "EXHAUSTED" : "FAILED");
        },
      )
      .finally(() => {
        if (this.recovery === recovery) this.recovery = null;
      });
    return recovery;
  }
  forceReconnect(): Promise<void> {
    return this.reconnect();
  }
  switchHost(): Promise<void> {
    return this.bridge.request("switchHost");
  }
  get authenticationRequired(): boolean {
    return (
      this.phase === "REAUTHENTICATION_REQUIRED" || this.phase === "REVOKED"
    );
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.recoveryScheduler.disarm();
    this.removeRecoverySignals();
    this.protocol.close();
    this.responseBodies.cancelAll(new SourceTransportDisposedError("secure"));
    this.bridge.close();
    this.listeners.clear();
    for (const upload of this.uploads.values())
      upload.reject(new SourceTransportDisposedError("secure"));
    this.uploads.clear();
  }
}
