import type { Hono } from "hono";
import { SESSION_UNREAD_TIMESTAMP } from "@yep-anywhere/shared";
import type { SessionMetadataService } from "../metadata/index.js";
import { nonHumanUserTurnField } from "../metadata/SessionMetadataService.js";
import type { NotificationService } from "../notifications/index.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { EventBus } from "../watcher/index.js";
import { parseSessionMetadataPatch } from "./session-metadata-patch.js";

export interface SessionMetadataRoutesDeps {
  supervisor: Supervisor;
  notificationService?: NotificationService;
  sessionMetadataService?: SessionMetadataService;
  eventBus?: EventBus;
}

/**
 * Seen-state, last-seen, debug metadata, and metadata-update routes for the
 * sessions route factory. Registered in place so route order is unchanged.
 */
export function registerSessionMetadataRoutes(
  routes: Hono,
  deps: SessionMetadataRoutesDeps,
) {
  // POST /api/sessions/:sessionId/mark-seen - Mark session as seen (read)
  routes.post("/sessions/:sessionId/mark-seen", async (c) => {
    const sessionId = c.req.param("sessionId");

    if (!deps.notificationService) {
      return c.json({ error: "Notification service not available" }, 503);
    }

    let body: {
      timestamp?: string;
      messageId?: string;
      nonHumanUserTurnMessageId?: string;
    } = {};
    try {
      body = await c.req.json();
    } catch {
      // Body is optional
    }

    let acknowledged: boolean | undefined;
    if (body.nonHumanUserTurnMessageId !== undefined) {
      if (
        typeof body.nonHumanUserTurnMessageId !== "string" ||
        !body.nonHumanUserTurnMessageId
      ) {
        return c.json({ error: "Invalid non-human user turn id" }, 400);
      }
      if (!deps.sessionMetadataService) {
        return c.json({ error: "Session metadata service not available" }, 503);
      }
      acknowledged =
        await deps.sessionMetadataService.acknowledgeNonHumanUserTurn(
          sessionId,
          body.nonHumanUserTurnMessageId,
        );
      deps.eventBus?.emit({
        type: "session-metadata-changed",
        sessionId,
        nonHumanUserTurn: nonHumanUserTurnField(
          deps.sessionMetadataService,
          sessionId,
        ),
        timestamp: new Date().toISOString(),
      });
    }

    await deps.notificationService.markSeen(
      sessionId,
      body.timestamp,
      body.messageId,
    );

    // A stale or unknown delivered-turn id leaves the receipt pending; the
    // client needs that answer to report the failed acknowledgement.
    return c.json(
      acknowledged === undefined
        ? { marked: true }
        : { marked: true, acknowledged },
    );
  });

  // DELETE /api/sessions/:sessionId/mark-seen - Mark session as unread
  routes.delete("/sessions/:sessionId/mark-seen", async (c) => {
    const sessionId = c.req.param("sessionId");

    if (!deps.notificationService) {
      return c.json({ error: "Notification service not available" }, 503);
    }

    await deps.notificationService.clearSession(sessionId);

    // Emit event so other tabs/clients can update
    if (deps.eventBus) {
      deps.eventBus.emit({
        type: "session-seen",
        sessionId,
        timestamp: SESSION_UNREAD_TIMESTAMP,
      });
    }

    return c.json({ marked: false });
  });

  // GET /api/notifications/last-seen - Get all last seen entries
  routes.get("/notifications/last-seen", async (c) => {
    if (!deps.notificationService) {
      return c.json({ error: "Notification service not available" }, 503);
    }

    return c.json({ lastSeen: deps.notificationService.getAllLastSeen() });
  });

  // GET /api/debug/metadata - Debug endpoint to inspect metadata service state
  routes.get("/debug/metadata", (c) => {
    if (!deps.sessionMetadataService) {
      return c.json(
        { error: "Session metadata service not available", available: false },
        503,
      );
    }

    const allMetadata = deps.sessionMetadataService.getAllMetadata();
    const sessionCount = Object.keys(allMetadata).length;
    const starredCount = Object.values(allMetadata).filter(
      (m) => m.isStarred,
    ).length;
    const archivedCount = Object.values(allMetadata).filter(
      (m) => m.isArchived,
    ).length;
    const filePath = deps.sessionMetadataService.getFilePath();

    return c.json({
      available: true,
      filePath,
      sessionCount,
      starredCount,
      archivedCount,
    });
  });

  // PUT /api/sessions/:sessionId/metadata - Update session metadata
  routes.put("/sessions/:sessionId/metadata", async (c) => {
    const sessionId = c.req.param("sessionId");

    if (!deps.sessionMetadataService) {
      return c.json({ error: "Session metadata service not available" }, 503);
    }

    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = parseSessionMetadataPatch(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const { patch } = parsed;

    await deps.sessionMetadataService.updateMetadata(sessionId, patch);

    // Archive is a stop boundary, including for older clients that only know
    // the generic metadata route. Provider-owned background jobs can outlive a
    // graceful turn interrupt, so verify the whole owned process is gone.
    if (patch.archived === true) {
      await deps.supervisor.abortSessionWithVerification(sessionId);
    }

    // Emit SSE event so sidebar and other clients can update
    if (deps.eventBus) {
      deps.eventBus.emit({
        type: "session-metadata-changed",
        sessionId,
        title: patch.title,
        archived: patch.archived,
        starred: patch.starred,
        sidebarCategory: patch.sidebarCategory,
        parentSessionId: patch.parentSessionId,
        parentSessionKind:
          patch.parentSessionId === undefined
            ? undefined
            : patch.parentSessionId
              ? "btw-aside"
              : null,
        promptSuggestionMode: patch.promptSuggestionMode ?? undefined,
        recapAfterSeconds: patch.recapAfterSeconds ?? undefined,
        timestamp: new Date().toISOString(),
      });
    }

    return c.json({ updated: true });
  });
}
