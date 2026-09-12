import type {
  AppSessionSummary,
  RetainedSessionCollectionState,
  AgentActivity,
  AgentContextHints,
  CacheMissBillingRecord,
  CacheMissBillingSettings,
  BrowserSettingsBackupResponse,
  BrowserSettingsBackupValues,
  ClaudeAdditionalModelSelection,
  ClaudeSteerBackgroundBashSettings,
  ClientDefaults,
  CodexCyberAccessProgram,
  CodexPlanToolMode,
  CodexReasoningSummary,
  ConnectionsResponse,
  CreatePublicFileShareRequest,
  CreatePublicFileShareResponse,
  CreateProjectWorkstreamRequest,
  CreateProjectWorkstreamResponse,
  CreateProjectQueueItemRequest,
  CreatePublicSessionShareRequest,
  CreatePublicSessionShareResponse,
  DeviceInfo,
  DurableSyntheticDoneMessage,
  FreezePublicSharesResponse,
  FreezePublicSessionLiveSharesResponse,
  HelperTargetConfig,
  HostAwakeMode,
  HostAwakeStatus,
  HostIdentity,
  ModelInfo,
  NewSessionDefaults,
  PendingInputType,
  ProjectQueueItemSummary,
  ProjectQueueListResponse,
  ProjectQueuePromoteNowRequest,
  ProjectQueuePromoteNowResponse,
  ProjectQueueResponse,
  ProjectQueueReadinessCommand,
  ProjectSessionDefaultsResponse,
  ProjectWorkstreamsResponse,
  PublicFileShareListResponse,
  PublicShareManagementListResponse,
  PublicShareStorageState,
  WorkstreamCheckoutPreviewResponse,
  PromptSuggestionMode,
  PromptCacheKeepaliveSettings,
  ProviderInfo,
  ProviderChildSessionSummary,
  ProviderName,
  ProviderSubscriptionUsage,
  RecapMode,
  PublicSessionShareSessionStatusResponse,
  PublicSessionShareViewerActionResponse,
  RevokePublicSessionSharesResponse,
  RevokeAllPublicSharesResponse,
  RevokePublicShareResponse,
  SessionQueuedMessageSummary,
  SessionSandboxEnforcement,
  SessionSandboxLevel,
  ShowThinking,
  ThinkingOption,
  TranscriptDisplayObject,
  UpdateProjectQueueItemRequest,
  UpdateProjectSessionDefaultsRequest,
  UploadedFile,
  UrlProjectId,
  UserQuestionAnswers,
  UserMessageMetadata,
  WorkstreamId,
} from "@yep-anywhere/shared";
import { PUBLIC_SHARE_MANAGEMENT_FREEZE_CONFIRMATION } from "@yep-anywhere/shared";
import type {
  AgentSession,
  InputRequest,
  PermissionMode,
  Project,
  SessionStatus,
} from "../types";
import { authApi } from "./authClient";
import { browserProfilesApi } from "./browserProfilesClient";
import { fileApi } from "./fileClient";
import { gitApi } from "./gitClient";
import { reviewApi } from "./reviewClient";
import { onboardingApi } from "./onboardingClient";
import { getDesktopAuthToken } from "./plainFetch";
import { pushApi, pushSettingsApi } from "./pushClient";
import { recentsApi } from "./recentsClient";
import { serverMetadataApi } from "./serverMetadataClient";
import { fetchJSON } from "./sourceApiFetch";
import { createSessionApi } from "./sessionClient";

/** Pagination metadata for compact-boundary-based session loading */
export interface PaginationInfo {
  hasOlderMessages: boolean;
  /** Full-session count unless the provider omitted a known-hidden prefix. */
  totalMessageCount: number;
  returnedMessageCount: number;
  truncatedBeforeMessageId?: string;
  /** Full-session count unless the provider omitted a known-hidden prefix. */
  totalCompactions: number;
  totalUserTurns?: number;
  truncatedBy?: "compact_boundary" | "user_turn";
}

/**
 * An item in the inbox representing a session that may need attention.
 */
export interface InboxItem {
  asyncQuestions?: AppSessionSummary["asyncQuestions"];
  sessionId: string;
  projectId: string;
  projectName: string;
  sessionTitle?: string | null;
  updatedAt: string;
  customTitle?: string;
  isStarred?: boolean;
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  activityInferredFromInboxTier?: boolean;
  hasUnread?: boolean;
}

/**
 * Inbox response with sessions categorized into priority tiers.
 */
export interface InboxResponse {
  catalog?: RetainedSessionCollectionState;
  needsAttention: InboxItem[];
  active: InboxItem[];
  recentActivity: InboxItem[];
  unread8h: InboxItem[];
  unread24h: InboxItem[];
}

/**
 * An item in the global sessions list.
 */
export interface GlobalSessionItem {
  asyncQuestions?: AppSessionSummary["asyncQuestions"];
  id: string;
  title?: string | null;
  fullTitle?: string | null;
  createdAt?: string;
  updatedAt: string;
  messageCount?: number;
  provider: ProviderName;
  /** Last active model for this session (from JSONL), for list/badge display. */
  model?: string;
  projectId: string;
  projectName: string;
  ownership: SessionStatus;
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  hasUnread?: boolean;
  customTitle?: string;
  isArchived?: boolean;
  isStarred?: boolean;
  /** True when an explicit manual termination disabled resume. */
  autoResumeDisabled?: boolean;
  /** Interactive Mother session for a YA-owned `/btw` aside. */
  parentSessionId?: string;
  parentSessionKind?: "btw-aside";
  /** Source session whose provider transcript was cloned or forked. */
  forkedFromSessionId?: string;
  /** Initial prompt text accepted by YA for new-session recovery/copy. */
  initialPrompt?: string;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Capped excerpt of the most recent regular agent turn (hover card). */
  lastAgentText?: string;
  /** Provider-launched child work nested under this parent. Absent on older servers. */
  providerChildren?: ProviderChildSessionSummary[];
}

/** Stats about all sessions (computed during full scan on server) */
export interface GlobalSessionStats {
  totalCount: number;
  unreadCount: number;
  starredCount: number;
  archivedCount: number;
  /** Counts per provider (non-archived only) */
  providerCounts: Partial<Record<ProviderName, number>>;
  /** Counts per executor host (non-archived only, "local" key for sessions without executor) */
  executorCounts: Record<string, number>;
}

export type DeferredQueueMessage = SessionQueuedMessageSummary;

/** Minimal project info for filter dropdowns */
export interface ProjectOption {
  id: string;
  name: string;
}

/**
 * Response from the global sessions API.
 */
export interface GlobalSessionsResponse {
  catalog?: RetainedSessionCollectionState;
  sessions: GlobalSessionItem[];
  hasMore: boolean;
  /** Global stats computed from all sessions (not just paginated results) */
  stats: GlobalSessionStats;
  /** All projects for filter dropdown */
  projects: ProjectOption[];
  /**
   * The collection revision these rows reflect, present only on a server with
   * `progressive-session-catalog`. Replaying it as `knownGeneration` against
   * the same query is what earns {@link GlobalSessionsUnchangedResponse}.
   */
  generation?: number;
}

/**
 * The answer to a conditional read whose `knownGeneration` still holds: the
 * collection did not change, so the response carries no rows and the client
 * keeps the ones it has.
 */
export interface GlobalSessionsUnchangedResponse {
  unchanged: true;
  generation: number;
}

export interface GlobalSessionsRequest {
  summaryMode?: "retained";
  project?: string;
  q?: string;
  after?: string;
  limit?: number;
  includeArchived?: boolean;
  starred?: boolean;
  includeStats?: boolean;
}

/**
 * A read that offers a generation this client already holds rows for, from a
 * prior response to this same query. Only send it behind
 * `progressive-session-catalog`; an older server ignores the parameter and
 * walks anyway, which is correct but pointless.
 */
export interface ConditionalGlobalSessionsRequest
  extends GlobalSessionsRequest {
  knownGeneration: number;
}

export function isUnchangedGlobalSessionsResponse(
  response: GlobalSessionsResponse | GlobalSessionsUnchangedResponse,
): response is GlobalSessionsUnchangedResponse {
  return (response as GlobalSessionsUnchangedResponse).unchanged === true;
}

export interface SessionOptions {
  computerControl?: boolean;
  mode?: PermissionMode;
  /** Model ID (e.g., "sonnet", "opus", "qwen2.5-coder:0.5b") */
  model?: string;
  /** Provider-visible service tier. Omit for provider/default behavior. */
  serviceTier?: string;
  thinking?: ThinkingOption;
  /** Display preference for thinking rows (default/on/off). */
  showThinking?: ShowThinking;
  provider?: ProviderName;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Default-off YA host filesystem confinement for a newly created session. */
  sandboxLevel?: SessionSandboxLevel;
  /** Public-only egress boundary for project-write sessions. */
  sandboxNetworkFirewall?: boolean;
  /** Recap behavior for future away-return triggers in this session. */
  recapMode?: RecapMode;
  /** Browser-away duration before YA asks this session for a recap. */
  recapAfterSeconds?: number;
  /** Prompt suggestion behavior for this session. */
  promptSuggestionMode?: PromptSuggestionMode;
  /** Session-level helper side model for simulated helper features. */
  helperSideModel?: string;
  /** Existing-session resume strategy. */
  resumeMode?: "full" | "compact-first";
  /** Experimental project workstream lane for new project sessions. */
  workstreamId?: WorkstreamId;
}

export type { UploadedFile } from "@yep-anywhere/shared";

/** Get the desktop auth token (if running inside Tauri iframe). */
export { getDesktopAuthToken };

export type { AuthStatus } from "./authClient";

export type {
  EnvSettingEntry,
  EnvSettingsReport,
  GetVersionOptions,
  ServerInfo,
  VersionInfo,
} from "./serverMetadataClient";

export { fetchJSON } from "./sourceApiFetch";

// Re-export upload functions
export {
  buildStagedUploadUrl,
  buildUploadUrl,
  fileToChunks,
  UploadError,
  uploadChunks,
  uploadFile,
  uploadStagedChunks,
  uploadStagedFile,
  type UploadOptions,
} from "./upload";

export interface NetworkInterface {
  /** Interface name (e.g., "eth0", "wlan0") */
  name: string;
  /** IP address */
  address: string;
  /** IPv4 or IPv6 */
  family: "IPv4" | "IPv6";
  /** Whether this is a loopback/internal interface */
  internal: boolean;
  /** Human-readable display name */
  displayName: string;
}

export interface NetworkBindingState {
  localhost: { port: number; overriddenByCli: boolean };
  network: {
    enabled: boolean;
    host: string | null;
    port: number | null;
    overriddenByCli: boolean;
  };
  interfaces: NetworkInterface[];
}

export interface UpdateBindingRequest {
  localhostPort?: number;
  network?: {
    enabled: boolean;
    host?: string;
    port?: number;
  };
}

export interface UpdateBindingResponse {
  success: boolean;
  error?: string;
  redirectUrl?: string;
}

/**
 * Overloaded so only a caller that sends `knownGeneration` has to narrow: the
 * server answers `unchanged` exactly when it was asked to.
 */
function getGlobalSessionsRequest(
  params?: GlobalSessionsRequest,
): Promise<GlobalSessionsResponse>;
function getGlobalSessionsRequest(
  params: ConditionalGlobalSessionsRequest,
): Promise<GlobalSessionsResponse | GlobalSessionsUnchangedResponse>;
function getGlobalSessionsRequest(
  params?: Partial<ConditionalGlobalSessionsRequest>,
): Promise<GlobalSessionsResponse | GlobalSessionsUnchangedResponse> {
  const searchParams = new URLSearchParams();
  if (params?.summaryMode) searchParams.set("summaryMode", params.summaryMode);
  if (params?.project) searchParams.set("project", params.project);
  if (params?.q) searchParams.set("q", params.q);
  if (params?.after) searchParams.set("after", params.after);
  if (params?.limit) searchParams.set("limit", String(params.limit));
  if (params?.includeArchived) searchParams.set("includeArchived", "true");
  if (params?.starred) searchParams.set("starred", "true");
  if (params?.includeStats) searchParams.set("includeStats", "true");
  if (params?.knownGeneration !== undefined) {
    searchParams.set("knownGeneration", String(params.knownGeneration));
  }
  const query = searchParams.toString();
  return fetchJSON<GlobalSessionsResponse | GlobalSessionsUnchangedResponse>(
    query ? `/sessions?${query}` : "/sessions",
  );
}

export const api = {
  ...createSessionApi(fetchJSON),
  // Server metadata/admin API
  ...serverMetadataApi,

  // Network binding API (runtime port/interface configuration)
  getNetworkBinding: () => fetchJSON<NetworkBindingState>("/network-binding"),

  setNetworkBinding: (request: UpdateBindingRequest) =>
    fetchJSON<UpdateBindingResponse>("/network-binding", {
      method: "PUT",
      body: JSON.stringify(request),
    }),

  disableNetworkBinding: () =>
    fetchJSON<UpdateBindingResponse>("/network-binding", {
      method: "DELETE",
    }),

  // Provider API
  getProviders: (options?: { refresh?: boolean }) =>
    fetchJSON<{ providers: ProviderInfo[] }>(
      options?.refresh ? "/providers?refresh=1" : "/providers",
      options?.refresh
        ? { headers: { "Cache-Control": "no-cache" } }
        : undefined,
    ),

  /**
   * Fetch one provider's status and model catalog.
   *
   * The aggregate `/providers` request waits for every exposed provider, so a
   * slow unselected provider delays the selected one. This route resolves the
   * selected provider on its own; the server coalesces it with any aggregate
   * request already probing that provider.
   */
  getProvider: (provider: ProviderName, options?: { refresh?: boolean }) =>
    fetchJSON<{ provider: ProviderInfo }>(
      `/providers/${encodeURIComponent(provider)}${
        options?.refresh ? "?refresh=1" : ""
      }`,
      options?.refresh
        ? { headers: { "Cache-Control": "no-cache" } }
        : undefined,
    ),

  getProviderSubscriptionUsage: (
    provider: ProviderName,
    options?: { refresh?: boolean },
  ) =>
    fetchJSON<{ usage: ProviderSubscriptionUsage | null }>(
      `/providers/${encodeURIComponent(provider)}/subscription-usage${
        options?.refresh ? "?refresh=1" : ""
      }`,
      options?.refresh
        ? { headers: { "Cache-Control": "no-cache" } }
        : undefined,
    ),

  getProjects: () => fetchJSON<{ projects: Project[] }>("/projects"),

  /**
   * Add a project by file path.
   * Validates the path exists on disk and returns project info.
   * Supports ~ for home directory and normalizes trailing slashes.
   */
  addProject: (path: string) =>
    fetchJSON<{ project: Project }>("/projects", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  getProject: (projectId: string) =>
    fetchJSON<{ project: Project }>(`/projects/${projectId}`),

  updateProjectCodeName: (projectId: string, codeName: string) =>
    fetchJSON<{
      assignments: Array<{ projectId: string; codeName: string }>;
    }>(`/projects/${encodeURIComponent(projectId)}/code-name`, {
      method: "PATCH",
      body: JSON.stringify({ codeName }),
    }),

  getProjectSessionDefaults: (projectId: string) =>
    fetchJSON<ProjectSessionDefaultsResponse>(
      `/projects/${projectId}/session-defaults`,
    ),

  updateProjectSessionDefaults: (
    projectId: string,
    updates: UpdateProjectSessionDefaultsRequest,
  ) =>
    fetchJSON<ProjectSessionDefaultsResponse>(
      `/projects/${projectId}/session-defaults`,
      {
        method: "PATCH",
        body: JSON.stringify(updates),
      },
    ),

  deleteProject: (projectId: string) =>
    fetchJSON<{ removed: boolean; projectId: string; path: string }>(
      `/projects/${projectId}`,
      {
        method: "DELETE",
      },
    ),

  reclassifySessionProject: (
    projectId: string,
    sessionId: string,
    targetProjectId: string,
  ) =>
    fetchJSON<{
      updated: boolean;
      projectId: UrlProjectId;
      transcriptProjectId: UrlProjectId | null;
    }>(`/projects/${projectId}/sessions/${sessionId}/project`, {
      method: "PUT",
      body: JSON.stringify({ projectId: targetProjectId }),
    }),

  /**
   * Recompute the hover-card recent-activity excerpt for a non-running session
   * and push it to lists/hovers via a session-updated event. Fire-and-update:
   * the refreshed value arrives through the activity stream, not this response.
   */
  refreshSessionPreview: (projectId: string, sessionId: string) =>
    fetchJSON<{ lastAgentText: string | null }>(
      `/projects/${projectId}/sessions/${sessionId}/refresh-preview`,
      { method: "POST" },
    ),

  getProjectQueue: (projectId: string) =>
    fetchJSON<ProjectQueueResponse>(`/projects/${projectId}/queue`),

  getProjectWorkstreams: (projectId: string) =>
    fetchJSON<ProjectWorkstreamsResponse>(`/projects/${projectId}/workstreams`),

  getProjectWorkstreamCheckoutPreview: (projectId: string, label: string) => {
    const params = new URLSearchParams({ label });
    return fetchJSON<WorkstreamCheckoutPreviewResponse>(
      `/projects/${projectId}/workstreams/checkout-preview?${params}`,
    );
  },

  createProjectWorkstream: (
    projectId: string,
    request: CreateProjectWorkstreamRequest,
  ) =>
    fetchJSON<CreateProjectWorkstreamResponse>(
      `/projects/${projectId}/workstreams`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    ),

  getProjectQueueItems: () =>
    fetchJSON<ProjectQueueListResponse>("/project-queue"),

  pauseProjectQueueDispatch: () =>
    fetchJSON<ProjectQueueListResponse>("/project-queue/pause", {
      method: "POST",
    }),

  resumeProjectQueueDispatch: () =>
    fetchJSON<ProjectQueueListResponse>("/project-queue/resume", {
      method: "POST",
    }),

  promoteProjectQueueNow: (
    projectId: string,
    request: ProjectQueuePromoteNowRequest = {},
  ) =>
    fetchJSON<ProjectQueuePromoteNowResponse>(
      `/project-queue/${encodeURIComponent(projectId)}/promote-now`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    ),

  createProjectQueueItem: (
    projectId: string,
    request: CreateProjectQueueItemRequest,
  ) =>
    fetchJSON<{
      item: ProjectQueueItemSummary;
      queue: ProjectQueueResponse;
    }>(`/projects/${projectId}/queue`, {
      method: "POST",
      body: JSON.stringify(request),
    }),

  updateProjectQueueItem: (
    projectId: string,
    itemId: string,
    request: UpdateProjectQueueItemRequest,
  ) =>
    fetchJSON<{
      item: ProjectQueueItemSummary;
      queue: ProjectQueueResponse;
    }>(`/projects/${projectId}/queue/${encodeURIComponent(itemId)}`, {
      method: "PATCH",
      body: JSON.stringify(request),
    }),

  deleteProjectQueueItem: (projectId: string, itemId: string) =>
    fetchJSON<{
      deleted: boolean;
      queue: ProjectQueueResponse;
    }>(`/projects/${projectId}/queue/${encodeURIComponent(itemId)}`, {
      method: "DELETE",
    }),

  retryProjectQueueItem: (projectId: string, itemId: string) =>
    fetchJSON<{
      item: ProjectQueueItemSummary;
      queue: ProjectQueueResponse;
    }>(`/projects/${projectId}/queue/${encodeURIComponent(itemId)}/retry`, {
      method: "POST",
    }),

  moveProjectQueueItemToTop: (projectId: string, itemId: string) =>
    fetchJSON<{
      item: ProjectQueueItemSummary;
      queue: ProjectQueueResponse;
    }>(
      `/projects/${projectId}/queue/${encodeURIComponent(itemId)}/move-to-top`,
      {
        method: "POST",
      },
    ),

  /**
   * Get agent session content for lazy-loading completed Tasks.
   * Used to fetch subagent messages on demand when expanding a Task.
   */
  getAgentSession: (projectId: string, sessionId: string, agentId: string) =>
    fetchJSON<AgentSession>(
      `/projects/${projectId}/sessions/${sessionId}/agents/${agentId}`,
    ),

  /**
   * Get mappings of toolUseId → agentId for all agent files.
   * Used to find agent sessions for pending Tasks on page reload.
   */
  getAgentMappings: (projectId: string, sessionId: string) =>
    fetchJSON<{ mappings: Array<{ toolUseId: string; agentId: string }> }>(
      `/projects/${projectId}/sessions/${sessionId}/agents`,
    ),

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
        executor: options?.executor,
        sandboxLevel: options?.sandboxLevel,
        sandboxNetworkFirewall: options?.sandboxNetworkFirewall,
        recapMode: options?.recapMode,
        recapAfterSeconds: options?.recapAfterSeconds,
        promptSuggestionMode: options?.promptSuggestionMode,
        helperSideModel: options?.helperSideModel,
        workstreamId: options?.workstreamId,
        attachments,
        clientTimestamp,
        messageMetadata,
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
        executor: options?.executor,
        sandboxLevel: options?.sandboxLevel,
        sandboxNetworkFirewall: options?.sandboxNetworkFirewall,
        recapMode: options?.recapMode,
        recapAfterSeconds: options?.recapAfterSeconds,
        promptSuggestionMode: options?.promptSuggestionMode,
        helperSideModel: options?.helperSideModel,
        workstreamId: options?.workstreamId,
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
        executor: options?.executor,
        sandboxLevel: options?.sandboxLevel,
        sandboxNetworkFirewall: options?.sandboxNetworkFirewall,
        recapMode: options?.recapMode,
        recapAfterSeconds: options?.recapAfterSeconds,
        promptSuggestionMode: options?.promptSuggestionMode,
        helperSideModel: options?.helperSideModel,
      }),
    }),

  restartSession: (
    projectId: string,
    sessionId: string,
    options?: SessionOptions & {
      reason?: string;
      /** "handoff" (default) or "fork" (real transcript fork, Claude only). */
      restartMode?: "handoff" | "fork";
      /** Fork slice point (transcript message UUID, inclusive). */
      forkUpToMessageId?: string;
      /** Client URL the user was on; shown in the handoff Source Session block. */
      sourceUrl?: string;
      /**
       * Seed the successor with this message instead of the text the server
       * would build, set when the user edited the handoff draft. Ignored by
       * "fork", which copies the real transcript.
       */
      handoffText?: string;
    },
  ) =>
    fetchJSON<{
      sessionId: string;
      processId: string;
      projectId: string;
      provider?: ProviderName;
      title?: string;
      permissionMode: PermissionMode;
      appliedPermissionMode?: PermissionMode;
      modeVersion: number;
      recapAfterSeconds?: number;
      sandboxEnforcement?: SessionSandboxEnforcement;
      restartedFrom: string;
      forkUpToMessageId?: string;
      oldProcessId?: string;
      oldProcessInterrupted: boolean;
      oldProcessAbortDeferred: boolean;
      oldProcessAborted: boolean;
    }>(`/projects/${projectId}/sessions/${sessionId}/restart`, {
      method: "POST",
      body: JSON.stringify({
        mode: options?.mode,
        model: options?.model,
        serviceTier: options?.serviceTier,
        thinking: options?.thinking,
        showThinking: options?.showThinking,
        provider: options?.provider,
        executor: options?.executor,
        sandboxLevel: options?.sandboxLevel,
        sandboxNetworkFirewall: options?.sandboxNetworkFirewall,
        recapMode: options?.recapMode,
        recapAfterSeconds: options?.recapAfterSeconds,
        promptSuggestionMode: options?.promptSuggestionMode,
        helperSideModel: options?.helperSideModel,
        reason: options?.reason,
        restartMode: options?.restartMode,
        forkUpToMessageId: options?.forkUpToMessageId,
        sourceUrl: options?.sourceUrl,
        handoffText: options?.handoffText,
      }),
    }),

  /**
   * The handoff message as it stands now, for the Handoff Session dialog to
   * offer as an editable draft. Compacts first, like the handoff itself, but
   * leaves the source session running.
   */
  getRestartHandoff: (
    projectId: string,
    sessionId: string,
    options?: { sourceUrl?: string },
  ) =>
    fetchJSON<{
      handoff: string;
      handoffTitle: string;
      compactStatus: string;
    }>(
      `/projects/${projectId}/sessions/${sessionId}/restart/handoff${
        options?.sourceUrl
          ? `?sourceUrl=${encodeURIComponent(options.sourceUrl)}`
          : ""
      }`,
    ),

  /**
   * Fork the provider transcript into a new session without starting a
   * process or sending a message ("fork from here"). The fork opens cold;
   * the next send resumes it normally.
   */
  forkSession: (
    projectId: string,
    sessionId: string,
    options?:
      | { upToMessageId?: string }
      | {
          forkKind: "clone-latest-complete";
        }
      | {
          forkKind: "before-user-turn" | "after-user-turn";
          sourceMessageId: string;
        },
  ) =>
    fetchJSON<{
      sessionId: string;
      projectId: string;
      provider?: ProviderName;
      title?: string;
      forkedFrom: string;
      upToMessageId?: string;
      forkKind?:
        | "clone-latest-complete"
        | "before-user-turn"
        | "after-user-turn";
      sourceMessageId?: string;
      retainedThroughMessageId?: string;
    }>(`/projects/${projectId}/sessions/${sessionId}/fork`, {
      method: "POST",
      body: JSON.stringify(options ?? {}),
    }),

  forkSessionWithSummary: (
    projectId: string,
    sessionId: string,
    options: {
      sourceMessageId: string;
      instructions?: string;
      mode?: PermissionMode;
      autoOpenWhenReady?: boolean;
    },
  ) =>
    fetchJSON<{
      displayObject: TranscriptDisplayObject;
    }>(`/projects/${projectId}/sessions/${sessionId}/fork-summary`, {
      method: "POST",
      body: JSON.stringify({
        sourceMessageId: options.sourceMessageId,
        instructions: options.instructions,
        mode: options.mode,
        autoOpenWhenReady: options.autoOpenWhenReady,
      }),
    }),

  proposeSessionRetitle: (
    projectId: string,
    sessionId: string,
    options?: { currentTitle?: string; lengthTarget?: number },
  ) =>
    fetchJSON<{ title: string; generatorSessionId: string }>(
      `/projects/${projectId}/sessions/${sessionId}/retitle`,
      {
        method: "POST",
        body: JSON.stringify({
          currentTitle: options?.currentTitle,
          lengthTarget: options?.lengthTarget,
        }),
      },
    ),

  cancelForkSessionWithSummary: (
    projectId: string,
    sessionId: string,
    objectId: string,
  ) =>
    fetchJSON<{
      transcriptDisplayObjects: TranscriptDisplayObject[];
    }>(
      `/projects/${projectId}/sessions/${sessionId}/fork-summary/${objectId}/cancel`,
      { method: "POST" },
    ),

  updateForkSummaryDisplayObject: (
    projectId: string,
    sessionId: string,
    objectId: string,
    updates: {
      autoOpenWhenReady?: boolean;
      action?: "opened" | "clicked";
    },
  ) =>
    fetchJSON<{
      displayObject: TranscriptDisplayObject;
      transcriptDisplayObjects: TranscriptDisplayObject[];
    }>(
      `/projects/${projectId}/sessions/${sessionId}/fork-summary/${objectId}`,
      {
        method: "PATCH",
        body: JSON.stringify(updates),
      },
    ),

  runBangCommand: (
    projectId: string,
    sessionId: string,
    command: string,
    placementAfterMessageId: string,
  ) =>
    fetchJSON<{
      displayObject: TranscriptDisplayObject;
      transcriptDisplayObjects: TranscriptDisplayObject[];
    }>(`/projects/${projectId}/sessions/${sessionId}/bang-commands`, {
      method: "POST",
      body: JSON.stringify({ command, placementAfterMessageId }),
    }),

  killBangCommand: (projectId: string, sessionId: string, objectId: string) =>
    fetchJSON<{ killed: boolean }>(
      `/projects/${projectId}/sessions/${sessionId}/bang-commands/${objectId}/kill`,
      { method: "POST" },
    ),

  fetchBangCommandOutput: (
    projectId: string,
    sessionId: string,
    objectId: string,
  ) =>
    fetchJSON<{
      stdout: string;
      stderr: string;
      stdoutHtml: string;
      mode: "markdown" | "json" | "ansi" | "toon" | "raw";
      responseTruncated: boolean;
    }>(
      `/projects/${projectId}/sessions/${sessionId}/bang-commands/${objectId}/output`,
    ),

  deleteBangCommand: (projectId: string, sessionId: string, objectId: string) =>
    fetchJSON<{
      removed: boolean;
      transcriptDisplayObjects: TranscriptDisplayObject[];
    }>(
      `/projects/${projectId}/sessions/${sessionId}/bang-commands/${objectId}`,
      {
        method: "DELETE",
      },
    ),

  fetchBangCompletions: (
    projectId: string,
    token: string,
    kind: "command" | "path",
    line: string,
  ) =>
    fetchJSON<{ completions: string[]; history: string[] }>(
      `/projects/${projectId}/bang-completions?token=${encodeURIComponent(token)}&kind=${kind}&line=${encodeURIComponent(line)}`,
    ),

  fetchBangCommandHistory: () =>
    fetchJSON<{
      entries: Array<{
        sessionId: string;
        projectId?: string;
        object: TranscriptDisplayObject;
      }>;
    }>("/bang-commands"),

  queueMessage: (
    sessionId: string,
    message: string,
    mode?: PermissionMode,
    attachments?: UploadedFile[],
    tempId?: string,
    thinking?: ThinkingOption,
    deferred?: boolean,
    clientTimestamp?: number,
    messageMetadata?: UserMessageMetadata,
    serviceTier?: string,
    showThinking?: ShowThinking,
  ) =>
    fetchJSON<{
      queued: boolean;
      compactQueued?: boolean;
      restarted?: boolean;
      processId?: string;
      deferred?: boolean;
      promoted?: boolean;
      position?: number;
      deferredMessages?: DeferredQueueMessage[];
      serverTimestamp: number;
    }>(`/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        message,
        mode,
        attachments,
        tempId,
        thinking,
        showThinking,
        serviceTier,
        deferred,
        clientTimestamp,
        messageMetadata,
      }),
    }),

  cancelDeferredMessage: (sessionId: string, tempId: string) =>
    fetchJSON<{ cancelled: boolean }>(
      `/sessions/${sessionId}/deferred/${encodeURIComponent(tempId)}`,
      { method: "DELETE" },
    ),

  cancelUnconfirmedSteerMessage: (sessionId: string, tempId: string) =>
    fetchJSON<{ cancelled: boolean }>(
      `/sessions/${sessionId}/steering/${encodeURIComponent(tempId)}`,
      { method: "DELETE" },
    ),

  steerDeferredMessagesThrough: (sessionId: string, tempId: string) =>
    fetchJSON<{
      steered: boolean;
      count?: number;
      deferredMessages: DeferredQueueMessage[];
    }>(`/sessions/${sessionId}/deferred/${encodeURIComponent(tempId)}/steer`, {
      method: "POST",
    }),

  deleteRecoveredQueuedMessage: (sessionId: string, queueId: string) =>
    fetchJSON<{ deleted: boolean; deferredMessages: DeferredQueueMessage[] }>(
      `/sessions/${sessionId}/recovered-queue/${encodeURIComponent(queueId)}`,
      { method: "DELETE" },
    ),

  resumeRecoveredQueuedMessage: (sessionId: string, queueId: string) =>
    fetchJSON<{
      resumed: boolean;
      resumedCount?: number;
      deferred?: boolean;
      promoted?: boolean;
      position?: number;
      processId: string;
      processState?: "idle" | "in-turn" | "waiting-input";
      permissionMode?: PermissionMode;
      appliedPermissionMode?: PermissionMode;
      modeVersion?: number;
      recapAfterSeconds?: number;
      deferredMessages: DeferredQueueMessage[];
      serverTimestamp: number;
    }>(
      `/sessions/${sessionId}/recovered-queue/${encodeURIComponent(
        queueId,
      )}/resume`,
      { method: "POST" },
    ),

  steerRecoveredQueuedMessage: (sessionId: string, queueId: string) =>
    fetchJSON<{
      steered: boolean;
      count?: number;
      processId: string;
      processState?: "idle" | "in-turn" | "waiting-input";
      permissionMode?: PermissionMode;
      appliedPermissionMode?: PermissionMode;
      modeVersion?: number;
      recapAfterSeconds?: number;
      deferredMessages: DeferredQueueMessage[];
      serverTimestamp: number;
    }>(
      `/sessions/${sessionId}/recovered-queue/${encodeURIComponent(
        queueId,
      )}/steer`,
      { method: "POST" },
    ),

  interruptProcess: (processId: string) =>
    fetchJSON<{ interrupted: boolean; supported: boolean; aborted?: boolean }>(
      `/processes/${processId}/interrupt`,
      { method: "POST" },
    ),

  requestRecap: (processId: string, hiddenSinceMs?: number) =>
    fetchJSON<{ supported: boolean; emitted: boolean; reason?: string }>(
      `/processes/${processId}/recap`,
      {
        method: "POST",
        ...(hiddenSinceMs === undefined
          ? {}
          : { body: JSON.stringify({ hiddenSinceMs }) }),
      },
    ),

  // Session-keyed away recap: survives a server restart that killed the
  // process. A cold fork-mode session is revived server-side and recapped.
  requestSessionRecap: (
    projectId: string,
    sessionId: string,
    hiddenSinceMs?: number,
  ) =>
    fetchJSON<{ supported: boolean; emitted: boolean; reason?: string }>(
      `/projects/${projectId}/sessions/${sessionId}/recap`,
      {
        method: "POST",
        ...(hiddenSinceMs === undefined
          ? {}
          : { body: JSON.stringify({ hiddenSinceMs }) }),
      },
    ),

  setProcessRecapConfig: (
    processId: string,
    config: {
      recapMode?: RecapMode;
      recapAfterSeconds?: number;
      helperSideModel?: string;
    },
  ) =>
    fetchJSON<{
      success: boolean;
      processId: string;
      recapMode: RecapMode;
      recapAfterSeconds: number;
      helperSideModel: string;
    }>(`/processes/${processId}/recap-config`, {
      method: "POST",
      body: JSON.stringify(config),
    }),

  getProcessModels: (processId: string) =>
    fetchJSON<{
      models: ModelInfo[];
    }>(`/processes/${processId}/models`),

  setProcessModel: (processId: string, model?: string) =>
    fetchJSON<{ success: boolean; processId: string; model?: string }>(
      `/processes/${processId}/model`,
      { method: "POST", body: JSON.stringify({ model }) },
    ),

  setProcessConfig: (
    processId: string,
    config: {
      model?: string;
      thinking?: ThinkingOption;
      showThinking?: ShowThinking;
    },
  ) =>
    fetchJSON<{
      success: boolean;
      processId: string;
      model?: string;
      thinking?: { type: string };
      effort?: string;
    }>(`/processes/${processId}/config`, {
      method: "POST",
      body: JSON.stringify(config),
    }),

  respondToInput: (
    sessionId: string,
    requestId: string,
    response: "approve" | "approve_accept_edits" | "deny",
    answers?: UserQuestionAnswers,
    feedback?: string,
  ) =>
    fetchJSON<{ accepted: boolean; pendingInputRequest?: InputRequest | null }>(
      `/sessions/${sessionId}/input`,
      {
        method: "POST",
        body: JSON.stringify({ requestId, response, answers, feedback }),
      },
    ),

  getPendingInputRequest: (sessionId: string) =>
    fetchJSON<{ request: InputRequest | null }>(
      `/sessions/${sessionId}/pending-input`,
    ),

  setPermissionMode: (sessionId: string, mode: PermissionMode) =>
    fetchJSON<{
      permissionMode: PermissionMode;
      appliedPermissionMode?: PermissionMode;
      modeVersion: number;
    }>(`/sessions/${sessionId}/mode`, {
      method: "PUT",
      body: JSON.stringify({ mode }),
    }),

  markSessionSeen: (
    sessionId: string,
    timestamp?: string,
    messageId?: string,
  ) =>
    fetchJSON<{ marked: boolean }>(`/sessions/${sessionId}/mark-seen`, {
      method: "POST",
      body: JSON.stringify({ timestamp, messageId }),
    }),

  markSessionUnread: (sessionId: string) =>
    fetchJSON<{ marked: boolean }>(`/sessions/${sessionId}/mark-seen`, {
      method: "DELETE",
    }),

  markSessionDone: (sessionId: string) =>
    fetchJSON<{
      message: DurableSyntheticDoneMessage;
      paused: true;
      queued?: boolean;
      deferredMessages?: SessionQueuedMessageSummary[];
    }>(`/sessions/${sessionId}/done`, {
      method: "POST",
    }),

  archiveSession: (sessionId: string) =>
    fetchJSON<{
      message: DurableSyntheticDoneMessage;
      paused: true;
      queued?: boolean;
      deferredMessages?: SessionQueuedMessageSummary[];
    }>(`/sessions/${sessionId}/archive`, {
      method: "POST",
    }),

  terminateSession: (sessionId: string) =>
    fetchJSON<{
      message: DurableSyntheticDoneMessage;
      paused: true;
      queued?: boolean;
      deferredMessages?: SessionQueuedMessageSummary[];
    }>(`/sessions/${sessionId}/terminate`, {
      method: "POST",
    }),

  getLastSeen: () =>
    fetchJSON<{
      lastSeen: Record<string, { timestamp: string; messageId?: string }>;
    }>("/notifications/last-seen"),

  // Push notification API
  ...pushApi,

  // Connected devices API
  getConnections: () => fetchJSON<ConnectionsResponse>("/connections"),

  ...pushSettingsApi,

  // File API
  ...fileApi,

  // Git status API
  ...gitApi,

  // Source-review draft comments (topic: source-review-to-session)
  ...reviewApi,

  // Inbox API
  getInbox: (projectId?: string, summaryMode?: "retained") => {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (summaryMode) params.set("summaryMode", summaryMode);
    return fetchJSON<InboxResponse>(
      params.size ? `/inbox?${params}` : "/inbox",
    );
  },

  // Global Sessions API
  getGlobalSessions: getGlobalSessionsRequest,
  getGlobalSessionStats: () =>
    fetchJSON<{
      stats: GlobalSessionStats;
    }>("/sessions/stats"),

  // Auth API
  ...authApi,

  // Recents API
  ...recentsApi,

  // Onboarding API (first-run wizard state)
  ...onboardingApi,

  // Browser profiles API (device origin tracking)
  ...browserProfilesApi,

  // Server settings API (persistent server configuration)
  getServerSettings: () => fetchJSON<{ settings: ServerSettings }>("/settings"),

  getHostAwakeStatus: (forceRefresh = false) =>
    fetchJSON<{ status: HostAwakeStatus }>(
      `/settings/host-awake/status${forceRefresh ? "?refresh=1" : ""}`,
    ),

  updateServerSettings: (settings: Partial<ServerSettings>) =>
    fetchJSON<{ settings: ServerSettings }>("/settings", {
      method: "PUT",
      body: JSON.stringify(
        settings,
        // Preserve explicit clears for optional settings. The server treats null
        // and empty string as "clear this value", but plain JSON drops undefined keys.
        (_key, value) => (value === undefined ? null : value),
      ),
    }),

  getBrowserSettingsBackup: () =>
    fetchJSON<BrowserSettingsBackupResponse>("/settings/browser-backup"),

  saveBrowserSettingsBackup: (input: {
    version: number;
    values: BrowserSettingsBackupValues;
  }) =>
    fetchJSON<BrowserSettingsBackupResponse>("/settings/browser-backup", {
      method: "PUT",
      body: JSON.stringify(input),
    }),

  // Read-only file-access info (env-pin state + resolved hint paths)
  getFileAccessInfo: () => fetchJSON<FileAccessInfo>("/settings/file-access"),

  getCacheMissBillingEvents: (limit = 200, includeExpectedExpiry = false) =>
    fetchJSON<{ events: CacheMissBillingRecord[] }>(
      `/settings/cache-miss-billing/events?limit=${encodeURIComponent(
        String(limit),
      )}${includeExpectedExpiry ? "&includeExpectedExpiry=1" : ""}`,
    ),

  discoverHelperTargetModels: (baseUrl: string) =>
    fetchJSON<{ baseUrl: string; models: ModelInfo[] }>(
      "/settings/helper-targets/models",
      {
        method: "POST",
        body: JSON.stringify({ baseUrl }),
      },
    ),

  // Codex CLI update checker
  getCodexUpdateStatus: (force?: boolean) =>
    fetchJSON<{ status: CodexUpdateStatus }>(
      `/codex/updates${force ? "?force=true" : ""}`,
    ),

  installCodexUpdate: () =>
    fetchJSON<{
      success: boolean;
      output: string;
      status: CodexUpdateStatus;
      error?: string;
      retryable?: boolean;
    }>("/codex/updates/install", { method: "POST" }),

  // Remote executors API
  getRemoteExecutors: () =>
    fetchJSON<{ executors: string[] }>("/settings/remote-executors"),

  updateRemoteExecutors: (executors: string[]) =>
    fetchJSON<{ executors: string[] }>("/settings/remote-executors", {
      method: "PUT",
      body: JSON.stringify({ executors }),
    }),

  testRemoteExecutor: (host: string) =>
    fetchJSON<RemoteExecutorTestResult>(
      `/settings/remote-executors/${encodeURIComponent(host)}/test`,
      { method: "POST" },
    ),

  // Sharing API
  getSharingStatus: () => fetchJSON<{ configured: boolean }>("/sharing/status"),

  shareSession: (html: string, title?: string) =>
    fetchJSON<{ url: string }>("/sharing/upload", {
      method: "POST",
      body: JSON.stringify({ html, title }),
    }),

  getPublicShareStatus: () =>
    fetchJSON<PublicShareStatusResponse>("/public-shares/status"),

  getPublicSessionShareStatus: (projectId: string, sessionId: string) =>
    fetchJSON<PublicSessionShareSessionStatusResponse>(
      `/public-shares/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`,
    ),

  getPublicShares: (
    options: {
      cursor?: string;
      limit?: number;
      projectId?: string;
      sessionId?: string;
      mode?: "frozen" | "live";
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.projectId) params.set("projectId", options.projectId);
    if (options.sessionId) params.set("sessionId", options.sessionId);
    if (options.mode) params.set("mode", options.mode);
    const query = params.toString();
    return fetchJSON<PublicShareManagementListResponse>(
      `/public-shares${query ? `?${query}` : ""}`,
    );
  },

  revokePublicShare: (shareId: string) =>
    fetchJSON<RevokePublicShareResponse>(
      `/public-shares/${encodeURIComponent(shareId)}`,
      { method: "DELETE" },
    ),

  revokeAllPublicShares: () =>
    fetchJSON<RevokeAllPublicSharesResponse>("/public-shares/revoke-all", {
      method: "POST",
      body: JSON.stringify({ confirmation: "revoke-all-public-shares" }),
    }),

  freezePublicShares: (shareIds: readonly string[]) =>
    fetchJSON<FreezePublicSharesResponse>("/public-shares/freeze-live", {
      method: "POST",
      body: JSON.stringify({
        shareIds,
        confirmation: PUBLIC_SHARE_MANAGEMENT_FREEZE_CONFIRMATION,
      }),
    }),

  createPublicSessionShare: (body: CreatePublicSessionShareRequest) =>
    fetchJSON<CreatePublicSessionShareResponse>("/public-shares", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getPublicFileShares: (projectId: UrlProjectId, path: string) => {
    const params = new URLSearchParams({ projectId, path });
    return fetchJSON<PublicFileShareListResponse>(
      `/public-file-shares?${params}`,
    );
  },

  createPublicFileShare: (body: CreatePublicFileShareRequest) =>
    fetchJSON<CreatePublicFileShareResponse>("/public-file-shares", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  revokePublicFileShare: (shareId: string) =>
    fetchJSON<RevokePublicShareResponse>(
      `/public-file-shares/${encodeURIComponent(shareId)}`,
      { method: "DELETE" },
    ),

  revokePublicSessionShares: (projectId: string, sessionId: string) =>
    fetchJSON<RevokePublicSessionSharesResponse>(
      `/public-shares/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    ),

  freezePublicSessionLiveShares: (projectId: string, sessionId: string) =>
    fetchJSON<FreezePublicSessionLiveSharesResponse>(
      `/public-shares/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/freeze-live`,
      { method: "POST" },
    ),

  freezePublicSessionViewerToken: (
    projectId: string,
    sessionId: string,
    viewerId: string,
  ) =>
    fetchJSON<PublicSessionShareViewerActionResponse>(
      `/public-shares/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/viewers/${encodeURIComponent(viewerId)}/freeze`,
      { method: "POST" },
    ),

  disconnectPublicSessionViewerToken: (
    projectId: string,
    sessionId: string,
    viewerId: string,
  ) =>
    fetchJSON<PublicSessionShareViewerActionResponse>(
      `/public-shares/sessions/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/viewers/${encodeURIComponent(viewerId)}`,
      { method: "DELETE" },
    ),

  // Device bridge API
  getDevices: () => fetchJSON<DeviceInfo[]>("/devices"),

  startDevice: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/devices/${encodeURIComponent(id)}/start`, {
      method: "POST",
    }),

  stopDevice: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/devices/${encodeURIComponent(id)}/stop`, {
      method: "POST",
    }),

  downloadDeviceBridge: () =>
    fetchJSON<{
      ok: boolean;
      path?: string;
      binaryPath?: string;
      apkPath?: string;
      error?: string;
    }>("/devices/bridge/download", { method: "POST" }),

  // Legacy aliases (kept while UI naming is still emulator-centric)
  getEmulators: () => fetchJSON<DeviceInfo[]>("/devices"),

  startEmulator: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/devices/${encodeURIComponent(id)}/start`, {
      method: "POST",
    }),

  stopEmulator: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/devices/${encodeURIComponent(id)}/stop`, {
      method: "POST",
    }),

  downloadEmulatorBridge: () =>
    fetchJSON<{
      ok: boolean;
      path?: string;
      binaryPath?: string;
      apkPath?: string;
      error?: string;
    }>("/devices/bridge/download", { method: "POST" }),
};

/** Result of testing an SSH connection to a remote executor */
export interface RemoteExecutorTestResult {
  success: boolean;
  error?: string;
  /** SSH host that was tested */
  host?: string;
  /** Remote home directory */
  homeDir?: string;
  /** Whether Claude CLI is available on remote */
  claudeAvailable?: boolean;
  /** Claude CLI version on remote (e.g. "1.0.12") */
  claudeVersion?: string;
}

/**
 * Which local path prefixes the HTTP file doors (media + project-files routes)
 * may read. See docs/tactical/018-file-access-scoping.md.
 */
export interface FileAccessSettings {
  /** All scanned project paths. */
  projects: boolean;
  /** The managed uploads directory. */
  uploads: boolean;
  /** Per-OS temp prefixes. */
  temp: boolean;
  /** The home directory. */
  home: boolean;
  /** Literal absolute prefixes, one per entry (`~` expanded server-side). */
  custom: string[];
}

/** Read-only file-access info from the server (for UI hints + env-pin state). */
export interface FileAccessInfo {
  /** True when ALLOWED_FILE_PATHS/ALLOWED_IMAGE_PATHS pins the set (UI read-only). */
  envPinned: boolean;
  /** The env-pinned prefixes (only meaningful when envPinned). */
  envPaths: string[];
  /** Resolved temp prefixes the "Temp folders" toggle expands to. */
  tempPaths: string[];
  /** Managed uploads directory. */
  uploadsDir: string;
  /** Home directory. */
  homeDir: string;
}

/** Default file-access settings (secure-by-default; mirrors the server). */
export const DEFAULT_FILE_ACCESS: FileAccessSettings = {
  projects: true,
  uploads: true,
  temp: true,
  home: false,
  custom: [],
};

/** Server-wide settings that persist across restarts */
export interface ServerSettings {
  issueAssociations?: import("@yep-anywhere/shared").IssueSettings;
  /** Where new YA-owned project state is written. */
  projectDirectoryStorage?: "app-data" | "project";
  /** Whether new live tool-result images receive durable copies. */
  toolResultMediaPreservation?: "on-demand" | "preserve";
  /** Whether clients should register the service worker */
  serviceWorkerEnabled: boolean;
  /** Whether remote SRP resume sessions should be persisted to disk */
  persistRemoteSessionsToDisk: boolean;
  /** Whether the server is requesting browser clients to upload diagnostic logs */
  clientLogCollectionRequested?: boolean;
  /** Whether approve/deny decisions are written to the server audit log */
  approvalAuditLogEnabled?: boolean;
  /** Whether users may create public read-only share links */
  publicSharesEnabled?: boolean;
  /** Whether experimental workstream surfaces and APIs are enabled */
  workstreamsEnabled?: boolean;
  /** Whether experimental live Source Control filesystem monitoring is enabled. */
  liveWorktreeMonitoringEnabled?: boolean;
  /** Whether captured source-review submissions and outcomes are enabled */
  sourceReviewSubmissionsEnabled?: boolean;
  /** Completed assistant turns that may ingest one submission response */
  sourceReviewResponseTurns?: number;
  /** Whether Agents may sample same-user provider processes on this host. */
  hostProcessObservabilityEnabled?: boolean;
  /** Base URL for the hosted YA client */
  yaClientBaseUrl?: string | null;
  /** Optional visual marker identifying the connected YA host. */
  hostIdentity?: HostIdentity;
  /** Process-lifetime operating-system idle-sleep assertion mode. */
  hostAwakeMode?: HostAwakeMode;
  /** Battery level at or below which the host-awake assertion is released. */
  hostAwakeBatteryFloorPercent?: number;
  /** @deprecated Use yaClientBaseUrl. */
  publicShareViewerBaseUrl?: string | null;
  /** SSH host aliases for remote executors */
  remoteExecutors?: string[];
  /** SSH host aliases for ChromeOS device bridge targets */
  chromeOsHosts?: string[];
  /** Allowed hostnames for host/origin validation. "*" = allow all, comma-separated = specific hosts. */
  allowedHosts?: string;
  /** Which local path prefixes the HTTP file doors may read. Undefined = secure defaults. */
  fileAccess?: FileAccessSettings;
  /** Free-form instructions appended to the system prompt for all sessions */
  globalInstructions?: string;
  /** Optional additive context hints composed with global instructions */
  agentContextHints?: AgentContextHints;
  /** Default idle minutes before an opted-in session queues a heartbeat turn */
  heartbeatTurnsAfterMinutes?: number;
  /** Default text queued as the synthetic heartbeat user turn */
  heartbeatTurnText?: string;
  /** Anthropic-compatible endpoint for the isolated Claude Gateway provider */
  claudeGatewayUrl?: string;
  /** Optional shell line that starts a loopback Claude Gateway on demand */
  claudeGatewayStartCommand?: string;
  /** Whether Claude Gateway launches deny Claude Code's Agent tool */
  claudeGatewayDisableAgent?: boolean;
  /** Whether Claude Gateway launches remove Claude Code's plan-mode tools */
  claudeGatewayDisablePlanMode?: boolean;
  /** YA launch override for supported providers' subagent nesting depth. */
  subagentMaxDepth?: number | null;
  /** Ollama server URL for claude-ollama provider */
  ollamaUrl?: string;
  /** Custom system prompt for Ollama provider */
  ollamaSystemPrompt?: string;
  /** Whether to use the full Claude system prompt for Ollama */
  ollamaUseFullSystemPrompt?: boolean;
  /** Whether Grok Build may receive the server's XAI_API_KEY */
  grokBuildUseXaiApiKey?: boolean;
  /** Exact previous/custom Claude model ids opted into provider catalogs. */
  claudeAdditionalModels?: ClaudeAdditionalModelSelection[];
  /**
   * Claude Code launch-time percentage override for its own auto-compaction
   * window. Absent leaves Claude's environment/default unchanged.
   */
  claudeAutoCompactPercentOverride?: number;
  /** Foreground Bash commands Claude may make resumable when a steer arrives. */
  claudeSteerBackgroundBash?: ClaudeSteerBackgroundBashSettings;
  /** Whether the device bridge (emulator/device streaming) feature is enabled */
  deviceBridgeEnabled?: boolean;
  /** Defaults applied when opening the new session form */
  newSessionDefaults?: NewSessionDefaults;
  /** Provider-scoped prompt-cache keepalive settings */
  promptCacheKeepalive?: PromptCacheKeepaliveSettings;
  /** Usage-accounting monitor for suspected prompt-cache billing misses */
  cacheMissBilling?: CacheMissBillingSettings;
  /** Browser-client defaults used when local storage has no explicit value */
  clientDefaults?: ClientDefaults;
  /** Server-routed speech audio retention policy */
  speechAudioRetention?: {
    enabled: boolean;
    maxAgeDays: number;
    maxBytes: number;
  };
  /** OpenAI-compatible helper endpoints for side-session helper work */
  helperTargets?: HelperTargetConfig[];
  /** Whether lifecycle webhook delivery is enabled */
  lifecycleWebhooksEnabled?: boolean;
  /** External webhook URL that receives lifecycle events */
  lifecycleWebhookUrl?: string;
  /** Optional bearer token used for lifecycle webhook delivery */
  lifecycleWebhookToken?: string;
  /** When true, include dryRun=true in lifecycle webhook payloads */
  lifecycleWebhookDryRun?: boolean;
  /** Reasoning-summary mode applied when Codex app-server sessions start. */
  codexReasoningSummary?: CodexReasoningSummary;
  /** Stored Codex plan-tool override; null clears it to the startup fallback. */
  codexPlanToolMode?: CodexPlanToolMode | null;
  /**
   * Cyber access program requested on each Codex turn; null clears it to the
   * startup fallback, which sends nothing and keeps Codex's own choice.
   */
  codexCyberAccessProgram?: CodexCyberAccessProgram | null;
  /** How the server handles Codex CLI updates */
  codexUpdatePolicy?: "auto" | "notify" | "off";
  /** Keep eligible local Linux Codex runtimes across YA server reloads. */
  codexReloadSafeSessions?: boolean;
  /** Best-effort idle provider reap grace in hours; negative disables it. */
  idleReapHours?: number;
  /** Max seconds between consecutive queued turns to join at delivery. */
  deferredJoinWindowSeconds?: number;
  /** Whether delivered queued turns receive compose-time staleness anchors. */
  composeAnchorsEnabled?: boolean;
  /** Absolute [sent <ISO>] compose-time markers on delivered user turns. */
  turnTimestamps?: "off" | "before" | "after";
  /** Seconds Project Queue waits after whole-project idle before promotion. */
  projectQueueQuietSeconds?: number;
  /** Optional server-wide executable gate; null disables it. */
  projectQueueReadinessCheck?: ProjectQueueReadinessCommand | null;
}

export type RelayClientStatus =
  | "disconnected"
  | "connecting"
  | "registering"
  | "waiting"
  | "rejected";

export interface PublicShareStatusResponse {
  enabled: boolean;
  configured: boolean;
  requiresRelay: boolean;
  remoteAccessEnabled: boolean;
  relayStatus: RelayClientStatus | null;
  relayUrl?: string | null;
  relayUsername?: string | null;
  canCreate: boolean;
  storageState?: PublicShareStorageState;
  storageError?: string | null;
  totalValidLinks?: number | null;
  yaClientBaseUrl: string | null;
  defaultYaClientBaseUrl: string;
  yaClientBaseUrlError?: string;
  viewerBaseUrl: string | null;
  defaultViewerBaseUrl: string;
  viewerBaseUrlError?: string;
}

/** Status from the server's Codex CLI update checker */
export interface CodexUpdateStatus {
  installed: string | null;
  installedPath: string | null;
  installedPackage: string | null;
  updateMethod: "npm" | "manual";
  manualInstallCommand: string | null;
  latest: string | null;
  releaseUrl: string | null;
  updateAvailable: boolean;
  lastCheckedAt: number | null;
  error: string | null;
}
