import type { ShowThinking } from "@yep-anywhere/shared";
import type { useNewSessionOptions } from "../hooks/useNewSessionOptions";
import {
  resolvePromptSuggestionMode,
  resolveRecapMode,
  toThinkingOption,
} from "./newSessionOptions";
import { routerLaunchFields } from "./newSessionStartDecisions";

type NewSessionOptions = ReturnType<typeof useNewSessionOptions>;

/**
 * The session settings a template project's preparation session starts with.
 * A shown pool or account routes it as it would a direct start, with the
 * routed model and thinking (plan 183).
 */
export function templateSessionSettings(
  options: NewSessionOptions,
  showThinking: ShowThinking,
): Record<string, unknown> {
  const { routerSelection } = options;
  return {
    mode: options.effectivePermissionMode,
    provider: options.selectedProvider ?? undefined,
    model: routerSelection
      ? options.routedModel
      : (options.selectedModel ?? undefined),
    thinking: routerSelection
      ? options.routerThinking
      : toThinkingOption(
          options.effectiveThinkingMode,
          options.effectiveEffortLevel,
        ),
    ...routerLaunchFields({
      routed: routerSelection,
      routerAccountId: options.routerAccountId,
      routerPolicy: options.routerPolicy,
      routerClaudeAiConnectors: options.routerClaudeAiConnectors,
    }),
    ...(options.effectiveServiceTier
      ? { serviceTier: options.effectiveServiceTier }
      : {}),
    showThinking,
    sandboxLevel: options.effectiveSandboxLevel,
    sandboxNetworkFirewall: options.effectiveSandboxNetworkFirewall,
    recapMode: resolveRecapMode(
      options.selectedProviderInfo,
      options.selectedRecapMode,
    ),
    recapAfterSeconds: options.recapAfterSeconds,
    promptSuggestionMode: resolvePromptSuggestionMode(
      options.selectedProviderInfo,
      options.selectedPromptSuggestionMode,
    ),
    helperSideModel: options.helperSideModel,
  };
}
