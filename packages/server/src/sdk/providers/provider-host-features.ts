import { BOUND_RUNTIME_FEATURE } from "./bound-runtime-identity.mjs";

/**
 * Features the provider host process advertises in its `status` reply
 * (scripts/provider-runtime-host.mjs). These describe the running host
 * build, not server capabilities, though some names coincide.
 */
export const PROVIDER_HOST_FEATURE = {
  creationOwner: "session-creation-owner-v1",
  codexCreation: "session-creation-codex-v1",
  opencodeCreation: "session-creation-opencode-v1",
  piCreation: "session-creation-pi-v1",
  adaptersCreation: "session-creation-adapters-v1",
  sandboxCreation: "session-creation-sandbox-v1",
  nativeBinding: BOUND_RUNTIME_FEATURE,
  agentApiRevocation: "agent-api-revocation",
  agentApiManagement: "agent-api-management",
  agentApiPeers: "agent-api-peers",
  bootInstructions: "session-boot-instructions-v1",
} as const;

/** Whether a host `status` reply advertises `feature`. */
export function providerHostHasFeature(
  status: Record<string, unknown>,
  feature: (typeof PROVIDER_HOST_FEATURE)[keyof typeof PROVIDER_HOST_FEATURE],
): boolean {
  return Array.isArray(status.features) && status.features.includes(feature);
}

/**
 * Refuse a hosted launch with boot instructions on a host that predates
 * them: its worker would ignore the option and load the operator's layer.
 */
export async function assertHostBootSupport(
  getStatus: () => Promise<Record<string, unknown>>,
): Promise<void> {
  if (
    !providerHostHasFeature(
      await getStatus(),
      PROVIDER_HOST_FEATURE.bootInstructions,
    )
  )
    throw new Error(
      "Restart the provider host before starting a session with boot instructions",
    );
}
