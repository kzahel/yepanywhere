import { assertAndroidWorkspaceAvailable } from "../../lib/android-workspace.js";
import {
  isDesktopControlOrigin,
  nativeMachineControl,
} from "../../desktop/machine-control.js";
/**
 * Provider exports.
 *
 * Re-exports all provider implementations and types.
 */

import {
  DEFAULT_CODEX_CYBER_ACCESS_PROGRAM,
  DEFAULT_CODEX_REASONING_SUMMARY,
  DEFAULT_SUBAGENT_MAX_DEPTH,
  type ClaudeAdditionalModelSelection,
  type CodexCyberAccessProgram,
  type EffortLevel,
  type CodexPlanToolMode,
  type CodexReasoningSummary,
  type GatewayService,
  type SubagentMaxDepth,
} from "@yep-anywhere/shared";
import {
  isProviderRuntimeHostAvailable,
  retainProviderRuntimeProcessGroup,
  startHostedProviderSession,
} from "./provider-runtime-host.js";
// Types
import type { AgentProvider, ProviderName } from "./types.js";
import { withInstructionRestoration } from "./instruction-restoration.js";
export type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  ProviderName,
  StartSessionOptions,
} from "./types.js";

// Claude provider (uses @anthropic-ai/claude-agent-sdk)
import { claudeProvider } from "./claude.js";
export { ClaudeProvider, claudeProvider } from "./claude.js";

// Claude Gateway provider (Claude SDK with a per-launch gateway overlay)
import {
  ClaudeGatewayProvider,
  claudeGatewayProvider,
} from "./claude-gateway.js";
export {
  ClaudeGatewayProvider,
  claudeGatewayProvider,
} from "./claude-gateway.js";

// Codex provider (uses codex CLI)
import { codexProvider } from "./codex.js";
export {
  CodexProvider,
  codexProvider,
  type CodexProviderConfig,
} from "./codex.js";

// Gemini provider (uses gemini CLI)
import { geminiProvider } from "./gemini.js";
export {
  GeminiProvider,
  geminiProvider,
  type GeminiProviderConfig,
} from "./gemini.js";

// Gemini ACP provider (uses gemini CLI with --experimental-acp)
import { geminiACPProvider } from "./gemini-acp.js";
export {
  GeminiACPProvider,
  geminiACPProvider,
  type GeminiACPProviderConfig,
} from "./gemini-acp.js";

// Grok Build ACP provider (uses `grok agent stdio`)
// Phase 1 isolated addition per topics/grok.md. Gated by ENABLED_PROVIDERS=grok.
import { grokACPProvider } from "./grok-acp.js";
export {
  GrokACPProvider,
  grokACPProvider,
  type GrokACPProviderConfig,
} from "./grok-acp.js";

// CodexOSS provider (uses codex CLI with --oss for local models)
import { codexOSSProvider } from "./codex-oss.js";
export {
  CodexOSSProvider,
  codexOSSProvider,
  type CodexOSSProviderConfig,
} from "./codex-oss.js";

// Claude + Ollama provider (uses Claude SDK with Ollama backend)
import { claudeOllamaProvider } from "./claude-ollama.js";
export {
  ClaudeOllamaProvider,
  claudeOllamaProvider,
} from "./claude-ollama.js";

// OpenCode provider (uses opencode serve for multi-provider agent)
import { opencodeProvider } from "./opencode.js";
export {
  OpenCodeProvider,
  opencodeProvider,
  type OpenCodeProviderConfig,
} from "./opencode.js";

// pi provider (uses `pi --mode rpc`; see topics/pi-provider.md, Plan A)
import { piProvider } from "./pi.js";
export { PiProvider, piProvider, type PiProviderConfig } from "./pi.js";

export interface ProviderRuntimeConfig {
  /** Explicit Codex CLI path supplied by an embedding runtime such as desktop. */
  codexCliPath?: string;
  /** Current server-persisted opt-ins for the Claude model catalog. */
  getClaudeAdditionalModels?: () =>
    | readonly ClaudeAdditionalModelSelection[]
    | undefined;
  /** Saved per-model effort defaults for auto-thinking Claude launches. */
  getClaudeModelEffortLevels?: () =>
    | Readonly<Record<string, EffortLevel>>
    | undefined;
  /** Whether legacy ClaudeOllama has configured or persisted usage. */
  isClaudeOllamaVisible?: () => boolean;
  /** Cloneable process-scoped settings supplied to a provider worker. */
  getProviderRuntimeSnapshot?: () => ProviderRuntimeSnapshot;
}

export interface ProviderRuntimeSnapshot {
  codexCliPath?: string;
  codexPlanToolMode?: CodexPlanToolMode;
  codexCyberAccessProgram?: CodexCyberAccessProgram;
  codexReasoningSummary?: CodexReasoningSummary;
  /** Host MCP App views: declare the UI extension and serve view requests. */
  mcpAppViews?: boolean;
  claudeAdditionalModels?: readonly ClaudeAdditionalModelSelection[];
  claudeGatewayUrl?: string;
  claudeGatewayStartCommand?: string;
  claudeGatewayDisableAgent?: boolean;
  claudeGatewayDisablePlanMode?: boolean;
  /** Configured model-serving endpoints; the legacy keys mirror the default. */
  gatewayServices?: readonly GatewayService[];
  defaultGatewayServiceId?: string;
  /** Whether endpoints may be asked which thinking efforts they accept. */
  gatewayServiceEffortDetection?: boolean;
  subagentMaxDepth?: SubagentMaxDepth;
  ollamaUrl?: string;
  ollamaSystemPrompt?: string;
  ollamaUseFullSystemPrompt?: boolean;
  ambientXaiApiKey?: string;
  grokBuildUseXaiApiKey?: boolean;
}

let isClaudeOllamaVisible = () => false;
let getProviderRuntimeSnapshot = (): ProviderRuntimeSnapshot => ({});
const hostedProviderProxies = new Map<ProviderName, AgentProvider>();

export function configureProviderRuntime(config: ProviderRuntimeConfig): void {
  claudeProvider.setAdditionalModelsGetter(
    config.getClaudeAdditionalModels ?? (() => []),
  );
  claudeProvider.setModelEffortLevelsGetter(
    config.getClaudeModelEffortLevels ?? (() => undefined),
  );
  codexProvider.setCodexPath(config.codexCliPath);
  codexOSSProvider.setCodexPath(config.codexCliPath);
  codexOSSProvider.setGatewayServicesGetter(
    () => getProviderRuntimeSnapshot().gatewayServices ?? [],
  );
  isClaudeOllamaVisible = config.isClaudeOllamaVisible ?? (() => false);
  getProviderRuntimeSnapshot =
    config.getProviderRuntimeSnapshot ?? (() => ({}));
  const getCodexReasoningSummary = (): CodexReasoningSummary =>
    getProviderRuntimeSnapshot().codexReasoningSummary ??
    DEFAULT_CODEX_REASONING_SUMMARY;
  const getCodexPlanToolMode = (): CodexPlanToolMode =>
    getProviderRuntimeSnapshot().codexPlanToolMode ?? "provider-default";
  const getCodexCyberAccessProgram = (): CodexCyberAccessProgram =>
    getProviderRuntimeSnapshot().codexCyberAccessProgram ??
    DEFAULT_CODEX_CYBER_ACCESS_PROGRAM;
  const getSubagentMaxDepth = (): SubagentMaxDepth => {
    const configured = getProviderRuntimeSnapshot().subagentMaxDepth;
    return configured === undefined ? DEFAULT_SUBAGENT_MAX_DEPTH : configured;
  };
  claudeProvider.setSubagentMaxDepthGetter(getSubagentMaxDepth);
  claudeGatewayProvider.setSubagentMaxDepthGetter(getSubagentMaxDepth);
  claudeOllamaProvider.setSubagentMaxDepthGetter(getSubagentMaxDepth);
  grokACPProvider.setSubagentMaxDepthGetter(getSubagentMaxDepth);
  codexProvider.setReasoningSummaryGetter(getCodexReasoningSummary);
  codexProvider.setPlanToolModeGetter(getCodexPlanToolMode);
  codexProvider.setCyberAccessProgramGetter(getCodexCyberAccessProgram);
  codexProvider.setMcpAppViewsGetter(
    () => getProviderRuntimeSnapshot().mcpAppViews === true,
  );
  codexProvider.setSubagentMaxDepthGetter(getSubagentMaxDepth);
}

function hostedProvider(rawProvider: AgentProvider): AgentProvider {
  const existing = hostedProviderProxies.get(rawProvider.name);
  if (existing) return existing;
  const proxy = new Proxy(rawProvider, {
    get(target, property) {
      if (
        property === "getAvailableModels" &&
        target.name === "claude-gateway"
      ) {
        return async (
          options?: Parameters<AgentProvider["getAvailableModels"]>[0],
        ) => {
          const models = await target.getAvailableModels(options);
          const retentions =
            await ClaudeGatewayProvider.retainOwnedGatewayProcessGroups(
              retainProviderRuntimeProcessGroup,
            );
          for (const retention of retentions) {
            if (retention.error) throw retention.error;
            if (!retention.relinquished) {
              throw new Error(
                "Claude Gateway ownership changed during host transfer",
              );
            }
          }
          return models;
        };
      }
      if (property === "startSession") {
        return async (
          options: Parameters<AgentProvider["startSession"]>[0],
        ) => {
          await assertAndroidWorkspaceAvailable(options.cwd);
          const native = nativeMachineControl();
          if (
            options.machineControl &&
            isDesktopControlOrigin(options.desktopControlOrigin) &&
            native &&
            (await native.enabled())
          ) {
            throw new Error(
              "Native Machine Control delegation requires a local provider owner; detached provider hosting is unsupported",
            );
          }
          return startHostedProviderSession(
            target.name,
            {
              ...options,
              launchModel: target.resolveLaunchModel?.(options.model),
              // The worker holds no catalog, so the endpoint is decided here,
              // from the one this process reads for the model picker.
              ...(target.resolveLaunchGatewayRoute &&
              options.gatewayRoute === undefined
                ? {
                    gatewayRoute: await target.resolveLaunchGatewayRoute(
                      options.model,
                    ),
                  }
                : {}),
            },
            getProviderRuntimeSnapshot(),
          );
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  hostedProviderProxies.set(rawProvider.name, proxy);
  return proxy;
}

export { isProviderRuntimeHostAvailable };

function runtimeProvider(rawProvider: AgentProvider): AgentProvider {
  if (!isProviderRuntimeHostAvailable())
    return new Proxy(rawProvider, {
      get(target, property) {
        if (property === "startSession")
          return async (
            options: Parameters<AgentProvider["startSession"]>[0],
          ) => {
            await assertAndroidWorkspaceAvailable(options.cwd);
            return withInstructionRestoration(
              await target.startSession(options),
              options,
            );
          };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return hostedProvider(rawProvider);
}

/**
 * Get all available provider instances.
 * Useful for provider detection UI.
 */
export function getAllProviders(): AgentProvider[] {
  return [
    claudeProvider,
    ...(ClaudeGatewayProvider.isConfigured() ? [claudeGatewayProvider] : []),
    ...(isClaudeOllamaVisible() ? [claudeOllamaProvider] : []),
    codexProvider,
    codexOSSProvider,
    geminiProvider,
    geminiACPProvider,
    grokACPProvider, // Phase 1: additive only (see grok-acp.ts header + topics/grok.md)
    opencodeProvider,
    piProvider,
  ].map(runtimeProvider);
}

/**
 * Get a provider by name.
 *
 * Note: "gemini" maps to geminiACPProvider (ACP mode) since it's the better
 * implementation with proper permission handling. The non-ACP stream-json
 * provider is deprecated and will be removed.
 *
 * "grok" added (additive, isolated). When ENABLED_PROVIDERS does not include "grok",
 * getProvider("grok") is never reached from normal flows.
 */
export function getRawProvider(name: ProviderName): AgentProvider | null {
  switch (name) {
    case "claude":
      return claudeProvider;
    case "claude-gateway":
      return claudeGatewayProvider;
    case "claude-ollama":
      return claudeOllamaProvider;
    case "codex":
      return codexProvider;
    case "codex-oss":
      return codexOSSProvider;
    case "gemini":
    case "gemini-acp":
      // Both map to ACP provider - "gemini" is legacy name for backward compatibility
      return geminiACPProvider;
    case "grok":
      return grokACPProvider; // Phase 1 Grok Build (ACP)
    case "opencode":
      return opencodeProvider;
    case "pi":
      return piProvider;
    default:
      return null;
  }
}

export function getProvider(name: ProviderName): AgentProvider | null {
  const provider = getRawProvider(name);
  return provider ? runtimeProvider(provider) : null;
}
