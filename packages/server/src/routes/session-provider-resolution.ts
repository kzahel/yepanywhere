import {
  isClaudeProviderName,
  type ClaudeProviderName,
  type ProviderName,
} from "@yep-anywhere/shared";
import type { ISessionIndexService } from "../indexes/types.js";
import type { CodexSessionReader } from "../sessions/codex-reader.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import type { GrokSessionReader } from "../sessions/grok-reader.js";
import type { PiSessionReader } from "../sessions/pi-reader.js";
import type { ProviderResolutionDeps } from "../sessions/provider-resolution.js";
import type { SessionReaderFactory } from "../sessions/types.js";

export interface SessionProviderResolutionDeps {
  readerFactory: SessionReaderFactory;
  sessionIndexService?: ISessionIndexService;
  codexScanner?: Pick<CodexSessionScanner, "getSessionProjectPath">;
  codexSessionsDir?: string;
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  geminiScanner?: {
    getHashToCwd(): Promise<Map<string, string>>;
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
