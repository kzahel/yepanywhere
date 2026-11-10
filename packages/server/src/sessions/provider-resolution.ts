import type { ProviderChildRelationshipService } from "./ProviderChildRelationshipService.js";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import {
  isClaudeProviderName,
  isYaSessionId,
  fromUrlProjectId,
  parseNativeSessionId,
  nativeSessionFamily,
  type NativeSessionId,
  type NativeSessionRef,
  type ProviderName,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import {
  resolveNativeSessionRef,
  type SessionIdentityStore,
  type SessionIdentityLookup,
  type DiscoveredSessionIdentity,
} from "./SessionIdentityStore.js";
import type {
  ISessionIndexService,
  SessionIndexListOptions,
} from "../indexes/types.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import {
  GROK_SESSIONS_DIR,
  PI_SESSIONS_DIR,
  canonicalizeProjectPath,
} from "../projects/paths.js";
import type { Project, SessionSummary } from "../supervisor/types.js";
import { CodexSessionReader } from "./codex-reader.js";
import { GeminiSessionReader } from "./gemini-reader.js";
import { antigravitySessionsDir } from "../sdk/providers/antigravity-runtime.js";
import { GrokSessionReader } from "./grok-reader.js";
import { OPENCODE_STORAGE_DIR } from "./opencode-reader.js";
import { PiSessionReader } from "./pi-reader.js";
import { ClaudeSessionReader } from "./reader.js";
import type { SummaryParserWorkerMode } from "./summary-parser-worker-protocol.js";
import {
  type GetSessionSummaryOptions,
  type ISessionReader,
  type SessionReaderFactory,
  type SessionListSummary,
  toSessionListSummary,
} from "./types.js";

type ProviderGroup =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "grok"
  | "pi"
  | "antigravity";
const SESSION_LIST_READ_BATCH_SIZE = 8;

export interface ProviderProjectCatalog {
  codexPaths: Set<string>;
  geminiPaths: Set<string>;
  geminiHashToCwd?: Promise<ReadonlyMap<string, string>>;
}

export interface ProviderResolutionDeps {
  providerChildRelationships?: ProviderChildRelationshipService;
  signal?: AbortSignal;
  identities?: SessionIdentityStore;
  getRecordedProvider?: (sessionId: string) => ProviderName | undefined;
  readerFactory: SessionReaderFactory;
  sessionIndexService?: ISessionIndexService;
  codexScanner?: Pick<CodexSessionScanner, "getSessionProjectPath">;
  codexSessionsDir?: string;
  codexReaderFactory?: (projectPath: string) => ISessionReader;
  geminiSessionsDir?: string;
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
  geminiHashToCwd?: Promise<ReadonlyMap<string, string>>;
  grokSessionsDir?: string;
  grokReaderFactory?: (projectPath: string) => GrokSessionReader;
  piSessionsDir?: string;
  piReaderFactory?: (projectPath: string) => PiSessionReader;
  claudeSummaryParserWorkerMode?: SummaryParserWorkerMode;
  codexSummaryParserWorkerMode?: SummaryParserWorkerMode;
}

export interface SessionSource {
  provider: ProviderName;
  reader: ISessionReader;
  sessionDir: string;
  kind:
    | "primary"
    | "codex"
    | "gemini"
    | "opencode"
    | "grok"
    | "pi"
    | "antigravity";
}

export interface ResolvedSessionSource {
  source: SessionSource;
  nativeSessionId: NativeSessionId;
  native?: NativeSessionRef;
}

export interface ResolvedSessionSummary extends ResolvedSessionSource {
  summary: SessionSummary;
}

export interface ResolvedSessionListSummary extends ResolvedSessionSource {
  summary: SessionListSummary;
}

/** Legacy reads cannot create an alias for another stored public resource. */
export async function resolveLegacySessionSource(
  source: SessionSource,
  sessionId: string,
  project: Project,
  deps: ProviderResolutionDeps,
  options?: {
    allowMissingNativeProof?: boolean;
    nativeRef?: NativeSessionRef | null;
  },
): Promise<ResolvedSessionSource | null> {
  if (deps.signal?.aborted) return null;
  const nativeSessionId = parseNativeSessionId(sessionId);
  // Unmigrated reader shapes retain their existing legacy boundary. Qualified
  // native readers expose their actual scope, including merged private roots.
  const native = deps.identities
    ? options && "nativeRef" in options
      ? options.nativeRef
      : await source.reader.getNativeSessionRef?.(nativeSessionId)
    : undefined;
  if (deps.signal?.aborted) return null;
  if (
    deps.identities &&
    source.reader.getNativeSessionRef &&
    !native &&
    !options?.allowMissingNativeProof
  )
    return null;
  if (native) {
    if (
      native.id !== nativeSessionId ||
      native.family !== nativeSessionFamily(source.provider)
    )
      return null;
    if (native.family === "claude" && source.reader.getSessionFilePath) {
      const file = await source.reader.getSessionFilePath(nativeSessionId);
      const physical = file ? await realpath(file).catch(() => null) : null;
      if (
        deps.signal?.aborted ||
        !physical ||
        basename(physical) !== `${nativeSessionId}.jsonl`
      )
        return null;
    }
    if (deps.identities && !deps.identities.canDiscoverNative(native))
      return null;
    const owner = deps.identities?.lookupNative(native);
    if (
      owner &&
      (owner.sessionId !== sessionId || owner.projectId !== project.id)
    )
      return null;
  }
  if (
    !native &&
    deps.identities?.hasPendingNativeFamily(
      nativeSessionFamily(source.provider),
    )
  )
    return null;
  const selected = native
    ? {
        ...source,
        reader: deps.readerFactory(
          { ...project, provider: source.provider },
          native,
        ),
        sessionDir: native.storageScope,
      }
    : source;
  return { source: selected, nativeSessionId, ...(native ? { native } : {}) };
}

/** A public lookup either resolves its exact stored source or stays legacy. */
export function boundSessionSource(
  project: Project,
  sessionId: string,
  deps: ProviderResolutionDeps,
  lookup?: SessionIdentityLookup,
):
  | {
      source: SessionSource;
      nativeSessionId: NativeSessionId;
      projectId: UrlProjectId;
      native: NativeSessionRef;
    }
  | null
  | undefined {
  if (deps.signal?.aborted) return null;
  const identity =
    lookup?.kind === "stored"
      ? lookup.identity
      : lookup?.kind === "legacy"
        ? undefined
        : isYaSessionId(sessionId)
          ? deps.identities?.resolveYa(sessionId)
          : undefined;
  if (identity && identity.sessionId !== sessionId)
    throw new Error("Resolved identity does not match the public session");
  if (!identity) return undefined;
  if (!identity.native) return null;
  return {
    native: identity.native,
    nativeSessionId: identity.native.id,
    projectId: identity.projectId,
    source: {
      provider: identity.provider,
      reader: deps.readerFactory(
        {
          ...project,
          id: identity.projectId,
          path: fromUrlProjectId(identity.projectId),
          provider: identity.provider,
        },
        identity.native,
      ),
      sessionDir: identity.native.storageScope,
      kind: "primary",
    },
  };
}

/** Native indexes retain native keys. Only the application projection adopts. */
async function publicSessionSummaries<T extends SessionListSummary>(
  sessions: T[],
  source: SessionSource,
  deps: ProviderResolutionDeps,
): Promise<T[]> {
  const store = deps.identities;
  if (
    !store ||
    !(
      isClaudeProviderName(source.provider) ||
      source.provider === "codex" ||
      source.provider === "codex-oss" ||
      ((source.provider === "opencode" ||
        source.provider === "pi" ||
        source.provider === "grok" ||
        source.provider === "antigravity" ||
        source.provider === "gemini" ||
        source.provider === "gemini-acp") &&
        source.reader.getNativeSessionRef !== undefined)
    )
  )
    return sessions;
  const excluded = new Set<number>();
  const candidates: DiscoveredSessionIdentity[] = [];
  const positions: number[] = [];
  for (
    let offset = 0;
    offset < sessions.length;
    offset += SESSION_LIST_READ_BATCH_SIZE
  ) {
    const batch = await Promise.all(
      sessions
        .slice(offset, offset + SESSION_LIST_READ_BATCH_SIZE)
        .map(async (summary, index) => {
          const nativeSessionId = parseNativeSessionId(summary.id);
          const native = source.reader.getNativeSessionRef
            ? await source.reader.getNativeSessionRef(nativeSessionId)
            : await resolveNativeSessionRef(
                source.provider,
                source.sessionDir,
                nativeSessionId,
              );
          if (deps.signal?.aborted) return null;
          if (!native && source.reader.getNativeSessionRef) {
            // A stale native cache row cannot become a public-id guess after
            // the source disappears or its qualified reader is retired.
            excluded.add(offset + index);
            return null;
          }
          // A session bound to another project belongs to that listing; one
          // misattributed row must not fail the whole discovery batch.
          if (native) {
            const bound = store.lookupNative(native);
            if (bound && bound.projectId !== summary.projectId) {
              excluded.add(offset + index);
              return null;
            }
          }
          return native
            ? {
                position: offset + index,
                input: {
                  native,
                  provider: summary.provider ?? source.provider,
                  legacyProvider: deps.getRecordedProvider?.(summary.id),
                  projectId: summary.projectId,
                  createdAt: summary.createdAt ?? summary.updatedAt,
                },
              }
            : null;
        }),
    );
    for (const entry of batch) {
      if (!entry) continue;
      candidates.push(entry.input);
      positions.push(entry.position);
    }
  }
  if (deps.signal?.aborted) return [];
  const result = [...sessions];
  for (const [index, identity] of store
    .adoptDiscoveredBatch(candidates)
    .entries()) {
    const position = positions[index]!;
    if (!identity) {
      excluded.add(position);
      continue;
    }
    result[position] = {
      ...sessions[position]!,
      id: identity.sessionId,
      provider: identity.provider,
    };
  }
  return result.filter((_, index) => !excluded.has(index));
}

export interface NativeSessionProject {
  provider: ProviderName;
  projectPath: string;
}

function normalizeProviderGroup(
  provider: ProviderName | string | undefined,
): ProviderGroup | null {
  if (!provider) return null;
  if (provider === "codex" || provider === "codex-oss") return "codex";
  if (provider === "gemini" || provider === "gemini-acp") return "gemini";
  if (provider === "opencode") return "opencode";
  if (isClaudeProviderName(provider)) return "claude";
  if (provider === "grok" || provider === "grok-acp") return "grok";
  if (provider === "antigravity") return "antigravity";
  if (provider === "pi") return "pi";
  return null;
}

export async function findNativeSessionProjectAcrossProviders(
  sessionId: string,
  deps: ProviderResolutionDeps,
  preferredProvider?: ProviderName | string,
): Promise<NativeSessionProject | null> {
  const preferredGroup = normalizeProviderGroup(preferredProvider);
  const groups: ProviderGroup[] = preferredGroup
    ? preferredGroup === "codex" ||
      preferredGroup === "grok" ||
      preferredGroup === "pi"
      ? [preferredGroup]
      : []
    : ["codex", "grok", "pi"];
  const matches: NativeSessionProject[] = [];

  for (const group of groups) {
    let projectPath: string | null = null;
    if (group === "codex") {
      projectPath = deps.codexScanner
        ? await deps.codexScanner.getSessionProjectPath(sessionId)
        : deps.codexSessionsDir
          ? await new CodexSessionReader({
              sessionsDir: deps.codexSessionsDir,
            }).getSessionProjectPath(sessionId)
          : null;
    } else if (group === "grok") {
      projectPath = deps.grokSessionsDir
        ? await new GrokSessionReader({
            sessionsDir: deps.grokSessionsDir,
          }).getSessionProjectPath(sessionId)
        : null;
    } else if (group === "pi") {
      projectPath = deps.piSessionsDir
        ? await new PiSessionReader({
            sessionsDir: deps.piSessionsDir,
          }).getSessionProjectPath(sessionId)
        : null;
    }
    if (projectPath) {
      matches.push({
        provider: group,
        projectPath: canonicalizeProjectPath(projectPath),
      });
    }
  }

  return matches.length === 1 ? (matches[0] ?? null) : null;
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

function mayHaveGrokSessions(_project: Project): boolean {
  // Grok sessions are keyed by cwd under ~/.grok/sessions, so the reader's
  // project-path filter is the real membership test. Include it for every
  // provider group so mixed-provider projects survive YA restarts.
  return true;
}

function mayHavePiSessions(_project: Project): boolean {
  // pi sessions are keyed by cwd under ~/.pi/agent/sessions, so the reader's
  // project-path filter is the real membership test. Include it for every
  // provider group so pi sessions survive YA restarts (mirrors Grok).
  return true;
}

function mayHaveOpenCodeSessions(_project: Project): boolean {
  // OpenCode sessions live under its own storage keyed by a project whose
  // worktree is the cwd; the reader matches that worktree, so its project-path
  // filter is the real membership test. Include it for every provider group so
  // OpenCode sessions appear (and resume) in any project that has them, even
  // when YA's primary provider for the project is Claude/Codex/etc.
  return true;
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
          summaryParserWorkerMode: deps.codexSummaryParserWorkerMode,
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

function createGrokSource(
  project: Project,
  deps: ProviderResolutionDeps,
): SessionSource | null {
  const reader =
    deps.grokReaderFactory?.(project.path) ??
    new GrokSessionReader({
      sessionsDir: deps.grokSessionsDir ?? GROK_SESSIONS_DIR,
      projectPath: project.path,
    });
  return {
    provider: "grok",
    reader,
    sessionDir: deps.grokSessionsDir ?? GROK_SESSIONS_DIR,
    kind: "grok",
  };
}

function createPiSource(
  project: Project,
  deps: ProviderResolutionDeps,
): SessionSource {
  const reader =
    deps.piReaderFactory?.(project.path) ??
    new PiSessionReader({
      sessionsDir: deps.piSessionsDir ?? PI_SESSIONS_DIR,
      projectPath: project.path,
    });
  return {
    provider: "pi",
    reader,
    sessionDir: deps.piSessionsDir ?? PI_SESSIONS_DIR,
    kind: "pi",
  };
}

function createOpenCodeSource(
  project: Project,
  deps: ProviderResolutionDeps,
): SessionSource {
  return {
    provider: "opencode",
    reader: deps.readerFactory({ ...project, provider: "opencode" }),
    // Use OpenCode's own storage dir (not the project's Claude-style dir) so the
    // session-index cache key is distinct from the Claude source for the same
    // project — otherwise the two would collide on (sessionDir, projectId).
    sessionDir: OPENCODE_STORAGE_DIR,
    kind: "opencode",
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
  if (process.env.ENABLED_PROVIDERS?.split(",").includes("antigravity"))
    pushGroup("antigravity");

  if (mayHaveCodexSessions(project, catalog)) {
    pushGroup("codex");
  }
  if (mayHaveGeminiSessions(project, catalog)) {
    pushGroup("gemini");
  }
  if (mayHaveGrokSessions(project)) {
    pushGroup("grok");
  }
  if (mayHavePiSessions(project)) {
    pushGroup("pi");
  }
  if (mayHaveOpenCodeSessions(project)) {
    pushGroup("opencode");
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
    case "antigravity":
      return {
        provider: "antigravity",
        kind: "antigravity",
        sessionDir: antigravitySessionsDir(),
        reader: deps.readerFactory({ ...project, provider: "antigravity" }),
      };
    case "claude":
      return createClaudeSource(project, deps);
    case "opencode":
      return createOpenCodeSource(project, deps);
    case "codex":
      return createCodexSource(project, deps);
    case "gemini":
      return createGeminiSource(project, deps, catalog);
    case "grok":
      return createGrokSource(project, deps);
    case "pi":
      return createPiSource(project, deps);
  }
}

export function getSessionSources(
  project: Project,
  deps: ProviderResolutionDeps,
  preferredProvider?: ProviderName | string,
  catalog?: ProviderProjectCatalog,
  allowedGroups?: ReadonlySet<string>,
): SessionSource[] {
  const sources: SessionSource[] = [];
  for (const group of buildCandidateGroups(
    project,
    preferredProvider,
    catalog,
  )) {
    if (allowedGroups && !allowedGroups.has(group)) continue;
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

/**
 * Selects the session source for one named provider, so a caller that knows
 * which provider recorded a session reads it with that provider's reader.
 * Returns null when the name belongs to no provider group, or when the group's
 * reader is unavailable here; never substitutes another provider's reader.
 */
export function getSessionSourceForProvider(
  project: Project,
  deps: ProviderResolutionDeps,
  provider: ProviderName | string,
  catalog?: ProviderProjectCatalog,
): SessionSource | null {
  const group = normalizeProviderGroup(provider);
  if (!group) return null;
  return getSourceForGroup(project, deps, group, catalog);
}

function filterActiveSessions(
  sessions: SessionSummary[],
  options?: SessionIndexListOptions,
): SessionSummary[] {
  const activeAfterMs = options?.activeAfterMs;
  if (activeAfterMs === undefined) {
    return sessions;
  }
  return sessions.filter(
    (session) => Date.parse(session.updatedAt) >= activeAfterMs,
  );
}

function filterActiveSessionListSummaries(
  sessions: SessionListSummary[],
  options?: SessionIndexListOptions,
): SessionListSummary[] {
  const activeAfterMs = options?.activeAfterMs;
  if (activeAfterMs === undefined) {
    return sessions;
  }
  return sessions.filter(
    (session) => Date.parse(session.updatedAt) >= activeAfterMs,
  );
}

async function listSessionsForSource(
  project: Project,
  source: SessionSource,
  deps: ProviderResolutionDeps,
  options?: SessionIndexListOptions,
): Promise<SessionSummary[]> {
  if (!deps.sessionIndexService) {
    return filterActiveSessions(
      await source.reader.listSessions(project.id),
      options,
    );
  }

  let sessions = await deps.sessionIndexService.getSessionsWithCache(
    source.sessionDir,
    project.id,
    source.reader,
    options,
  );

  if (
    source.kind === "primary" &&
    normalizeProviderGroup(project.provider) === "claude"
  ) {
    for (const dir of project.mergedSessionDirs ?? []) {
      const mergedReader = new ClaudeSessionReader({
        sessionDir: dir,
        summaryParserWorkerMode: deps.claudeSummaryParserWorkerMode,
      });
      const merged = await deps.sessionIndexService.getSessionsWithCache(
        dir,
        project.id,
        mergedReader,
        options,
      );
      sessions = [...sessions, ...merged];
    }
  }

  return sessions;
}

async function listSessionListSummariesForSource(
  project: Project,
  source: SessionSource,
  deps: ProviderResolutionDeps,
  options?: SessionIndexListOptions,
): Promise<SessionListSummary[]> {
  const listReader = source.reader.getSessionListSummary;
  if (!listReader || !source.reader.listSessionFiles) {
    return (await listSessionsForSource(project, source, deps, options)).map(
      toSessionListSummary,
    );
  }

  const sessionFiles = await source.reader.listSessionFiles(
    source.sessionDir,
    options,
  );
  const summaries: SessionListSummary[] = [];

  for (
    let offset = 0;
    offset < sessionFiles.length;
    offset += SESSION_LIST_READ_BATCH_SIZE
  ) {
    const batch = await Promise.all(
      sessionFiles
        .slice(offset, offset + SESSION_LIST_READ_BATCH_SIZE)
        .map(async (entry) => {
          const cached =
            deps.sessionIndexService && !entry.sharedFilePath
              ? await deps.sessionIndexService.getCachedSessionSummary(
                  source.sessionDir,
                  project.id,
                  entry.sessionId,
                  source.reader,
                )
              : null;
          if (
            cached &&
            !(
              (cached.provider === "codex" ||
                cached.provider === "codex-oss") &&
              cached.asyncQuestions === undefined
            )
          ) {
            return toSessionListSummary(cached);
          }
          return listReader.call(
            source.reader,
            entry.sessionId,
            project.id,
            cached ? toSessionListSummary(cached) : undefined,
          );
        }),
    );
    for (const summary of batch) {
      if (summary) {
        summaries.push(summary);
      }
    }
  }

  const activeSummaries = filterActiveSessionListSummaries(summaries, options);
  activeSummaries.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return activeSummaries;
}

export async function listSessionsAcrossProviders(
  project: Project,
  deps: ProviderResolutionDeps,
  catalog?: ProviderProjectCatalog,
  options?: SessionIndexListOptions,
): Promise<SessionSummary[]> {
  const sessions: SessionSummary[] = [];
  const seenSessionIds = new Set<string>();

  for (const source of getSessionSources(project, deps, undefined, catalog)) {
    const sourceSessions = await listSessionsForSource(
      project,
      source,
      deps,
      options,
    );
    for (const session of await publicSessionSummaries(
      sourceSessions,
      source,
      deps,
    )) {
      if (seenSessionIds.has(session.id)) continue;
      seenSessionIds.add(session.id);
      sessions.push(session);
    }
  }

  return sessions;
}

export async function listSessionListSummariesAcrossProviders(
  project: Project,
  deps: ProviderResolutionDeps,
  catalog?: ProviderProjectCatalog,
  options?: SessionIndexListOptions,
): Promise<SessionListSummary[]> {
  const sessions: SessionListSummary[] = [];
  const seenSessionIds = new Set<string>();

  for (const source of getSessionSources(project, deps, undefined, catalog)) {
    const sourceSessions = await listSessionListSummariesForSource(
      project,
      source,
      deps,
      options,
    );
    for (const session of await publicSessionSummaries(
      sourceSessions,
      source,
      deps,
    )) {
      if (seenSessionIds.has(session.id)) continue;
      seenSessionIds.add(session.id);
      sessions.push(session);
    }
  }

  return sessions;
}

export async function findSessionListSummaryAcrossProviders(
  project: Project,
  sessionId: string,
  projectId: UrlProjectId,
  deps: ProviderResolutionDeps,
  preferredProvider?: ProviderName | string,
  lookup?: SessionIdentityLookup,
): Promise<ResolvedSessionListSummary | null> {
  const bound = boundSessionSource(project, sessionId, deps, lookup);
  if (bound === null) return null;
  // An absent stored identity retains the explicit legacy native lookup.
  const nativeSessionId =
    bound?.nativeSessionId ?? parseNativeSessionId(sessionId);
  const nativeProjectId = bound?.projectId ?? projectId;
  const projectSummary = <T extends SessionListSummary>(summary: T): T =>
    bound
      ? { ...summary, id: sessionId, provider: bound.source.provider }
      : summary;
  for (const candidate of bound
    ? [bound.source]
    : getSessionSources(project, deps, preferredProvider)) {
    const legacy = bound
      ? undefined
      : await resolveLegacySessionSource(
          candidate,
          sessionId,
          { ...project, id: nativeProjectId },
          deps,
        );
    if (legacy === null) continue;
    const source = legacy?.source ?? candidate;
    if (source.reader.getSessionListSummary) {
      const cachedSummary = deps.sessionIndexService
        ? await deps.sessionIndexService.getCachedSessionSummary(
            source.sessionDir,
            nativeProjectId,
            nativeSessionId,
            source.reader,
          )
        : null;
      if (
        cachedSummary &&
        !(
          (cachedSummary.provider === "codex" ||
            cachedSummary.provider === "codex-oss") &&
          cachedSummary.asyncQuestions === undefined
        )
      ) {
        return {
          source,
          nativeSessionId,
          ...((bound?.native ?? legacy?.native)
            ? { native: bound?.native ?? legacy?.native }
            : {}),
          summary: projectSummary(toSessionListSummary(cachedSummary)),
        };
      }

      const summary = await source.reader.getSessionListSummary(
        nativeSessionId,
        nativeProjectId,
        cachedSummary ? toSessionListSummary(cachedSummary) : undefined,
      );
      if (summary) {
        return {
          source,
          nativeSessionId,
          ...((bound?.native ?? legacy?.native)
            ? { native: bound?.native ?? legacy?.native }
            : {}),
          summary: projectSummary(summary),
        };
      }
      continue;
    }

    const completeSummary = deps.sessionIndexService
      ? await deps.sessionIndexService.getSessionSummaryWithCache(
          source.sessionDir,
          nativeProjectId,
          nativeSessionId,
          source.reader,
        )
      : await source.reader.getSessionSummary(nativeSessionId, nativeProjectId);
    if (completeSummary) {
      return {
        source,
        nativeSessionId,
        ...((bound?.native ?? legacy?.native)
          ? { native: bound?.native ?? legacy?.native }
          : {}),
        summary: projectSummary(toSessionListSummary(completeSummary)),
      };
    }
  }

  return null;
}

export async function findSessionSummaryAcrossProviders(
  project: Project,
  sessionId: string,
  projectId: UrlProjectId,
  deps: ProviderResolutionDeps,
  preferredProvider?: ProviderName | string,
  options?: GetSessionSummaryOptions,
  lookup?: SessionIdentityLookup,
): Promise<ResolvedSessionSummary | null> {
  const bound = boundSessionSource(project, sessionId, deps, lookup);
  if (bound === null) return null;
  // An absent stored identity retains the explicit legacy native lookup.
  const nativeSessionId =
    bound?.nativeSessionId ?? parseNativeSessionId(sessionId);
  const nativeProjectId = bound?.projectId ?? projectId;
  const projectSummary = <T extends SessionListSummary>(summary: T): T =>
    bound
      ? { ...summary, id: sessionId, provider: bound.source.provider }
      : summary;
  for (const candidate of bound
    ? [bound.source]
    : getSessionSources(project, deps, preferredProvider)) {
    const legacy = bound
      ? undefined
      : await resolveLegacySessionSource(
          candidate,
          sessionId,
          { ...project, id: nativeProjectId },
          deps,
        );
    if (legacy === null) continue;
    const source = legacy?.source ?? candidate;
    if (deps.sessionIndexService && options?.readMode === "head") {
      const cachedSummary =
        await deps.sessionIndexService.getCachedSessionSummary(
          source.sessionDir,
          nativeProjectId,
          nativeSessionId,
          source.reader,
        );
      if (cachedSummary) {
        return {
          source,
          nativeSessionId,
          ...((bound?.native ?? legacy?.native)
            ? { native: bound?.native ?? legacy?.native }
            : {}),
          summary: projectSummary(cachedSummary),
        };
      }
    }

    const summary =
      deps.sessionIndexService &&
      options?.readMode !== "head" &&
      options?.contextUsageMode !== "manual-compaction"
        ? await deps.sessionIndexService.getSessionSummaryWithCache(
            source.sessionDir,
            nativeProjectId,
            nativeSessionId,
            source.reader,
          )
        : options
          ? await source.reader.getSessionSummary(
              nativeSessionId,
              nativeProjectId,
              options,
            )
          : await source.reader.getSessionSummary(
              nativeSessionId,
              nativeProjectId,
            );
    if (summary) {
      return {
        source,
        nativeSessionId,
        ...((bound?.native ?? legacy?.native)
          ? { native: bound?.native ?? legacy?.native }
          : {}),
        summary: projectSummary(summary),
      };
    }
  }

  return null;
}
