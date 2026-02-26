/**
 * Inbox route - aggregates sessions across all projects into prioritized tiers.
 *
 * Tiers (in priority order):
 * 1. needsAttention - Sessions with pendingInputType set (tool-approval or user-question)
 * 2. active - Sessions with processState === 'running' but no pending input
 * 3. recentActivity - Sessions updated in the last 30 minutes (not in tiers 1-2)
 * 4. unread8h - Sessions with hasUnread and updatedAt within 8 hours (not in tiers 1-3)
 * 5. unread24h - Sessions with hasUnread and updatedAt within 24 hours (not in tiers 1-4)
 */

import { getSessionDisplayTitle } from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { SessionIndexService } from "../indexes/index.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { NotificationService } from "../notifications/index.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { ClaudeSessionReader } from "../sessions/reader.js";
import type { ISessionReader } from "../sessions/types.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type {
  AgentActivity,
  PendingInputType,
  Project,
  SessionSummary,
} from "../supervisor/types.js";

export interface InboxDeps {
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  supervisor?: Supervisor;
  notificationService?: NotificationService;
  sessionIndexService?: SessionIndexService;
  sessionMetadataService?: SessionMetadataService;
}

export interface InboxItem {
  sessionId: string;
  projectId: string;
  projectName: string;
  sessionTitle: string;
  updatedAt: string;
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  hasUnread?: boolean;
}

export interface InboxResponse {
  needsAttention: InboxItem[];
  active: InboxItem[];
  recentActivity: InboxItem[];
  unread8h: InboxItem[];
  unread24h: InboxItem[];
}

/** Maximum items per tier to keep response size manageable */
const MAX_ITEMS_PER_TIER = 20;

/** Time thresholds in milliseconds */
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export function createInboxRoutes(deps: InboxDeps): Hono {
  const routes = new Hono();

  // GET /api/inbox - Get prioritized inbox of sessions
  // Optional query param: projectId - filter to a single project
  routes.get("/", async (c) => {
    const now = Date.now();
    const filterProjectId = c.req.query("projectId");
    const allProjects = await deps.scanner.listProjects();

    // Filter to single project if projectId query param provided
    const projects = filterProjectId
      ? allProjects.filter((p) => p.id === filterProjectId)
      : allProjects;

    // Collect all sessions with enriched data
    const allSessions: Array<{
      session: SessionSummary;
      projectName: string;
      pendingInputType?: PendingInputType;
      activity?: AgentActivity;
      hasUnread?: boolean;
      customTitle?: string;
    }> = [];

    // Fetch sessions for all projects in parallel to avoid sequential I/O
    const projectSessionResults = await Promise.all(
      projects.map(async (project) => {
        const reader = deps.readerFactory(project);
        let sessions: SessionSummary[];
        const indexService = deps.sessionIndexService;
        if (indexService && project.provider === "claude") {
          sessions = await indexService.getSessionsWithCache(
            project.sessionDir,
            project.id,
            reader,
          );
          if (project.mergedSessionDirs) {
            const mergedResults = await Promise.all(
              project.mergedSessionDirs.map((dir) => {
                const mergedReader = new ClaudeSessionReader({
                  sessionDir: dir,
                });
                return indexService.getSessionsWithCache(
                  dir,
                  project.id,
                  mergedReader,
                );
              }),
            );
            for (const merged of mergedResults) {
              sessions = [...sessions, ...merged];
            }
          }
        } else {
          sessions = await reader.listSessions(project.id);
        }
        return { project, sessions };
      }),
    );

    // Enrich each session with process state and notification data (synchronous)
    for (const { project, sessions } of projectSessionResults) {
      for (const session of sessions) {
        const metadata = deps.sessionMetadataService?.getMetadata(session.id);
        const isArchived = metadata?.isArchived ?? session.isArchived ?? false;
        if (isArchived) continue;

        let pendingInputType: PendingInputType | undefined;
        let activity: AgentActivity | undefined;

        const process = deps.supervisor?.getProcessForSession(session.id);
        if (process) {
          const pendingRequest = process.getPendingInputRequest();
          if (pendingRequest) {
            pendingInputType =
              pendingRequest.type === "tool-approval"
                ? "tool-approval"
                : "user-question";
          }
          const state = process.state.type;
          if (state === "in-turn" || state === "waiting-input") {
            activity = state;
          }
        }

        const hasUnread = deps.notificationService
          ? deps.notificationService.hasUnread(session.id, session.updatedAt)
          : undefined;

        allSessions.push({
          session,
          projectName: project.name,
          pendingInputType,
          activity,
          hasUnread,
          customTitle: metadata?.customTitle ?? session.customTitle,
        });
      }
    }

    // Build the inbox response by categorizing into tiers
    const needsAttention: InboxItem[] = [];
    const active: InboxItem[] = [];
    const recentActivity: InboxItem[] = [];
    const unread8h: InboxItem[] = [];
    const unread24h: InboxItem[] = [];

    // Track which sessions have been assigned to a tier
    const assignedSessionIds = new Set<string>();

    // Helper to convert to InboxItem
    const toInboxItem = (item: (typeof allSessions)[0]): InboxItem => ({
      sessionId: item.session.id,
      projectId: item.session.projectId,
      projectName: item.projectName,
      sessionTitle: getSessionDisplayTitle({
        customTitle: item.customTitle,
        title: item.session.title,
      }),
      updatedAt: item.session.updatedAt,
      pendingInputType: item.pendingInputType,
      activity: item.activity,
      hasUnread: item.hasUnread,
    });

    // Tier 1: needsAttention - sessions with pending input
    for (const item of allSessions) {
      if (item.pendingInputType) {
        needsAttention.push(toInboxItem(item));
        assignedSessionIds.add(item.session.id);
      }
    }

    // Tier 2: active - in-turn sessions without pending input
    for (const item of allSessions) {
      if (assignedSessionIds.has(item.session.id)) continue;
      if (item.activity === "in-turn") {
        active.push(toInboxItem(item));
        assignedSessionIds.add(item.session.id);
      }
    }

    // Tier 3: recentActivity - updated in last 30 minutes
    for (const item of allSessions) {
      if (assignedSessionIds.has(item.session.id)) continue;
      const updatedAt = new Date(item.session.updatedAt).getTime();
      if (now - updatedAt <= THIRTY_MINUTES_MS) {
        recentActivity.push(toInboxItem(item));
        assignedSessionIds.add(item.session.id);
      }
    }

    // Tier 4: unread8h - unread and updated within 8 hours
    for (const item of allSessions) {
      if (assignedSessionIds.has(item.session.id)) continue;
      if (item.hasUnread) {
        const updatedAt = new Date(item.session.updatedAt).getTime();
        if (now - updatedAt <= EIGHT_HOURS_MS) {
          unread8h.push(toInboxItem(item));
          assignedSessionIds.add(item.session.id);
        }
      }
    }

    // Tier 5: unread24h - unread and updated within 24 hours
    for (const item of allSessions) {
      if (assignedSessionIds.has(item.session.id)) continue;
      if (item.hasUnread) {
        const updatedAt = new Date(item.session.updatedAt).getTime();
        if (now - updatedAt <= TWENTY_FOUR_HOURS_MS) {
          unread24h.push(toInboxItem(item));
          assignedSessionIds.add(item.session.id);
        }
      }
    }

    // Sort each tier by updatedAt descending (most recent first)
    const sortByUpdatedAt = (a: InboxItem, b: InboxItem) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();

    needsAttention.sort(sortByUpdatedAt);
    active.sort(sortByUpdatedAt);
    recentActivity.sort(sortByUpdatedAt);
    unread8h.sort(sortByUpdatedAt);
    unread24h.sort(sortByUpdatedAt);

    // Apply limits per tier
    const response: InboxResponse = {
      needsAttention: needsAttention.slice(0, MAX_ITEMS_PER_TIER),
      active: active.slice(0, MAX_ITEMS_PER_TIER),
      recentActivity: recentActivity.slice(0, MAX_ITEMS_PER_TIER),
      unread8h: unread8h.slice(0, MAX_ITEMS_PER_TIER),
      unread24h: unread24h.slice(0, MAX_ITEMS_PER_TIER),
    };

    return c.json(response);
  });

  return routes;
}
