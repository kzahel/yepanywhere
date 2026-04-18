import { homedir } from "node:os";
import { basename } from "node:path";
import { isUrlProjectId, toUrlProjectId } from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { SessionIndexService } from "../indexes/index.js";
import type {
  ProjectMetadataService,
  SessionMetadataService,
} from "../metadata/index.js";
import type { NotificationService } from "../notifications/index.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import { canonicalizeProjectPath, isAbsolutePath } from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { CodexSessionReader } from "../sessions/codex-reader.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import { listSessionsAcrossProviders } from "../sessions/provider-resolution.js";
import type { ISessionReader } from "../sessions/types.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type {
  AgentActivity,
  PendingInputType,
  Project,
  SessionSummary,
} from "../supervisor/types.js";
import { buildProviderProjectCatalog } from "./provider-catalog.js";

export interface ProjectsDeps {
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  supervisor?: Supervisor;
  externalTracker?: ExternalSessionTracker;
  notificationService?: NotificationService;
  sessionMetadataService?: SessionMetadataService;
  /** ProjectMetadataService for persisting added projects */
  projectMetadataService?: ProjectMetadataService;
  sessionIndexService?: SessionIndexService;
  /** Codex scanner for checking if a project has Codex sessions */
  codexScanner?: CodexSessionScanner;
  /** Codex sessions directory (defaults to ~/.codex/sessions) */
  codexSessionsDir?: string;
  /** Optional shared Codex reader factory for cross-provider session lookups */
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  /** Gemini scanner for checking if a project has Gemini sessions */
  geminiScanner?: GeminiSessionScanner;
  /** Gemini sessions directory (defaults to ~/.gemini/tmp) */
  geminiSessionsDir?: string;
  /** Optional shared Gemini reader factory for cross-provider session lookups */
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
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

  const buildHiddenProjects = () => {
    if (!deps.projectMetadataService) return [];

    return Object.entries(deps.projectMetadataService.getAllHiddenProjects())
      .map(([id, metadata]) => ({
        id,
        path: metadata.path,
        name: basename(metadata.path),
        hiddenAt: metadata.hiddenAt,
      }))
      .sort(
        (a, b) =>
          new Date(b.hiddenAt).getTime() - new Date(a.hiddenAt).getTime(),
      );
  };

  /**
   * Get owned sessions for a project that might not be in the file list yet.
   * New sessions may not have user/assistant messages written to disk yet.
   */
  function getOwnedSessionsForProject(
    projectId: string,
  ): Map<string, SessionSummary> {
    const ownedSessions = new Map<string, SessionSummary>();
    if (!deps.supervisor) return ownedSessions;

    for (const process of deps.supervisor.getAllProcesses()) {
      if (process.projectId === projectId) {
        const now = new Date().toISOString();
        ownedSessions.set(process.sessionId, {
          id: process.sessionId,
          projectId: process.projectId,
          title: null, // Title will be populated once file has content
          fullTitle: null,
          createdAt: process.startedAt.toISOString(),
          updatedAt: now,
          messageCount: 0,
          ownership: {
            owner: "self",
            processId: process.id,
            permissionMode: process.permissionMode,
            modeVersion: process.modeVersion,
          },
          provider: process.provider,
        });
      }
    }

    return ownedSessions;
  }

  /**
   * Add missing owned sessions to the session list.
   * Newly created sessions may not have user/assistant messages written yet,
   * but we should still show them in the list if we own the process.
   */
  function addMissingOwnedSessions(
    sessions: SessionSummary[],
    projectId: string,
  ): SessionSummary[] {
    const ownedSessions = getOwnedSessionsForProject(projectId);
    if (ownedSessions.size === 0) return sessions;

    // Check which owned sessions are already in the list
    const existingIds = new Set(sessions.map((s) => s.id));

    // Add missing owned sessions at the beginning (they're new)
    const missingSessions: SessionSummary[] = [];
    for (const [sessionId, summary] of ownedSessions) {
      if (!existingIds.has(sessionId)) {
        missingSessions.push(summary);
      }
    }

    return [...missingSessions, ...sessions];
  }

  // Helper to enrich sessions with real status, notification state, and metadata
  function enrichSessions(sessions: SessionSummary[]): SessionSummary[] {
    return sessions.map((session) => {
      const process = deps.supervisor?.getProcessForSession(session.id);
      const isExternal = deps.externalTracker?.isExternal(session.id) ?? false;

      // Enrich with ownership
      const ownership = process
        ? {
            owner: "self" as const,
            processId: process.id,
            permissionMode: process.permissionMode,
            modeVersion: process.modeVersion,
          }
        : isExternal
          ? { owner: "external" as const }
          : session.ownership;

      // Enrich with notification data and agent activity
      let pendingInputType: PendingInputType | undefined;
      let activity: AgentActivity | undefined;
      if (process) {
        const pendingRequest = process.getPendingInputRequest();
        if (pendingRequest) {
          pendingInputType =
            pendingRequest.type === "tool-approval"
              ? "tool-approval"
              : "user-question";
        }
        // Get the current agent activity (in-turn/waiting-input/idle)
        const state = process.state.type;
        if (state === "in-turn" || state === "waiting-input") {
          activity = state;
        }
      }

      // Get last seen and unread status
      const lastSeenEntry = deps.notificationService?.getLastSeen(session.id);
      const lastSeenAt = lastSeenEntry?.timestamp;
      const hasUnread = deps.notificationService
        ? deps.notificationService.hasUnread(session.id, session.updatedAt)
        : undefined;

      // Get session metadata (custom title, archived, starred)
      const metadata = deps.sessionMetadataService?.getMetadata(session.id);
      const customTitle = metadata?.customTitle;
      const isArchived = metadata?.isArchived;
      const isStarred = metadata?.isStarred;

      return {
        ...session,
        ownership,
        pendingInputType,
        activity,
        lastSeenAt,
        hasUnread,
        customTitle,
        isArchived,
        isStarred,
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

  // GET /api/projects/hidden - List hidden projects
  routes.get("/hidden", async (c) => {
    return c.json({ projects: buildHiddenProjects() });
  });

  // POST /api/projects/:projectId/restore - Restore a hidden project
  routes.post("/:projectId/restore", async (c) => {
    const projectId = c.req.param("projectId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    if (!deps.projectMetadataService) {
      return c.json({ error: "Project restoration is not supported" }, 501);
    }

    const restoredPath = await deps.projectMetadataService.restoreProject(
      projectId,
    );
    if (!restoredPath) {
      return c.json({ error: "Hidden project not found" }, 404);
    }

    deps.scanner.invalidateCache();
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project path no longer exists" }, 404);
    }

    return c.json({ restored: true, project });
  });

  // GET /api/projects/:projectId - Get project info
  routes.get("/:projectId", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Use getOrCreateProject to support new projects without sessions yet
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    return c.json({ project });
  });

  // POST /api/projects - Add a project by path
  // Validates the path exists on disk and returns project info
  routes.post("/", async (c) => {
    let body: { path: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.path || typeof body.path !== "string") {
      return c.json({ error: "path is required" }, 400);
    }

    // Normalize path (remove trailing slashes, expand ~)
    let normalizedPath = body.path.trim();
    if (normalizedPath.startsWith("~")) {
      normalizedPath = normalizedPath.replace("~", homedir());
    }
    // Remove trailing slash/backslash
    if (normalizedPath.length > 1 && /[/\\]$/.test(normalizedPath)) {
      normalizedPath = normalizedPath.slice(0, -1);
    }
    normalizedPath = canonicalizeProjectPath(normalizedPath);

    // Validate path is absolute
    if (!isAbsolutePath(normalizedPath)) {
      return c.json({ error: "Path must be absolute" }, 400);
    }

    // Create projectId and try to get/create the project
    const projectId = toUrlProjectId(normalizedPath);
    const project = await deps.scanner.getOrCreateProject(projectId);

    if (!project) {
      return c.json(
        { error: "Path does not exist or is not a directory" },
        404,
      );
    }

    // Persist the project so it appears in future listings
    if (deps.projectMetadataService) {
      await deps.projectMetadataService.addProject(projectId, normalizedPath);
      deps.scanner.invalidateCache();
    }

    return c.json({ project });
  });

  // DELETE /api/projects/:projectId - Hide a project from the visible list
  routes.delete("/:projectId", async (c) => {
    const projectId = c.req.param("projectId");

    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    if (!deps.projectMetadataService) {
      return c.json({ error: "Project removal is not supported" }, 501);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    await deps.projectMetadataService.hideProject(projectId, project.path);
    deps.scanner.invalidateCache();

    return c.json({ removed: true, projectId });
  });

  // GET /api/projects/:projectId/sessions - List sessions
  routes.get("/:projectId/sessions", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    // Use getOrCreateProject to support new projects without sessions yet
    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const providerCatalog = await buildProviderProjectCatalog({
      projects: [project],
      codexScanner: deps.codexScanner,
      geminiScanner: deps.geminiScanner,
    });
    let sessions = await listSessionsAcrossProviders(
      project,
      {
        readerFactory: deps.readerFactory,
        sessionIndexService: deps.sessionIndexService,
        codexSessionsDir: deps.codexSessionsDir,
        codexReaderFactory: deps.codexReaderFactory,
        geminiSessionsDir: deps.geminiSessionsDir,
        geminiReaderFactory: deps.geminiReaderFactory,
        geminiHashToCwd: providerCatalog.geminiHashToCwd,
      },
      providerCatalog,
    );

    // Add missing owned sessions (new sessions that don't have user/assistant messages yet)
    sessions = addMissingOwnedSessions(sessions, projectId);

    return c.json({ sessions: enrichSessions(sessions) });
  });

  return routes;
}
