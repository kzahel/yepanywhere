import type {
  EnrichedRecentEntry,
  ProviderName,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { ISessionIndexService } from "../indexes/types.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import { decodeProjectId, getProjectName } from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { RecentsService } from "../recents/index.js";
import type { CodexSessionReader } from "../sessions/codex-reader.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import { findSessionSummaryAcrossProviders } from "../sessions/provider-resolution.js";
import type { ISessionReader } from "../sessions/types.js";
import type { Project } from "../supervisor/types.js";

export interface RecentsDeps {
  recentsService: RecentsService;
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  sessionIndexService?: ISessionIndexService;
  codexScanner?: CodexSessionScanner;
  codexSessionsDir?: string;
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  geminiScanner?: GeminiSessionScanner;
  geminiSessionsDir?: string;
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
}

export function createRecentsRoutes(deps: RecentsDeps): Hono {
  const routes = new Hono();

  // GET /api/recents - Get recent session visits with enriched data
  // Optional query param: ?limit=N (default: 50)
  routes.get("/", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;

    const recents = deps.recentsService.getRecentsWithLimit(
      Math.min(limit, 100),
    );

    // Load all projects once and build a lookup map
    const allProjects = await deps.scanner.listProjects();
    const projectMap = new Map(allProjects.map((p) => [p.id, p]));

    // Enrich each entry with session data
    const enriched: EnrichedRecentEntry[] = [];

    for (const entry of recents) {
      // Cast to UrlProjectId - the recents service stores strings but they are valid UrlProjectIds
      const projectId = entry.projectId as UrlProjectId;

      const project = projectMap.get(projectId);
      if (!project) {
        // Project no longer exists - skip this entry
        continue;
      }

      const projectPath = decodeProjectId(projectId);
      const projectName = getProjectName(projectPath);
      const resolved = await findSessionSummaryAcrossProviders(
        project,
        entry.sessionId,
        projectId,
        {
          readerFactory: deps.readerFactory,
          sessionIndexService: deps.sessionIndexService,
          codexSessionsDir: deps.codexSessionsDir,
          codexReaderFactory: deps.codexReaderFactory,
          geminiSessionsDir: deps.geminiSessionsDir,
          geminiReaderFactory: deps.geminiReaderFactory,
          geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
        },
      );
      if (!resolved) {
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

    return c.json({ recents: enriched });
  });

  // DELETE /api/recents - Clear all recents
  routes.delete("/", async (c) => {
    await deps.recentsService.clear();
    return c.json({ cleared: true });
  });

  // POST /api/recents/visit - Record a session visit
  // Body: { sessionId: string, projectId: string }
  routes.post("/visit", async (c) => {
    let body: { sessionId?: string; projectId?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.sessionId || !body.projectId) {
      return c.json({ error: "sessionId and projectId are required" }, 400);
    }

    await deps.recentsService.recordVisit(
      body.sessionId,
      body.projectId as UrlProjectId,
    );

    return c.json({ recorded: true });
  });

  return routes;
}
