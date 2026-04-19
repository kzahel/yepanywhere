import type { ProviderName, UrlProjectId } from "@yep-anywhere/shared";
import type { ISessionIndexService } from "../indexes/types.js";
import { canonicalizeProjectPath } from "../projects/paths.js";
import type { Project, SessionSummary } from "../supervisor/types.js";
import { CodexSessionReader } from "./codex-reader.js";
import { GeminiSessionReader } from "./gemini-reader.js";
import { ClaudeSessionReader } from "./reader.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
} from "./types.js";

type ProviderGroup = "claude" | "codex" | "gemini" | "opencode";

export interface ProviderProjectCatalog {
  codexPaths: Set<string>;
  geminiPaths: Set<string>;
  geminiHashToCwd?: Promise<Map<string, string>>;
}

export interface ProviderResolutionDeps {
  readerFactory: (project: Project) => ISessionReader;
  sessionIndexService?: ISessionIndexService;
  codexSessionsDir?: string;
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  geminiSessionsDir?: string;
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
  geminiHashToCwd?: Promise<Map<string, string>>;
}

export interface SessionSource {
  provider: ProviderName;
  reader: ISessionReader;
  sessionDir: string;
  kind: "primary" | "codex" | "gemini";
}

export interface ResolvedSessionSummary {
  source: SessionSource;
  summary: SessionSummary;
}

export interface ResolvedLoadedSession {
  source: SessionSource;
  loaded: LoadedSession;
}

function normalizeProviderGroup(
  provider: ProviderName | string | undefined,
): ProviderGroup | null {
  if (!provider) return null;
  if (provider === "codex" || provider === "codex-oss") return "codex";
  if (provider === "gemini" || provider === "gemini-acp") return "gemini";
  if (provider === "opencode") return "opencode";
  if (provider === "claude" || provider === "claude-ollama") return "claude";
  return null;
}

function mayHaveCodexSessions(
  project: Project,
  catalog?: ProviderProjectCatalog,
): boolean {
  if (catalog) {
    return catalog.codexPaths.has(canonicalizeProjectPath(project.path));
  }
  return normalizeProviderGroup(project.provider) === "claude";
}

function mayHaveGeminiSessions(
  project: Project,
  catalog?: ProviderProjectCatalog,
): boolean {
  if (catalog) {
    return catalog.geminiPaths.has(canonicalizeProjectPath(project.path));
  }
  const provider = normalizeProviderGroup(project.provider);
  return provider === "claude" || provider === "codex";
}

function createClaudeSource(
  project: Project,
  deps: ProviderResolutionDeps,
): SessionSource {
  return {
    provider: project.provider,
    reader: deps.readerFactory(project),
    sessionDir: project.sessionDir,
    kind: "primary",
  };
}

function createCodexSource(
  project: Project,
  deps: ProviderResolutionDeps,
): SessionSource | null {
  const reader =
    deps.codexReaderFactory?.(project.path) ??
    (deps.codexSessionsDir
      ? new CodexSessionReader({
          sessionsDir: deps.codexSessionsDir,
          projectPath: project.path,
        })
      : null);
  if (!reader) return null;
  return {
    provider: "codex",
    reader,
    sessionDir: deps.codexSessionsDir ?? project.sessionDir,
    kind: "codex",
  };
}

function createGeminiSource(
  project: Project,
  deps: ProviderResolutionDeps,
  catalog?: ProviderProjectCatalog,
): SessionSource | null {
  const reader =
    deps.geminiReaderFactory?.(project.path) ??
    (deps.geminiSessionsDir
      ? new GeminiSessionReader({
          sessionsDir: deps.geminiSessionsDir,
          projectPath: project.path,
          hashToCwd: catalog?.geminiHashToCwd ?? deps.geminiHashToCwd,
        })
      : null);
  if (!reader) return null;
  return {
    provider: "gemini",
    reader,
    sessionDir: deps.geminiSessionsDir ?? project.sessionDir,
    kind: "gemini",
  };
}

function buildCandidateGroups(
  project: Project,
  preferredProvider: ProviderName | string | undefined,
  catalog?: ProviderProjectCatalog,
): ProviderGroup[] {
  const groups: ProviderGroup[] = [];
  const pushGroup = (group: ProviderGroup | null) => {
    if (!group || groups.includes(group)) return;
    groups.push(group);
  };

  const preferredGroup = normalizeProviderGroup(preferredProvider);
  const projectGroup = normalizeProviderGroup(project.provider);

  pushGroup(preferredGroup);
  pushGroup(projectGroup);

  if (mayHaveCodexSessions(project, catalog)) {
    pushGroup("codex");
  }
  if (mayHaveGeminiSessions(project, catalog)) {
    pushGroup("gemini");
  }

  return groups;
}

function getSourceForGroup(
  project: Project,
  deps: ProviderResolutionDeps,
  group: ProviderGroup,
  catalog?: ProviderProjectCatalog,
): SessionSource | null {
  switch (group) {
    case "claude":
    case "opencode":
      return createClaudeSource(project, deps);
    case "codex":
      return createCodexSource(project, deps);
    case "gemini":
      return createGeminiSource(project, deps, catalog);
  }
}

function getSessionSources(
  project: Project,
  deps: ProviderResolutionDeps,
  preferredProvider?: ProviderName | string,
  catalog?: ProviderProjectCatalog,
): SessionSource[] {
  const sources: SessionSource[] = [];
  for (const group of buildCandidateGroups(
    project,
    preferredProvider,
    catalog,
  )) {
    const source = getSourceForGroup(project, deps, group, catalog);
    if (!source) continue;
    if (
      sources.some(
        (existing) =>
          existing.kind === source.kind &&
          existing.sessionDir === source.sessionDir,
      )
    ) {
      continue;
    }
    sources.push(source);
  }
  return sources;
}

async function listSessionsForSource(
  project: Project,
  source: SessionSource,
  deps: ProviderResolutionDeps,
): Promise<SessionSummary[]> {
  if (!deps.sessionIndexService) {
    return source.reader.listSessions(project.id);
  }

  let sessions = await deps.sessionIndexService.getSessionsWithCache(
    source.sessionDir,
    project.id,
    source.reader,
  );

  if (
    source.kind === "primary" &&
    normalizeProviderGroup(project.provider) === "claude"
  ) {
    for (const dir of project.mergedSessionDirs ?? []) {
      const mergedReader = new ClaudeSessionReader({ sessionDir: dir });
      const merged = await deps.sessionIndexService.getSessionsWithCache(
        dir,
        project.id,
        mergedReader,
      );
      sessions = [...sessions, ...merged];
    }
  }

  return sessions;
}

export async function listSessionsAcrossProviders(
  project: Project,
  deps: ProviderResolutionDeps,
  catalog?: ProviderProjectCatalog,
): Promise<SessionSummary[]> {
  const sessions: SessionSummary[] = [];
  const seenSessionIds = new Set<string>();

  for (const source of getSessionSources(project, deps, undefined, catalog)) {
    const sourceSessions = await listSessionsForSource(project, source, deps);
    for (const session of sourceSessions) {
      if (seenSessionIds.has(session.id)) continue;
      seenSessionIds.add(session.id);
      sessions.push(session);
    }
  }

  return sessions;
}

export async function findSessionSummaryAcrossProviders(
  project: Project,
  sessionId: string,
  projectId: UrlProjectId,
  deps: ProviderResolutionDeps,
  preferredProvider?: ProviderName | string,
  catalog?: ProviderProjectCatalog,
): Promise<ResolvedSessionSummary | null> {
  for (const source of getSessionSources(
    project,
    deps,
    preferredProvider,
    catalog,
  )) {
    const summary = await source.reader.getSessionSummary(sessionId, projectId);
    if (summary) {
      return { source, summary };
    }
  }

  return null;
}

export async function findLoadedSessionAcrossProviders(
  project: Project,
  sessionId: string,
  projectId: UrlProjectId,
  deps: ProviderResolutionDeps,
  afterMessageId?: string,
  preferredProvider?: ProviderName | string,
  catalog?: ProviderProjectCatalog,
  options?: GetSessionOptions,
): Promise<ResolvedLoadedSession | null> {
  for (const source of getSessionSources(
    project,
    deps,
    preferredProvider,
    catalog,
  )) {
    const loaded = await source.reader.getSession(
      sessionId,
      projectId,
      afterMessageId,
      options,
    );
    if (loaded) {
      return { source, loaded };
    }
  }

  return null;
}
