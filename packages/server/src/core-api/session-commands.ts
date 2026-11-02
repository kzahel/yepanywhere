import { followReceipt, type ReceiptFollowQuery } from "./receipt-follow.js";
import type { ApiProject, ApiLaunchContext, ApiSession } from "./contracts.js";
import type {
  ApiReceipt,
  CreateSessionRequest,
  SendMessageRequest,
  ApiCreator,
} from "./command-contracts.js";
import type { ApiReceiptStore } from "./receipt-store.js";
import { CoreApiError } from "./errors.js";

export interface SessionCommandOwner {
  recover?(
    receipt: ApiReceipt,
    consumed?: () => void,
    ended?: () => void,
  ): Promise<{ sessionId: string; consumed?: boolean } | undefined>;
  canSend?(sessionId: string): boolean;
  send?(
    sessionId: string,
    request: SendMessageRequest,
    receipt: ApiReceipt,
    consumed: () => void,
    ended: () => void,
  ): { accepted: boolean };
  close?(): void;
  start(
    project: ApiProject,
    request: CreateSessionRequest,
    receipt: ApiReceipt,
    settled: (sessionId: string) => void,
    failed: () => void,
    consumed?: () => void,
    admitted?: (sessionId: string) => void,
    authorize?: () => Promise<void>,
  ): Promise<{ sessionId: string } | { queueId: string } | { rejected: true }>;
}
/** Native launch admission plus durable retry identity; no HTTP or workflow policy. */
export class SessionCommands {
  private active = new Set<Promise<void>>();
  private disposed = false;
  private readonly closing = new AbortController();
  constructor(
    readonly serverId: string,
    readonly store: ApiReceiptStore,
    private readonly owner: SessionCommandOwner,
    readonly enabled: () => boolean,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    store.recoverInterrupted();
  }
  creator(launch?: ApiLaunchContext, authenticated?: ApiCreator): ApiCreator {
    if (authenticated) return authenticated;
    return {
      serverId: this.serverId,
      sessionId: launch?.id ?? null,
      launchId: launch?.launchId ?? null,
      principal: { kind: "superuser" },
    };
  }
  replayCreate(
    request: CreateSessionRequest,
    launch?: ApiLaunchContext,
    authenticated?: ApiCreator,
    checkPayload = true,
  ) {
    return this.store.lookup(
      {
        requestId: request.requestId,
        kind: "createSession",
        projectId: request.projectId,
        sessionId: null,
        creator: this.creator(launch, authenticated),
        payload: request,
      },
      checkPayload,
    );
  }
  create(
    project: ApiProject,
    request: CreateSessionRequest,
    launch?: ApiLaunchContext,
    authenticated?: ApiCreator,
    authorize?: () => Promise<void>,
  ) {
    if (!this.enabled())
      throw new CoreApiError(
        "forbidden",
        "Session command enablement was revoked before admission",
        403,
      );
    if (this.disposed)
      throw new CoreApiError(
        "controller_unavailable",
        "Session command owner is closing",
        503,
      );
    // Replays remain possible at capacity: inspect durable identity first.
    const reserved = this.store.reserve({
      requestId: request.requestId,
      kind: "createSession",
      projectId: project.id,
      sessionId: null,
      creator: this.creator(launch, authenticated),
      destinationServerId: this.serverId,
      payload: request,
    });
    if (!reserved.created) return reserved.receipt;
    if (this.active.size >= 16) {
      return this.store.update(reserved.receipt.id, {
        state: "failed",
        failure: {
          code: "command_capacity",
          message:
            "Native launch admission is busy; this request was not dispatched",
        },
      })!;
    }
    const receipt = reserved.receipt;
    const settled = (sessionId: string) => {
      if (this.disposed) return;
      this.store.update(receipt.id, { state: "accepted", sessionId });
    };
    const failed = () => {
      if (this.disposed) return;
      const current = this.store.get(receipt.id);
      if (current?.state === "accepted" && current.sessionId) {
        this.ended(receipt.id);
        return;
      }
      if (this.store.get(receipt.id)?.delivery !== "consumed")
        this.store.update(receipt.id, {
          state: "uncertain",
          delivery: "uncertain",
          failure: {
            code: "launch_uncertain",
            message:
              "Native launch did not establish a durable outcome; inspect existing work before any intentional retry",
          },
        });
    };
    const work = Promise.resolve()
      .then(() =>
        this.disposed
          ? { rejected: true as const }
          : this.owner.start(
              project,
              request,
              receipt,
              settled,
              failed,
              () => this.consumed(receipt.id),
              (sessionId) => {
                if (!this.disposed)
                  this.store.update(receipt.id, { sessionId });
              },
              async () => {
                if (this.disposed || !this.enabled())
                  throw new CoreApiError(
                    "forbidden",
                    "Native creation authority is no longer active",
                    403,
                  );
                await authorize?.();
              },
            ),
      )
      .then((result) => {
        if (this.disposed) return;
        if ("sessionId" in result) settled(result.sessionId);
        else if ("queueId" in result) {
          const current = this.store.get(receipt.id);
          if (current?.state === "dispatching")
            this.store.update(receipt.id, {
              state: "queued",
              queueId: result.queueId,
            });
        } else
          this.store.update(receipt.id, {
            state: "failed",
            failure: {
              code: "admission_rejected",
              message: "Native admission rejected this request before dispatch",
            },
          });
      }, failed)
      .catch((error) => {
        this.onError(error);
      })
      .finally(() => this.active.delete(work));
    this.active.add(work);
    return receipt;
  }
  private consumed(id: string) {
    if (this.disposed) return;
    try {
      this.store.update(id, {
        state: "accepted",
        delivery: "consumed",
        failure: undefined,
      });
    } catch (error) {
      this.onError(error);
    }
  }
  private ended(id: string) {
    if (this.disposed) return;
    try {
      const receipt = this.store.get(id);
      if (receipt && receipt.delivery !== "consumed")
        this.store.update(id, {
          delivery: "uncertain",
          failure: {
            code: "delivery_uncertain",
            message:
              "The incumbent native process ended or input was removed without consumption evidence; this input is not automatically replayed",
          },
        });
    } catch (error) {
      this.onError(error);
    }
  }
  replaySend(
    sessionId: string,
    request: SendMessageRequest,
    launch?: ApiLaunchContext,
    authenticated?: ApiCreator,
    checkPayload = true,
  ) {
    return this.store.lookup(
      {
        requestId: request.requestId,
        kind: "sendMessage",
        projectId: "",
        sessionId,
        creator: this.creator(launch, authenticated),
        payload: request,
      },
      checkPayload,
    );
  }
  send(
    session: ApiSession,
    request: SendMessageRequest,
    launch?: ApiLaunchContext,
    authenticated?: ApiCreator,
  ) {
    if (this.disposed)
      throw new CoreApiError(
        "controller_unavailable",
        "Session command owner is closing",
        503,
      );
    if (!this.enabled())
      throw new CoreApiError(
        "forbidden",
        "Session command enablement was revoked before admission",
        403,
      );
    const replay = this.replaySend(session.id, request, launch, authenticated);
    if (replay) return replay;
    if (!this.owner.canSend?.(session.id) || !this.owner.send)
      throw new CoreApiError(
        "session_not_running",
        "Only the incumbent active native owner can receive input; automatic resume is not supported",
        409,
      );
    const { created, receipt } = this.store.reserve({
      requestId: request.requestId,
      kind: "sendMessage",
      projectId: session.projectId,
      sessionId: session.id,
      creator: this.creator(launch, authenticated),
      destinationServerId: this.serverId,
      payload: request,
    });
    if (!created) return receipt;
    try {
      const result = this.owner.send(
        session.id,
        request,
        receipt,
        () => this.consumed(receipt.id),
        () => this.ended(receipt.id),
      );
      this.store.update(
        receipt.id,
        result.accepted
          ? { state: "accepted" }
          : {
              state: "failed",
              failure: {
                code: "input_rejected",
                message:
                  "The native owner rejected input before queue admission",
              },
            },
      );
    } catch (error) {
      this.onError(error);
      if (this.store.get(receipt.id)?.delivery !== "consumed")
        this.store.update(receipt.id, {
          state: "uncertain",
          delivery: "uncertain",
          failure: {
            code: "input_uncertain",
            message:
              "Input admission did not establish a durable outcome; do not automatically resend",
          },
        });
    }
    return this.store.get(receipt.id)!;
  }
  async follow(id: string, query: ReceiptFollowQuery, signal?: AbortSignal) {
    // Reattach positive incumbent-owner evidence after controller replacement.
    await this.receipt(id);
    return followReceipt(
      this.store,
      id,
      query,
      AbortSignal.any([this.closing.signal, ...(signal ? [signal] : [])]),
    );
  }
  async receipt(id: string) {
    const receipt = this.store.get(id);
    if (
      !receipt ||
      this.disposed ||
      (receipt.state !== "uncertain" &&
        receipt.delivery !== "uncertain" &&
        receipt.delivery !== "unknown")
    )
      return receipt;
    const evidence = await this.owner.recover?.(
      receipt,
      () => this.consumed(id),
      () => this.ended(id),
    );
    if (evidence && !this.disposed)
      return this.store.update(id, {
        state: "accepted",
        sessionId: evidence.sessionId,
        failure: undefined,
        ...(evidence.consumed ? { delivery: "consumed" as const } : {}),
      });
    return receipt;
  }
  /** Shutdown fences stale async completions; it never repeats an external launch. */
  close() {
    this.disposed = true;
    this.closing.abort();
    this.owner.close?.();
  }
  async idle() {
    await Promise.allSettled(this.active);
  }
}
