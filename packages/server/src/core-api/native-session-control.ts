import type { Supervisor } from "../supervisor/Supervisor.js";
import { appendApprovalAuditLog } from "../security/approvalAuditLog.js";
import { getLogger } from "../logging/logger.js";
import { CoreApiError } from "./errors.js";
import type { SessionCommandOwner } from "./session-commands.js";

export function nativeSessionControl(deps: {
  supervisor: Pick<Supervisor, "getProcessForSession"> &
    Partial<
      Pick<
        Supervisor,
        | "interruptProcess"
        | "abortProcessWithVerification"
        | "pauseRecapsUntilUserTurn"
      >
    >;
  dataDir?: string;
  approvalAuditEnabled?: () => boolean;
}): Pick<SessionCommandOwner, "requests" | "prepareControl"> {
  return {
    requests(id) {
      const request = deps.supervisor
        .getProcessForSession(id)
        ?.getPendingInputRequest();
      return {
        items: request
          ? [
              {
                id: request.id,
                kind:
                  request.type === "tool-approval" ? "permission" : "question",
                description: request.prompt,
                toolName: request.toolName,
                toolInput: request.toolInput,
                canRespond: request.type === "tool-approval",
              },
            ]
          : [],
      };
    },
    prepareControl(id, operation, requestId, response) {
      const process = deps.supervisor.getProcessForSession(id);
      if (!process || process.isTerminated)
        throw new CoreApiError(
          operation === "respond"
            ? "request_not_pending"
            : "session_not_running",
          operation === "respond"
            ? "Permission request is no longer pending"
            : "No incumbent provider process",
          409,
        );
      const request = process.getPendingInputRequest();
      if (
        operation === "respond" &&
        (!request ||
          request.id !== requestId ||
          request.type !== "tool-approval")
      )
        throw new CoreApiError(
          "request_not_pending",
          "Permission request is no longer pending or cannot be answered",
          409,
        );
      return async () => {
        if (
          deps.supervisor.getProcessForSession(id) !== process ||
          process.isTerminated
        )
          throw new CoreApiError(
            "session_not_running",
            "The admitted provider owner has ended",
            409,
          );
        if (operation === "respond") {
          const before = process.permissionMode;
          const accepted = process.respondToInput(requestId!, response!);
          if (deps.approvalAuditEnabled?.()) {
            try {
              await appendApprovalAuditLog(deps.dataDir, {
                timestamp: new Date().toISOString(),
                sessionId: id,
                processId: process.id,
                provider: process.provider,
                requestId: requestId!,
                request,
                response: response!,
                normalizedResponse: response!,
                accepted,
                permissionModeBefore: before,
                permissionModeAfter: process.permissionMode,
                ...(!accepted ? { failure: "Request already resolved" } : {}),
              });
            } catch (error) {
              getLogger().warn({ error }, "Approval audit append failed");
            }
          }
          if (!accepted)
            throw new CoreApiError(
              "request_not_pending",
              "Permission request already resolved",
              409,
            );
          return { accepted: true, requestId };
        }
        if (operation === "cancel") {
          const result = (await deps.supervisor.interruptProcess?.(
            process.id,
          )) ?? { success: false, supported: false };
          return {
            interrupted: result.success,
            supported: result.supported,
            aborted: result.hardAborted === true,
          };
        }
        // As the UI's Stop does: a stopped session starts no background
        // recap until its next user turn. Interrupt pauses them itself.
        await deps.supervisor.pauseRecapsUntilUserTurn?.(process.id);
        const result = await deps.supervisor.abortProcessWithVerification?.(
          process.id,
        );
        if (!result)
          throw new CoreApiError(
            "session_not_running",
            "Provider process ended before stop",
            409,
          );
        return { stopped: true, ...result };
      };
    },
  };
}
