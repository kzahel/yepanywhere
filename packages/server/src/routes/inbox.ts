import {
  creationCollectionRows,
  creationSessionSummary,
} from "../sessions/session-creation-view.js";
import { fromUrlProjectId } from "@yep-anywhere/shared";
import { getProjectName } from "../projects/paths.js";
/**
 * Inbox route - aggregates sessions across all projects into prioritized tiers.
 *
 * Tiers (in priority order):
 * 1. needsAttention - Sessions with pendingInputType set (tool-approval or user-question)
 * 2. active - In-turn sessions, idle sessions still retaining provider
 *    background work, or existing sessions targeted by pending Project Queue
 *    work, without pending input
 * 3. recentActivity - Sessions updated in the last 30 minutes (not in tiers 1-2)
 * 4. unread8h - Sessions with hasUnread and updatedAt within 8 hours (not in tiers 1-3)
 * 5. unread24h - Sessions with hasUnread and updatedAt within 24 hours (not in tiers 1-4)
 */

import { getSessionDisplayTitle } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { nonHumanUserTurnField } from "../metadata/SessionMetadataService.js";
import type {
  RetainedSessionCollectionState,
  SessionProviderPhase,
} from "@yep-anywhere/shared";
import type { RetainedSessionCollections } from "../services/RetainedSessionCollections.js";
import type { GlobalSessionsDeps } from "./global-sessions.js";
import { retainedSessionQuery } from "../services/retained-session-query.js";
import { accessibleProjectIdsForRequest } from "./global-sessions.js";
import type { SessionIndexService } from "../indexes/index.js";
import { SourceVersionedSingleFlight } from "../lib/sourceVersionedSingleFlight.js";
import { getLogger } from "../logging/logger.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { NotificationService } from "../notifications/index.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { CodexSessionReader } from "../sessions/codex-reader.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import { listSessionListSummariesAcrossProviders } from "../sessions/provider-resolution.js";
import { SessionCollectionGeneration } from "../sessions/sessionCollectionGeneration.js";
import type { GrokSessionReader } from "../sessions/grok-reader.js";
import type { PiSessionReader } from "../sessions/pi-reader.js";
import type { ISessionReader, SessionListSummary } from "../sessions/types.js";
import { getEffectiveProviderUpdatedAt } from "../sessions/recap-overlays.js";
import { sessionProviderPhaseFromProcess } from "../sessions/session-provider-phase.js";
import {
  inboxModelConfig,
  type InboxModelConfig,
} from "../sessions/inbox-model-config.js";
import { sessionRowRuntimeOverlay } from "../sessions/session-runtime-overlay.js";
import type { ProjectQueueService } from "../services/ProjectQueueService.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type {
  AgentActivity,
  PendingInputType,
  Project,
} from "../supervisor/types.js";
import type { EventBus } from "../watcher/index.js";
import type { ProjectDisplayNameResolver } from "../projects/paths.js";
import { buildProviderProjectCatalog } from "./provider-catalog.js";
import {
  getActiveSessionIndexOptions,
  isSessionAutoArchived,
} from "./session-list-options.js";

export interface InboxDeps {
  signal?: AbortSignal;
  retainedCollections?: RetainedSessionCollections;
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  supervisor?: Supervisor;
  notificationService?: NotificationService;
  sessionIndexService?: SessionIndexService;
  sessionMetadataService?: SessionMetadataService;
  projectQueueService?: Pick<ProjectQueueService, "listAll">;
  codexScanner?: CodexSessionScanner;
  codexSessionsDir?: string;
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  geminiScanner?: GeminiSessionScanner;
  geminiSessionsDir?: string;
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
  grokSessionsDir?: string;
  grokReaderFactory?: (projectPath: string) => GrokSessionReader;
  piSessionsDir?: string;
  piReaderFactory?: (projectPath: string) => PiSessionReader;
  eventBus?: EventBus;
  sessionAutoArchiveDays?: number;
  /** Names a retained row's project; defaults to the path's name. */
  projectDisplayName?: ProjectDisplayNameResolver;
  /**
   * Inbox rows carry no ownership, but the retained walk it shares with the
   * sidebar feeds reads it; the same tracker lets them share one walk.
   */
  externalTracker?: GlobalSessionsDeps["externalTracker"];
}

export interface InboxItem {
  /** Optional known settings; absence requires no capability check or request. */
  modelConfig?: InboxModelConfig;
  creation?: import("@yep-anywhere/shared").SessionCreationStatus;
  creationProvenance?: import("@yep-anywhere/shared").SessionCreationProvenance;
  nonHumanUserTurn?: import("@yep-anywhere/shared").NonHumanUserTurn | null;
  asyncQuestions?: SessionListSummary["asyncQuestions"];
  sessionId: string;
  projectId: string;
  projectName: string;
  sessionTitle?: string;
  updatedAt: string;
  customTitle?: string;
  isStarred?: boolean;
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  /** What an active session's provider is doing; absent on older servers. */
  providerPhase?: SessionProviderPhase;
  hasUnread?: boolean;
}

export interface InboxResponse {
  catalog?: RetainedSessionCollectionState;
  needsAttention: InboxItem[];
  active: InboxItem[];
  recentActivity: InboxItem[];
  unread8h: InboxItem[];
  unread24h: InboxItem[];
}

/** Maximum items per tier to keep response size manageable */
const MAX_ITEMS_PER_TIER = 20;

/**
 * How much enriched inbox state to retain across requests. Rows are compact
 * summaries, not transcripts; this bounds an unusually large install rather
 * than sizing an expected one.
 */
const INBOX_RETENTION_BYTES = 8 * 1024 * 1024;

/** One session, walked and enriched, before any tier decision is made. */
interface EnrichedInboxSession {
  modelConfig?: InboxModelConfig;
  nonHumanUserTurn?: InboxItem["nonHumanUserTurn"];
  creation?: InboxItem["creation"];
  creationProvenance?: InboxItem["creationProvenance"];
  session: SessionListSummary;
  projectName: string;
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  hasUnread?: boolean;
  customTitle?: string;
  isStarred?: boolean;
}

/** Time thresholds in milliseconds */
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function getActiveProjectQueueSessionIds(
  projectQueueService: InboxDeps["projectQueueService"],
): Set<string> {
  const sessionIds = new Set<string>();
  if (!projectQueueService) return sessionIds;

  for (const item of projectQueueService.listAll()) {
    if (
      item.target.type === "existing-session" &&
      (item.status === "queued" || item.status === "dispatching")
    ) {
      sessionIds.add(item.target.sessionId);
    }
  }

  return sessionIds;
}

export function createInboxRoutes(deps: InboxDeps): Hono {
  const routes = new Hono();

  const collectionGeneration = new SessionCollectionGeneration(
    deps.eventBus,
    () =>
      deps.signal?.aborted
        ? undefined
        : deps.sessionMetadataService?.creations?.generation,
  );
  /**
   * One walk per (project filter, generation), however many tabs ask for it.
   *
   * The Inbox is mounted by the app shell, so a herd of tabs reconnecting used
   * to run a herd of independent walks over every project — the same defect
   * `GET /api/sessions` had. The generation is the collection's, so the same
   * deny-list over bus events decides when a retained walk stops being usable.
   *
   * `isCurrent` is vacuous for the reason it is on the global session walk: the
   * generation is read before the walk, so a change landing mid-walk leaves the
   * retained entry unreachable rather than wrong.
   */
  const inboxWalks = new SourceVersionedSingleFlight<
    string,
    EnrichedInboxSession[]
  >({
    maxRetainedBytes: INBOX_RETENTION_BYTES,
    estimateBytes: (value) => value.length * 512,
  });

  async function walkInbox(
    filterProjectId: string | undefined,
  ): Promise<EnrichedInboxSession[]> {
    const allProjects = await deps.scanner.listProjects();

    // Filter to single project if projectId query param provided
    const projects = filterProjectId
      ? allProjects.filter((p) => p.id === filterProjectId)
      : allProjects;

    const allSessions: EnrichedInboxSession[] = [];

    const logger = getLogger();
    const providerCatalog = await buildProviderProjectCatalog({
      codexScanner: deps.codexScanner,
      geminiScanner: deps.geminiScanner,
    });
    const listOptions = getActiveSessionIndexOptions(
      deps.sessionAutoArchiveDays,
    );

    // Fetch sessions from all projects in parallel
    const projectSessionResults = await Promise.all(
      projects.map(async (project) => {
        try {
          const sessions = await listSessionListSummariesAcrossProviders(
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
            listOptions,
          );
          return { project, sessions };
        } catch (err) {
          logger.warn(
            { err, projectId: project.id },
            "Failed to fetch sessions for inbox project",
          );
          return { project, sessions: [] as SessionListSummary[] };
        }
      }),
    );

    // Enrich each session with process state and notification data
    for (const { project, sessions } of projectSessionResults) {
      for (const session of sessions) {
        const metadata = deps.sessionMetadataService?.getMetadata(session.id);
        const isArchived = metadata?.isArchived ?? session.isArchived ?? false;
        if (isArchived) continue;

        const process = deps.supervisor?.getProcessForSession(session.id);
        const effectiveUpdatedAt = getEffectiveProviderUpdatedAt(
          session.updatedAt,
          process,
        );
        const effectiveSession =
          effectiveUpdatedAt === session.updatedAt
            ? session
            : { ...session, updatedAt: effectiveUpdatedAt };
        // Retained background work reads as "in-turn" here too, so such a
        // session lands in the Active tier rather than Recent Activity.
        const { pendingInputType, activity, hasUnread } =
          sessionRowRuntimeOverlay(process, {
            sessionId: session.id,
            providerUpdatedAt: effectiveUpdatedAt,
            notificationService: deps.notificationService,
          });

        allSessions.push({
          modelConfig: inboxModelConfig(session.provider, process, metadata),
          session: effectiveSession,
          projectName: project.name,
          pendingInputType,
          activity,
          hasUnread,
          customTitle: metadata?.customTitle ?? session.customTitle,
          creationProvenance: metadata?.creationProvenance,
          isStarred: metadata?.isStarred ?? session.isStarred ?? false,
        });
      }
    }

    const control = creationCollectionRows(
        deps.sessionMetadataService,
        deps.signal,
      ),
      byId = new Map(control.map((row) => [String(row.sessionId), row]));
    const visible = allSessions.filter((item) => {
      const row = byId.get(item.session.id);
      if (row?.deleted || (row && !row.nativeBound)) return false;
      if (row) item.creation = row.creation;
      return true;
    });
    const seen = new Set(visible.map((item) => item.session.id));
    if (deps.sessionMetadataService)
      for (const row of control) {
        if (seen.has(row.sessionId)) continue;
        const summary = creationSessionSummary(
          row,
          deps.sessionMetadataService,
        );
        if (
          !summary ||
          (filterProjectId && summary.projectId !== filterProjectId) ||
          (summary.isArchived ??
            isSessionAutoArchived(summary, listOptions?.activeAfterMs))
        )
          continue;
        visible.push({
          modelConfig: inboxModelConfig(
            summary.provider,
            undefined,
            deps.sessionMetadataService.getMetadata(summary.id),
          ),
          session: summary,
          projectName: (deps.projectDisplayName ?? getProjectName)(
            fromUrlProjectId(summary.projectId),
          ),
          creation: row.creation,
          creationProvenance: summary.creationProvenance,
          customTitle: summary.customTitle,
          isStarred: summary.isStarred,
          hasUnread: false,
        });
      }
    return visible;
  }

  async function readInbox(
    filterProjectId: string | undefined,
  ): Promise<EnrichedInboxSession[]> {
    const result = await inboxWalks.run({
      key: filterProjectId ?? "",
      sourceVersion: String(collectionGeneration.current),
      compute: () => walkInbox(filterProjectId),
      isCurrent: () => true,
    });
    if (result.status === "stale") {
      // Unreachable while `isCurrent` is vacuous; walking again is the only
      // answer that cannot be wrong if that ever changes.
      return walkInbox(filterProjectId);
    }
    return result.value;
  }

  // GET /api/inbox - Get prioritized inbox of sessions
  // Optional query param: projectId - filter to a single project
  routes.get("/", async (c) => {
    const now = Date.now();
    const filterProjectId = c.req.query("projectId");

    // Only the walk is retained. Tier membership is a wall-clock decision —
    // 30 minutes, 8 hours, 24 hours — so retaining a tiered response would
    // freeze those windows at the instant of the walk, and a session would
    // stay in "Recent Activity" for as long as nothing on the bus moved.
    const activeProjectQueueSessionIds = getActiveProjectQueueSessionIds(
      deps.projectQueueService,
    );
    const retained =
      c.req.query("summaryMode") === "retained" && deps.retainedCollections
        ? await retainedSessionQuery(deps.retainedCollections, deps).inbox({
            projectId: filterProjectId,
            accessibleProjectIds: accessibleProjectIdsForRequest(c),
            queueIds: [...activeProjectQueueSessionIds],
            now,
          })
        : undefined;
    const allSessions: EnrichedInboxSession[] = retained
      ? retained.sessions
          .filter(
            (item) =>
              !item.isArchived &&
              (!filterProjectId || item.projectId === filterProjectId),
          )
          .map((item) => ({
            modelConfig: item.modelConfig,
            session: {
              id: item.id,
              projectId: item.projectId as Project["id"],
              title: item.title ?? null,
              fullTitle: item.fullTitle ?? null,
              updatedAt: item.updatedAt,
              provider: item.provider,
              ...(item.asyncQuestions
                ? { asyncQuestions: item.asyncQuestions }
                : {}),
            },
            projectName: item.projectName,
            pendingInputType: item.pendingInputType,
            activity: item.activity,
            hasUnread: item.hasUnread,
            customTitle: item.customTitle,
            creationProvenance: item.creationProvenance,
            creation: item.creation,
            nonHumanUserTurn: item.nonHumanUserTurn,
            isStarred: item.isStarred,
          }))
      : await readInbox(filterProjectId);

    // Build the inbox response by categorizing into tiers
    const needsAttention: InboxItem[] = [];
    const active: InboxItem[] = [];
    const recentActivity: InboxItem[] = [];
    const unread8h: InboxItem[] = [];
    const unread24h: InboxItem[] = [];

    // Track which sessions have been assigned to a tier
    const assignedSessionIds = new Set<string>();

    // Helper to convert to InboxItem
    const toInboxItem = (
      item: EnrichedInboxSession,
      nonHumanUserTurn = item.nonHumanUserTurn !== undefined
        ? item.nonHumanUserTurn
        : nonHumanUserTurnField(deps.sessionMetadataService, item.session.id),
    ): InboxItem => ({
      modelConfig:
        inboxModelConfig(
          item.session.provider,
          deps.supervisor?.getProcessForSession(item.session.id),
          undefined,
        ) ?? item.modelConfig,
      nonHumanUserTurn,
      sessionId: item.session.id,
      projectId: item.session.projectId,
      projectName: item.projectName,
      sessionTitle:
        retained && item.session.title == null && !item.customTitle
          ? undefined
          : getSessionDisplayTitle({
              customTitle: item.customTitle,
              title: item.session.title,
            }),
      updatedAt: item.session.updatedAt,
      customTitle: item.customTitle,
      creationProvenance: item.creationProvenance,
      creation: item.creation,
      isStarred: item.isStarred,
      pendingInputType: item.pendingInputType,
      activity: item.activity,
      providerPhase:
        item.activity === "in-turn"
          ? sessionProviderPhaseFromProcess(
              deps.supervisor?.getProcessForSession(item.session.id),
            )
          : undefined,
      hasUnread: item.hasUnread,
      asyncQuestions: item.session.asyncQuestions,
    });

    // Tier 1: needsAttention - sessions with pending input
    for (const item of allSessions) {
      const nonHumanUserTurn =
        item.nonHumanUserTurn !== undefined
          ? item.nonHumanUserTurn
          : nonHumanUserTurnField(deps.sessionMetadataService, item.session.id);
      if (item.pendingInputType || nonHumanUserTurn) {
        needsAttention.push(toInboxItem(item, nonHumanUserTurn));
        assignedSessionIds.add(item.session.id);
      }
    }

    // Tier 2: active - live sessions and sessions with pending Project Queue work
    for (const item of allSessions) {
      if (assignedSessionIds.has(item.session.id)) continue;
      if (
        item.activity === "in-turn" ||
        activeProjectQueueSessionIds.has(item.session.id)
      ) {
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
      ...(retained ? { catalog: retained.catalog } : {}),
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
