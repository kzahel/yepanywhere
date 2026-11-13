import { SessionCommands } from "./session-commands.js";
import { nativeSessionCommandOwner } from "./native-session-commands.js";
import type { ApiReceiptStore } from "./receipt-store.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import {
  agentApiCallerLaunch,
  effectiveGlobalInstructions,
} from "../sessions/derived-launch-sources.js";
import { getLogger } from "../logging/logger.js";

export function createProductionApiCommands(
  publicServerId: string,
  apiReceipts: ApiReceiptStore,
  options: {
    serverSettingsService?: ServerSettingsService;
    sessionMetadataService?: SessionMetadataService;
  },
  supervisor: Supervisor,
) {
  return new SessionCommands(
    publicServerId,
    apiReceipts,
    nativeSessionCommandOwner({
      supervisor,
      creations: options.sessionMetadataService?.creations,
      callerLaunch: agentApiCallerLaunch(options, supervisor),
      globalInstructions: () =>
        effectiveGlobalInstructions(options.serverSettingsService),
    }),
    () =>
      options.serverSettingsService?.getSetting("agentApiManagementEnabled") ===
      true,
    (error) =>
      getLogger().error(
        { error },
        "Agent API command outcome persistence failed",
      ),
  );
}
