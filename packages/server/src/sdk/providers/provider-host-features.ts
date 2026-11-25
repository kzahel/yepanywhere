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
} as const;

/** Whether a host `status` reply advertises `feature`. */
export function providerHostHasFeature(
  status: Record<string, unknown>,
  feature: (typeof PROVIDER_HOST_FEATURE)[keyof typeof PROVIDER_HOST_FEATURE],
): boolean {
  return Array.isArray(status.features) && status.features.includes(feature);
}
