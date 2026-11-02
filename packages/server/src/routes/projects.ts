import {
  mergeCreationProjectCards,
  type CreationNativeInventoryItem,
} from "./creation-session-collections.js";
import { mergeCreationSessionSummaries } from "../sessions/session-creation-view.js";
import { homedir } from "node:os";
import {
  isUrlProjectId,
  normalizeProjectCaption,
  normalizeProjectCodeName,
  normalizeProjectName,
  toUrlProjectId,
  type ProjectCaption,
  type ProjectQueueItemSummary,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { type Context, Hono } from "hono";
import type { SessionIndexService } from "../indexes/index.js";
import type {
  ProjectMetadataService,
  SessionMetadataService,
} from "../metadata/index.js";
import type { NotificationService } from "../notifications/index.js";
import { nonHumanUserTurnField } from "../metadata/SessionMetadataService.js";
import { warmGitAuthorPalette } from "../git/authorPalette.js";
import {
  decideProjectCreation,
  ensureProjectDirectory,
  isContainedOnDisk,
  probeProjectFolder,
} from "./project-creation.js";
import type { LimitedUsersService } from "../auth/LimitedUsersService.js";
import { principalFor } from "../auth/limitedLaunchPolicy.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import {
  canonicalizeProjectPath,
  decodeProjectId,
  getProjectIdentityKey,
  getProjectName,
  isAbsolutePath,
  isDetachedProjectPath,
} from "../projects/paths.js";
import { getDerivedProjectCaption } from "../projects/projectCaption.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { ProjectAppStore } from "../projects/ProjectAppStore.js";
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
  getEffectiveProviderUpdatedAt,
} from "../sessions/recap-overlays.js";
import {
  sessionOwnershipFromProcess,
  sessionRowRuntimeOverlay,
} from "../sessions/session-runtime-overlay.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type { Process } from "../supervisor/Process.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { Project, SessionSummary } from "../supervisor/types.js";
import { buildProviderProjectCatalog } from "./provider-catalog.js";
import { getActiveSessionIndexOptions } from "./session-list-options.js";

/** A typed project path as the server will store it: `~` expanded, no trailing separator. */
function normalizeAddedProjectPath(typed: string): string {
  let normalizedPath = typed.trim();
  if (normalizedPath.startsWith("~")) {
    normalizedPath = normalizedPath.replace("~", homedir());
  }
  if (normalizedPath.length > 1 && /[/\\]$/.test(normalizedPath)) {
    normalizedPath = normalizedPath.slice(0, -1);
  }
  return canonicalizeProjectPath(normalizedPath);
}

export interface ProjectsDeps {
  signal?: AbortSignal;
  readNativeSessionInventory?: () => Promise<
    readonly CreationNativeInventoryItem[]
  >;
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  supervisor?: Supervisor;
  externalTracker?: ExternalSessionTracker;
  notificationService?: NotificationService;
  sessionMetadataService?: SessionMetadataService;
  /** ProjectMetadataService for persisting added projects */
  projectMetadataService?: ProjectMetadataService;
  projectAppStore?: ProjectAppStore;
  /** Grants a limited user the project they just created. */
  limitedUsersService?: Pick<LimitedUsersService, "grantNewSessionProject">;
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

/**
 * Whether the acting principal may change how a project is named, captioned,
 * code-named or listed. Those are one value every principal sees, so a
 * limited user changes them only on a project they own; a grant to start
 * sessions somewhere is not a say in how it is presented to everyone else.
 * topics/limited-users.md § Delivery v1 — Authorization.
 */
function mayEditSharedProjectMetadata(c: Context, project: Project): boolean {
  const principal = principalFor(c);
  return (
    principal.kind !== "limited" || project.ownerUsername === principal.username
  );
}

const NOT_PROJECT_OWNER_ERROR =
  "Only the project's owner or the superuser may change this project";

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
  retained = false,
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
      const info = await externalTracker.getExternalSessionInfoWithUrlId(
        sessionId,
        { retained },
      );
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
   * A project was added, removed, or renamed. Besides refreshing project
   * lists, this bumps the global session collection: the All Sessions
   * project filter is served from a generation-gated cache that otherwise
   * keeps offering removed projects and never learns of new ones.
   */
  function publishProjectsChanged(projectIds: readonly string[]): void {
    deps.eventBus?.emit({
      type: "projects-changed",
      projectIds: [...projectIds],
      timestamp: new Date().toISOString(),
    });
  }

  /** Every listed project plus `project` when it is not listed yet. */
  async function codeNameScope(project: Project): Promise<Project[]> {
    const visibleProjects = (await deps.scanner.listProjects()).filter(
      (candidate) => !isDetachedProjectPath(candidate.path),
    );
    if (!visibleProjects.some((candidate) => candidate.id === project.id)) {
      visibleProjects.push(project);
    }
    return visibleProjects;
  }

  /** User override first, else the cached README/manifest derivation. */
  async function captionForProject(
    project: Project,
  ): Promise<ProjectCaption | undefined> {
    const override = deps.projectMetadataService?.getProjectCaptionOverride(
      project.id,
    );
    if (override) return { text: override, source: "override" };
    return getDerivedProjectCaption(project.path);
  }

  async function captionsForProjects(
    projects: readonly Project[],
  ): Promise<Map<string, ProjectCaption>> {
    const captions = new Map<string, ProjectCaption>();
    await Promise.all(
      projects.map(async (project) => {
        const caption = await captionForProject(project);
        if (caption) captions.set(project.id, caption);
      }),
    );
    return captions;
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
          ownership: sessionOwnershipFromProcess(process),
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
      const { ownership, pendingInputType, activity, hasUnread } =
        sessionRowRuntimeOverlay(process, {
          sessionId: session.id,
          providerUpdatedAt,
          notificationService: deps.notificationService,
          externalTracker: deps.externalTracker,
          fallbackOwnership: session.ownership,
        });

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
        nonHumanUserTurn: nonHumanUserTurnField(
          deps.sessionMetadataService,
          session.id,
        ),
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
        creationProvenance: metadata?.creationProvenance,
      };
    });
  }

  // GET /api/projects - List all projects
  routes.get("/", async (c) => {
    const retained =
      c.req.query("summaryMode") === "retained"
        ? await deps.scanner.readRetainedProjects()
        : undefined;
    const rawProjects = (
      retained?.projects ?? (await deps.scanner.listProjects())
    ).filter((project) => !isDetachedProjectPath(project.path));
    const activityCounts = await getProjectActivityCounts(
      deps.supervisor,
      deps.externalTracker,
      retained !== undefined,
    );
    const codeNameByProjectId = await codeNamesForProjects(rawProjects);
    const captionByProjectId = await captionsForProjects(rawProjects);

    // Enrich projects with active counts (all keyed by UrlProjectId now)
    const nativeProjects = rawProjects.map((project) => {
      const counts = getActivityCountsForProject(activityCounts, project.id);
      return {
        ...project,
        codeName: codeNameByProjectId.get(project.id),
        caption: captionByProjectId.get(project.id),
        activeOwnedCount: counts.activeOwnedCount,
        activeExternalCount: counts.activeExternalCount,
        projectQueueBlockingCount: counts.projectQueueBlockingCount,
        projectQueueCount: getProjectQueueCountForProject(
          deps.projectQueueService,
          project.id,
        ),
      };
    });

    const projects = mergeCreationProjectCards(
      nativeProjects,
      deps.sessionMetadataService,
      {
        signal: deps.signal,
        nativeInventory: await deps.readNativeSessionInventory?.(),
        projectMetadata: deps.projectMetadataService,
        runtimeCounts: (projectId) =>
          getActivityCountsForProject(activityCounts, projectId),
      },
    );

    // Sort by lastActivity descending (most recent first), nulls last
    projects.sort((a, b) => {
      if (!a.lastActivity && !b.lastActivity) return 0;
      if (!a.lastActivity) return 1;
      if (!b.lastActivity) return -1;
      return (
        new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
      );
    });

    if (retained) {
      const { projects: _projects, refreshError, ...catalog } = retained;
      return c.json({
        projects,
        catalog: {
          ...catalog,
          ...(principalFor(c).kind === "limited" ? {} : { refreshError }),
        },
      });
    }
    return c.json({ projects });
  });

  // GET /api/projects/folder-state?path= - What adding this path would find.
  // Registered before /:projectId, which would otherwise claim the segment.
  // Answers only where this principal may add a project.
  routes.get("/folder-state", async (c) => {
    const typed = c.req.query("path");
    if (!typed?.trim()) return c.json({ error: "path is required" }, 400);
    const normalizedPath = normalizeAddedProjectPath(typed);
    if (!isAbsolutePath(normalizedPath)) {
      return c.json({ error: "Path must be absolute" }, 400);
    }
    const creation = await decideProjectCreation(c, normalizedPath);
    if (creation.kind === "denied") {
      return c.json({ error: creation.error }, 403);
    }
    return c.json({
      path: normalizedPath,
      state: await probeProjectFolder(normalizedPath),
    });
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

    const cards = mergeCreationProjectCards(
      [
        {
          ...project,
          codeName: codeNameByProjectId.get(project.id),
          caption: await captionForProject(project),
          activeOwnedCount: counts.activeOwnedCount,
          activeExternalCount: counts.activeExternalCount,
          projectQueueBlockingCount: counts.projectQueueBlockingCount,
          projectQueueCount,
        },
      ],
      deps.sessionMetadataService,
      {
        signal: deps.signal,
        nativeInventory: await deps.readNativeSessionInventory?.(),
        projectMetadata: deps.projectMetadataService,
        runtimeCounts: (id) => getActivityCountsForProject(activityCounts, id),
      },
    );
    return c.json({ project: cards[0] });
  });

  // POST /api/projects - Add a project by path
  // Validates the path exists on disk and returns project info
  routes.post("/", async (c) => {
    let body: {
      path: string;
      create?: boolean;
      /** False creates a missing folder without a repository. */
      gitInit?: unknown;
      name?: unknown;
      codeName?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.path || typeof body.path !== "string") {
      return c.json({ error: "path is required" }, 400);
    }
    if (body.gitInit !== undefined && typeof body.gitInit !== "boolean") {
      return c.json({ error: "gitInit must be a boolean" }, 400);
    }

    // The chosen name and code name are validated before anything is
    // persisted, so a rejected request adds nothing. An omitted or blank
    // name keeps the path's last component; an omitted code name is
    // allocated by the server as before.
    let chosenName: string | null = null;
    let chosenCodeName: string | null = null;
    try {
      if (body.name !== undefined) {
        if (typeof body.name !== "string") {
          return c.json({ error: "name must be a string" }, 400);
        }
        chosenName = normalizeProjectName(body.name) || null;
      }
      if (body.codeName !== undefined) {
        if (typeof body.codeName !== "string") {
          return c.json({ error: "codeName must be a string" }, 400);
        }
        chosenCodeName = body.codeName.trim()
          ? normalizeProjectCodeName(body.codeName)
          : null;
      }
    } catch (error) {
      if (error instanceof RangeError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }

    const normalizedPath = normalizeAddedProjectPath(body.path);

    // Validate path is absolute
    if (!isAbsolutePath(normalizedPath)) {
      return c.json({ error: "Path must be absolute" }, 400);
    }

    // A limited user may only add projects under their configured directory;
    // the superuser may add anything (topics/limited-users.md § Delivery v1).
    const creation = await decideProjectCreation(c, normalizedPath);
    if (creation.kind === "denied") {
      return c.json({ error: creation.error }, 403);
    }
    const owner = creation.owner;
    if (owner && !deps.limitedUsersService) {
      throw new Error(
        "Adding a limited user's project needs the limited users service",
      );
    }
    // A limited user adds a directory; re-adding must not claim a project
    // that is already here under another owner or none, nor show one the
    // superuser hid. Their own project may be added again.
    if (owner) {
      const projectId = toUrlProjectId(normalizedPath);
      // Discovery can still be refreshing or retain an older empty snapshot.
      // Registered ownership is authoritative even before discovery catches up.
      const existing = await deps.scanner.getProject(projectId);
      const registered = deps.projectMetadataService?.getMetadata(projectId);
      if (
        deps.projectMetadataService?.isHiddenProjectPath(normalizedPath) ||
        ((registered ?? existing) &&
          (registered ?? existing)?.ownerUsername !== owner.username)
      ) {
        return c.json(
          {
            error:
              "This directory is already a project; ask the superuser for access",
          },
          403,
        );
      }
    }

    // `create` is the client's confirmed answer to "this does not exist yet".
    // Without it a missing directory is refused exactly as it always was, so
    // no caller creates a directory by accident.
    const directory = await ensureProjectDirectory(normalizedPath, {
      create: body.create === true,
      projectRoot: owner?.projectRoot,
      initializeGit: body.gitInit !== false,
    });
    if (directory.kind === "error") {
      return c.json({ error: directory.error }, directory.status);
    }
    // Checked again now the directory exists: a link swapped in under the
    // root since the first check must not become a registered project.
    if (
      owner &&
      !(await isContainedOnDisk(owner.projectRoot, normalizedPath))
    ) {
      return c.json(
        {
          error: `This user may only create projects under ${owner.projectRoot}`,
        },
        403,
      );
    }

    // Create projectId and try to get/create the project
    const projectId = toUrlProjectId(normalizedPath);
    let project = await deps.scanner.getOrCreateProject(projectId);

    if (!project) {
      return c.json(
        { error: "Path does not exist or is not a directory" },
        404,
      );
    }
    void warmGitAuthorPalette(project.path, deps.storagePolicy);

    // Persist the project so it appears in future listings
    if (deps.projectMetadataService) {
      // Another request may have registered or hidden it during directory
      // preparation. Recheck immediately before addProject mutates metadata.
      const registered = deps.projectMetadataService.getMetadata(projectId);
      if (
        owner &&
        (deps.projectMetadataService.isHiddenProjectPath(normalizedPath) ||
          (registered && registered.ownerUsername !== owner.username))
      ) {
        return c.json(
          {
            error:
              "This directory is already a project; ask the superuser for access",
          },
          403,
        );
      }
      await deps.projectMetadataService.addProject(
        projectId,
        normalizedPath,
        owner?.username,
      );
      // A name equal to the path's own is no override at all.
      if (
        chosenName !== null &&
        chosenName !== getProjectName(normalizedPath)
      ) {
        await deps.projectMetadataService.setProjectNameOverride(
          project.id,
          chosenName,
        );
      }
      deps.scanner.invalidateCache();
      // Re-read so the response, and the code-name allocation below, see
      // the chosen name.
      project = (await deps.scanner.getOrCreateProject(projectId)) ?? project;
      if (chosenCodeName !== null) {
        const update = await deps.projectMetadataService.setProjectCodeName(
          project.id,
          chosenCodeName,
          await codeNameScope(project),
        );
        publishCodeNameChanges(update.changedProjectIds);
      }
    }
    // Owning a project is what makes it theirs to use; without the grant it
    // would vanish from their own project list the moment it was made.
    if (owner) {
      await deps.limitedUsersService?.grantNewSessionProject(
        owner.username,
        project.id,
      );
    }
    publishProjectsChanged([project.id]);

    const codeNameByProjectId = await codeNamesForProjects([project]);
    return c.json({
      project: {
        ...project,
        codeName: codeNameByProjectId.get(project.id),
        caption: await captionForProject(project),
        ...(owner ? { ownerUsername: owner.username } : {}),
      },
      created: directory.kind === "created",
    });
  });

  // PATCH /api/projects/:projectId/caption - set or clear the caption override
  routes.patch("/:projectId/caption", async (c) => {
    const projectId = c.req.param("projectId");
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    if (!deps.projectMetadataService) {
      return c.json({ error: "Project caption editing is unavailable" }, 501);
    }

    let body: { caption?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (body.caption !== null && typeof body.caption !== "string") {
      return c.json({ error: "caption must be a string or null" }, 400);
    }

    // Only a listed project takes a caption; an arbitrary directory's id
    // must not gain app-data metadata through this route.
    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    if (!mayEditSharedProjectMetadata(c, project)) {
      return c.json({ error: NOT_PROJECT_OWNER_ERROR }, 403);
    }

    let caption: string | null;
    try {
      caption =
        body.caption === null ? null : normalizeProjectCaption(body.caption);
      if (caption === "") caption = null;
    } catch (error) {
      if (error instanceof RangeError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }

    await deps.projectMetadataService.setProjectCaptionOverride(
      project.id,
      caption,
    );
    deps.eventBus?.emit({
      type: "project-captions-changed",
      projectIds: [project.id],
      timestamp: new Date().toISOString(),
    });
    return c.json({ caption: await captionForProject(project) });
  });

  // PATCH /api/projects/:projectId/name - set or clear the chosen name
  routes.patch("/:projectId/name", async (c) => {
    const projectId = c.req.param("projectId");
    if (!isUrlProjectId(projectId)) {
      return c.json({ error: "Invalid project ID format" }, 400);
    }
    if (!deps.projectMetadataService) {
      return c.json({ error: "Project renaming is unavailable" }, 501);
    }

    let body: { name?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (body.name !== null && typeof body.name !== "string") {
      return c.json({ error: "name must be a string or null" }, 400);
    }

    // Only a listed project takes a name; an arbitrary directory's id must
    // not become a project through a rename.
    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    if (!mayEditSharedProjectMetadata(c, project)) {
      return c.json({ error: NOT_PROJECT_OWNER_ERROR }, 403);
    }

    let name: string | null;
    try {
      name = body.name === null ? null : normalizeProjectName(body.name);
      if (name === "" || name === getProjectName(project.path)) name = null;
    } catch (error) {
      if (error instanceof RangeError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }

    await deps.projectMetadataService.setProjectNameOverride(project.id, name);
    deps.scanner.invalidateCache();
    publishProjectsChanged([project.id]);
    const renamed = (await deps.scanner.getProject(projectId)) ?? project;
    return c.json({ name: renamed.name });
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

    const project = await deps.scanner.getProject(projectId);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }
    if (!mayEditSharedProjectMetadata(c, project)) {
      return c.json({ error: NOT_PROJECT_OWNER_ERROR }, 403);
    }

    try {
      const update = await deps.projectMetadataService.setProjectCodeName(
        project.id,
        body.codeName,
        await codeNameScope(project),
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
    if (!mayEditSharedProjectMetadata(c, project)) {
      return c.json({ error: NOT_PROJECT_OWNER_ERROR }, 403);
    }

    const principal = principalFor(c);
    if (principal.kind === "limited") {
      if (!deps.projectAppStore)
        return c.json(
          { error: "Personal project removal is unavailable" },
          501,
        );
      await deps.projectAppStore.setHidden(
        project.id,
        principal.username,
        true,
        principal.username,
      );
      publishProjectsChanged([project.id]);
      return c.json({
        removed: true,
        projectId: project.id,
        path: project.path,
        personal: true,
      });
    }

    await deps.projectMetadataService.hideProject(project.id, project.path);
    deps.scanner.invalidateCache();
    publishProjectsChanged([project.id]);

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
        identities: deps.sessionMetadataService?.identities,
        getRecordedProvider: (id) =>
          deps.sessionMetadataService?.getProvider?.(id),
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

    const enriched = mergeCreationSessionSummaries(
      enrichSessions(sessions),
      deps.sessionMetadataService,
      project.id,
      deps.signal,
      includeArchived
        ? undefined
        : getActiveSessionIndexOptions(deps.sessionAutoArchiveDays)
            ?.activeAfterMs,
    ).filter((session) =>
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
