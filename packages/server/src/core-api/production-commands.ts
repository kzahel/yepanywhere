import { stat } from "node:fs/promises";
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
    dataDir?: string;
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
      dataDir: options.dataDir,
      approvalAuditEnabled: () =>
        options.serverSettingsService?.getSetting("approvalAuditLogEnabled") ===
        true,
      creations: options.sessionMetadataService?.creations,
      callerLaunch: agentApiCallerLaunch(options, supervisor),
      projectDirectoryExists: (path) =>
        stat(path).then(
          (entry) => entry.isDirectory(),
          () => false,
        ),
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
    // The receipt says only that the outcome is uncertain; say why here.
    (receiptId, reason) =>
      getLogger().warn(
        {
          event: "agent_api_launch_failed",
          receiptId,
          reason:
            reason instanceof Error
              ? (reason.stack ?? reason.message)
              : reason === undefined
                ? "no reason reported"
                : String(reason),
        },
        "Agent API session launch ended without a durable outcome",
      ),
  );
}
