import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import { canonicalizeProjectPath } from "../projects/paths.js";
import type { Project } from "../supervisor/types.js";

export interface ProviderCatalogDeps {
  codexScanner?: CodexSessionScanner;
  geminiScanner?: GeminiSessionScanner;
  projects?: Project[];
}

export interface ProviderProjectCatalog {
  codexPaths: Set<string>;
  geminiPaths: Set<string>;
  geminiHashToCwd?: Promise<Map<string, string>>;
}

/**
 * Build a per-request catalog of project paths that have Codex/Gemini sessions.
 * This avoids re-running scanner filters for each project in route loops.
 */
export async function buildProviderProjectCatalog(
  deps: ProviderCatalogDeps,
): Promise<ProviderProjectCatalog> {
  if (deps.projects) {
    const codexPaths = new Set(
      deps.projects
        .filter(
          (project) =>
            project.hasCodexSessions === true ||
            project.provider === "codex" ||
            project.provider === "codex-oss",
        )
        .map((project) => canonicalizeProjectPath(project.path)),
    );
    const geminiPaths = new Set(
      deps.projects
        .filter(
          (project) =>
            project.hasGeminiSessions === true ||
            project.provider === "gemini" ||
            project.provider === "gemini-acp",
        )
        .map((project) => canonicalizeProjectPath(project.path))
        .filter((path) => !path.startsWith("gemini:")),
    );

    const needsCodexScan = deps.projects.some(
      (project) =>
        project.provider !== "codex" &&
        project.provider !== "codex-oss" &&
        project.hasCodexSessions === undefined,
    );
    const needsGeminiScan = deps.projects.some(
      (project) =>
        project.provider !== "gemini" &&
        project.provider !== "gemini-acp" &&
        project.hasGeminiSessions === undefined,
    );

    if (!needsCodexScan && !needsGeminiScan) {
      return {
        codexPaths,
        geminiPaths,
        geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
      };
    }

    const [codexProjects, geminiProjects] = await Promise.all([
      needsCodexScan
        ? (deps.codexScanner?.listProjects() ?? Promise.resolve([]))
        : Promise.resolve([]),
      needsGeminiScan
        ? (deps.geminiScanner?.listProjects() ?? Promise.resolve([]))
        : Promise.resolve([]),
    ]);

    for (const project of codexProjects) {
      codexPaths.add(canonicalizeProjectPath(project.path));
    }
    for (const project of geminiProjects) {
      const path = canonicalizeProjectPath(project.path);
      if (!path.startsWith("gemini:")) {
        geminiPaths.add(path);
      }
    }

    return {
      codexPaths,
      geminiPaths,
      geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
    };
  }

  const [codexProjects, geminiProjects] = await Promise.all([
    deps.codexScanner?.listProjects() ?? Promise.resolve([]),
    deps.geminiScanner?.listProjects() ?? Promise.resolve([]),
  ]);

  return {
    codexPaths: new Set(
      codexProjects.map((project) => canonicalizeProjectPath(project.path)),
    ),
    geminiPaths: new Set(
      geminiProjects
        .map((project) => canonicalizeProjectPath(project.path))
        .filter((path) => !path.startsWith("gemini:")),
    ),
    geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
  };
}
