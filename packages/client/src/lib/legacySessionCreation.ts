import {
  SERVER_CAPABILITIES,
  getSessionTextCreationCapability,
  serverHasCapability,
  type ServerCapabilitySource,
  type UserMessageMetadata,
  type UploadedFile,
  type ProviderName,
  type PermissionMode,
  type SessionSandboxEnforcement,
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

/** Wire bindings exist only for the supported older-server adapter. */
export function legacySessionCreationApi(
  fetchJSON: typeof import("../api/sourceApiFetch").fetchJSON,
) {
  return {
    startSession: (
      projectId: string,
      message: string,
      options?: SessionOptions,
      attachments?: UploadedFile[],
      clientTimestamp?: number,
      messageMetadata?: UserMessageMetadata,
    ) =>
      fetchJSON<{
        sessionId: string;
        processId: string;
        projectId: string;
        provider?: ProviderName;
        model?: string;
        permissionMode: PermissionMode;
        appliedPermissionMode?: PermissionMode;
        modeVersion: number;
        recapAfterSeconds?: number;
        sandboxEnforcement?: SessionSandboxEnforcement;
        serverTimestamp: number;
      }>(`/projects/${projectId}/sessions`, {
        method: "POST",
        body: JSON.stringify({
          message,
          mode: options?.mode,
          model: options?.model,
          serviceTier: options?.serviceTier,
          thinking: options?.thinking,
          showThinking: options?.showThinking,
          provider: options?.provider,
          computerControl: options?.computerControl,
          machineControl: options?.machineControl,
          routerAccountId: options?.routerAccountId,
          routerPoolId: options?.routerPoolId,
          routerPolicy: options?.routerPolicy,
          executor: options?.executor,
          sandboxLevel: options?.sandboxLevel,
          sandboxNetworkFirewall: options?.sandboxNetworkFirewall,
          recapMode: options?.recapMode,
          recapAfterSeconds: options?.recapAfterSeconds,
          promptSuggestionMode: options?.promptSuggestionMode,
          helperSideModel: options?.helperSideModel,
          attachments,
          clientTimestamp,
          messageMetadata,
          creationProvenance: options?.creationProvenance,
        }),
      }),

    /**
     * Create a session without sending an initial message.
     * Use this for two-phase flow: create session, upload files, then send message.
     */
    createSession: (projectId: string, options?: SessionOptions) =>
      fetchJSON<{
        sessionId: string;
        processId: string;
        projectId: string;
        permissionMode: PermissionMode;
        appliedPermissionMode?: PermissionMode;
        modeVersion: number;
        recapAfterSeconds?: number;
        sandboxEnforcement?: SessionSandboxEnforcement;
        serverTimestamp: number;
      }>(`/projects/${projectId}/sessions/create`, {
        method: "POST",
        body: JSON.stringify({
          mode: options?.mode,
          model: options?.model,
          serviceTier: options?.serviceTier,
          thinking: options?.thinking,
          showThinking: options?.showThinking,
          provider: options?.provider,
          computerControl: options?.computerControl,
          machineControl: options?.machineControl,
          routerAccountId: options?.routerAccountId,
          routerPoolId: options?.routerPoolId,
          routerPolicy: options?.routerPolicy,
          executor: options?.executor,
          sandboxLevel: options?.sandboxLevel,
          sandboxNetworkFirewall: options?.sandboxNetworkFirewall,
          recapMode: options?.recapMode,
          recapAfterSeconds: options?.recapAfterSeconds,
          promptSuggestionMode: options?.promptSuggestionMode,
          helperSideModel: options?.helperSideModel,
          creationProvenance: options?.creationProvenance,
        }),
      }),

    startDetachedSession: (
      message: string,
      options?: SessionOptions,
      attachments?: UploadedFile[],
      clientTimestamp?: number,
      messageMetadata?: UserMessageMetadata,
    ) =>
      fetchJSON<{
        sessionId: string;
        processId: string;
        projectId: string;
        permissionMode: PermissionMode;
        appliedPermissionMode?: PermissionMode;
        modeVersion: number;
        recapAfterSeconds?: number;
        sandboxEnforcement?: SessionSandboxEnforcement;
        serverTimestamp: number;
      }>(`/sessions`, {
        method: "POST",
        body: JSON.stringify({
          message,
          mode: options?.mode,
          model: options?.model,
          serviceTier: options?.serviceTier,
          thinking: options?.thinking,
          showThinking: options?.showThinking,
          provider: options?.provider,
          computerControl: options?.computerControl,
          machineControl: options?.machineControl,
          routerAccountId: options?.routerAccountId,
          routerPoolId: options?.routerPoolId,
          routerPolicy: options?.routerPolicy,
          executor: options?.executor,
          sandboxLevel: options?.sandboxLevel,
          sandboxNetworkFirewall: options?.sandboxNetworkFirewall,
          recapMode: options?.recapMode,
          recapAfterSeconds: options?.recapAfterSeconds,
          promptSuggestionMode: options?.promptSuggestionMode,
          helperSideModel: options?.helperSideModel,
          attachments,
          clientTimestamp,
          messageMetadata,
          creationProvenance: options?.creationProvenance,
        }),
      }),

    createDetachedSession: (options?: SessionOptions) =>
      fetchJSON<{
        sessionId: string;
        processId: string;
        projectId: string;
        permissionMode: PermissionMode;
        appliedPermissionMode?: PermissionMode;
        modeVersion: number;
        recapAfterSeconds?: number;
        sandboxEnforcement?: SessionSandboxEnforcement;
        serverTimestamp: number;
      }>(`/sessions/create`, {
        method: "POST",
        body: JSON.stringify({
          mode: options?.mode,
          model: options?.model,
          serviceTier: options?.serviceTier,
          thinking: options?.thinking,
          showThinking: options?.showThinking,
          provider: options?.provider,
          computerControl: options?.computerControl,
          machineControl: options?.machineControl,
          routerAccountId: options?.routerAccountId,
          routerPoolId: options?.routerPoolId,
          routerPolicy: options?.routerPolicy,
          executor: options?.executor,
          sandboxLevel: options?.sandboxLevel,
          sandboxNetworkFirewall: options?.sandboxNetworkFirewall,
          recapMode: options?.recapMode,
          recapAfterSeconds: options?.recapAfterSeconds,
          promptSuggestionMode: options?.promptSuggestionMode,
          helperSideModel: options?.helperSideModel,
          creationProvenance: options?.creationProvenance,
        }),
      }),
  };
}
type LegacyApi = ReturnType<typeof legacySessionCreationApi> &
  Pick<typeof apiShape, "queueMessage">;

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
