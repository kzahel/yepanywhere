import type {
  AppSessionSummary,
  ProviderName,
  ProviderRuntimeStatus,
  PromptSuggestionMode,
  RecapMode,
  SessionLivenessSnapshot,
  SessionMetadataResponse,
  SessionSandboxEnforcement,
  SlashCommand,
  UploadedFile,
  UserMessageMetadata,
  SessionContentSearchRequest,
  SessionContentSearchBatch,
} from "@yep-anywhere/shared";
import type {
  InputRequest,
  Message,
  PermissionMode,
  SessionMetadata,
  SessionStatus,
} from "../types";
import type {
  DeferredQueueMessage,
  PaginationInfo,
  SessionOptions,
} from "./client";
import type { fetchJSON as FetchJson } from "./sourceApiFetch";

export function createSessionApi(fetchJSON: typeof FetchJson) {
  return {
    markSessionSeen: (
      sessionId: string,
      timestamp?: string,
      messageId?: string,
      nonHumanUserTurnMessageId?: string,
    ) =>
      // `acknowledged` is absent on servers older than the delivered-turn
      // capability, and false when the named turn was stale or unknown.
      fetchJSON<{ marked: boolean; acknowledged?: boolean }>(
        `/sessions/${sessionId}/mark-seen`,
        {
          method: "POST",
          body: JSON.stringify({
            timestamp,
            messageId,
            nonHumanUserTurnMessageId,
          }),
        },
      ),
    markSessionUnread: (sessionId: string) =>
      fetchJSON<{ marked: boolean }>(`/sessions/${sessionId}/mark-seen`, {
        method: "DELETE",
      }),
    searchSessionContent: (
      request: SessionContentSearchRequest,
      signal?: AbortSignal,
    ) =>
      fetchJSON<SessionContentSearchBatch>("/sessions/content-search", {
        method: "POST",
        body: JSON.stringify(request),
        signal,
      }),
    getSession: (
      projectId: string,
      sessionId: string,
      afterMessageId?: string,
      options?: {
        tailCompactions?: number;
        beforeMessageId?: string;
        tailTurns?: number;
        tailFrom?: string;
        fullHistory?: boolean;
        fullHistoryReason?: string;
      },
    ) => {
      const params = new URLSearchParams();
      if (afterMessageId) params.set("afterMessageId", afterMessageId);
      if (options?.tailCompactions !== undefined)
        params.set("tailCompactions", String(options.tailCompactions));
      if (options?.beforeMessageId)
        params.set("beforeMessageId", options.beforeMessageId);
      if (options?.tailTurns !== undefined)
        params.set("tailTurns", String(options.tailTurns));
      if (options?.tailFrom) params.set("tailFrom", options.tailFrom);
      if (options?.fullHistory) params.set("fullHistory", "1");
      if (options?.fullHistoryReason)
        params.set("fullHistoryReason", options.fullHistoryReason);
      const qs = params.toString();
      return fetchJSON<{
        session: SessionMetadata;
        messages: Message[];
        transcriptSnapshotUpdatedAt?: string;
        ownership: SessionStatus;
        pendingInputRequest?: InputRequest | null;
        providerRuntimeStatus?: ProviderRuntimeStatus;
        slashCommands?: SlashCommand[] | null;
        deferredMessages?: DeferredQueueMessage[];
        pagination?: PaginationInfo;
      }>(`/projects/${projectId}/sessions/${sessionId}${qs ? `?${qs}` : ""}`);
    },

    getSessionMetadata: (projectId: string, sessionId: string) =>
      fetchJSON<SessionMetadataResponse>(
        `/projects/${projectId}/sessions/${sessionId}/metadata`,
      ),

    /** Move a session to a pool account, or to Direct; kills its process. */
    switchSessionRouterAccount: (
      sessionId: string,
      target: { routerPoolId: string; routerAccountId: string } | null,
    ) =>
      fetchJSON<{ routerBinding: AppSessionSummary["routerBinding"] | null }>(
        `/agent-auth-router/sessions/${encodeURIComponent(sessionId)}/switch`,
        {
          method: "POST",
          body: JSON.stringify(target ?? { direct: true }),
        },
      ),

    resumeSession: (
      projectId: string,
      sessionId: string,
      message: string,
      options?: SessionOptions,
      attachments?: UploadedFile[],
      tempId?: string,
      clientTimestamp?: number,
      messageMetadata?: UserMessageMetadata,
    ) =>
      fetchJSON<{
        processId: string;
        permissionMode: PermissionMode;
        appliedPermissionMode?: PermissionMode;
        modeVersion: number;
        recapAfterSeconds?: number;
        sandboxEnforcement?: SessionSandboxEnforcement;
        serverTimestamp: number;
        resume?: {
          requestedMode: "full" | "compact-first";
          provider?: ProviderName;
          outcome?: "queued" | "started";
          compaction?: { status: string; [key: string]: unknown };
        };
      }>(`/projects/${projectId}/sessions/${sessionId}/resume`, {
        method: "POST",
        body: JSON.stringify({
          message,
          mode: options?.mode,
          model: options?.model,
          serviceTier: options?.serviceTier,
          thinking: options?.thinking,
          showThinking: options?.showThinking,
          provider: options?.provider,
          executor: options?.executor,
          recapMode: options?.recapMode,
          recapAfterSeconds: options?.recapAfterSeconds,
          promptSuggestionMode: options?.promptSuggestionMode,
          helperSideModel: options?.helperSideModel,
          resumeMode: options?.resumeMode,
          attachments,
          tempId,
          clientTimestamp,
          messageMetadata,
        }),
      }),

    reactivateSession: (
      projectId: string,
      sessionId: string,
      options?: {
        mode?: PermissionMode;
        model?: string;
        provider?: ProviderName;
        executor?: string;
        recapAfterSeconds?: number;
      },
    ) =>
      fetchJSON<{
        processId: string;
        permissionMode: PermissionMode;
        appliedPermissionMode?: PermissionMode;
        modeVersion: number;
        recapAfterSeconds?: number;
        sandboxEnforcement?: SessionSandboxEnforcement;
        serverTimestamp: number;
      }>(`/projects/${projectId}/sessions/${sessionId}/reactivate`, {
        method: "POST",
        body: JSON.stringify({
          mode: options?.mode,
          model: options?.model,
          provider: options?.provider,
          executor: options?.executor,
          recapAfterSeconds: options?.recapAfterSeconds,
        }),
      }),

    abortProcess: (processId: string, options?: { blockResume?: boolean }) =>
      fetchJSON<{
        aborted: true;
        processId: string;
        sessionId: string;
        pid?: number;
        verifiedStopped: true;
        verification: "pid" | "provider" | "iterator";
        /** Present when the abort also exempted the session from auto-resume. */
        resumeExemption?: {
          heartbeatDisabled: boolean;
          autoResumeDisabled: boolean;
          error?: string;
        };
      }>(`/processes/${processId}/abort`, {
        method: "POST",
        ...(options?.blockResume
          ? { body: JSON.stringify({ blockResume: true }) }
          : {}),
      }),

    getProcessInfo: (sessionId: string) =>
      fetchJSON<{
        process: {
          id: string;
          sessionId: string;
          projectId: string;
          projectPath: string;
          projectName: string;
          sessionTitle: string | null;
          state: string;
          startedAt: string;
          queueDepth: number;
          idleSince?: string;
          terminationReason?: string;
          terminatedAt?: string;
          provider: ProviderName;
          thinking?: { type: string };
          effort?: string;
          model?: string;
          /** Provider service tier, e.g. Codex "priority"; absent is Standard. */
          serviceTier?: string;
          /** YA model id (launch alias) for keying per-model settings. */
          requestedModel?: string;
          liveness?: SessionLivenessSnapshot;
          providerRuntimeStatus?: ProviderRuntimeStatus;
          recapMode?: RecapMode;
          recapAfterSeconds?: number;
          promptSuggestionMode?: PromptSuggestionMode;
          helperSideModel?: string;
        } | null;
      }>(`/sessions/${sessionId}/process`),

    updateSessionMetadata: (
      sessionId: string,
      updates: {
        title?: string;
        archived?: boolean;
        starred?: boolean;
        sidebarCategory?: string | null;
        parentSessionId?: string | null;
        promptSuggestionMode?: PromptSuggestionMode | null;
      },
    ) =>
      fetchJSON<{ updated: boolean }>(`/sessions/${sessionId}/metadata`, {
        method: "PUT",
        body: JSON.stringify(updates),
      }),

    cloneSession: (
      projectId: string,
      sessionId: string,
      title?: string,
      provider?: string,
      parentSessionId?: string,
    ) =>
      fetchJSON<{
        sessionId: string;
        messageCount: number;
        clonedFrom: string;
        provider: string;
      }>(`/projects/${projectId}/sessions/${sessionId}/clone`, {
        method: "POST",
        body: JSON.stringify({ title, provider, parentSessionId }),
      }),

    sendConversationContext: (
      projectId: string,
      sessionId: string,
      request: import("@yep-anywhere/shared").ConversationContextRequest,
    ) =>
      fetchJSON<import("@yep-anywhere/shared").ConversationContextReceipt>(
        `/projects/${projectId}/sessions/${sessionId}/conversation-context`,
        { method: "POST", body: JSON.stringify(request) },
      ),
  };
}

export type SessionApi = ReturnType<typeof createSessionApi>;
