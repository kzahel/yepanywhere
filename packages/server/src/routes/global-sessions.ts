/**
 * Global sessions route - returns all sessions across all projects.
 *
 * Unlike the inbox route which categorizes sessions into tiers,
 * this returns a flat list suitable for navigation/sidebar use.
 */

import {
  type ProviderName,
  getSessionDisplayTitle,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { SessionIndexService } from "../indexes/index.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { NotificationService } from "../notifications/index.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { CodexSessionReader } from "../sessions/codex-reader.js";
import { GeminiSessionReader } from "../sessions/gemini-reader.js";
import type { ISessionReader } from "../sessions/types.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type {
  PendingInputType,
  ProcessStateType,
  Project,
  SessionStatus,
  SessionSummary,
} from "../supervisor/types.js";

export interface GlobalSessionsDeps {
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  supervisor?: Supervisor;
  externalTracker?: ExternalSessionTracker;
  notificationService?: NotificationService;
  sessionIndexService?: SessionIndexService;
  sessionMetadataService?: SessionMetadataService;
  /** Codex scanner for checking if a project has Codex sessions */
  codexScanner?: CodexSessionScanner;
  /** Codex sessions directory (defaults to ~/.codex/sessions) */
  codexSessionsDir?: string;
  /** Gemini scanner for checking if a project has Gemini sessions */
  geminiScanner?: GeminiSessionScanner;
  /** Gemini sessions directory (defaults to ~/.gemini/tmp) */
  geminiSessionsDir?: string;
}

export interface GlobalSessionItem {
  // From cache (cheap)
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  provider: ProviderName;
  // Project context
  projectId: string;
  projectName: string;
  // Enrichment (all in-memory, cheap)
  status: SessionStatus;
  pendingInputType?: PendingInputType;
  processState?: ProcessStateType;
  hasUnread?: boolean;
  customTitle?: string;
  isArchived?: boolean;
  isStarred?: boolean;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
}

/** Stats about all sessions (computed during full scan) */
export interface GlobalSessionStats {
  totalCount: number;
  unreadCount: number;
  starredCount: number;
  archivedCount: number;
  /** Counts per provider (non-archived only) */
  providerCounts: Partial<Record<ProviderName, number>>;
}

/** Minimal project info for filter dropdowns */
export interface ProjectOption {
  id: string;
  name: string;
}

export interface GlobalSessionsResponse {
  sessions: GlobalSessionItem[];
  hasMore: boolean;
  /** Global stats computed from all sessions (not just paginated results) */
  stats: GlobalSessionStats;
  /** All projects for filter dropdown */
  projects: ProjectOption[];
}

/** Default limit for sessions per page */
const DEFAULT_LIMIT = 100;

/** Maximum allowed limit */
const MAX_LIMIT = 500;

export function createGlobalSessionsRoutes(deps: GlobalSessionsDeps): Hono {
  const routes = new Hono();

  // GET /api/sessions - Get all sessions with pagination
  routes.get("/", async (c) => {
    // Parse query params
    const filterProjectId = c.req.query("project");
    const searchQuery = c.req.query("q")?.toLowerCase();
    const afterCursor = c.req.query("after");
    const includeArchived = c.req.query("includeArchived") === "true";
    const starredOnly = c.req.query("starred") === "true";
    const limitParam = c.req.query("limit");
    const limit = Math.min(
      Math.max(1, Number.parseInt(limitParam || "", 10) || DEFAULT_LIMIT),
      MAX_LIMIT,
    );

    // Get all projects
    const allProjects = await deps.scanner.listProjects();

    // Filter to single project if projectId query param provided
    const projects = filterProjectId
      ? allProjects.filter((p) => p.id === filterProjectId)
      : allProjects;

    // Build project options for filter dropdown (from all projects, sorted by name)
    const projectOptions: ProjectOption[] = allProjects
      .map((p) => ({ id: p.id, name: p.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Global stats counters (computed from ALL sessions, ignoring filters)
    const stats: GlobalSessionStats = {
      totalCount: 0,
      unreadCount: 0,
      starredCount: 0,
      archivedCount: 0,
      providerCounts: {},
    };

    // Collect all sessions with enriched data
    const allSessions: GlobalSessionItem[] = [];

    for (const project of projects) {
      const reader = deps.readerFactory(project);

      // Get sessions using cache if available
      // SessionIndexService only works with Claude's directory structure
      let sessions: SessionSummary[];
      if (deps.sessionIndexService && project.provider === "claude") {
        sessions = await deps.sessionIndexService.getSessionsWithCache(
          project.sessionDir,
          project.id,
          reader,
        );
      } else {
        sessions = await reader.listSessions(project.id);
      }

      // For Claude projects, also check for Codex sessions for the same path
      // This handles the case where a project has sessions from multiple providers
      if (project.provider === "claude" && deps.codexScanner) {
        const codexSessions = await deps.codexScanner.getSessionsForProject(
          project.path,
        );
        if (codexSessions.length > 0 && deps.codexSessionsDir) {
          const codexReader = new CodexSessionReader({
            sessionsDir: deps.codexSessionsDir,
            projectPath: project.path,
          });
          const codexSessionSummaries = await codexReader.listSessions(
            project.id,
          );
          // Merge Codex sessions with Claude sessions
          sessions = [...sessions, ...codexSessionSummaries];
        }
      }

      // For Claude/Codex projects, also check for Gemini sessions for the same path
      // This handles the case where a project has sessions from multiple providers
      if (
        (project.provider === "claude" || project.provider === "codex") &&
        deps.geminiScanner
      ) {
        const geminiSessions = await deps.geminiScanner.getSessionsForProject(
          project.path,
        );
        if (geminiSessions.length > 0 && deps.geminiSessionsDir) {
          const geminiReader = new GeminiSessionReader({
            sessionsDir: deps.geminiSessionsDir,
            projectPath: project.path,
            hashToCwd: deps.geminiScanner.getHashToCwd(),
          });
          const geminiSessionSummaries = await geminiReader.listSessions(
            project.id,
          );
          // Merge Gemini sessions with Claude/Codex sessions
          sessions = [...sessions, ...geminiSessionSummaries];
        }
      }

      // Enrich each session
      for (const session of sessions) {
        // Get session metadata
        const metadata = deps.sessionMetadataService?.getMetadata(session.id);
        const isArchived = metadata?.isArchived ?? session.isArchived ?? false;
        const isStarred = metadata?.isStarred ?? session.isStarred ?? false;
        const customTitle = metadata?.customTitle ?? session.customTitle;
        const executor = metadata?.executor;

        // Get unread status
        const hasUnread = deps.notificationService
          ? deps.notificationService.hasUnread(session.id, session.updatedAt)
          : undefined;

        // Update global stats (always, regardless of filters)
        // Stats are computed only when not filtering by project (global view)
        if (!filterProjectId) {
          if (isArchived) {
            stats.archivedCount++;
          } else {
            stats.totalCount++;
            if (hasUnread) stats.unreadCount++;
            // Provider counts only for non-archived
            if (session.provider) {
              stats.providerCounts[session.provider] =
                (stats.providerCounts[session.provider] ?? 0) + 1;
            }
          }
          if (isStarred) stats.starredCount++;
        }

        // Skip archived sessions unless explicitly requested
        if (isArchived && !includeArchived) continue;

        // Skip non-starred sessions if starred filter is active
        if (starredOnly && !isStarred) continue;

        // Compute status
        const process = deps.supervisor?.getProcessForSession(session.id);
        const isExternal =
          deps.externalTracker?.isExternal(session.id) ?? false;

        const status: SessionStatus = process
          ? {
              state: "owned",
              processId: process.id,
              permissionMode: process.permissionMode,
              modeVersion: process.modeVersion,
            }
          : isExternal
            ? { state: "external" }
            : (session.status ?? { state: "idle" });

        // Get process state
        let pendingInputType: PendingInputType | undefined;
        let processState: ProcessStateType | undefined;
        if (process) {
          const pendingRequest = process.getPendingInputRequest();
          if (pendingRequest) {
            pendingInputType =
              pendingRequest.type === "tool-approval"
                ? "tool-approval"
                : "user-question";
          }
          const state = process.state.type;
          if (state === "running" || state === "waiting-input") {
            processState = state;
          }
        }

        // Apply search filter
        if (searchQuery) {
          const titleMatch = session.title?.toLowerCase().includes(searchQuery);
          const customTitleMatch = customTitle
            ?.toLowerCase()
            .includes(searchQuery);
          const projectNameMatch = project.name
            .toLowerCase()
            .includes(searchQuery);

          if (!titleMatch && !customTitleMatch && !projectNameMatch) {
            continue;
          }
        }

        allSessions.push({
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: session.messageCount,
          provider: session.provider,
          projectId: session.projectId,
          projectName: project.name,
          status,
          pendingInputType,
          processState,
          hasUnread,
          customTitle,
          isArchived,
          isStarred,
          executor,
        });
      }
    }

    // Sort by updatedAt descending (most recent first)
    allSessions.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    // Apply cursor pagination
    let filteredSessions = allSessions;
    if (afterCursor) {
      const afterTime = new Date(afterCursor).getTime();
      filteredSessions = allSessions.filter(
        (s) => new Date(s.updatedAt).getTime() < afterTime,
      );
    }

    // Get one extra to determine hasMore
    const sessionsWithExtra = filteredSessions.slice(0, limit + 1);
    const hasMore = sessionsWithExtra.length > limit;
    const sessions = sessionsWithExtra.slice(0, limit);

    const response: GlobalSessionsResponse = {
      sessions,
      hasMore,
      stats,
      projects: projectOptions,
    };

    return c.json(response);
  });

  return routes;
}
