import { DEFAULT_PATIENT_QUEUE_PATIENCE_SECONDS } from "@yep-anywhere/shared";
import type {
  SessionQueuedMessageSummary,
  UserMessageMetadata,
} from "@yep-anywhere/shared";
import type { UserMessage } from "../sdk/types.js";
import type { Process } from "../supervisor/Process.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { SessionQueuePersistenceService } from "../services/SessionQueuePersistenceService.js";
import {
  deferSessionInput,
  prepareQueuedCompaction,
} from "../routes/session-input-admission.js";
import {
  sessionQueueSummaries,
  type SessionQueueSummaryDeps,
} from "../routes/session-queue-summaries.js";
import type {
  ApiReceipt,
  InputProgress,
  InputRequest,
} from "./command-contracts.js";
import type { ApiPendingInput } from "./input-contracts.js";
import { CoreApiError } from "./errors.js";
import type { ApiAttachment } from "./attachment-uploads.js";
import type { ProjectStoragePolicy } from "../projects/projectStoragePolicy.js";
import { MAX_CALLER_ATTACHMENT_BYTES } from "./attachment-contracts.js";
import { prepareInputAttachments } from "./input-attachments.js";

/** Receipt changes the input owner reports; SessionCommands applies them. */
export type InputReceiptPatch = Partial<
  Pick<ApiReceipt, "delivery" | "completion" | "failure">
> & { input?: Partial<InputProgress> };

export interface NativeSessionInputDeps extends SessionQueueSummaryDeps {
  supervisor: Pick<Supervisor, "getProcessForSession">;
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
  attachmentStoragePolicy?: ProjectStoragePolicy;
}

function inputMessage(request: InputRequest, receipt: ApiReceipt): UserMessage {
  const metadata: UserMessageMetadata = {
    deliveryIntent: request.delivery,
    ...(request.delivery === "patient"
      ? { patienceSeconds: DEFAULT_PATIENT_QUEUE_PATIENCE_SECONDS }
      : {}),
    apiSubmissionId: receipt.id,
    origin: "coordination",
    ...(receipt.creator.principal.kind !== "peer" && receipt.creator.sessionId
      ? { sourceSessionId: receipt.creator.sessionId }
      : {}),
    serverReceivedAt: receipt.createdAt,
  };
  return {
    text:
      request.type === "compact"
        ? `/compact${request.instructions ? ` ${request.instructions}` : ""}`
        : request.text,
    uuid: receipt.id,
    tempId: receipt.id,
    metadata,
  };
}

/**
 * Follows one input through YA's queue by its tempId. Removal is classified
 * by the queue event that removed it; anything ambiguous is reported as
 * uncertain rather than delivered.
 */
function observeQueuedInput(
  process: Process,
  tempId: string,
  type: InputRequest["type"],
  progress: (patch: InputReceiptPatch) => void,
  active: Set<() => void>,
) {
  let armed = false;
  let done = false;
  let compacting = false;
  let reported: string | undefined;
  const finish = () => {
    done = true;
    active.delete(finish);
    unsubscribe();
  };
  const report = (key: string, patch: InputReceiptPatch) => {
    if (reported === key) return;
    reported = key;
    progress(patch);
  };
  const evaluate = (
    reason: "queued" | "cancelled" | "promoted" | undefined,
    eventTempId: string | undefined,
  ) => {
    if (!armed || done) return;
    // Consumed input is settled; later queue changes belong to other input.
    if (type === "prompt" && process.hasConsumedApiInput(tempId)) {
      report("released", { input: { status: "released" } });
      finish();
      return;
    }
    const entry = process
      .getDeferredQueueSummary()
      .find((item) => item.tempId === tempId);
    if (entry) {
      const state = entry.compactionGate?.state;
      if (type === "compact" && state === "compacting") {
        compacting = true;
        report("compacting", { input: { compaction: "compacting" } });
      } else if (type === "compact" && state === "failed")
        report("failed", {
          completion: "failed",
          input: { compaction: "failed" },
          failure: {
            code: "compaction_failed",
            message:
              entry.compactionGate?.reason ??
              "Provider compaction failed; later input stays held until this compaction is cancelled",
          },
        });
      else if (type === "compact" && state === "unconfirmed")
        report("unconfirmed", {
          completion: "unconfirmed",
          input: { compaction: "unconfirmed" },
        });
      return;
    }
    // A queued event never removes input; absence then is a requeue in
    // progress (an interrupt drains, then queues entries one by one).
    if (reason === "queued") return;
    if (reason === "cancelled") {
      report("cancelled", {
        delivery: "cancelled",
        input: { status: "cancelled" },
      });
    } else if (
      reason === "promoted" &&
      type === "compact" &&
      compacting &&
      eventTempId === tempId
    ) {
      // Only a confirmed compaction removes its own entry as promoted;
      // drains name the first pending entry, never a dispatched compaction.
      report("released", {
        delivery: "consumed",
        completion: "compacted",
        input: { status: "released", compaction: "compacted" },
      });
    } else if (type === "prompt" && process.hasAcceptedApiInput(tempId)) {
      report("released", { input: { status: "released" } });
    } else if (reason === "promoted" && eventTempId === undefined) {
      // A grouped promotion or an interrupt drain that requeues: keep
      // watching. Requeued input reappears; delivered input reports
      // consumption, which marks it released.
      return;
    } else {
      // Preserved for restart, or handed to a replacement process.
      report("paused", {
        delivery: "uncertain",
        input: { status: "paused" },
        failure: {
          code: "input_paused",
          message:
            "Input left the live queue without delivery evidence, for example preserved across a restart; inspect inputs before any intentional resend",
        },
      });
    }
    finish();
  };
  const unsubscribe = process.subscribe((event) => {
    if (event.type === "deferred-queue" && !event.republished)
      evaluate(event.reason, event.tempId);
    else if (
      event.type === "terminated" ||
      event.type === "complete" ||
      (event.type === "state-change" && event.state.type === "terminated")
    ) {
      // Prompts learn owner loss from their consumption watch; a compaction
      // has none, so it reports here unless its outcome was already seen.
      if (type === "compact" && !done)
        report("ended", {
          delivery: "uncertain",
          failure: {
            code: "delivery_uncertain",
            message:
              "The provider process ended before this compaction's outcome was observed; it is not automatically retried",
          },
        });
      finish();
    }
  });
  const observer = {
    /** Start classifying queue changes; call just before admission mutates the queue. */
    arm() {
      armed = true;
    },
    /** After admission: input not in the queue was delivered directly. */
    settle() {
      if (done) return;
      const queued = process
        .getDeferredQueueSummary()
        .some((item) => item.tempId === tempId);
      if (!queued) {
        report("released", { input: { status: "released" } });
        finish();
      }
    },
    release: finish,
  };
  active.add(finish);
  return observer;
}

function inputStatus(
  summary: SessionQueuedMessageSummary,
): ApiPendingInput["status"] {
  const gate = summary.compactionGate?.state;
  if (gate === "compacting" || gate === "failed" || gate === "unconfirmed")
    return gate;
  return summary.status === "paused-after-restart" ? summary.status : "queued";
}

export interface InputAdmission {
  accepted: boolean;
  failure?: { code: string; message: string };
}
const revoked: InputAdmission = {
  accepted: false,
  failure: {
    code: "forbidden",
    message: "Input authority ended before queue admission; nothing was queued",
  },
};

const sessionEnded: InputAdmission = {
  accepted: false,
  failure: {
    code: "session_not_running",
    message: "The active session owner ended or changed before queue admission",
  },
};

export function nativeSessionInputs(deps: NativeSessionInputDeps) {
  const observers = new Set<() => void>();
  let preparingAttachments = 0;
  return {
    /** Command-owner shutdown releases every queue subscription. */
    close() {
      for (const release of [...observers]) release();
    },
    /** Refusals that need no receipt: provider/session cannot take this input. */
    async check(sessionId: string, request: InputRequest) {
      if (request.type !== "compact") return;
      const process = deps.supervisor.getProcessForSession(sessionId);
      if (!process || process.isTerminated) return;
      const probe: UserMessage = { text: "/compact", metadata: {} };
      const refusal = await prepareQueuedCompaction(process, probe, "");
      if (refusal)
        throw new CoreApiError(refusal.code, refusal.message, refusal.status);
    },

    async admit(
      process: Process,
      request: InputRequest,
      receipt: ApiReceipt,
      progress: (patch: InputReceiptPatch) => void,
      /** Rechecked immediately before the queue mutation, after any await. */
      admissible: () => boolean = () => true,
      attachments?: readonly ApiAttachment[],
    ): Promise<InputAdmission> {
      const refusal = () => {
        if (!admissible()) return revoked;
        if (
          attachments &&
          (deps.supervisor.getProcessForSession(process.sessionId) !==
            process ||
            process.isTerminated)
        )
          return sessionEnded;
      };
      const message = inputMessage(request, receipt);
      let prepared: Awaited<ReturnType<typeof prepareInputAttachments>>;
      if (attachments) {
        if (
          attachments.reduce((sum, file) => sum + file.size, 0) >
          MAX_CALLER_ATTACHMENT_BYTES
        )
          return {
            accepted: false,
            failure: {
              code: "invalid_request",
              message: "Prompt attachments exceed 128 MiB",
            },
          };
        if (!deps.attachmentStoragePolicy || preparingAttachments >= 8)
          return {
            accepted: false,
            failure: {
              code: "command_capacity",
              message: "Attachment preparation is unavailable or busy",
            },
          };
        const refused = refusal();
        if (refused) return refused;
        preparingAttachments++;
        try {
          prepared = await prepareInputAttachments(
            attachments,
            process.projectPath,
            process.sessionId,
            deps.attachmentStoragePolicy,
            () => !refusal(),
          );
        } catch {
          return {
            accepted: false,
            failure: {
              code: "attachment_unavailable",
              message: "Could not prepare all attachments; nothing was queued",
            },
          };
        } finally {
          preparingAttachments--;
        }
        if (!prepared) return refusal() ?? sessionEnded;
        message.attachments = prepared.attachments;
      }
      let mayHaveQueued = false;
      progress({
        input: {
          type: request.type,
          delivery: request.delivery,
          status: "queued",
          ...(request.type === "compact"
            ? { compaction: "pending" as const }
            : {}),
        },
      });
      const observer = observeQueuedInput(
        process,
        receipt.id,
        request.type,
        progress,
        observers,
      );
      try {
        if (request.type === "compact") {
          const compactionRefusal = await prepareQueuedCompaction(
            process,
            message,
            request.instructions ?? "",
          );
          if (compactionRefusal) {
            observer.release();
            return { accepted: false };
          }
        }
        if (request.delivery === "steer") {
          const refused = refusal();
          if (refused) {
            observer.release();
            return refused;
          }
          observer.arm();
          process.noteInputIntent();
          // Synchronous after the authority check, and never parsed as a
          // provider command: steer delivers exact text.
          mayHaveQueued = true;
          const result = process.queueMessage(message);
          if (!result.success) {
            mayHaveQueued = false;
            observer.release();
            return { accepted: false };
          }
          observer.settle();
          return { accepted: true };
        }
        process.noteInputIntent();
        let refused: InputAdmission | undefined;
        const result = await deferSessionInput(process, message, {
          beforeDefer: () => {
            refused = refusal();
            if (refused) return false;
            observer.arm();
            mayHaveQueued = true;
            return true;
          },
        });
        if (!result.success) {
          observer.release();
          mayHaveQueued = false;
          return refused ?? { accepted: false };
        }
        return { accepted: true };
      } catch (error) {
        observer.release();
        throw error;
      } finally {
        if (!mayHaveQueued) await prepared?.discard();
      }
    },

    list(
      sessionId: string,
      receiptFor: (id: string) => boolean,
      includeText: boolean,
    ): ApiPendingInput[] {
      const process = deps.supervisor.getProcessForSession(sessionId);
      return sessionQueueSummaries(deps, sessionId, process)
        .slice(0, 500)
        .map((summary) => {
          const id = summary.tempId ?? summary.id ?? "";
          const metadata = summary.metadata;
          const command = summary.kind === "ya-command";
          return {
            id,
            receiptId:
              !command && summary.tempId && receiptFor(summary.tempId)
                ? summary.tempId
                : null,
            type: command
              ? "command"
              : summary.operation === "compact"
                ? "compact"
                : "prompt",
            delivery: metadata?.deliveryIntent ?? null,
            status: inputStatus(summary),
            ...(summary.compactionGate?.reason
              ? { failure: summary.compactionGate.reason }
              : {}),
            cancellable: !command && summary.cancellable !== false && !!id,
            text: includeText ? summary.content : null,
            createdAt:
              metadata?.serverReceivedAt ??
              summary.createdAt ??
              summary.timestamp,
            creator: {
              origin: command ? "ya" : (metadata?.origin ?? "user"),
              ...(metadata?.sourceSessionId
                ? { sourceSessionId: metadata.sourceSessionId }
                : {}),
              ...(metadata?.sentByUser
                ? { sentByUser: metadata.sentByUser }
                : {}),
            },
          } satisfies ApiPendingInput;
        });
    },

    /**
     * Validates before any receipt exists and returns the cancellation to
     * run; a later loss of the input fails that receipt instead.
     */
    prepareCancel(sessionId: string, inputId: string) {
      const process = deps.supervisor.getProcessForSession(sessionId);
      const live = process && !process.isTerminated ? process : undefined;
      const entry = live
        ?.getDeferredQueueSummary()
        .find((item) => item.tempId === inputId || item.id === inputId);
      if (entry?.kind === "ya-command")
        throw new CoreApiError(
          "input_not_cancellable",
          "YA-owned queued commands are not cancelled through inputs",
          409,
        );
      if (entry && entry.cancellable === false)
        throw new CoreApiError(
          "input_not_cancellable",
          "This compaction has already been dispatched; wait for its outcome or stop the session",
          409,
        );
      const persisted = deps.sessionQueuePersistenceService
        ?.listSession(sessionId)
        .find(
          (item) =>
            item.kind === "patient" &&
            item.status === "paused-after-restart" &&
            (item.id === inputId ||
              (item.message.tempId ?? item.source?.tempId) === inputId),
        );
      const notPending = () =>
        new CoreApiError(
          "input_not_pending",
          "Input is not pending in YA's queue; it may have been delivered, consumed or cancelled already",
          409,
        );
      // Outside YA's queue only an unconsumed v0 steer can still be removed.
      const steer =
        !!live?.hasAcceptedApiInput(inputId) &&
        !live.hasConsumedApiInput(inputId);
      if (!entry && !persisted && !steer) throw notPending();
      return async () => {
        if (entry?.tempId && live) {
          if (!live.cancelDeferredMessage(entry.tempId)) throw notPending();
          await live.waitForPatientQueuePersistenceIdle();
          return { cancelled: true, inputId };
        }
        if (persisted) {
          await deps.sessionQueuePersistenceService!.deleteItem(persisted.id);
          return { cancelled: true, inputId };
        }
        if (steer && live?.cancelUnconfirmedSteerMessage(inputId))
          return { cancelled: true, inputId };
        throw notPending();
      };
    },
  };
}
