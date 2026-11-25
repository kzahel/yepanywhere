import type { ProviderName, UrlProjectId } from "@yep-anywhere/shared";
import type { StartSessionOptions } from "../sdk/providers/types.js";
import type { SupervisorOptions } from "./Supervisor.js";

/** The Supervisor options a launch's instruction settings read. */
export type InstructionLaunchDeps = Pick<
  SupervisorOptions,
  "getInstructionRestorationSettings" | "readInstructionHistory"
>;

/**
 * Instruction restoration options for one provider launch: off for an
 * isolated (sandboxed or remote) launch or a provider the setting excludes.
 */
export async function instructionLaunchOptions(
  deps: InstructionLaunchDeps,
  provider: ProviderName,
  sessionId: string | undefined,
  projectId: UrlProjectId,
  isolated: boolean,
): Promise<
  Pick<StartSessionOptions, "instructionRestoration" | "instructionReadHistory">
> {
  const settings = deps.getInstructionRestorationSettings?.();
  if (!settings?.providers[provider] || isolated) return {};
  return {
    instructionRestoration: settings,
    instructionReadHistory: sessionId
      ? await deps.readInstructionHistory?.(sessionId, projectId, provider)
      : undefined,
  };
}
