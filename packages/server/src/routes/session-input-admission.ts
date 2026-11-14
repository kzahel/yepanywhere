import type { PermissionMode, UserMessage } from "../sdk/types.js";
import type { Process } from "../supervisor/Process.js";
import { isClaudeSdkProviderName } from "./session-provider-resolution.js";

/**
 * Queue admission shared by the composer route and the v0 inputs API, so
 * queued compaction and YA-queue delivery cannot drift between humans and
 * agents. Callers own their request shape, authority and response.
 */
export interface InputAdmissionRefusal {
  status: 400 | 409;
  code: "invalid_request" | "compaction_unsupported";
  message: string;
}

/** Marks the message as an explicit queued compaction, or explains why not. */
export async function prepareQueuedCompaction(
  process: Process,
  message: UserMessage,
  argument: string,
): Promise<InputAdmissionRefusal | undefined> {
  if (
    process.provider !== "codex" &&
    !isClaudeSdkProviderName(process.provider)
  )
    return {
      status: 409,
      code: "compaction_unsupported",
      message: "Queued compaction is unavailable for this provider",
    };
  if (
    message.attachments?.length ||
    message.images?.length ||
    message.documents?.length
  )
    return {
      status: 400,
      code: "invalid_request",
      message: "Queue compaction separately from attachments",
    };
  const commands = await process.supportedCommands();
  if (
    !commands?.some((command) => command.name.replace(/^\//, "") === "compact")
  )
    return {
      status: 409,
      code: "compaction_unsupported",
      message: "This session does not advertise compaction",
    };
  if (message.metadata) message.metadata.compactAboveContextPercent = undefined;
  message.queuedCompact = { command: "compact", argument };
  return undefined;
}

/**
 * Holds the message in YA's regular or patient queue until its delivery
 * boundary; an idle process may accept it at once.
 */
export async function deferSessionInput(
  process: Process,
  message: UserMessage,
  options: {
    mode?: PermissionMode;
    /**
     * Runs synchronously immediately before the queue mutation; false
     * abandons admission without queueing.
     */
    beforeDefer?: () => boolean;
  } = {},
): Promise<ReturnType<Process["deferMessage"]>> {
  if (options.mode) process.setPermissionMode(options.mode);
  await process.primeSupportedCommandsForMessage(message);
  if (options.beforeDefer?.() === false)
    return {
      success: false,
      deferred: false,
      error: "Admission was withdrawn",
    };
  const result = process.deferMessage(message, { promoteIfReady: true });
  if (result.success) await process.waitForPatientQueuePersistenceIdle();
  return result;
}
