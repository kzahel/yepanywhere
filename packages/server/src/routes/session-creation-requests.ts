import {
  ALL_PROVIDERS,
  type LimitedUserGrants,
  type SessionCreationProvenance,
} from "@yep-anywhere/shared";
import type { Context } from "hono";
import {
  principalFor,
  savedLimitedCreationError,
} from "../auth/limitedLaunchPolicy.js";
import { desktopControlOrigin } from "../desktop/machine-control.js";
import { getLogger } from "../logging/logger.js";
import type { SessionMetadataService } from "../metadata/index.js";
import { creationProvenanceForHeaders } from "../sessions/creation-provenance.js";
import {
  sessionCreationReceipt,
  sessionCreationSubmissionHash,
} from "../sessions/session-creation-acceptance.js";
import {
  SessionCreationConflict,
  type SavedSessionCreation,
} from "../sessions/SessionCreationStore.js";
import type { SessionLaunchOptions } from "../supervisor/Supervisor.js";
import type { StartSessionBody } from "./session-launch-request.js";

function requestCreationProvenance(
  c: Context,
  declared: unknown,
): SessionCreationProvenance {
  return creationProvenanceForHeaders(c.req.raw.headers, declared);
}

/** What the creation-request closures read from the sessions route deps. */
export interface SessionCreationRequestDeps {
  signal?: AbortSignal;
  getLimitedUserGrants?: (username: string) => LimitedUserGrants | null;
  sessionMetadataService?: SessionMetadataService;
}

/**
 * The durable session-creation closures: the creation context every
 * session-launching route records, and the two-phase acceptance the
 * session-creation routes run. Stateless; they read `deps` at call time.
 */
export function createSessionCreationRequests(
  deps: SessionCreationRequestDeps,
) {
  const creationForRequest = (
    c: Context,
    declared: unknown,
    lineage?: import("../sessions/SessionRelationshipWriter.js").CreationLineage,
  ): NonNullable<SessionLaunchOptions["creation"]> => {
    const principal = principalFor(c);
    const liveDesktopOrigin = desktopControlOrigin(c);
    const context = {
      owner:
        principal.kind === "limited"
          ? { kind: "limited" as const, username: principal.username }
          : { kind: "superuser" as const },
      source: {
        kind: "request" as const,
        provenance: requestCreationProvenance(c, declared),
      },
    };
    return {
      context,
      lineage,
      async authorize(saved) {
        if (deps.signal?.aborted)
          throw new Error("Session owner is shutting down");
        if (
          saved.context.owner.kind !== context.owner.kind ||
          (saved.context.owner.kind === "limited" &&
            (context.owner.kind !== "limited" ||
              saved.context.owner.username !== context.owner.username))
        )
          throw new Error("Creation owner changed");
        if (saved.context.owner.kind === "limited") {
          const refused = savedLimitedCreationError(
            saved,
            deps.getLimitedUserGrants?.(saved.context.owner.username) ?? null,
          );
          if (refused) throw new Error(refused);
        }
        return { desktopControlOrigin: liveDesktopOrigin };
      },
    };
  };
  const creationAcceptance = (
    c: Context,
    body: StartSessionBody,
    projectId: string,
  ) => {
    const context = creationForRequest(c, body.creationProvenance);
    if (
      typeof body.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId)
    )
      return c.json({ error: "Invalid creation request id" }, 400);
    const store = deps.sessionMetadataService?.creations;
    if (!store)
      return c.json({ error: "Durable session storage is unavailable" }, 503);
    const submissionHash = sessionCreationSubmissionHash(body, projectId);
    const existing = store.get(context.context.owner, body.requestId);
    if (existing) {
      if (existing.deleted)
        return c.json({ error: "Session creation was deleted" }, 410);
      if (existing.request?.submissionHash !== submissionHash)
        return c.json(
          { error: "Creation request conflicts with saved input" },
          409,
        );
      return c.json(sessionCreationReceipt(existing), 202);
    }
    if (
      (body.provider !== undefined && !ALL_PROVIDERS.includes(body.provider)) ||
      typeof body.message !== "string" ||
      (!body.message.trim() &&
        !body.stagedAttachments?.length &&
        body.intent !== "prepare") ||
      (body.intent !== undefined &&
        (body.intent !== "prepare" ||
          Boolean(body.message) ||
          Boolean(body.stagedAttachments?.length))) ||
      (body.stagedAttachments !== undefined &&
        (!Array.isArray(body.stagedAttachments) ||
          !body.stagedAttachments.length ||
          body.stagedAttachments.length > 64)) ||
      body.images !== undefined ||
      body.documents !== undefined ||
      body.attachments !== undefined ||
      body.executor
    )
      return c.json(
        {
          error:
            "This request is outside the supported session creation workflow",
          reason: "creation-not-accepted",
        },
        400,
      );
    let accepted = false;
    let resolve!: (saved: SavedSessionCreation) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<SavedSessionCreation>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return {
      promise,
      replay() {
        const saved = store.get(context.context.owner, body.requestId!);
        if (!saved) return undefined;
        if (saved.deleted)
          return c.json({ error: "Session creation was deleted" }, 410);
        if (saved.request?.submissionHash !== submissionHash)
          return c.json(
            { error: "Creation request conflicts with saved input" },
            409,
          );
        return c.json(sessionCreationReceipt(saved), 202);
      },
      creation: {
        ...context,
        intent: body.intent,
        requestId: body.requestId,
        attachments: body.stagedAttachments
          ? { owner: { type: "draft" as const }, refs: body.stagedAttachments }
          : undefined,
        submissionHash,
        onAccepted(saved: SavedSessionCreation) {
          accepted = true;
          resolve(saved);
        },
      },
      refused(error: unknown): Response {
        const saved = store.get(context.context.owner, body.requestId!);
        if (saved) {
          if (saved.deleted)
            return c.json({ error: "Session creation was deleted" }, 410);
          if (saved.request?.submissionHash !== submissionHash)
            return c.json(
              { error: "Creation request conflicts with saved input" },
              409,
            );
          return c.json(sessionCreationReceipt(saved), 202);
        }
        if (error instanceof SessionCreationConflict)
          return c.json(
            { error: "Creation request conflicts with preparing input" },
            409,
          );
        return c.json(
          {
            error:
              "Session creation was not accepted; your draft is preserved. Check the attachments or available capacity before retrying.",
            reason: "creation-not-accepted",
          },
          400,
        );
      },
      failed(error: unknown) {
        if (!accepted) {
          reject(error);
          return;
        }
        // The receipt already went out, so this log line and the saved
        // failure code are the only record of why startup failed.
        getLogger().warn(
          {
            event: "session_creation_failed",
            requestId: body.requestId,
            projectId,
            provider: body.provider,
            error: error instanceof Error ? error.message : String(error),
          },
          "Accepted session creation failed to start",
        );
      },
      finished() {
        if (!accepted) reject(new Error("Creation was not durably accepted"));
      },
    };
  };

  return { creationForRequest, creationAcceptance };
}
