import type { ProviderChildRelationshipService } from "../sessions/ProviderChildRelationshipService.js";
import {
  isClaudeProviderName,
  type ClaudeProviderName,
  type NativeSessionId,
  type NativeSessionRef,
  type ProviderName,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import type { ISessionIndexService } from "../indexes/types.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import type { GrokSessionReader } from "../sessions/grok-reader.js";
import type { PiSessionReader } from "../sessions/pi-reader.js";
import {
  boundSessionSource,
  findSessionListSummaryAcrossProviders,
  resolveLegacySessionSource,
  type ProviderResolutionDeps,
} from "../sessions/provider-resolution.js";
import type {
  ISessionReader,
  SessionReaderFactory,
} from "../sessions/types.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { Project } from "../supervisor/types.js";

export interface SessionProviderResolutionDeps {
  providerChildRelationships?: ProviderChildRelationshipService;
  signal?: AbortSignal;
  sessionMetadataService?: Pick<
    SessionMetadataService,
    "identities" | "getProvider"
  >;
  readerFactory: SessionReaderFactory;
  sessionIndexService?: ISessionIndexService;
  codexScanner?: Pick<CodexSessionScanner, "getSessionProjectPath">;
  codexSessionsDir?: string;
  codexReaderFactory?: (projectPath: string) => ISessionReader;
  geminiScanner?: {
    getHashToCwd(): Promise<ReadonlyMap<string, string>>;
  };
  geminiSessionsDir?: string;
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
  grokSessionsDir?: string;
  grokReaderFactory?: (projectPath: string) => GrokSessionReader;
  piSessionsDir?: string;
  piReaderFactory?: (projectPath: string) => PiSessionReader;
}

export function isClaudeSdkProviderName(
  provider: ProviderName | undefined,
): provider is ClaudeProviderName {
  return isClaudeProviderName(provider);
}

export function isCodexProviderName(
  provider: ProviderName | string | undefined,
): provider is "codex" | "codex-oss" {
  return provider === "codex" || provider === "codex-oss";
}

export function providerResolutionDeps(
  deps: SessionProviderResolutionDeps,
): ProviderResolutionDeps {
  return {
    providerChildRelationships: deps.providerChildRelationships,
    signal: deps.signal,
    identities: deps.sessionMetadataService?.identities,
    getRecordedProvider: (sessionId) =>
      deps.sessionMetadataService?.getProvider?.(sessionId),
    readerFactory: deps.readerFactory,
    sessionIndexService: deps.sessionIndexService,
    codexScanner: deps.codexScanner,
    codexSessionsDir: deps.codexSessionsDir,
    codexReaderFactory: deps.codexReaderFactory,
    geminiSessionsDir: deps.geminiSessionsDir,
    geminiReaderFactory: deps.geminiReaderFactory,
    geminiHashToCwd: deps.geminiScanner?.getHashToCwd(),
    grokSessionsDir: deps.grokSessionsDir,
    grokReaderFactory: deps.grokReaderFactory,
    piSessionsDir: deps.piSessionsDir,
    piReaderFactory: deps.piReaderFactory,
  };
}

export type SessionReaderResolutionDeps = SessionProviderResolutionDeps & {
  sessionMetadataService?: Pick<SessionMetadataService, "getMetadata">;
};

export async function resolveSessionReader({
  deps,
  project,
  sessionId,
  projectId,
}: {
  deps: SessionReaderResolutionDeps;
  project: Project;
  sessionId: string;
  projectId: UrlProjectId;
}): Promise<{
  reader: ISessionReader;
  nativeSessionId: NativeSessionId;
  native?: NativeSessionRef;
} | null> {
  const bound = boundSessionSource(
    project,
    sessionId,
    providerResolutionDeps(deps),
  );
  if (bound === null) return null;
  if (bound)
    return {
      reader: bound.source.reader,
      nativeSessionId: bound.nativeSessionId,
      native: bound.native,
    };
  const metadataProvider = deps.sessionMetadataService?.getProvider(
    sessionId,
  ) as ProviderName | undefined;
  const resolved = await findSessionListSummaryAcrossProviders(
    project,
    sessionId,
    projectId,
    providerResolutionDeps(deps),
    metadataProvider,
  );

  if (resolved)
    return {
      reader: resolved.source.reader,
      nativeSessionId: resolved.nativeSessionId,
      native: resolved.native,
    };
  const fallback = await resolveLegacySessionSource(
    {
      provider: project.provider,
      reader: deps.readerFactory(project),
      sessionDir: project.sessionDir,
      kind: "primary",
    },
    sessionId,
    { ...project, id: projectId },
    providerResolutionDeps(deps),
    {
      allowMissingNativeProof: Boolean(
        deps.sessionMetadataService?.getMetadata(sessionId),
      ),
    },
  );
  return fallback
    ? {
        reader: fallback.source.reader,
        nativeSessionId: fallback.nativeSessionId,
        native: fallback.native,
      }
    : null;
}
