import { isUrlProjectId } from "@claude-anywhere/shared";
import { Hono } from "hono";
import type { NotificationService } from "../notifications/index.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { SessionReader } from "../sessions/reader.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { PendingInputType, SessionSummary } from "../supervisor/types.js";

export interface ProjectsDeps {
  scanner: ProjectScanner;
  readerFactory: (sessionDir: string) => SessionReader;
  supervisor?: Supervisor;
  externalTracker?: ExternalSessionTracker;
  notificationService?: NotificationService;
}

interface ProjectActivityCounts {
  activeOwnedCount: number;
  activeExternalCount: number;
}

/**
 * Get activity counts for all projects.
 * All counts are keyed by UrlProjectId (base64url format).
 */
async function getProjectActivityCounts(
  supervisor: Supervisor | undefined,
  externalTracker: ExternalSessionTracker | undefined,
): Promise<Map<string, ProjectActivityCounts>> {
  const counts = new Map<string, ProjectActivityCounts>();

  // Count owned sessions from Supervisor (uses base64url projectId)
  if (supervisor) {
    for (const process of supervisor.getAllProcesses()) {
      const existing = counts.get(process.projectId) || {
        activeOwnedCount: 0,
        activeExternalCount: 0,
      };
      existing.activeOwnedCount++;
      counts.set(process.projectId, existing);
    }
  }

  // Count external sessions - convert to UrlProjectId for consistent keys
  if (externalTracker) {
    for (const sessionId of externalTracker.getExternalSessions()) {
      const info =
        await externalTracker.getExternalSessionInfoWithUrlId(sessionId);
      if (info) {
        const existing = counts.get(info.projectId) || {
          activeOwnedCount: 0,
          activeExternalCount: 0,
        };
        existing.activeExternalCount++;
        counts.set(info.projectId, existing);
      }
    }
  }

  return counts;
}

export function createProjectsRoutes(deps: ProjectsDeps): Hono {
  const routes = new Hono();

  // Helper to enrich sessions with real status and notification state
  function enrichSessions(sessions: SessionSummary[]): SessionSummary[] {
    return sessions.map((session) => {
      const process = deps.supervisor?.getProcessForSession(session.id);
      const isExternal = deps.externalTracker?.isExternal(session.id) ?? false;

      // Enrich with status
      const status = process
        ? {
            state: "owned" as const,
            processId: process.id,
            permissionMode: process.permissionMode,
            modeVersion: process.modeVersion,
          }
        : isExternal
          ? { state: "external" as const }
          : session.status;

      // Enrich with notification data
      let pendingInputType: PendingInputType | undefined;
      if (process) {
        const pendingRequest = process.getPendingInputRequest();
        if (pendingRequest) {
          pendingInputType =
            pendingRequest.type === "tool-approval"
              ? "tool-approval"
              : "user-question";
        }
      }

      // Get last seen and unread status
      const lastSeenEntry = deps.notificationService?.getLastSeen(session.id);
      const lastSeenAt = lastSeenEntry?.timestamp;
      const hasUnread = deps.notificationService
        ? deps.notificationService.hasUnread(session.id, session.updatedAt)
        : undefined;

      return {
        ...session,
        status,
        pendingInputType,
        lastSeenAt,
        hasUnread,
      };
    });
  }

  // GET /api/projects - List all projects
  routes.get("/", async (c) => {
    const rawProjects = await deps.scanner.listProjects();
    const activityCounts = await getProjectActivityCounts(
      deps.supervisor,
      deps.externalTracker,
    );

    // Enrich projects with active counts (all keyed by UrlProjectId now)
    const projects = rawProjects.map((project) => {
      const counts = activityCounts.get(project.id);
      return {
        ...project,
        activeOwnedCount: counts?.activeOwnedCount ?? 0,
        activeExternalCount: counts?.activeExternalCount ?? 0,
      };
    });

    // Sort by lastActivity descending (most recent first), nulls last
    projects.sort((a, b) => {
      if (!a.lastActivity && !b.lastActivity) return 0;
      if (!a.lastActivity) return 1;
      if (!b.lastActivity) return -1;
      return (
        new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
      );
    });

    return c.json({ projects });
  });

  // GET /api/projects/:projectId - Get project with sessions
  routes.get("/:projectId", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Get sessions for this project using the stored sessionDir
    const reader = deps.readerFactory(project.sessionDir);
    const sessions = await reader.listSessions(project.id);

    return c.json({ project, sessions: enrichSessions(sessions) });
  });

  // GET /api/projects/:projectId/sessions - List sessions
  routes.get("/:projectId/sessions", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const reader = deps.readerFactory(project.sessionDir);
    const sessions = await reader.listSessions(project.id);

    return c.json({ sessions: enrichSessions(sessions) });
  });

  return routes;
}
