import { HttpError } from "../middleware/error-handler.js";
import { textCreationSubmissionHash } from "../sessions/session-creation-acceptance.js";
import { createHash } from "node:crypto";
import type { SessionLaunchOptions } from "../supervisor/Supervisor.js";
import type {
  SessionCreationStore,
  SavedSessionCreation,
} from "../sessions/SessionCreationStore.js";
/**
 * The narrow session-launch seam the review submit endpoint needs (topic:
 * source-review-to-session). Segregated from the full Supervisor so the route
 * is testable with a small stub; the real implementation is thin glue over
 * `supervisor.startSession` / `getProcessForSession().queueMessage`.
 */

import type { ReviewNewSessionOptions } from "@yep-anywhere/shared";
import type { Supervisor } from "../supervisor/Supervisor.js";

export type ReviewLaunchResult =
  | { status: "started"; sessionId: string }
  | { status: "queued"; sessionId?: string }
  | { status: "queue-full"; maxQueueSize?: number };

/** Outcome of delivering a follow-up turn (possibly resuming a reaped session). */
export type ReviewFollowUpResult =
  | { status: "delivered" }
  | { status: "queued" }
  | { status: "queue-full"; maxQueueSize?: number };

export interface ReviewSessionLauncher {
  /** Start a fresh review session whose first turn is `text`. */
  startReviewSession(
    projectPath: string,
    text: string,
    options?: ReviewNewSessionOptions,
    submissionId?: string,
    creation?: NonNullable<SessionLaunchOptions["creation"]>,
  ): Promise<ReviewLaunchResult>;
  /**
   * Deliver `text` as a follow-up turn to `sessionId`. When the session has a
   * live process the turn is queued to it; when it has been reaped (no live
   * process — the common case for a review session idle for a while), it is
   * resumed from its jsonl and the turn delivered, rather than failing.
   */
  deliverFollowUp(
    projectPath: string,
    sessionId: string,
    text: string,
    submissionId?: string,
  ): Promise<ReviewFollowUpResult>;
}

export interface ReviewDeliveryAcceptance {
  deliveryStatus: "queued" | "delivered";
  targetSessionId?: string;
}

export function createSupervisorReviewLauncher(
  supervisor: Supervisor,
  onDeliveryAccepted?: (
    projectPath: string,
    submissionId: string,
    acceptance: ReviewDeliveryAcceptance,
  ) => void | Promise<void>,
  creations?: SessionCreationStore,
): ReviewSessionLauncher {
  const followUps = new Map<string, Promise<ReviewFollowUpResult>>();
  return {
    async startReviewSession(
      projectPath,
      text,
      options,
      submissionId,
      creation,
    ) {
      return start(projectPath, text, options, submissionId, creation);
    },

    async deliverFollowUp(projectPath, sessionId, text, submissionId) {
      if (submissionId) {
        const key = `${projectPath}\0${submissionId}`;
        const existing = followUps.get(key);
        if (existing) return existing;
        const pending = followUp(projectPath, sessionId, text, submissionId);
        followUps.set(key, pending);
        let result: ReviewFollowUpResult;
        try {
          result = await pending;
        } catch (error) {
          followUps.delete(key);
          throw error;
        }
        if (result.status === "queue-full") followUps.delete(key);
        trimOldest(followUps);
        return result;
      }
      return followUp(projectPath, sessionId, text);
    },
  };

  async function start(
    projectPath: string,
    text: string,
    options?: ReviewNewSessionOptions,
    submissionId?: string,
    suppliedCreation?: NonNullable<SessionLaunchOptions["creation"]>,
  ): Promise<ReviewLaunchResult> {
    // projectId derives from projectPath inside startSession.
    const modelSettings = options
      ? {
          providerName: options.provider,
          model: options.model,
          thinking: options.thinking,
          effort: options.effort,
        }
      : undefined;
    const creation = suppliedCreation ?? {
      context: {
        owner: { kind: "superuser" as const },
        source: {
          kind: "request" as const,
          provenance: { surface: "api" as const },
        },
      },
      authorize: async () => {},
    };
    const requestId =
      creation.requestId ??
      (submissionId
        ? `review-${createHash("sha256").update(projectPath).update("\0").update(submissionId).digest("hex")}`
        : undefined);
    const submissionHash = textCreationSubmissionHash(
      { text, options },
      projectPath,
    );
    let accepted: SavedSessionCreation | undefined;
    const associate = async (saved: SavedSessionCreation) => {
      accepted = saved;
      await creation.onAccepted?.(saved);
      if (submissionId)
        await onDeliveryAccepted?.(projectPath, submissionId, {
          deliveryStatus: "queued",
          targetSessionId: saved.sessionId,
        });
    };
    const prior = requestId
      ? creations?.get(creation.context.owner, requestId)
      : undefined;
    if (prior) {
      if (prior.deleted)
        throw new HttpError(410, "Review creation was deleted");
      if (prior.request?.submissionHash !== submissionHash)
        throw new HttpError(409, "Review creation conflicts with saved input");
      await creation.authorize(prior);
      await associate(prior);
      return prior.attempt.delivery === "consumed"
        ? { status: "started", sessionId: prior.sessionId }
        : { status: "queued", sessionId: prior.sessionId };
    }
    const launch = async (): Promise<ReviewLaunchResult> => {
      let result: Awaited<ReturnType<Supervisor["startSession"]>>;
      try {
        result = await supervisor.startSession(
          projectPath,
          reviewMessage(text, submissionId),
          undefined,
          modelSettings,
          {
            creation: {
              ...creation,
              requestId,
              submissionHash,
              onAccepted: associate,
            },
            creationProvenance:
              creation.context.source.kind === "request"
                ? creation.context.source.provenance
                : undefined,
            onStarted: (sessionId) =>
              submissionId
                ? onDeliveryAccepted?.(projectPath, submissionId, {
                    deliveryStatus: "delivered",
                    targetSessionId: sessionId,
                  })
                : undefined,
          },
        );
      } catch (error) {
        if (accepted && submissionId)
          return { status: "queued", sessionId: accepted.sessionId };
        throw error;
      }
      if ("error" in result) {
        return { status: "queue-full", maxQueueSize: result.maxQueueSize };
      }
      if ("queued" in result) {
        if (submissionId) {
          await onDeliveryAccepted?.(projectPath, submissionId, {
            deliveryStatus: "queued",
          });
        }
        return {
          status: "queued",
          ...(accepted ? { sessionId: accepted.sessionId } : {}),
        };
      }
      return { status: "started", sessionId: result.sessionId };
    };
    return launch();
  }

  async function followUp(
    projectPath: string,
    sessionId: string,
    text: string,
    submissionId?: string,
  ): Promise<ReviewFollowUpResult> {
    const process = supervisor.getProcessForSession(sessionId);
    if (process) {
      process.queueMessage(reviewMessage(text, submissionId));
      if (submissionId) {
        await onDeliveryAccepted?.(projectPath, submissionId, {
          deliveryStatus: "delivered",
          targetSessionId: sessionId,
        });
      }
      return { status: "delivered" };
    }
    // Reaped: resume the session from its jsonl and deliver the turn.
    const result = await supervisor.resumeSession(
      sessionId,
      projectPath,
      reviewMessage(text, submissionId),
    );
    if ("error" in result) {
      return { status: "queue-full", maxQueueSize: result.maxQueueSize };
    }
    if ("queued" in result) {
      if (submissionId) {
        await onDeliveryAccepted?.(projectPath, submissionId, {
          deliveryStatus: "queued",
          targetSessionId: sessionId,
        });
      }
      return { status: "queued" };
    }
    if (submissionId) {
      await onDeliveryAccepted?.(projectPath, submissionId, {
        deliveryStatus: "delivered",
        targetSessionId: sessionId,
      });
    }
    return { status: "delivered" };
  }
}

function reviewMessage(text: string, submissionId?: string) {
  if (!submissionId) return { text };
  return {
    text,
    tempId: `source-review-${submissionId}`,
    ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      submissionId,
    )
      ? { uuid: submissionId }
      : {}),
    metadata: { sourceReviewSubmissionId: submissionId },
  };
}

function trimOldest<T>(map: Map<string, Promise<T>>): void {
  if (map.size <= 2_000) return;
  const oldest = map.keys().next().value;
  if (oldest) map.delete(oldest);
}
