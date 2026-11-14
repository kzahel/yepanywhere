import type { SessionMetadataService } from "./metadata/index.js";
import { listHostedProviderRuntimes } from "./sdk/providers/provider-runtime-host.js";
import type { Supervisor } from "./supervisor/Supervisor.js";

export async function reattachProviderRuntimes(
  supervisor: Pick<Supervisor, "reactivateSession">,
  sessionMetadataService: Pick<
    SessionMetadataService,
    "getEffectiveLaunchSettings"
  >,
): Promise<void> {
  const hostedProviderRuntimes = await listHostedProviderRuntimes().catch(
    (error) => {
      console.error(
        "[ProviderRuntimeHost] Failed to list retained runtimes:",
        error,
      );
      return [];
    },
  );
  for (const runtime of hostedProviderRuntimes) {
    if (!runtime.sessionId) continue;
    try {
      await supervisor.reactivateSession(
        runtime.projectPath,
        runtime.sessionId,
        sessionMetadataService.getEffectiveLaunchSettings(runtime.sessionId)
          ?.permissionMode ?? runtime.reattach.permissionMode,
        {
          providerName: runtime.providerName,
          model: runtime.reattach.model,
          serviceTier: runtime.reattach.serviceTier,
          thinking: runtime.reattach.thinking,
          effort: runtime.reattach.effort,
          clientName: runtime.reattach.clientName,
          executor: runtime.reattach.executor,
          sandboxLevel: runtime.reattach.sandboxLevel,
          sandboxNetworkFirewall: runtime.reattach.sandboxNetworkFirewall,
          sandboxStateKey: runtime.reattach.sandboxStateKey,
        },
      );
      console.log(
        `[ProviderRuntimeHost] Reattached ${runtime.providerName} session ${runtime.sessionId}`,
      );
    } catch (error) {
      console.error(
        `[ProviderRuntimeHost] Failed to reattach session ${runtime.sessionId}:`,
        error,
      );
    }
  }
}
