import {
  SERVER_CAPABILITIES,
  getSessionTextCreationCapability,
  serverHasCapability,
  type ServerCapabilitySource,
  type UserMessageMetadata,
  type UploadedFile,
} from "@yep-anywhere/shared";
import type { api as apiShape, SessionOptions } from "../api/client";

/** Partial pre-admission servers keep their exact narrow contract. */
export function supportsSessionCreation(
  version: ServerCapabilitySource | null | undefined,
  choices: {
    provider?: string | null;
    limited?: boolean;
    sandbox?: string;
    machineControl?: boolean;
    command?: boolean;
    fileCount: number;
    stagedCount: number;
  },
): boolean {
  if (
    serverHasCapability(
      version,
      SERVER_CAPABILITIES.sessionCreationAdmission.name,
    )
  )
    return true;
  const capability = getSessionTextCreationCapability(choices.provider);
  return Boolean(
    capability &&
      serverHasCapability(version, capability.name) &&
      !choices.limited &&
      choices.sandbox === "none" &&
      !choices.machineControl &&
      !choices.command &&
      (!choices.fileCount ||
        (choices.fileCount === choices.stagedCount &&
          ["claude", "codex"].includes(choices.provider ?? "") &&
          serverHasCapability(
            version,
            SERVER_CAPABILITIES.stagedSessionCreation.name,
          ))),
  );
}

type LegacyApi = Pick<
  typeof apiShape,
  | "createSession"
  | "createDetachedSession"
  | "startSession"
  | "startDetachedSession"
  | "queueMessage"
>;

/** The only client creation engine for supported older servers. No new-route probe. */
export async function createLegacySession({
  version,
  api,
  projectId,
  message,
  options,
  clientTimestamp,
  metadata,
  materialize,
}: {
  version: ServerCapabilitySource | null | undefined;
  api: LegacyApi;
  projectId?: string;
  message: string;
  options: SessionOptions;
  clientTimestamp: number;
  metadata?: UserMessageMetadata;
  materialize?: (
    projectId: string,
    sessionId: string,
  ) => Promise<UploadedFile[]>;
}) {
  if (
    serverHasCapability(
      version,
      SERVER_CAPABILITIES.sessionCreationAdmission.name,
    )
  )
    throw new Error("Current servers require durable creation admission");
  if (!materialize)
    return projectId
      ? api.startSession(
          projectId,
          message,
          options,
          undefined,
          clientTimestamp,
          metadata,
        )
      : api.startDetachedSession(
          message,
          options,
          undefined,
          clientTimestamp,
          metadata,
        );
  const result = projectId
    ? await api.createSession(projectId, options)
    : await api.createDetachedSession(options);
  const files = await materialize(result.projectId, result.sessionId);
  await api.queueMessage(
    result.sessionId,
    message,
    options.mode,
    files.length ? files : undefined,
    undefined,
    options.thinking,
    undefined,
    clientTimestamp,
    metadata,
    undefined,
    options.showThinking,
  );
  return result;
}
