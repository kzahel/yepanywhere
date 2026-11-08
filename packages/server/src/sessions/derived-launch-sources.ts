import { buildEffectiveAgentContext } from "@yep-anywhere/shared";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { ReviewLaunchDefaults } from "../review/reviewSessionLauncher.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import {
  type CompactModelSettingsDeps,
  resolveCompactModelSettings,
} from "./session-compact-thresholds.js";

/**
 * What a session derived from another one (an Agent API child, a Source
 * Review session) reads from its source, so it keeps the source's router
 * selection and boundary instead of falling back to the owner's defaults
 * (plan 183, topics/agent-auth-router.md).
 */

/** The configured Global Instructions with agent context hints. */
export function effectiveGlobalInstructions(
  settings: ServerSettingsService | undefined,
): string | undefined {
  return buildEffectiveAgentContext({
    globalInstructions: settings?.getSetting("globalInstructions"),
    hints: settings?.getSetting("agentContextHints"),
  });
}

/** An Agent API caller's router pin and model. */
export function agentApiCallerLaunch(
  deps: { sessionMetadataService?: SessionMetadataService },
  supervisor: Pick<Supervisor, "getProcessForSession">,
) {
  return (sessionId: string) => {
    const metadata = deps.sessionMetadataService?.getMetadata(sessionId);
    const requested = metadata?.effectiveLaunchSettings?.requestedModel;
    return {
      routerBinding: metadata?.routerBinding,
      model:
        supervisor.getProcessForSession(sessionId)?.resolvedModel ??
        (requested && requested !== "default" ? requested : undefined),
    };
  };
}

/** Server defaults and source-session settings for a Source Review launch. */
export function reviewLaunchDefaults(
  deps: CompactModelSettingsDeps & {
    sessionMetadataService?: SessionMetadataService;
  },
): ReviewLaunchDefaults {
  return {
    globalInstructions: () =>
      effectiveGlobalInstructions(deps.serverSettingsService),
    compactSettings: (provider, model) =>
      resolveCompactModelSettings(deps, { provider, yaModelId: model }),
    sourceLaunch: (sessionId) => {
      const metadata = deps.sessionMetadataService?.getMetadata(sessionId);
      if (!metadata) return undefined;
      return {
        provider: metadata.provider,
        routerBinding: metadata.routerBinding,
        sandboxLevel: metadata.sandboxLevel,
        sandboxNetworkFirewall: metadata.sandboxNetworkFirewall,
        serviceTier: metadata.effectiveLaunchSettings?.serviceTier,
      };
    },
  };
}
