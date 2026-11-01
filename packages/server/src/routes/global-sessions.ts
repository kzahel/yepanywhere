/**
 * Global sessions route - returns all sessions across all projects.
 *
 * Unlike the inbox route which categorizes sessions into tiers,
 * this returns a flat list suitable for navigation/sidebar use.
 */

import type { SessionClearloopBadge } from "@yep-anywhere/shared";
import {
  isUrlProjectId,
  type ProviderChildSessionSummary,
  type ProviderName,
  type NonHumanUserTurn,
  type SessionCreationProvenance,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { type Principal, PRINCIPAL_VARIABLE } from "../auth/principal.js";
import { nonHumanUserTurnField } from "../metadata/SessionMetadataService.js";
import type { RetainedSessionCollectionState } from "@yep-anywhere/shared";
import type { RetainedSessionCollections } from "../services/RetainedSessionCollections.js";
import { readRetainedSessionItems } from "./retained-session-collections.js";
import { createSessionContentSearchRoutes } from "./session-content-search.js";
import type { SessionIndexService } from "../indexes/index.js";
import type { SessionIndexListOptions } from "../indexes/types.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { NotificationService } from "../notifications/index.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import {
  isDetachedProjectPath,
  type ProjectDisplayNameResolver,
} from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { CodexSessionReader } from "../sessions/codex-reader.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import { attachProviderChildSessions } from "../sessions/provider-child-sessions.js";
import { listSessionsAcrossProviders } from "../sessions/provider-resolution.js";
import { providerResolutionDeps } from "./session-provider-resolution.js";
import type { GrokSessionReader } from "../sessions/grok-reader.js";
import type { PiSessionReader } from "../sessions/pi-reader.js";
import type { ISessionReader } from "../sessions/types.js";
import {
  applyRecapOverlayToSummary,
  getEffectiveProviderUpdatedAt,
  hasUnreadProviderContent,
} from "../sessions/recap-overlays.js";
import { sessionRowRuntimeOverlay } from "../sessions/session-runtime-overlay.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type {
  AgentActivity,
  PendingInputType,
  Project,
  SessionOwnership,
  SessionSummary,
} from "../supervisor/types.js";
import type { BusEvent, EventBus } from "../watcher/index.js";
import { SourceVersionedSingleFlight } from "../lib/sourceVersionedSingleFlight.js";
import { SessionCollectionGeneration } from "../sessions/sessionCollectionGeneration.js";
import { buildProviderProjectCatalog } from "./provider-catalog.js";
import {
  getActiveSessionIndexOptions,
  isSessionAutoArchived,
} from "./session-list-options.js";
import type { ClearloopBadgeResolver } from "../services/ClearloopService.js";

export interface GlobalSessionsDeps {
  signal?: AbortSignal;
  retainedCollections?: RetainedSessionCollections;
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  supervisor?: Supervisor;
  externalTracker?: ExternalSessionTracker;
  notificationService?: NotificationService;
  sessionIndexService?: SessionIndexService;
  sessionMetadataService?: SessionMetadataService;
  getClearloopBadge?: ClearloopBadgeResolver;
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
  /** Event bus for cache invalidation */
  eventBus?: EventBus;
  /** Sessions older than this many days are hidden from default scans. 0 disables. */
  sessionAutoArchiveDays?: number;
  /** Names a retained row's project; defaults to the path's name. */
  projectDisplayName?: ProjectDisplayNameResolver;
}

export interface GlobalSessionItem {
  // From cache (cheap)
  id: string;
  title?: string | null;
  fullTitle?: string | null;
  createdAt?: string;
  updatedAt: string;
  messageCount?: number;
  provider: ProviderName;
  /** Last active model for this session (from JSONL), for list/badge display. */
  model?: string;
  // Project context
  projectId: string;
  projectName: string;
  // Enrichment (all in-memory, cheap)
  ownership: SessionOwnership;
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  hasUnread?: boolean;
  customTitle?: string;
  isArchived?: boolean;
  isStarred?: boolean;
  /** User-named sidebar category; absent when the session has none. */
  sidebarCategory?: string;
  /** Limited user who started the session; absent means the superuser. */
  createdByUser?: string;
  /** Iterations a running `/clearloop` still has to do; absent when none runs. */
  clearloop?: SessionClearloopBadge;
  /** True when an explicit manual termination disabled automatic resume. */
  autoResumeDisabled?: boolean;
  /** Interactive Mother session for a YA-owned `/btw` aside. */
  parentSessionId?: string;
  parentSessionKind?: "btw-aside";
  /** Source session whose provider transcript was cloned or forked. */
  forkedFromSessionId?: string;
  creationProvenance?: SessionCreationProvenance;
  /** Initial prompt text accepted by YA for new-session recovery/copy. */
  initialPrompt?: string;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Capped excerpt of the most recent visible agent turn or provider recap. */
  lastAgentText?: string;
  /** When someone last wrote into this session; agent work never advances it. */
  lastHumanTurnAt?: string;
  asyncQuestions?: SessionSummary["asyncQuestions"];
  nonHumanUserTurn?: NonHumanUserTurn | null;
  /** Provider-launched child work nested under this parent. Absent when none. */
  providerChildren?: ProviderChildSessionSummary[];
}

/** Stats about all sessions (computed during full scan) */
export interface GlobalSessionStats {
  totalCount: number;
  unreadCount: number;
  starredCount: number;
  archivedCount: number;
  /** Counts per provider (non-archived only) */
  providerCounts: Partial<Record<ProviderName, number>>;
  /** Counts per executor host (non-archived only, "local" key for sessions without executor) */
  executorCounts: Record<string, number>;
}

/** Minimal project info for filter dropdowns */
export interface ProjectOption {
  id: string;
  name: string;
}

export interface GlobalSessionsResponse {
  catalog?: RetainedSessionCollectionState;
  sessions: GlobalSessionItem[];
  hasMore: boolean;
  /** Global stats computed from all sessions (not just paginated results) */
  stats: GlobalSessionStats;
  /** All projects for filter dropdown */
  projects: ProjectOption[];
  /**
   * The collection revision this response reflects. A client may send it back
   * as `knownGeneration` to get {@link GlobalSessionsUnchangedResponse} instead
   * of another full walk. Gated by `progressive-session-catalog`.
   */
  generation?: number;
}

/**
 * The answer to a conditional read whose `knownGeneration` still holds. It
 * carries no rows: the client keeps the ones it has.
 */
export interface GlobalSessionsUnchangedResponse {
  unchanged: true;
  generation: number;
}

/** Default limit for sessions per page */
const DEFAULT_LIMIT = 100;

/** Maximum allowed limit */
const MAX_LIMIT = 500;
/** Stats cache TTL in milliseconds */
const STATS_CACHE_TTL_MS = 5000;

/**
 * How much enriched collection state to retain across requests. Rows are
 * compact summaries, not transcripts; this bounds an unusually large install
 * rather than sizing an expected one.
 */
const COLLECTION_RETENTION_BYTES = 16 * 1024 * 1024;

interface CollectionRequest {
  filterProjectId?: string;
  searchQuery?: string;
  afterCursor?: string;
  includeArchived: boolean;
  starredOnly: boolean;
  /** Admit only sessions filed under a sidebar category. */
  categorizedOnly: boolean;
  includeStats: boolean;
  limit: number;
  /** Sorted project ids visible to a limited principal; absent for superuser. */
  accessibleProjectIds?: string[];
  /** The generation observed before the walk; stamped on the response. */
  generation: number;
}

function accessibleProjectIdsForRequest(c: {
  get: (key: string) => unknown;
}): string[] | undefined {
  const principal = c.get(PRINCIPAL_VARIABLE) as Principal | undefined;
  if (!principal || principal.kind === "superuser") return undefined;
  return [
    ...new Set([
      ...principal.grants.newSessionProjects,
      ...principal.grants.joinProjects,
      ...principal.grants.viewProjects,
    ]),
  ].sort();
}

function statsForSessionItems(
  sessions: readonly GlobalSessionItem[],
): GlobalSessionStats {
  const stats = createEmptyStats();
  for (const session of sessions) {
    if (session.isStarred) stats.starredCount += 1;
    if (session.isArchived) {
      stats.archivedCount += 1;
      continue;
    }
    stats.totalCount += 1;
    if (session.hasUnread) stats.unreadCount += 1;
    stats.providerCounts[session.provider] =
      (stats.providerCounts[session.provider] ?? 0) + 1;
    const executor = session.executor ?? "local";
    stats.executorCounts[executor] = (stats.executorCounts[executor] ?? 0) + 1;
  }
  return stats;
}

/**
 * Which rows a `GET /api/sessions` query admits.
 *
 * The retained read and the full walk answer the same contract, so the fields
 * a `q` matches — and the archived/starred/project rules around it — are
 * decided here once. Divergence here is invisible to a client: it just gets
 * fewer rows in one summary mode than the other for the same query.
 *
 * `searchQuery` is already lowercased by the route.
 */
function matchesGlobalSessionQuery(
  row: Pick<
    GlobalSessionItem,
    | "title"
    | "customTitle"
    | "projectName"
    | "initialPrompt"
    | "projectId"
    | "isArchived"
    | "isStarred"
    | "sidebarCategory"
  >,
  query: Pick<
    CollectionRequest,
    | "filterProjectId"
    | "searchQuery"
    | "includeArchived"
    | "starredOnly"
    | "categorizedOnly"
  >,
): boolean {
  if (row.isArchived && !query.includeArchived) return false;
  if (query.starredOnly && !row.isStarred) return false;
  if (query.categorizedOnly && !row.sidebarCategory) return false;
  if (query.filterProjectId && row.projectId !== query.filterProjectId) {
    return false;
  }
  const needle = query.searchQuery;
  if (!needle) return true;
  return [row.title, row.customTitle, row.projectName, row.initialPrompt].some(
    (text) => text?.toLowerCase().includes(needle),
  );
}

/** Cursor pagination: a page holds rows strictly older than the client's last. */
function isBeforeCursor(updatedAt: string, afterCursor?: string): boolean {
  if (!afterCursor) return true;
  return Date.parse(updatedAt) < Date.parse(afterCursor);
}

function createEmptyStats(): GlobalSessionStats {
  return {
    totalCount: 0,
    unreadCount: 0,
    starredCount: 0,
    archivedCount: 0,
    providerCounts: {},
    executorCounts: {},
  };
}

export function createGlobalSessionsRoutes(deps: GlobalSessionsDeps): Hono {
  const routes = new Hono();
  routes.route("/", createSessionContentSearchRoutes(deps));
  let cachedStats: { value: GlobalSessionStats; timestamp: number } | null =
    null;
  let statsDirty = true;
  let inFlightStats: Promise<GlobalSessionStats> | null = null;

  const collectionGeneration = new SessionCollectionGeneration(deps.eventBus);
  const collectionWalks = new SourceVersionedSingleFlight<
    string,
    GlobalSessionsResponse
  >({
    maxRetainedBytes: COLLECTION_RETENTION_BYTES,
    estimateBytes: (value) =>
      // Row count is the term that actually varies; the constant is a rough
      // per-row summary size, not a measurement of any particular install.
      value.sessions.length * 512 + value.projects.length * 64,
  });

  const shouldInvalidateStats = (event: BusEvent): boolean => {
    switch (event.type) {
      case "file-change":
      case "session-created":
      case "session-updated":
      case "session-seen":
      case "session-metadata-changed":
        return true;
      default:
        return false;
    }
  };

  const invalidateStats = (): void => {
    statsDirty = true;
  };

  if (deps.eventBus) {
    deps.eventBus.subscribe((event) => {
      if (shouldInvalidateStats(event)) {
        invalidateStats();
      }
    });
  }

  const getDefaultListOptions = (): SessionIndexListOptions | undefined =>
    getActiveSessionIndexOptions(deps.sessionAutoArchiveDays);

  const listSessionsForProject = async (
    project: Project,
    providerCatalog: Awaited<ReturnType<typeof buildProviderProjectCatalog>>,
    options?: SessionIndexListOptions,
  ): Promise<SessionSummary[]> => {
    return listSessionsAcrossProviders(
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
      options,
    );
  };

  const computeGlobalStats = async (
    accessibleProjectIds?: ReadonlySet<string>,
  ): Promise<GlobalSessionStats> => {
    const projects = await deps.scanner.listProjects();
    const stats: GlobalSessionStats = createEmptyStats();
    const providerCatalog = await buildProviderProjectCatalog({
      projects,
      codexScanner: deps.codexScanner,
      geminiScanner: deps.geminiScanner,
    });

    const statsListOptions = getDefaultListOptions();
    const statsAutoArchiveAfterMs = statsListOptions?.activeAfterMs;

    for (const project of projects) {
      const sessions = await listSessionsForProject(
        project,
        providerCatalog,
        statsListOptions,
      );
      for (const session of sessions) {
        const metadata = deps.sessionMetadataService?.getMetadata(session.id);
        const effectiveProjectId =
          metadata?.workingProjectId ?? session.projectId;
        if (
          accessibleProjectIds &&
          !accessibleProjectIds.has(effectiveProjectId)
        ) {
          continue;
        }
        const overlaidSession = deps.sessionMetadataService
          ? applyRecapOverlayToSummary(
              session,
              deps.sessionMetadataService.getRecapMessages(session.id),
            )
          : session;
        const isArchived =
          metadata?.isArchived ??
          overlaidSession.isArchived ??
          isSessionAutoArchived(overlaidSession, statsAutoArchiveAfterMs);
        const isStarred = metadata?.isStarred ?? session.isStarred ?? false;
        const executor = metadata?.executor;
        const process = deps.supervisor?.getProcessForSession(session.id);
        const effectiveProviderUpdatedAt = getEffectiveProviderUpdatedAt(
          session.updatedAt,
          process,
        );

        const hasUnread =
          hasUnreadProviderContent(
            deps.notificationService,
            session.id,
            effectiveProviderUpdatedAt,
          ) ?? false;

        if (isArchived) {
          stats.archivedCount++;
        } else {
          stats.totalCount++;
          if (hasUnread) stats.unreadCount++;
          if (overlaidSession.provider) {
            stats.providerCounts[overlaidSession.provider] =
              (stats.providerCounts[overlaidSession.provider] ?? 0) + 1;
          }
          const executorKey = executor ?? "local";
          stats.executorCounts[executorKey] =
            (stats.executorCounts[executorKey] ?? 0) + 1;
        }
        if (isStarred) stats.starredCount++;
      }
    }

    return stats;
  };

  const getCachedGlobalStats = async (
    accessibleProjectIds?: readonly string[],
  ): Promise<GlobalSessionStats> => {
    // Limited-user grant sets are small and mutable. Compute their scoped
    // view directly rather than sharing the superuser's host-wide cache or
    // adding principal state to that cache's lifecycle.
    if (accessibleProjectIds) {
      return computeGlobalStats(new Set(accessibleProjectIds));
    }
    const now = Date.now();
    const isFresh =
      cachedStats &&
      !statsDirty &&
      now - cachedStats.timestamp < STATS_CACHE_TTL_MS;
    if (isFresh && cachedStats) {
      return cachedStats.value;
    }

    if (inFlightStats) {
      return inFlightStats;
    }

    const statsPromise = computeGlobalStats()
      .then((stats) => {
        cachedStats = { value: stats, timestamp: Date.now() };
        statsDirty = false;
        return stats;
      })
      .finally(() => {
        if (inFlightStats === statsPromise) {
          inFlightStats = null;
        }
      });

    inFlightStats = statsPromise;
    return statsPromise;
  };

  // GET /api/sessions/stats - Get cached global session stats
  routes.get("/stats", async (c) => {
    const filterProjectId = c.req.query("project");
    if (filterProjectId) {
      return c.json({ stats: createEmptyStats() });
    }

    const stats = await getCachedGlobalStats(accessibleProjectIdsForRequest(c));
    return c.json({ stats });
  });

  // GET /api/sessions - Get all sessions with pagination
  routes.get("/", async (c) => {
    // Parse query params
    const filterProjectId = c.req.query("project");
    const searchQuery = c.req.query("q")?.toLowerCase();
    const afterCursor = c.req.query("after");
    const includeArchived = c.req.query("includeArchived") === "true";
    const starredOnly = c.req.query("starred") === "true";
    const categorizedOnly = c.req.query("categorized") === "true";
    const includeStats = c.req.query("includeStats") === "true";
    const limitParam = c.req.query("limit");
    const limit = Math.min(
      Math.max(1, Number.parseInt(limitParam || "", 10) || DEFAULT_LIMIT),
      MAX_LIMIT,
    );
    const accessibleProjectIds = accessibleProjectIdsForRequest(c);
    const accessibleProjectIdSet = accessibleProjectIds
      ? new Set(accessibleProjectIds)
      : undefined;

    // Read before the walk, never after: a change landing mid-walk must leave
    // the client's token behind the current generation, so its next
    // conditional read is answered `changed`. Stamping the response with the
    // post-walk value would certify rows the response does not contain.
    const generation = collectionGeneration.current;
    if (c.req.query("summaryMode") === "retained" && deps.retainedCollections) {
      const retained = await readRetainedSessionItems(
        deps.retainedCollections,
        deps,
      );
      const accessibleSessions = retained.sessions.filter(
        (row) =>
          !accessibleProjectIdSet || accessibleProjectIdSet.has(row.projectId),
      );
      const rows = accessibleSessions.filter(
        (row) =>
          matchesGlobalSessionQuery(row, {
            filterProjectId,
            searchQuery,
            includeArchived,
            starredOnly,
            categorizedOnly,
          }) && isBeforeCursor(row.updatedAt, afterCursor),
      );
      return c.json({
        ...retained,
        sessions: rows.slice(0, limit),
        hasMore: rows.length > limit,
        stats: accessibleProjectIdSet
          ? statsForSessionItems(accessibleSessions)
          : retained.stats,
        projects: retained.projects.filter(
          (project) =>
            !accessibleProjectIdSet || accessibleProjectIdSet.has(project.id),
        ),
      });
    }
    // A cursor page is not a whole-collection read, so it never short-circuits;
    // the token only means "the collection behind an identical query is
    // unchanged", which is why the client must replay it against the same
    // parameters it received it from.
    const knownGeneration = Number.parseInt(
      c.req.query("knownGeneration") ?? "",
      10,
    );
    if (!afterCursor && collectionGeneration.matches(knownGeneration)) {
      const unchanged: GlobalSessionsUnchangedResponse = {
        unchanged: true,
        generation,
      };
      return c.json(unchanged);
    }

    return c.json(
      await readCollection({
        filterProjectId,
        searchQuery,
        afterCursor,
        includeArchived,
        starredOnly,
        categorizedOnly,
        includeStats,
        limit,
        accessibleProjectIds,
        generation,
      }),
    );
  });

  /**
   * One walk per (query, generation), however many tabs ask for it.
   *
   * Twenty clients reconnecting at once used to run twenty independent walks of
   * every project, and a client without `progressive-session-catalog` — which
   * cannot send a known generation — repeats its walk on every revalidation
   * forever. Retention is what keeps that ungated client's fallback a
   * performance floor rather than a penalty.
   *
   * `isCurrent` is deliberately vacuous. A generation advancing mid-walk does
   * not invalidate the answer, because the response is stamped with the
   * generation read *before* the walk: the rows are a correct snapshot for that
   * generation, and the client's next conditional read is told `changed`.
   * Discarding the completion instead would leave a busy server unable to
   * answer at all, and the retained entry is unreachable afterwards anyway
   * since the generation only moves forward.
   */
  async function readCollection(
    request: CollectionRequest,
  ): Promise<GlobalSessionsResponse> {
    const result = await collectionWalks.run({
      key: JSON.stringify([
        request.filterProjectId ?? null,
        request.searchQuery ?? null,
        request.afterCursor ?? null,
        request.includeArchived,
        request.starredOnly,
        request.categorizedOnly,
        request.includeStats,
        request.limit,
        request.accessibleProjectIds ?? null,
      ]),
      sourceVersion: String(request.generation),
      compute: () => walkCollection(request),
      isCurrent: () => true,
    });
    if (result.status === "stale") {
      // Unreachable while `isCurrent` is vacuous; walking again is the only
      // answer that cannot be wrong if that ever changes.
      return walkCollection(request);
    }
    return result.value;
  }

  async function walkCollection(
    request: CollectionRequest,
  ): Promise<GlobalSessionsResponse> {
    const {
      filterProjectId,
      afterCursor,
      includeArchived,
      includeStats,
      limit,
      accessibleProjectIds,
      generation,
    } = request;
    const accessibleProjectIdSet = accessibleProjectIds
      ? new Set(accessibleProjectIds)
      : undefined;

    // Get all projects
    const allProjects = await deps.scanner.listProjects();

    const projectsById = new Map(allProjects.map((p) => [p.id, p]));
    // Project filtering applies to the effective YA project after session
    // metadata is read, so scan every transcript project and filter below.
    const projects = allProjects;

    // Build project options for filter dropdown (from all projects, sorted by name)
    const projectOptions: ProjectOption[] = allProjects
      .filter(
        (project) =>
          !isDetachedProjectPath(project.path) &&
          (!accessibleProjectIdSet || accessibleProjectIdSet.has(project.id)),
      )
      .map((p) => ({ id: p.id, name: p.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Collect all sessions with enriched data
    const allSessions: GlobalSessionItem[] = [];
    const providerCatalog = await buildProviderProjectCatalog({
      projects: allProjects,
      codexScanner: deps.codexScanner,
      geminiScanner: deps.geminiScanner,
    });

    const defaultListOptions = getDefaultListOptions();
    const listOptions = includeArchived ? undefined : defaultListOptions;
    const autoArchiveAfterMs = defaultListOptions?.activeAfterMs;

    for (const project of projects) {
      const sessions = await listSessionsForProject(
        project,
        providerCatalog,
        listOptions,
      );

      // Enrich each session
      for (const session of sessions) {
        // Get session metadata
        const metadata = deps.sessionMetadataService?.getMetadata(session.id);
        const overlaidSession = deps.sessionMetadataService
          ? applyRecapOverlayToSummary(
              session,
              deps.sessionMetadataService.getRecapMessages(session.id),
            )
          : session;
        const effectiveProjectId =
          metadata?.workingProjectId ?? session.projectId;
        const effectiveProject =
          projectsById.get(effectiveProjectId) ?? project;

        const isArchived =
          metadata?.isArchived ??
          overlaidSession.isArchived ??
          isSessionAutoArchived(overlaidSession, autoArchiveAfterMs);
        const isStarred =
          metadata?.isStarred ?? overlaidSession.isStarred ?? false;
        const customTitle =
          metadata?.customTitle ?? overlaidSession.customTitle;
        const parentSessionId =
          metadata?.parentSessionId ?? overlaidSession.parentSessionId;
        const parentSessionKind =
          metadata?.parentSessionKind ?? overlaidSession.parentSessionKind;
        const forkedFromSessionId =
          metadata?.forkedFromSessionId ?? overlaidSession.forkedFromSessionId;
        const initialPrompt =
          metadata?.initialPrompt ?? overlaidSession.fullTitle;
        const executor = metadata?.executor;

        // Compute status
        const process = deps.supervisor?.getProcessForSession(session.id);
        const effectiveProviderUpdatedAt = getEffectiveProviderUpdatedAt(
          session.updatedAt,
          process,
        );
        const effectiveUpdatedAt = getEffectiveProviderUpdatedAt(
          overlaidSession.updatedAt,
          process,
        );
        const { ownership, pendingInputType, activity, hasUnread } =
          sessionRowRuntimeOverlay(process, {
            sessionId: session.id,
            providerUpdatedAt: effectiveProviderUpdatedAt,
            notificationService: deps.notificationService,
            externalTracker: deps.externalTracker,
            fallbackOwnership: session.ownership,
          });

        // Admission is decided on the finished row, by the same predicate the
        // retained read uses, so neither mode can match fields the other does
        // not. Enriching a row we then discard costs only in-memory lookups;
        // every project is walked either way.
        const item: GlobalSessionItem = {
          id: overlaidSession.id,
          title: overlaidSession.title,
          fullTitle: overlaidSession.fullTitle,
          createdAt: overlaidSession.createdAt,
          updatedAt: effectiveUpdatedAt,
          messageCount: overlaidSession.messageCount,
          provider: overlaidSession.provider,
          model: overlaidSession.model,
          projectId: effectiveProjectId,
          projectName: effectiveProject.name,
          ownership,
          pendingInputType,
          activity,
          hasUnread,
          customTitle,
          isArchived,
          isStarred,
          sidebarCategory: metadata?.sidebarCategory,
          createdByUser: metadata?.createdByUser,
          autoResumeDisabled: metadata?.autoResumeDisabled === true,
          parentSessionId,
          parentSessionKind,
          forkedFromSessionId,
          creationProvenance: metadata?.creationProvenance,
          clearloop: deps.getClearloopBadge?.(overlaidSession.id),
          initialPrompt: initialPrompt ?? undefined,
          executor,
          lastAgentText: overlaidSession.lastAgentText,
          lastHumanTurnAt: overlaidSession.lastHumanTurnAt,
          asyncQuestions: overlaidSession.asyncQuestions,
          nonHumanUserTurn: nonHumanUserTurnField(
            deps.sessionMetadataService,
            overlaidSession.id,
          ),
        };

        if (
          accessibleProjectIdSet &&
          !accessibleProjectIdSet.has(item.projectId)
        ) {
          continue;
        }
        if (!matchesGlobalSessionQuery(item, request)) continue;
        allSessions.push(item);
      }
    }

    const resolutionDeps = providerResolutionDeps(deps);
    const sessionsByProject = new Map<string, GlobalSessionItem[]>();
    for (const session of allSessions) {
      const existing = sessionsByProject.get(session.projectId);
      if (existing) {
        existing.push(session);
      } else {
        sessionsByProject.set(session.projectId, [session]);
      }
    }
    const sessionsWithChildren: GlobalSessionItem[] = [];
    for (const [projectId, projectSessions] of sessionsByProject) {
      const sessionProject = isUrlProjectId(projectId)
        ? projectsById.get(projectId)
        : undefined;
      if (!sessionProject) {
        sessionsWithChildren.push(...projectSessions);
        continue;
      }
      sessionsWithChildren.push(
        ...(await attachProviderChildSessions(
          projectSessions,
          sessionProject,
          resolutionDeps,
          "accepted-or-cheap",
          providerCatalog,
        )),
      );
    }
    allSessions.length = 0;
    allSessions.push(...sessionsWithChildren);

    // Sort by updatedAt descending (most recent first)
    allSessions.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    // Apply cursor pagination
    const filteredSessions = allSessions.filter((s) =>
      isBeforeCursor(s.updatedAt, afterCursor),
    );

    // Get one extra to determine hasMore
    const sessionsWithExtra = filteredSessions.slice(0, limit + 1);
    const hasMore = sessionsWithExtra.length > limit;
    const sessions = sessionsWithExtra.slice(0, limit);
    const stats =
      includeStats && !filterProjectId
        ? await getCachedGlobalStats(accessibleProjectIds)
        : createEmptyStats();

    const response: GlobalSessionsResponse = {
      sessions,
      hasMore,
      stats,
      projects: projectOptions,
      generation,
    };

    return response;
  }

  return routes;
}
