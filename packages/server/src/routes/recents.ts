import type {
  EnrichedRecentEntry,
  ProviderName,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { ISessionIndexService } from "../indexes/types.js";
import { decodeProjectId, getProjectName } from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { RecentsService } from "../recents/index.js";
import type { ISessionReader } from "../sessions/types.js";
import type { Project } from "../supervisor/types.js";

export interface RecentsDeps {
  recentsService: RecentsService;
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  sessionIndexService?: ISessionIndexService;
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

    // Enrich each entry with session data
    const enriched: EnrichedRecentEntry[] = [];

    for (const entry of recents) {
      // Cast to UrlProjectId - the recents service stores strings but they are valid UrlProjectIds
      const projectId = entry.projectId as UrlProjectId;

      const project = await deps.scanner.getProject(entry.projectId);
      if (!project) {
        // Project no longer exists - skip this entry
        continue;
      }

      const projectPath = decodeProjectId(projectId);
      const projectName = getProjectName(projectPath);
      const reader = deps.readerFactory(project);

      // Try to get session data from cache first
      let title: string | null = null;
      let messageCount = 0;
      let provider: ProviderName = project.provider;

      if (deps.sessionIndexService) {
        const sessionTitle = await deps.sessionIndexService.getSessionTitle(
          project.sessionDir,
          projectId,
          entry.sessionId,
          reader,
        );
        if (sessionTitle === null) {
          // Session doesn't exist or is empty - skip this entry
          continue;
        }
        title = sessionTitle;
        // Note: messageCount not available from getSessionTitle, would need full summary
      } else {
        // Fallback: get full summary
        const summary = await reader.getSessionSummary(
          entry.sessionId,
          projectId,
        );
        if (!summary) {
          // Session doesn't exist - skip this entry
          continue;
        }
        title = summary.title;
        messageCount = summary.messageCount;
        provider = summary.provider;
      }

      enriched.push({
        sessionId: entry.sessionId,
        projectId: entry.projectId,
        visitedAt: entry.visitedAt,
        title,
        messageCount,
        projectName,
        provider,
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

    await deps.recentsService.recordVisit(body.sessionId, body.projectId);
    return c.json({ recorded: true });
  });

  return routes;
}
