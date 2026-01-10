import {
  type UrlProjectId,
  getSessionDisplayTitle,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { SessionIndexService } from "../indexes/index.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { ISessionReader } from "../sessions/types.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { ProcessInfo, Project } from "../supervisor/types.js";

export interface ProcessesDeps {
  supervisor: Supervisor;
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  sessionIndexService?: SessionIndexService;
  sessionMetadataService?: SessionMetadataService;
}

/**
 * Enrich process info with session title, model, and context usage.
 * Uses cache when available. Checks custom title from metadata service first.
 */
async function enrichProcessInfo(
  process: ProcessInfo,
  deps: ProcessesDeps,
): Promise<ProcessInfo> {
  try {
    const project = await deps.scanner.getProject(
      process.projectId as UrlProjectId,
    );
    if (!project) return process;

    const reader = deps.readerFactory(project);

    // Always get the session summary for model and contextUsage
    const summary = await reader.getSessionSummary(
      process.sessionId,
      process.projectId as UrlProjectId,
    );

    // Get title from cache if available, otherwise from summary
    let title: string | null = null;
    if (deps.sessionIndexService) {
      title = await deps.sessionIndexService.getSessionTitle(
        project.sessionDir,
        process.projectId as UrlProjectId,
        process.sessionId,
        reader,
      );
    } else {
      title = summary?.title ?? null;
    }

    // Get custom title from metadata service if available
    const metadata = deps.sessionMetadataService?.getMetadata(
      process.sessionId,
    );

    // Use getSessionDisplayTitle to compute final title (customTitle > title > "Untitled")
    const displayTitle = getSessionDisplayTitle({
      customTitle: metadata?.customTitle,
      title,
    });

    const enriched = { ...process };

    // Only set sessionTitle if we have something meaningful (not "Untitled")
    if (displayTitle !== "Untitled") {
      enriched.sessionTitle = displayTitle;
    }

    // Add model if available
    if (summary?.model) {
      enriched.model = summary.model;
    }

    // Add context usage if available
    if (summary?.contextUsage) {
      enriched.contextUsage = summary.contextUsage;
    }

    return enriched;
  } catch {
    // Ignore errors - just return process without enrichment
  }
  return process;
}

export function createProcessesRoutes(deps: ProcessesDeps): Hono {
  const routes = new Hono();

  // GET /api/processes - List all active processes
  // Query params:
  //   - includeTerminated: if "true", also includes recently terminated processes
  routes.get("/", async (c) => {
    const includeTerminated = c.req.query("includeTerminated") === "true";
    const processes = deps.supervisor.getProcessInfoList();

    // Enrich all processes with session titles and model info
    const enrichedProcesses = await Promise.all(
      processes.map((p) => enrichProcessInfo(p, deps)),
    );

    if (includeTerminated) {
      const terminatedProcesses =
        deps.supervisor.getRecentlyTerminatedProcesses();
      // Also enrich terminated processes
      const enrichedTerminated = await Promise.all(
        terminatedProcesses.map((p) => enrichProcessInfo(p, deps)),
      );
      return c.json({
        processes: enrichedProcesses,
        terminatedProcesses: enrichedTerminated,
      });
    }

    return c.json({ processes: enrichedProcesses });
  });

  // POST /api/processes/:processId/abort - Kill a process
  routes.post("/:processId/abort", async (c) => {
    const processId = c.req.param("processId");

    const aborted = await deps.supervisor.abortProcess(processId);
    if (!aborted) {
      return c.json({ error: "Process not found" }, 404);
    }

    return c.json({ aborted: true });
  });

  return routes;
}
