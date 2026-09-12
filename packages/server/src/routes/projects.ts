import { homedir } from "node:os";
import {
  isUrlProjectId,
  toUrlProjectId,
  type ProjectQueueItemSummary,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { SessionIndexService } from "../indexes/index.js";
import type {
  ProjectMetadataService,
  SessionMetadataService,
} from "../metadata/index.js";
import type { NotificationService } from "../notifications/index.js";
import { warmGitAuthorPalette } from "../git/authorPalette.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import {
  canonicalizeProjectPath,
  decodeProjectId,
  getProjectIdentityKey,
  isAbsolutePath,
  isDetachedProjectPath,
} from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { ProjectStoragePolicy } from "../projects/projectStoragePolicy.js";
import type { CodexSessionReader } from "../sessions/codex-reader.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import { attachProviderChildSessions } from "../sessions/provider-child-sessions.js";
import { listSessionsAcrossProviders } from "../sessions/provider-resolution.js";
import { providerResolutionDeps } from "./session-provider-resolution.js";
import type { GrokSessionReader } from "../sessions/grok-reader.js";
import type { PiSessionReader } from "../sessions/pi-reader.js";
import type { ISessionReader } from "../sessions/types.js";
import type { ProjectQueueService } from "../services/ProjectQueueService.js";
import type { EventBus } from "../watcher/index.js";
import {
  applyRecapOverlayToSummary,
  hasUnreadProviderContent,
  getEffectiveProviderUpdatedAt,
} from "../sessions/recap-overlays.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type { Process } from "../supervisor/Process.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type {
  AgentActivity,
  PendingInputType,
  Project,
  SessionSummary,
} from "../supervisor/types.js";
import { buildProviderProjectCatalog } from "./provider-catalog.js";
import { getActiveSessionIndexOptions } from "./session-list-options.js";

export interface ProjectsDeps {
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  supervisor?: Supervisor;
  externalTracker?: ExternalSessionTracker;
  notificationService?: NotificationService;
  sessionMetadataService?: SessionMetadataService;
  /** ProjectMetadataService for persisting added projects */
  projectMetadataService?: ProjectMetadataService;
  eventBus?: EventBus;
  projectQueueService?: Pick<ProjectQueueService, "listAll" | "listProject">;
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
  /** Grok sessions directory (defaults to ~/.grok/sessions) */
  grokSessionsDir?: string;
  grokReaderFactory?: (projectPath: string) => GrokSessionReader;
  /** pi sessions directory (defaults to ~/.pi/agent/sessions) */
  piSessionsDir?: string;
  piReaderFactory?: (projectPath: string) => PiSessionReader;
  /** Sessions older than this many days are hidden from default scans. 0 disables. */
  sessionAutoArchiveDays?: number;
  storagePolicy?: ProjectStoragePolicy;
}

interface ProjectActivityCounts {
  activeOwnedCount: number;
  activeExternalCount: number;
  projectQueueBlockingCount: number;
}

function emptyProjectActivityCounts(): ProjectActivityCounts {
  return {
    activeOwnedCount: 0,
    activeExternalCount: 0,
    projectQueueBlockingCount: 0,
  };
}

function getMutableProjectActivityCounts(
  counts: Map<string, ProjectActivityCounts>,
  projectId: string,
): ProjectActivityCounts {
  const existing = counts.get(projectId);
  if (existing) return existing;
  const created = emptyProjectActivityCounts();
  counts.set(projectId, created);
  return created;
}

function processBlocksProjectQueue(process: Process): boolean {
  const stateType = process.state.type;
  return (
    stateType === "in-turn" ||
    stateType === "waiting-input" ||
    process.isRetainingProviderWork() ||
    process.queueDepth > 0 ||
    process.getDeferredQueueSummary().length > 0 ||
    process.getPendingInputRequest() !== null ||
    process.getLivenessSnapshot().derivedStatus !== "verified-idle"
  );
}

function isVisibleProjectQueueItem(item: ProjectQueueItemSummary): boolean {
  return item.status === "queued" || item.status === "failed";
}

function projectIdsShareIdentity(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return (
      getProjectIdentityKey(decodeProjectId(left as UrlProjectId)) ===
      getProjectIdentityKey(decodeProjectId(right as UrlProjectId))
    );
  } catch {
    return false;
  }
}

function addProjectActivityCounts(
  left: ProjectActivityCounts,
  right: ProjectActivityCounts,
): ProjectActivityCounts {
  return {
    activeOwnedCount: left.activeOwnedCount + right.activeOwnedCount,
    activeExternalCount: left.activeExternalCount + right.activeExternalCount,
    projectQueueBlockingCount:
      left.projectQueueBlockingCount + right.projectQueueBlockingCount,
  };
}

function getActivityCountsForProject(
  counts: Map<string, ProjectActivityCounts>,
  projectId: string,
): ProjectActivityCounts {
  let total = emptyProjectActivityCounts();
  for (const [candidateProjectId, candidateCounts] of counts.entries()) {
    if (projectIdsShareIdentity(candidateProjectId, projectId)) {
      total = addProjectActivityCounts(total, candidateCounts);
    }
  }
  return total;
}

function getProjectQueueCountForProject(
  projectQueueService: ProjectsDeps["projectQueueService"],
  projectId: string,
): number {
  if (!projectQueueService) return 0;
  return projectQueueService
    .listAll()
    .filter(
      (item) =>
        isVisibleProjectQueueItem(item) &&
        projectIdsShareIdentity(item.projectId, projectId),
    ).length;
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
      const existing = getMutableProjectActivityCounts(
        counts,
        process.projectId,
      );
      existing.activeOwnedCount++;
      if (processBlocksProjectQueue(process)) {
        existing.projectQueueBlockingCount++;
      }
    }

    for (const request of supervisor.getQueueInfo()) {
      const existing = getMutableProjectActivityCounts(
        counts,
        request.projectId,
      );
      existing.projectQueueBlockingCount++;
    }
  }

  // Count external sessions - convert to UrlProjectId for consistent keys
  if (externalTracker) {
    for (const sessionId of externalTracker.getExternalSessions()) {
      const info =
        await externalTracker.getExternalSessionInfoWithUrlId(sessionId);
      if (info) {
        const existing = getMutableProjectActivityCounts(
          counts,
          info.projectId,
        );
        existing.activeExternalCount++;
        existing.projectQueueBlockingCount++;
      }
    }
  }

  return counts;
}

export function createProjectsRoutes(deps: ProjectsDeps): Hono {
  const routes = new Hono();

  async function codeNamesForProjects(
    projects: readonly Project[],
  ): Promise<Map<string, string>> {
    if (!deps.projectMetadataService) return new Map();
    const update =
      await deps.projectMetadataService.ensureProjectCodeNames(projects);
    publishCodeNameChanges(update.changedProjectIds);
    return new Map(
      update.assignments.map((assignment) => [
        assignment.projectId,
        assignment.codeName,
      ]),
    );
  }

  function publishCodeNameChanges(projectIds: readonly string[]): void {
    if (projectIds.length === 0) return;
    deps.eventBus?.emit({
      type: "project-code-names-changed",
      projectIds: [...projectIds],
      timestamp: new Date().toISOString(),
    });
  }

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
      if (projectIdsShareIdentity(process.projectId, projectId)) {
        const now = new Date().toISOString();
        ownedSessions.set(process.sessionId, {
          id: process.sessionId,
          projectId: projectId as UrlProjectId,
          title: null, // Title will be populated once file has content
          fullTitle: null,
          createdAt: process.startedAt.toISOString(),
          updatedAt: now,
          messageCount: 0,
          ownership: {
            owner: "self",
            processId: process.id,
            permissionMode: process.permissionMode,
            appliedPermissionMode: process.appliedPermissionMode,
            modeVersion: process.modeVersion,
            recapAfterSeconds: process.recapAfterSeconds,
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
            appliedPermissionMode: process.appliedPermissionMode,
            modeVersion: process.modeVersion,
            recapAfterSeconds: process.recapAfterSeconds,
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

      // Get session metadata (custom title, archived, starred)
      const metadata = deps.sessionMetadataService?.getMetadata(session.id);
      const providerUpdatedAt = getEffectiveProviderUpdatedAt(
        session.updatedAt,
        process,
      );
      const overlaidSession = deps.sessionMetadataService
        ? applyRecapOverlayToSummary(
            session,
            deps.sessionMetadataService.getRecapMessages(session.id),
          )
        : session;

      const lastSeenEntry = deps.notificationService?.getLastSeen(session.id);
      const lastSeenAt = lastSeenEntry?.timestamp;
      const hasUnread = hasUnreadProviderContent(
        deps.notificationService,
        session.id,
        providerUpdatedAt,
      );

      const customTitle = metadata?.customTitle;
      const isArchived = metadata?.isArchived;
      const isStarred = metadata?.isStarred;
      const parentSessionId =
        metadata?.parentSessionId ?? overlaidSession.parentSessionId;
      const parentSessionKind =
        metadata?.parentSessionKind ?? overlaidSession.parentSessionKind;
      const forkedFromSessionId =
        metadata?.forkedFromSessionId ?? overlaidSession.forkedFromSessionId;
      const effectiveProjectId =
        metadata?.workingProjectId ?? overlaidSession.projectId;

      return {
        ...overlaidSession,
        updatedAt: getEffectiveProviderUpdatedAt(
          overlaidSession.updatedAt,
          process,
        ),
        projectId: effectiveProjectId,
        ownership,
        pendingInputType,
        activity,
        lastSeenAt,
        hasUnread,
        customTitle,
        isArchived,
        isStarred,
        parentSessionId,
        parentSessionKind,
        forkedFromSessionId,
        workstreamId: metadata?.workstreamId,
      };
    });
  }

  // GET /api/projects - List all projects
  routes.get("/", async (c) => {
    const rawProjects = (await deps.scanner.listProjects()).filter(
      (project) => !isDetachedProjectPath(project.path),
    );
    const activityCounts = await getProjectActivityCounts(
      deps.supervisor,
      deps.externalTracker,
    );
    const codeNameByProjectId = await codeNamesForProjects(rawProjects);

    // Enrich projects with active counts (all keyed by UrlProjectId now)
    const projects = rawProjects.map((project) => {
      const counts = getActivityCountsForProject(activityCounts, project.id);
      return {
        ...project,
        codeName: codeNameByProjectId.get(project.id),
        activeOwnedCount: counts.activeOwnedCount,
        activeExternalCount: counts.activeExternalCount,
        projectQueueBlockingCount: counts.projectQueueBlockingCount,
        projectQueueCount: getProjectQueueCountForProject(
          deps.projectQueueService,
          project.id,
        ),
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
    void warmGitAuthorPalette(project.path, deps.storagePolicy);

    const activityCounts = await getProjectActivityCounts(
      deps.supervisor,
      deps.externalTracker,
    );
    const counts = getActivityCountsForProject(activityCounts, project.id);
    const codeNameByProjectId = await codeNamesForProjects([project]);
    const projectQueueCount = deps.projectQueueService
      ? getProjectQueueCountForProject(deps.projectQueueService, project.id)
      : 0;

    return c.json({
      project: {
        ...project,
        codeName: codeNameByProjectId.get(project.id),
        activeOwnedCount: counts.activeOwnedCount,
        activeExternalCount: counts.activeExternalCount,
        projectQueueBlockingCount: counts.projectQueueBlockingCount,
        projectQueueCount,
      },
    });
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
    void warmGitAuthorPalette(project.path, deps.storagePolicy);

    // Persist the project so it appears in future listings
    if (deps.projectMetadataService) {
      await deps.projectMetadataService.addProject(projectId, normalizedPath);
      deps.scanner.invalidateCache();
    }

    const codeNameByProjectId = await codeNamesForProjects([project]);
    return c.json({
      project: {
        ...project,
        codeName: codeNameByProjectId.get(project.id),
      },
    });
  });

  routes.patch("/:projectId/code-name", async (c) => {
    const projectId = c.req.param("projectId");
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    if (!deps.projectMetadataService) {
      return c.json({ error: "Project code-name editing is unavailable" }, 501);
    }

    let body: { codeName?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body.codeName !== "string") {
      return c.json({ error: "codeName is required" }, 400);
    }

    const project = await deps.scanner.getOrCreateProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    const visibleProjects = (await deps.scanner.listProjects()).filter(
      (candidate) => !isDetachedProjectPath(candidate.path),
    );
    if (!visibleProjects.some((candidate) => candidate.id === project.id)) {
      visibleProjects.push(project);
    }

    try {
      const update = await deps.projectMetadataService.setProjectCodeName(
        project.id,
        body.codeName,
        visibleProjects,
      );
      publishCodeNameChanges(update.changedProjectIds);
      return c.json({ assignments: update.assignments });
    } catch (error) {
      if (error instanceof RangeError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  // DELETE /api/projects/:projectId - Hide a project from YA lists
  routes.delete("/:projectId", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    if (!deps.projectMetadataService) {
      return c.json({ error: "Project removal is unavailable" }, 501);
    }

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    await deps.projectMetadataService.hideProject(project.id, project.path);
    deps.scanner.invalidateCache();

    return c.json({
      removed: true,
      projectId: project.id,
      path: project.path,
    });
  });

  // GET /api/projects/:projectId/sessions - List sessions
  routes.get("/:projectId/sessions", async (c) => {
    const projectId = c.req.param("projectId");

    // Validate projectId format at API boundary
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }

    const includeArchived = c.req.query("includeArchived") === "true";

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
        grokSessionsDir: deps.grokSessionsDir,
        grokReaderFactory: deps.grokReaderFactory,
        piSessionsDir: deps.piSessionsDir,
        piReaderFactory: deps.piReaderFactory,
      },
      providerCatalog,
      includeArchived
        ? undefined
        : getActiveSessionIndexOptions(deps.sessionAutoArchiveDays),
    );

    // Add missing owned sessions (new sessions that don't have user/assistant messages yet)
    const resolvedProjectId = project.id;
    sessions = addMissingOwnedSessions(sessions, resolvedProjectId);

    const enriched = enrichSessions(sessions).filter((session) =>
      projectIdsShareIdentity(session.projectId, resolvedProjectId),
    );
    const withChildren = await attachProviderChildSessions(
      enriched,
      project,
      providerResolutionDeps(deps),
      "accepted-or-cheap",
      providerCatalog,
    );

    return c.json({ sessions: withChildren });
  });

  return routes;
}
