import { dirname, join } from "node:path";
import type { ProviderName, UrlProjectId } from "@yep-anywhere/shared";
import type { StartSessionOptions } from "../sdk/providers/types.js";
import {
  type BootInstructionsLaunch,
  settledSessionBoot,
} from "../sessions/session-boot-instructions.js";
import type { ModelSettings } from "./SessionActivationCoordinator.js";
import type { SupervisorOptions } from "./Supervisor.js";

/** The Supervisor options a launch's instruction settings read. */
export type InstructionLaunchDeps = Pick<
  SupervisorOptions,
  | "getInstructionRestorationSettings"
  | "readInstructionHistory"
  | "sessionMetadataService"
  | "sandboxStateRoot"
>;

/**
 * Boot homes sit beside the sandbox state root; both are fixed children of
 * the server's data directory.
 */
function bootHomeRoot(deps: InstructionLaunchDeps): string | undefined {
  return deps.sandboxStateRoot
    ? join(dirname(deps.sandboxStateRoot), "boot-homes")
    : undefined;
}

/**
 * The boot instructions a launch applies: the session's saved ones, else
 * those a new session's settings carry.
 */
function bootInstructionsLaunch(
  deps: InstructionLaunchDeps,
  sessionId: string | undefined,
  modelSettings: ModelSettings | undefined,
): BootInstructionsLaunch | undefined {
  const saved = sessionId
    ? deps.sessionMetadataService?.getMetadata(sessionId)
    : undefined;
  const { apiClient, bootInstructions } = settledSessionBoot(
    saved,
    modelSettings,
  );
  if (!bootInstructions) return undefined;
  return {
    source: bootInstructions,
    ...(apiClient ? { apiClient } : {}),
    homeRoot: bootHomeRoot(deps),
  };
}

/**
 * Instruction options for one provider launch: server-wide instructions, the
 * session's boot instructions, and instruction restoration, which is off for
 * an isolated (sandboxed or remote) launch or a provider the setting
 * excludes. Boot instructions are refused for an isolated launch.
 */
export async function instructionLaunchOptions(
  deps: InstructionLaunchDeps,
  provider: ProviderName,
  sessionId: string | undefined,
  projectId: UrlProjectId,
  isolated: boolean,
  modelSettings: ModelSettings | undefined,
  createdSessionId: string | undefined,
): Promise<
  Pick<
    StartSessionOptions,
    | "instructionRestoration"
    | "instructionReadHistory"
    | "globalInstructions"
    | "bootInstructions"
  >
> {
  const bootInstructions = bootInstructionsLaunch(
    deps,
    sessionId ?? createdSessionId,
    modelSettings,
  );
  if (bootInstructions && isolated)
    throw new Error(
      "Boot instructions unavailable for a sandboxed session: start it without a sandbox",
    );
  const launch = {
    globalInstructions: modelSettings?.globalInstructions,
    ...(bootInstructions ? { bootInstructions } : {}),
  };
  const settings = deps.getInstructionRestorationSettings?.();
  if (!settings?.providers[provider] || isolated) return launch;
  return {
    ...launch,
    instructionRestoration: settings,
    instructionReadHistory: sessionId
      ? await deps.readInstructionHistory?.(sessionId, projectId, provider)
      : undefined,
  };
}
