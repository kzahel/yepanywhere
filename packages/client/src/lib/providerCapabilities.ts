import type { ProviderInfo, ProviderName } from "@yep-anywhere/shared";

// Shown before server provider metadata arrives. Keep this aligned with
// providers that advertise supportsSteering and implement a real mid-turn
// path (Codex turn/steer, Grok x.ai/interject).
const PROVIDERS_WITH_STATIC_STEERING_FALLBACK: ReadonlySet<ProviderName> =
  new Set(["codex", "grok"]);

const PROVIDERS_WITH_LOCAL_SESSION_SANDBOX: ReadonlySet<ProviderName> = new Set(
  ["claude", "claude-gateway", "claude-ollama", "codex"],
);

export interface SessionProviderCapabilities {
  providerName?: ProviderName;
  providerInfo: ProviderInfo | null;
  generallySupportsSteering: boolean;
  supportsCurrentTurnSteering: boolean;
  supportsSteerNow: boolean;
}

export function providerHasStaticSteeringFallback(
  providerName?: ProviderName | null,
): boolean {
  return providerName
    ? PROVIDERS_WITH_STATIC_STEERING_FALLBACK.has(providerName)
    : false;
}

export function providerSupportsLocalSessionSandbox(
  providerName?: ProviderName | null,
): boolean {
  return providerName
    ? PROVIDERS_WITH_LOCAL_SESSION_SANDBOX.has(providerName)
    : false;
}

export function resolveSessionProviderCapabilities(params: {
  providers: ProviderInfo[];
  providerName?: ProviderName | null;
}): SessionProviderCapabilities {
  const providerName = params.providerName ?? undefined;
  const providerInfo = providerName
    ? (params.providers.find((provider) => provider.name === providerName) ??
      null)
    : null;
  const metadataSupportsSteering = providerInfo?.supportsSteering === true;
  const staticSupportsSteering =
    providerHasStaticSteeringFallback(providerName);

  return {
    providerName,
    providerInfo,
    generallySupportsSteering:
      metadataSupportsSteering || staticSupportsSteering,
    supportsCurrentTurnSteering: providerInfo
      ? metadataSupportsSteering
      : staticSupportsSteering,
    supportsSteerNow: providerInfo?.steering
      ? providerInfo.steering.selection === "per-message" &&
        providerInfo.steering.modes.includes("immediate")
      : providerInfo?.supportsSteerNow === true,
  };
}
