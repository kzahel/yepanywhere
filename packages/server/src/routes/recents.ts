import type {
  EnrichedRecentEntry,
  ProviderName,
  RecentSessionsResponse,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { truncateSessionTitle } from "@yep-anywhere/shared";
import { PRINCIPAL_VARIABLE, type Principal } from "../auth/principal.js";
import type { ISessionIndexService } from "../indexes/types.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { RecentsService } from "../recents/index.js";
import { decodeProjectId, getProjectName } from "../projects/paths.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { RetainedSessionCollections } from "../services/RetainedSessionCollections.js";
import { projectCatalogIdentities } from "../sessions/catalog-identity.js";
import type { SessionCatalogRow } from "../sessions/catalog-types.js";
import type { CodexSessionReader } from "../sessions/codex-reader.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import { findSessionListSummaryAcrossProviders } from "../sessions/provider-resolution.js";
import type { GrokSessionReader } from "../sessions/grok-reader.js";
import type { PiSessionReader } from "../sessions/pi-reader.js";
import type { ISessionReader } from "../sessions/types.js";
import type { Project } from "../supervisor/types.js";

export interface RecentsDeps {
  signal?: AbortSignal;
  recentsService: RecentsService;
  retainedCollections?: RetainedSessionCollections;
  projectDisplayName?: (path: string) => string;
  sessionMetadataService?: SessionMetadataService;
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  sessionIndexService?: ISessionIndexService;
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
}

const UNRESOLVED_RECENT_GRACE_MS = 10 * 60 * 1000;

export function createRecentsRoutes(deps: RecentsDeps) {
  const routes = new Hono<{
    Variables: Record<typeof PRINCIPAL_VARIABLE, Principal>;
  }>();

  // GET /api/recents - Get recent session visits with enriched data
  // Optional query param: ?limit=N (default: 50)
  routes.get("/", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;

    const recents = deps.recentsService.getRecentsWithLimit(
      Math.min(limit, 100),
    );

    if (c.req.query("summaryMode") === "retained" && deps.retainedCollections) {
      const { rows, catalog } = await deps.retainedCollections.read();
      const bySession = new Map<string, SessionCatalogRow[]>();
      for (const row of await projectCatalogIdentities(
        rows,
        deps.sessionMetadataService,
        deps.signal,
      )) {
        const candidates = bySession.get(row.sessionId) ?? [];
        candidates.push(row);
        bySession.set(row.sessionId, candidates);
      }
      const projectDisplayName = deps.projectDisplayName ?? getProjectName;
      const enriched: RecentSessionsResponse["recents"] = [];
      const visits: NonNullable<RecentSessionsResponse["visits"]> = [];
      for (const entry of recents) {
        const candidates = (bySession.get(entry.sessionId) ?? []).filter(
          (row) =>
            row.projectId === entry.projectId ||
            deps.sessionMetadataService?.getMetadata(row.sessionId)
              ?.workingProjectId === entry.projectId,
        );
        const row = candidates.length === 1 ? candidates[0] : undefined;
        // Missing from the retained catalog is not evidence of deletion. Do
        // not probe provider stores or prune the durable visit on this path.
        if (!row) {
          visits.push(entry);
          continue;
        }
        const metadata = deps.sessionMetadataService?.getMetadata(
          row.sessionId,
        );
        const projectId = metadata?.workingProjectId ?? row.projectId;
        visits.push({ ...entry, projectId });
        enriched.push({
          ...entry,
          projectId,
          projectName: projectDisplayName(
            projectId === row.projectId
              ? row.projectPath
              : decodeProjectId(projectId),
          ),
          provider: metadata?.provider ?? row.provider ?? row.catalogFamily,
          ...(row.title !== undefined
            ? {
                title:
                  row.title === null ? null : truncateSessionTitle(row.title),
              }
            : {}),
        });
      }
      const { refreshError, ...catalogStatus } = catalog;
      const principal = c.get(PRINCIPAL_VARIABLE);
      return c.json({
        recents: enriched,
        catalog:
          principal?.kind === "limited"
            ? catalogStatus
            : { ...catalogStatus, refreshError },
        visits,
      } satisfies RecentSessionsResponse);
    }

    // Load all projects once and build a lookup map
    const allProjects = await deps.scanner.listProjects();
    const projectMap = new Map(allProjects.map((p) => [p.id, p]));

    // Enrich each entry with session data
    const enriched: EnrichedRecentEntry[] = [];
    const unresolved: string[] = [];

    for (const entry of recents) {
      // Cast to UrlProjectId - the recents service stores strings but they are valid UrlProjectIds
      const projectId = entry.projectId as UrlProjectId;

      const project = projectMap.get(projectId);
      if (!project) {
        // Project no longer exists - skip this entry
        continue;
      }

      const projectName = project.name;
      const resolved = await findSessionListSummaryAcrossProviders(
        project,
        entry.sessionId,
        projectId,
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
          geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
          grokSessionsDir: deps.grokSessionsDir,
          grokReaderFactory: deps.grokReaderFactory,
          piSessionsDir: deps.piSessionsDir,
          piReaderFactory: deps.piReaderFactory,
        },
        undefined,
      );
      if (!resolved) {
        unresolved.push(entry.sessionId);
        continue;
      }

      enriched.push({
        sessionId: entry.sessionId,
        projectId: entry.projectId,
        visitedAt: entry.visitedAt,
        title: resolved.summary.title,
        projectName,
        provider: resolved.summary.provider as ProviderName,
      });
    }

    // Missing every provider costs a full search of each (over a second with
    // Codex), so an entry that never resolves would slow every listing for as
    // long as it stays recent. Fresh visits are kept: a session just started
    // may not have written its transcript yet.
    if (unresolved.length > 0) {
      await deps.recentsService.pruneUnresolved(
        unresolved,
        UNRESOLVED_RECENT_GRACE_MS,
      );
    }

    return c.json({ recents: enriched });
  });

  // DELETE /api/recents - Clear all recents
  routes.delete("/", async (c) => {
    await deps.recentsService.clear();
    return c.json({ cleared: true });
  });

  // POST /api/recents/visit - Record a session visit
  // Body: { sessionId: string, projectId: string }
  // The list is the install's, shared with the superuser, so a limited user's
  // visit is not recorded (topics/limited-users.md § Delivery v1).
  routes.post("/visit", async (c) => {
    const principal = c.get(PRINCIPAL_VARIABLE) as Principal | undefined;
    if (principal && principal.kind !== "superuser") {
      return c.json({ recorded: false });
    }
    let body: { sessionId?: string; projectId?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.sessionId || !body.projectId) {
      return c.json({ error: "sessionId and projectId are required" }, 400);
    }

    await deps.recentsService.recordVisit(body.sessionId, body.projectId);
    return c.json({ recorded: true });
  });

  return routes;
}
