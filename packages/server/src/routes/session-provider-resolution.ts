import {
  isClaudeProviderName,
  type ClaudeProviderName,
  type ProviderName,
} from "@yep-anywhere/shared";
import type { ISessionIndexService } from "../indexes/types.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import type { GrokSessionReader } from "../sessions/grok-reader.js";
import type { PiSessionReader } from "../sessions/pi-reader.js";
import type { ProviderResolutionDeps } from "../sessions/provider-resolution.js";
import type {
  ISessionReader,
  SessionReaderFactory,
} from "../sessions/types.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";

export interface SessionProviderResolutionDeps {
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
