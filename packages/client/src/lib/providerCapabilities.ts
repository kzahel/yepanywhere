import {
  type ClientDefaults,
  DEFAULT_STEER_NOW_ENABLED,
  type ProviderInfo,
  type ProviderName,
} from "@yep-anywhere/shared";

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
    supportsSteerNow: providerSupportsSteerNow(providerInfo),
  };
}

/** A provider's own Steer now choice, else the global default. */
export function resolveSteerNowDefault(
  defaults: ClientDefaults | undefined,
  provider: ProviderName | null | undefined,
): boolean {
  const own = provider
    ? defaults?.steerNowDefaultByProvider?.[provider]
    : undefined;
  return own ?? defaults?.steerNowDefault ?? DEFAULT_STEER_NOW_ENABLED;
}

/** Whether a provider offers the per-message "now" steering lane. */
export function providerSupportsSteerNow(
  providerInfo: ProviderInfo | null | undefined,
): boolean {
  return providerInfo?.steering
    ? providerInfo.steering.selection === "per-message" &&
        providerInfo.steering.modes.includes("immediate")
    : providerInfo?.supportsSteerNow === true;
}
