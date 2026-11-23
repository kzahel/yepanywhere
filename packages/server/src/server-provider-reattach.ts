import type { SessionMetadataService } from "./metadata/index.js";
import { hostedAntigravityOwnerLink } from "./sdk/providers/antigravity-owners.js";
import {
  listHostedProviderRuntimes,
  type HostedProviderRuntimeInfo,
} from "./sdk/providers/provider-runtime-host.js";
import type { QueueRestartHandoff } from "./services/QueueRestartHandoff.js";
import type { Supervisor } from "./supervisor/Supervisor.js";

export async function reattachProviderRuntimes(
  supervisor: Pick<Supervisor, "reactivateSession">,
  sessionMetadataService: Pick<
    SessionMetadataService,
    "getEffectiveLaunchSettings"
  >,
  handoff?: QueueRestartHandoff,
): Promise<boolean> {
  let complete = true;
  const hostedProviderRuntimes = await listHostedProviderRuntimes().catch(
    (error) => {
      complete = false;
      console.error(
        "[ProviderRuntimeHost] Failed to list retained runtimes:",
        error,
      );
      return [];
    },
  );
  // A hosted Antigravity owner's conversation is YA's from this backend's
  // start, before its turn to reattach: a write its `agy` makes meanwhile
  // must not read as another program's (plan 195 step 9).
  const held = new Map(
    hostedProviderRuntimes.flatMap((runtime) => {
      const native = hostedAntigravityConversation(runtime);
      if (!native) return [];
      const link = hostedAntigravityOwnerLink();
      link.expect(native, true);
      return [[runtime, link] as const];
    }),
  );
  for (const runtime of hostedProviderRuntimes) {
    if (!runtime.sessionId) {
      held.get(runtime)?.end("unattached");
      continue;
    }
    try {
      await supervisor.reactivateSession(
        runtime.projectPath,
        runtime.sessionId,
        sessionMetadataService.getEffectiveLaunchSettings(runtime.sessionId)
          ?.permissionMode ?? runtime.reattach.permissionMode,
        {
          permissions: handoff?.permissionRulesForSession(
            runtime.sessionId,
            undefined,
          ),
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
      complete = false;
      held.get(runtime)?.end("unattached");
      console.error(
        `[ProviderRuntimeHost] Failed to reattach session ${runtime.sessionId}:`,
        error,
      );
    }
  }
  return complete;
}

function hostedAntigravityConversation(
  runtime: HostedProviderRuntimeInfo,
): { storageScope: string; id: string } | undefined {
  if (runtime.providerName !== "antigravity") return undefined;
  if (runtime.binding?.native.family === "antigravity")
    return runtime.binding.native;
  const namespace = runtime.creation?.identity.nativeNamespace;
  const id = runtime.creation?.nativeSessionId ?? runtime.providerSessionId;
  return namespace?.family === "antigravity" && namespace.storageScope && id
    ? { storageScope: namespace.storageScope, id }
    : undefined;
}
