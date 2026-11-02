import { principalFor } from "../auth/limitedLaunchPolicy.js";
import { creationProvenanceForHeaders } from "../sessions/creation-provenance.js";
/**
 * Source-review draft-comment CRUD (topic: source-review-to-session).
 *
 * The client leaves line comments that accumulate as server-owned drafts;
 * these routes are the create/read/update/delete surface over
 * {@link ReviewCommentService}. Preview and submit (stages P5) land here later
 * as sibling routes — kept out of the 1200-line git-status.ts by design.
 *
 * Mounted at `/api/projects`, so paths are `/:projectId/review/comments...`.
 */

import {
  ALL_PROVIDERS,
  MAX_REVIEW_COMMENT_TEXT_LENGTH,
  MAX_REVIEW_SUBMISSION_NAME_LENGTH,
  type EffortLevel,
  type ReviewCommentAnchor,
  type ReviewNewSessionOptions,
  type ThinkingConfig,
  parseReviewCommentAnchor,
  isReviewSubmissionId,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { ProjectScanner } from "../projects/scanner.js";
import { ReviewCommentService } from "../review/ReviewCommentService.js";
import {
  composeReviewTurn,
  composeSubmissionReviewTurn,
} from "../review/composeReviewTurn.js";
import {
  type AnchorRelocation,
  relocateAnchors,
} from "../review/relocateAnchors.js";
import { structuredErrorHandler } from "../middleware/error-handler.js";
import type { ReviewSessionLauncher } from "../review/reviewSessionLauncher.js";
import { repositoryRelativePath } from "../review/repositoryPath.js";
import { resolveProjectPath } from "./projectParam.js";

export interface ReviewCommentsDeps {
  signal?: AbortSignal;
  scanner: ProjectScanner;
  /** Injectable for tests (stub clock/id); a fresh service by default. */
  service?: ReviewCommentService;
  /** Launches/continues the review session on submit. Absent → submit 501s. */
  launcher?: ReviewSessionLauncher;
  /** Gates the version-2 capture/submission contract; default-off in app. */
  isSubmissionsEnabled?: () => boolean;
  /** Frozen onto each accepted delivery; defaults to the product value. */
  getResponseTurnLimit?: () => number;
}

export function createReviewCommentsRoutes(deps: ReviewCommentsDeps): Hono {
  const routes = new Hono();
  // When mounted, thrown errors (e.g. the service's HttpError 413 at the
  // draft cap) reach the root app's identical handler; this local install
  // covers direct requests against the unmounted sub-app, as in tests.
  routes.onError(structuredErrorHandler);
  const service = deps.service ?? new ReviewCommentService();

  // GET /:projectId/review/comments — full draft store (comments + batches).
  routes.get("/:projectId/review/comments", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;
    const file = await service.getFile(projectPath);
    const pendingCount = file.comments.filter(
      (comment) => comment.status === "pending",
    ).length;
    return c.json({ ...file, pendingCount });
  });

  // POST /:projectId/review/comments { anchor, text } — create a pending draft.
  routes.post("/:projectId/review/comments", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;

    const body = await readJsonBody(c);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);

    const anchor = parseReviewCommentAnchor(body.anchor);
    if (!anchor) return c.json({ error: "Invalid comment anchor" }, 400);
    if (!validateAnchorPaths(anchor)) {
      return c.json({ error: "Invalid comment anchor path" }, 400);
    }

    const textError = validateText(body.text, { required: true });
    if (textError) return c.json({ error: textError }, 400);

    const comment = await service.addComment(projectPath, {
      anchor: reviewAnchorForConfiguredWorkflow(anchor, deps),
      text: body.text as string,
    });
    return c.json({ comment }, 201);
  });

  // PATCH /:projectId/review/comments/:commentId { text?, anchor? }
  routes.patch("/:projectId/review/comments/:commentId", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;

    const body = await readJsonBody(c);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);

    const patch: {
      text?: string;
      anchor?: ReturnType<typeof parseReviewCommentAnchor>;
    } = {};
    if (body.text !== undefined) {
      const textError = validateText(body.text, { required: false });
      if (textError) return c.json({ error: textError }, 400);
      patch.text = body.text as string;
    }
    if (body.anchor !== undefined) {
      const anchor = parseReviewCommentAnchor(body.anchor);
      if (!anchor) return c.json({ error: "Invalid comment anchor" }, 400);
      if (!validateAnchorPaths(anchor)) {
        return c.json({ error: "Invalid comment anchor path" }, 400);
      }
      patch.anchor = reviewAnchorForConfiguredWorkflow(anchor, deps);
    }

    const comment = await service.updateComment(
      projectPath,
      c.req.param("commentId"),
      { text: patch.text, anchor: patch.anchor ?? undefined },
    );
    if (!comment) {
      return c.json({ error: "Pending comment not found" }, 404);
    }
    return c.json({ comment });
  });

  // DELETE /:projectId/review/comments/:commentId — discard a pending draft.
  routes.delete("/:projectId/review/comments/:commentId", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;
    const deleted = await service.deleteComment(
      projectPath,
      c.req.param("commentId"),
    );
    if (!deleted) {
      return c.json({ error: "Pending comment not found" }, 404);
    }
    return c.json({ ok: true });
  });

  // POST /:projectId/review/preview — relocate every pending anchor and return
  // per-comment relocated|gone, gone-first and pre-selected discard. A dry run
  // of submit; mutates nothing.
  routes.post("/:projectId/review/preview", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;
    const pending = await service.listPending(projectPath);
    const relocations = await relocateAnchors(
      projectPath,
      pending.map((comment) => comment.anchor),
    );
    const items = pending.map((comment, index) => {
      const relocation = relocations[index] as AnchorRelocation;
      return {
        comment,
        relocation,
        // Stale comments default to discard — usually too late to act on.
        defaultDiscard: relocation.status === "gone",
      };
    });
    // Gone comments first, so the discard-default block reads at the top.
    items.sort((a, b) => Number(b.defaultDiscard) - Number(a.defaultDiscard));
    return c.json({ items, pendingCount: pending.length });
  });

  // POST /:projectId/review/submit { include: string[], target: "new"|sessionId }
  // Re-relocate the included comments, compose the turn, launch/continue the
  // session, then archive the consumed batch against that session.
  routes.post("/:projectId/review/submit", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;
    if (!deps.launcher) {
      return c.json({ error: "Review submit is not available" }, 501);
    }

    const body = await readJsonBody(c);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);

    const include = parseStringArray(body.include);
    if (!include || include.length === 0) {
      return c.json({ error: "include must be a non-empty string array" }, 400);
    }
    const target = body.target;
    if (target !== "new" && typeof target !== "string") {
      return c.json({ error: "target must be 'new' or a session id" }, 400);
    }
    const newSession = parseNewSessionOptions(body.newSession);
    if (newSession === null) {
      return c.json({ error: "Invalid new-session settings" }, 400);
    }
    if (target !== "new" && body.newSession !== undefined) {
      return c.json(
        { error: "newSession options apply only to a new session" },
        400,
      );
    }

    const submissionsWorkflow =
      deps.isSubmissionsEnabled?.() === true && body.submissionId !== undefined;
    if (submissionsWorkflow && !isReviewSubmissionId(body.submissionId)) {
      return c.json({ error: "Invalid submissionId" }, 400);
    }
    const name = parseSubmissionName(body.name);
    if (name === null) {
      return c.json({ error: "Invalid submission name" }, 400);
    }
    if (!submissionsWorkflow && body.name !== undefined) {
      return c.json({ error: "name requires submissionId" }, 400);
    }

    if (submissionsWorkflow) {
      const submissionId = body.submissionId as string;
      const existing = (
        await service.getStoreFile(projectPath)
      ).submissions.find(
        (item) => item.id === submissionId && item.status === "accepted",
      );
      if (existing) return acceptedSubmissionResponse(c, existing);
    }

    const pending = await service.listPending(projectPath);
    const includeSet = new Set(include);
    const included = pending.filter((comment) => includeSet.has(comment.id));
    if (included.length === 0) {
      return c.json({ error: "No matching pending comments to submit" }, 400);
    }

    const relocations = await relocateAnchors(
      projectPath,
      included.map((comment) => comment.anchor),
    );
    const relocationMap = new Map<string, AnchorRelocation>();
    included.forEach((comment, index) => {
      relocationMap.set(comment.id, relocations[index] as AnchorRelocation);
    });

    const request = submissionsWorkflow
      ? await service.prepareSubmission(projectPath, {
          submissionId: body.submissionId as string,
          ...(name ? { name } : {}),
          commentIds: included.map((comment) => comment.id),
          requestedTarget: target,
          relocations: relocationMap,
        })
      : null;
    const turn = request
      ? composeSubmissionReviewTurn({
          request,
          submissionDirectoryRelPath:
            await service.existingSubmissionDirectoryFor(
              projectPath,
              request.submissionId,
            ),
          followUp: target !== "new",
        })
      : composeReviewTurn({
          comments: included,
          relocations: relocationMap,
          reviewFileRelPath: service.filePathFor(projectPath),
          followUp: target !== "new",
        });

    let sessionId: string;
    if (target === "new") {
      const principal = principalFor(c);
      if (principal.kind === "limited")
        return c.json({ error: "Review launch requires owner authority" }, 403);
      const result = await deps.launcher
        .startReviewSession(
          projectPath,
          turn,
          newSession,
          request?.submissionId,
          {
            context: {
              owner: { kind: "superuser" },
              source: {
                kind: "request",
                provenance: creationProvenanceForHeaders(c.req.raw.headers),
              },
            },
            authorize: async () => {
              if (deps.signal?.aborted)
                throw new Error("Review creation owner is shutting down");
            },
          },
        )
        .catch(async (error: unknown) => {
          if (request) {
            await service.releaseSubmission(projectPath, request.submissionId);
          }
          throw error;
        });
      if (result.status === "queue-full") {
        if (request) {
          await service.releaseSubmission(projectPath, request.submissionId);
        }
        return c.json(
          { error: "Queue is full", maxQueueSize: result.maxQueueSize },
          503,
        );
      }
      if (result.status === "queued") {
        if (request) {
          const accepted = await service.acceptSubmission(projectPath, {
            submissionId: request.submissionId,
            targetSessionId: result.sessionId,
            deliveryStatus: "queued",
            responseTurnLimit: deps.getResponseTurnLimit?.() ?? 8,
          });
          if (!accepted) {
            return c.json({ error: "Submission reservation was lost" }, 409);
          }
          return acceptedSubmissionResponse(c, accepted);
        }
        // Version-1 behavior: queued but no session id keeps drafts pending.
        return c.json({ status: "queued" }, 202);
      }
      sessionId = result.sessionId;
    } else {
      const result = await deps.launcher
        .deliverFollowUp(projectPath, target, turn, request?.submissionId)
        .catch(async (error: unknown) => {
          if (request) {
            await service.releaseSubmission(projectPath, request.submissionId);
          }
          throw error;
        });
      if (result.status === "queue-full") {
        if (request) {
          await service.releaseSubmission(projectPath, request.submissionId);
        }
        return c.json(
          { error: "Queue is full", maxQueueSize: result.maxQueueSize },
          503,
        );
      }
      if (result.status === "queued") {
        if (request) {
          const accepted = await service.acceptSubmission(projectPath, {
            submissionId: request.submissionId,
            targetSessionId: target,
            deliveryStatus: "queued",
            responseTurnLimit: deps.getResponseTurnLimit?.() ?? 8,
          });
          if (!accepted) {
            return c.json({ error: "Submission reservation was lost" }, 409);
          }
          return acceptedSubmissionResponse(c, accepted);
        }
        // Version-1 behavior keeps drafts pending until delivery.
        return c.json({ status: "queued" }, 202);
      }
      sessionId = target;
    }

    if (request) {
      const accepted = await service.acceptSubmission(projectPath, {
        submissionId: request.submissionId,
        targetSessionId: sessionId,
        deliveryStatus: "delivered",
        responseTurnLimit: deps.getResponseTurnLimit?.() ?? 8,
      });
      if (!accepted) {
        return c.json({ error: "Submission reservation was lost" }, 409);
      }
      return acceptedSubmissionResponse(c, accepted);
    }

    const batch = await service.archiveComments(projectPath, {
      commentIds: included.map((comment) => comment.id),
      targetSessionId: sessionId,
    });
    return c.json({ sessionId, batchId: batch.id, consumed: batch.commentIds });
  });

  return routes;
}

function parseSubmissionName(value: unknown): string | undefined | null {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_REVIEW_SUBMISSION_NAME_LENGTH) {
    return null;
  }
  return trimmed;
}

function acceptedSubmissionResponse(
  c: { json: (body: unknown, status?: 200 | 202) => Response },
  submission: {
    id: string;
    targetSessionId?: string;
    entryRefs: Array<{ entryId: string }>;
    deliveryStatus?: "queued" | "delivered";
  },
): Response {
  const body = {
    submissionId: submission.id,
    batchId: submission.id,
    consumed: submission.entryRefs.map((ref) => ref.entryId),
    ...(submission.targetSessionId
      ? { sessionId: submission.targetSessionId }
      : {}),
    ...(submission.deliveryStatus === "queued" ? { status: "queued" } : {}),
  };
  return submission.deliveryStatus === "queued"
    ? c.json(body, 202)
    : c.json(body, 200);
}

function reviewAnchorForConfiguredWorkflow(
  anchor: ReviewCommentAnchor,
  deps: ReviewCommentsDeps,
): ReviewCommentAnchor {
  if (deps.isSubmissionsEnabled?.() && anchor.projection) return anchor;
  const legacyAnchor = { ...anchor };
  delete legacyAnchor.projection;
  return legacyAnchor;
}

function parseNewSessionOptions(
  value: unknown,
): ReviewNewSessionOptions | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const options: ReviewNewSessionOptions = {};
  if (record.provider !== undefined) {
    if (
      typeof record.provider !== "string" ||
      !ALL_PROVIDERS.includes(
        record.provider as NonNullable<ReviewNewSessionOptions["provider"]>,
      )
    ) {
      return null;
    }
    options.provider = record.provider as NonNullable<
      ReviewNewSessionOptions["provider"]
    >;
  }
  if (record.model !== undefined) {
    if (
      typeof record.model !== "string" ||
      record.model.trim().length === 0 ||
      record.model.length > 200
    ) {
      return null;
    }
    options.model = record.model;
  }
  if (record.thinking !== undefined) {
    const thinking = parseThinkingConfig(record.thinking);
    if (!thinking) return null;
    options.thinking = thinking;
  }
  if (record.effort !== undefined) {
    if (
      typeof record.effort !== "string" ||
      !EFFORT_LEVELS.includes(record.effort as EffortLevel)
    ) {
      return null;
    }
    options.effort = record.effort as EffortLevel;
  }
  return options;
}

const EFFORT_LEVELS: readonly EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function parseThinkingConfig(value: unknown): ThinkingConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const display =
    record.display === undefined
      ? undefined
      : record.display === "summarized" || record.display === "omitted"
        ? record.display
        : null;
  if (display === null) return null;

  if (record.type === "disabled") {
    return record.display === undefined ? { type: "disabled" } : null;
  }
  if (record.type === "adaptive") {
    return {
      type: "adaptive",
      ...(display ? { display } : {}),
    };
  }
  if (record.type === "enabled") {
    if (
      record.budgetTokens !== undefined &&
      (typeof record.budgetTokens !== "number" ||
        !Number.isInteger(record.budgetTokens) ||
        record.budgetTokens <= 0)
    ) {
      return null;
    }
    return {
      type: "enabled",
      ...(typeof record.budgetTokens === "number"
        ? { budgetTokens: record.budgetTokens }
        : {}),
      ...(display ? { display } : {}),
    };
  }
  return null;
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

async function readJsonBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await c.req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Validate comment text; empty (after trim) is rejected only when required. */
function validateText(
  value: unknown,
  opts: { required: boolean },
): string | null {
  if (typeof value !== "string") return "Comment text must be a string";
  if (opts.required && value.trim().length === 0) {
    return "Comment text must not be empty";
  }
  if (value.length > MAX_REVIEW_COMMENT_TEXT_LENGTH) {
    return "Comment text is too long";
  }
  return null;
}

function validateAnchorPaths(anchor: {
  path: string;
  projection?: { path: string };
}): boolean {
  try {
    repositoryRelativePath(anchor.path);
    if (anchor.projection) repositoryRelativePath(anchor.projection.path);
    return true;
  } catch {
    return false;
  }
}
