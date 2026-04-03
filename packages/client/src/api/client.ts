import type {
  AgentActivity,
  BrowserProfilesResponse,
  ConnectionsResponse,
  DeviceInfo,
  EnrichedRecentEntry,
  FileContentResponse,
  GitStatusInfo,
  NewSessionDefaults,
  PendingInputType,
  ProviderInfo,
  ProviderName,
  SlashCommand,
  ThinkingOption,
  UploadedFile,
} from "@yep-anywhere/shared";
import { authEvents } from "../lib/authEvents";
import { getGlobalConnection, isRemoteClient } from "../lib/connection";
import type {
  AgentSession,
  InputRequest,
  Message,
  PermissionMode,
  Project,
  Session,
  SessionStatus,
  SessionSummary,
} from "../types";

/** Pagination metadata for compact-boundary-based session loading */
export interface PaginationInfo {
  hasOlderMessages: boolean;
  totalMessageCount: number;
  returnedMessageCount: number;
  truncatedBeforeMessageId?: string;
  totalCompactions: number;
}

/**
 * An item in the inbox representing a session that may need attention.
 */
export interface InboxItem {
  sessionId: string;
  projectId: string;
  projectName: string;
  sessionTitle: string | null;
  updatedAt: string;
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  hasUnread?: boolean;
}

/**
 * Inbox response with sessions categorized into priority tiers.
 */
export interface InboxResponse {
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
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  provider: ProviderName;
  projectId: string;
  projectName: string;
  ownership: SessionStatus;
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  hasUnread?: boolean;
  customTitle?: string;
  isArchived?: boolean;
  isStarred?: boolean;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
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

/** Minimal project info for filter dropdowns */
export interface ProjectOption {
  id: string;
  name: string;
}

/**
 * Response from the global sessions API.
 */
export interface GlobalSessionsResponse {
  sessions: GlobalSessionItem[];
  hasMore: boolean;
  /** Global stats computed from all sessions (not just paginated results) */
  stats: GlobalSessionStats;
  /** All projects for filter dropdown */
  projects: ProjectOption[];
}

export interface SessionOptions {
  mode?: PermissionMode;
  /** Model ID (e.g., "sonnet", "opus", "qwen2.5-coder:0.5b") */
  model?: string;
  thinking?: ThinkingOption;
  provider?: ProviderName;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Whether to create a git worktree for this session */
  worktree?: boolean;
}

export type { UploadedFile } from "@yep-anywhere/shared";

const API_BASE = "/api";

/**
 * Desktop auth token read from URL query parameter (?desktop_token=...).
 * When present, sent as X-Desktop-Token header on every API request.
 * The Tauri desktop app passes this token to authenticate the iframe
 * without cookies or sessions — the token is valid for the server's lifetime.
 */
let desktopAuthToken: string | null = null;
if (typeof window !== "undefined") {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("desktop_token");
  if (token) {
    desktopAuthToken = token;
    // Strip token from URL to keep it out of history/bookmarks
    params.delete("desktop_token");
    const cleanUrl = params.toString()
      ? `${window.location.pathname}?${params.toString()}${window.location.hash}`
      : `${window.location.pathname}${window.location.hash}`;
    window.history.replaceState({}, "", cleanUrl);
  }
}

/** Get the desktop auth token (if running inside Tauri iframe). */
export function getDesktopAuthToken(): string | null {
  return desktopAuthToken;
}

export interface AuthStatus {
  /** Whether auth is enabled in settings */
  enabled: boolean;
  /** Whether user has a valid session (or auth is disabled) */
  authenticated: boolean;
  /** Whether initial account setup is needed */
  setupRequired: boolean;
  /** Whether auth is bypassed by --auth-disable flag (for recovery) */
  disabledByEnv: boolean;
  /** Path to auth.json file (for recovery instructions) */
  authFilePath: string;
  /** Whether the server has a desktop auth token (Tauri app) */
  hasDesktopToken: boolean;
  /** Whether unauthenticated localhost access is allowed */
  localhostOpen: boolean;
}

export async function fetchJSON<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  // Route through global connection in remote mode (SecureConnection)
  const globalConn = getGlobalConnection();
  if (globalConn) {
    return globalConn.fetch<T>(path, options);
  }

  // In remote client mode, we MUST have a SecureConnection
  // If we reach this point, it means authentication hasn't completed yet
  if (isRemoteClient()) {
    throw new Error(
      "Remote client requires SecureConnection - not authenticated",
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Yep-Anywhere": "true",
  };
  if (desktopAuthToken) {
    headers["X-Desktop-Token"] = desktopAuthToken;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      ...headers,
      ...options?.headers,
    },
  });

  if (!res.ok) {
    // Signal login required for 401 errors (but not for auth endpoints themselves)
    if (res.status === 401 && !path.startsWith("/auth/")) {
      console.log("[API] 401 response, signaling login required");
      authEvents.signalLoginRequired();
    }

    // Try to parse error message from response body
    let errorMessage = `API error: ${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body.error) {
        errorMessage = body.error;
      } else if (body.message) {
        errorMessage = body.message;
      }
    } catch {
      // Response body wasn't JSON, use default message
    }

    // Include setup required info in error for auth handling
    const setupRequired = res.headers.get("X-Setup-Required") === "true";
    const error = new Error(errorMessage) as Error & {
      status: number;
      setupRequired?: boolean;
    };
    error.status = res.status;
    if (setupRequired) error.setupRequired = true;
    throw error;
  }

  return res.json();
}

// Re-export upload functions
export {
  buildUploadUrl,
  fileToChunks,
  UploadError,
  uploadChunks,
  uploadFile,
  type UploadOptions,
} from "./upload";

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Session resume protocol version supported by server (undefined on older servers). */
  resumeProtocolVersion?: number;
  /** Feature capabilities supported by the server. Undefined on older servers. */
  capabilities?: string[];
  /** Device bridge availability and update state. Undefined on older servers. */
  deviceBridgeState?:
    | "available"
    | "downloadable"
    | "update-available"
    | "unavailable";
  /** Installed managed bridge binary version when known. */
  deviceBridgeVersion?: string | null;
  /** Latest bridge release version when known. */
  latestDeviceBridgeVersion?: string | null;
}

export interface ServerInfo {
  /** The host/interface the server is bound to (e.g., "127.0.0.1" or "0.0.0.0") */
  host: string;
  /** The port the server is listening on */
  port: number;
  /** Whether the server is bound to all interfaces (0.0.0.0) */
  boundToAllInterfaces: boolean;
  /** Whether the server is localhost-only */
  localhostOnly: boolean;
}

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

export interface GetVersionOptions {
  /** Bypass the server's routine version cache and refresh from the update service. */
  fresh?: boolean;
}

export const api = {
  // Version API
  getVersion: (options?: GetVersionOptions) =>
    fetchJSON<VersionInfo>(options?.fresh ? "/version?fresh=1" : "/version"),

  // Server info API (host/port binding for Local Access settings)
  getServerInfo: () => fetchJSON<ServerInfo>("/server-info"),

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

  // Server admin API
  restartServer: () =>
    fetchJSON<{ ok: boolean; message: string }>("/server/restart", {
      method: "POST",
    }),

  // Provider API
  getProviders: () => fetchJSON<{ providers: ProviderInfo[] }>("/providers"),

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

  getSession: (
    projectId: string,
    sessionId: string,
    afterMessageId?: string,
    options?: { tailCompactions?: number; beforeMessageId?: string },
  ) => {
    const params = new URLSearchParams();
    if (afterMessageId) params.set("afterMessageId", afterMessageId);
    if (options?.tailCompactions !== undefined)
      params.set("tailCompactions", String(options.tailCompactions));
    if (options?.beforeMessageId)
      params.set("beforeMessageId", options.beforeMessageId);
    const qs = params.toString();
    return fetchJSON<{
      session: Session;
      messages: Message[];
      ownership: SessionStatus;
      pendingInputRequest?: InputRequest | null;
      slashCommands?: SlashCommand[] | null;
      pagination?: PaginationInfo;
    }>(`/projects/${projectId}/sessions/${sessionId}${qs ? `?${qs}` : ""}`);
  },

  /**
   * Get session metadata only (no messages).
   * Lightweight endpoint for refreshing title, status, etc. without re-fetching all messages.
   */
  getSessionMetadata: (projectId: string, sessionId: string) =>
    fetchJSON<{
      session: Session;
      ownership: SessionStatus;
      pendingInputRequest?: InputRequest | null;
      slashCommands?: SlashCommand[] | null;
    }>(`/projects/${projectId}/sessions/${sessionId}/metadata`),

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
  ) =>
    fetchJSON<{
      sessionId: string;
      processId: string;
      permissionMode: PermissionMode;
      modeVersion: number;
    }>(`/projects/${projectId}/sessions`, {
      method: "POST",
      body: JSON.stringify({
        message,
        mode: options?.mode,
        model: options?.model,
        thinking: options?.thinking,
        provider: options?.provider,
        executor: options?.executor,
        worktree: options?.worktree,
        attachments,
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
      permissionMode: PermissionMode;
      modeVersion: number;
    }>(`/projects/${projectId}/sessions/create`, {
      method: "POST",
      body: JSON.stringify({
        mode: options?.mode,
        model: options?.model,
        thinking: options?.thinking,
        provider: options?.provider,
        executor: options?.executor,
        worktree: options?.worktree,
      }),
    }),

  resumeSession: (
    projectId: string,
    sessionId: string,
    message: string,
    options?: SessionOptions,
    attachments?: UploadedFile[],
    tempId?: string,
  ) =>
    fetchJSON<{
      processId: string;
      permissionMode: PermissionMode;
      modeVersion: number;
    }>(`/projects/${projectId}/sessions/${sessionId}/resume`, {
      method: "POST",
      body: JSON.stringify({
        message,
        mode: options?.mode,
        model: options?.model,
        thinking: options?.thinking,
        provider: options?.provider,
        executor: options?.executor,
        attachments,
        tempId,
      }),
    }),

  queueMessage: (
    sessionId: string,
    message: string,
    mode?: PermissionMode,
    attachments?: UploadedFile[],
    tempId?: string,
    thinking?: ThinkingOption,
    deferred?: boolean,
  ) =>
    fetchJSON<{
      queued: boolean;
      restarted?: boolean;
      processId?: string;
      deferred?: boolean;
    }>(`/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        message,
        mode,
        attachments,
        tempId,
        thinking,
        deferred,
      }),
    }),

  cancelDeferredMessage: (sessionId: string, tempId: string) =>
    fetchJSON<{ cancelled: boolean }>(
      `/sessions/${sessionId}/deferred/${encodeURIComponent(tempId)}`,
      { method: "DELETE" },
    ),

  abortProcess: (processId: string) =>
    fetchJSON<{ aborted: boolean }>(`/processes/${processId}/abort`, {
      method: "POST",
    }),

  interruptProcess: (processId: string) =>
    fetchJSON<{ interrupted: boolean; supported: boolean }>(
      `/processes/${processId}/interrupt`,
      { method: "POST" },
    ),

  getProcessModels: (processId: string) =>
    fetchJSON<{
      models: Array<{ id: string; name: string; description?: string }>;
    }>(`/processes/${processId}/models`),

  setProcessModel: (processId: string, model?: string) =>
    fetchJSON<{ success: boolean; model?: string }>(
      `/processes/${processId}/model`,
      { method: "POST", body: JSON.stringify({ model }) },
    ),

  respondToInput: (
    sessionId: string,
    requestId: string,
    response: "approve" | "approve_accept_edits" | "deny",
    answers?: Record<string, string>,
    feedback?: string,
  ) =>
    fetchJSON<{ accepted: boolean }>(`/sessions/${sessionId}/input`, {
      method: "POST",
      body: JSON.stringify({ requestId, response, answers, feedback }),
    }),

  setPermissionMode: (sessionId: string, mode: PermissionMode) =>
    fetchJSON<{ permissionMode: PermissionMode; modeVersion: number }>(
      `/sessions/${sessionId}/mode`,
      { method: "PUT", body: JSON.stringify({ mode }) },
    ),

  setHold: (sessionId: string, hold: boolean) =>
    fetchJSON<{ isHeld: boolean; holdSince: string | null; state: string }>(
      `/sessions/${sessionId}/hold`,
      { method: "PUT", body: JSON.stringify({ hold }) },
    ),

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
        holdSince?: string;
        terminationReason?: string;
        terminatedAt?: string;
        provider: string;
        thinking?: { type: string };
        effort?: string;
        model?: string;
      } | null;
    }>(`/sessions/${sessionId}/process`),

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

  getLastSeen: () =>
    fetchJSON<{
      lastSeen: Record<string, { timestamp: string; messageId?: string }>;
    }>("/notifications/last-seen"),

  updateSessionMetadata: (
    sessionId: string,
    updates: { title?: string; archived?: boolean; starred?: boolean },
  ) =>
    fetchJSON<{ updated: boolean }>(`/sessions/${sessionId}/metadata`, {
      method: "PUT",
      body: JSON.stringify(updates),
    }),

  /**
   * Clone a session, creating a new session with the same conversation history.
   * Supported for Claude and Codex sessions.
   */
  cloneSession: (
    projectId: string,
    sessionId: string,
    title?: string,
    provider?: string,
  ) =>
    fetchJSON<{
      sessionId: string;
      messageCount: number;
      clonedFrom: string;
      provider: string;
    }>(`/projects/${projectId}/sessions/${sessionId}/clone`, {
      method: "POST",
      body: JSON.stringify({ title, provider }),
    }),

  // Push notification API
  getPushPublicKey: () =>
    fetchJSON<{ publicKey: string }>("/push/vapid-public-key"),

  subscribePush: (
    browserProfileId: string,
    subscription: PushSubscriptionJSON,
    deviceName?: string,
  ) =>
    fetchJSON<{ success: boolean; browserProfileId: string }>(
      "/push/subscribe",
      {
        method: "POST",
        body: JSON.stringify({ browserProfileId, subscription, deviceName }),
      },
    ),

  unsubscribePush: (browserProfileId: string) =>
    fetchJSON<{ success: boolean; browserProfileId: string }>(
      "/push/unsubscribe",
      {
        method: "POST",
        body: JSON.stringify({ browserProfileId }),
      },
    ),

  getPushSubscriptions: () =>
    fetchJSON<{
      count: number;
      subscriptions: Array<{
        browserProfileId: string;
        createdAt: string;
        deviceName?: string;
        endpointDomain: string;
      }>;
    }>("/push/subscriptions"),

  testPush: (
    browserProfileId: string,
    message?: string,
    urgency?: "normal" | "persistent" | "silent",
  ) =>
    fetchJSON<{ success: boolean }>("/push/test", {
      method: "POST",
      body: JSON.stringify({ browserProfileId, message, urgency }),
    }),

  deletePushSubscription: (browserProfileId: string) =>
    fetchJSON<{ success: boolean }>(
      `/push/subscriptions/${encodeURIComponent(browserProfileId)}`,
      { method: "DELETE" },
    ),

  // Connected devices API
  getConnections: () => fetchJSON<ConnectionsResponse>("/connections"),

  getNotificationSettings: () =>
    fetchJSON<{
      settings: {
        toolApproval: boolean;
        userQuestion: boolean;
        sessionHalted: boolean;
      };
    }>("/push/settings"),

  updateNotificationSettings: (
    settings: Partial<{
      toolApproval: boolean;
      userQuestion: boolean;
      sessionHalted: boolean;
    }>,
  ) =>
    fetchJSON<{
      settings: {
        toolApproval: boolean;
        userQuestion: boolean;
        sessionHalted: boolean;
      };
    }>("/push/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),

  // File API
  getFile: (projectId: string, path: string, highlight = false) => {
    const params = new URLSearchParams({ path });
    if (highlight) params.set("highlight", "true");
    return fetchJSON<FileContentResponse>(
      `/projects/${projectId}/files?${params.toString()}`,
    );
  },

  getFileRawUrl: (projectId: string, path: string, download = false) => {
    const params = new URLSearchParams({ path });
    if (download) params.set("download", "true");
    return `/api/projects/${projectId}/files/raw?${params.toString()}`;
  },

  /**
   * Expand diff context to show full file.
   * Returns syntax-highlighted diff with the entire file as context.
   * Uses originalFile from SDK Edit result (never truncated, verified up to 150KB+).
   */
  expandDiffContext: (
    projectId: string,
    filePath: string,
    oldString: string,
    newString: string,
    originalFile: string,
  ) =>
    fetchJSON<{
      structuredPatch: Array<{
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
        lines: string[];
      }>;
      diffHtml: string;
    }>(`/projects/${projectId}/diff/expand`, {
      method: "POST",
      body: JSON.stringify({ filePath, oldString, newString, originalFile }),
    }),

  // Git status API
  getGitStatus: (projectId: string) =>
    fetchJSON<GitStatusInfo>(`/projects/${projectId}/git`),

  getGitDiff: (
    projectId: string,
    params: {
      path: string;
      staged: boolean;
      status: string;
      fullContext?: boolean;
    },
  ) =>
    fetchJSON<{
      diffHtml: string;
      structuredPatch: Array<{
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
        lines: string[];
      }>;
      markdownHtml?: string;
    }>(`/projects/${projectId}/git/diff`, {
      method: "POST",
      body: JSON.stringify(params),
    }),

  // Inbox API
  getInbox: (projectId?: string) =>
    fetchJSON<InboxResponse>(
      projectId
        ? `/inbox?projectId=${encodeURIComponent(projectId)}`
        : "/inbox",
    ),

  // Global Sessions API
  getGlobalSessions: (params?: {
    project?: string;
    q?: string;
    after?: string;
    limit?: number;
    includeArchived?: boolean;
    starred?: boolean;
    includeStats?: boolean;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.project) searchParams.set("project", params.project);
    if (params?.q) searchParams.set("q", params.q);
    if (params?.after) searchParams.set("after", params.after);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.includeArchived) searchParams.set("includeArchived", "true");
    if (params?.starred) searchParams.set("starred", "true");
    if (params?.includeStats) searchParams.set("includeStats", "true");
    const query = searchParams.toString();
    return fetchJSON<GlobalSessionsResponse>(
      query ? `/sessions?${query}` : "/sessions",
    );
  },
  getGlobalSessionStats: () =>
    fetchJSON<{
      stats: GlobalSessionStats;
    }>("/sessions/stats"),

  // Auth API
  getAuthStatus: () => fetchJSON<AuthStatus>("/auth/status"),

  /** Enable auth with a password (fresh setup while auth is currently disabled) */
  enableAuth: (password: string) =>
    fetchJSON<{ success: boolean }>("/auth/enable", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  /** Disable auth (requires authenticated session) */
  disableAuth: () =>
    fetchJSON<{ success: boolean }>("/auth/disable", {
      method: "POST",
    }),

  /** @deprecated Use enableAuth instead */
  setupAccount: (password: string) =>
    fetchJSON<{ success: boolean }>("/auth/setup", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  login: (password: string) =>
    fetchJSON<{ success: boolean }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  logout: () =>
    fetchJSON<{ success: boolean }>("/auth/logout", {
      method: "POST",
    }),

  changePassword: (newPassword: string) =>
    fetchJSON<{ success: boolean }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ newPassword }),
    }),

  /** Toggle unauthenticated localhost access (desktop token floor bypass) */
  setLocalhostAccess: (open: boolean) =>
    fetchJSON<{ success: boolean; localhostOpen: boolean }>(
      "/auth/localhost-access",
      {
        method: "POST",
        body: JSON.stringify({ open }),
      },
    ),

  // Recents API
  getRecents: (limit?: number) =>
    fetchJSON<{
      recents: Array<EnrichedRecentEntry>;
    }>(limit ? `/recents?limit=${limit}` : "/recents"),

  recordVisit: (sessionId: string, projectId: string) =>
    fetchJSON<{ recorded: boolean }>("/recents/visit", {
      method: "POST",
      body: JSON.stringify({ sessionId, projectId }),
    }),

  clearRecents: () =>
    fetchJSON<{ cleared: boolean }>("/recents", {
      method: "DELETE",
    }),

  // Onboarding API (first-run wizard state)
  getOnboardingStatus: () => fetchJSON<{ complete: boolean }>("/onboarding"),

  completeOnboarding: () =>
    fetchJSON<{ success: boolean }>("/onboarding/complete", {
      method: "POST",
    }),

  resetOnboarding: () =>
    fetchJSON<{ success: boolean }>("/onboarding/reset", {
      method: "POST",
    }),

  // Browser profiles API (device origin tracking)
  getBrowserProfiles: () =>
    fetchJSON<BrowserProfilesResponse>("/browser-profiles"),

  deleteBrowserProfile: (browserProfileId: string) =>
    fetchJSON<{ deleted: boolean }>(
      `/browser-profiles/${encodeURIComponent(browserProfileId)}`,
      { method: "DELETE" },
    ),

  // Server settings API (persistent server configuration)
  getServerSettings: () => fetchJSON<{ settings: ServerSettings }>("/settings"),

  updateServerSettings: (settings: Partial<ServerSettings>) =>
    fetchJSON<{ settings: ServerSettings }>("/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),

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

/** Server-wide settings that persist across restarts */
export interface ServerSettings {
  /** Whether clients should register the service worker */
  serviceWorkerEnabled: boolean;
  /** Whether remote SRP resume sessions should be persisted to disk */
  persistRemoteSessionsToDisk: boolean;
  /** SSH host aliases for remote executors */
  remoteExecutors?: string[];
  /** SSH host aliases for ChromeOS device bridge targets */
  chromeOsHosts?: string[];
  /** Allowed hostnames for host/origin validation. "*" = allow all, comma-separated = specific hosts. */
  allowedHosts?: string;
  /** Free-form instructions appended to the system prompt for all sessions */
  globalInstructions?: string;
  /** Ollama server URL for claude-ollama provider */
  ollamaUrl?: string;
  /** Custom system prompt for Ollama provider */
  ollamaSystemPrompt?: string;
  /** Whether to use the full Claude system prompt for Ollama */
  ollamaUseFullSystemPrompt?: boolean;
  /** Whether the device bridge (emulator/device streaming) feature is enabled */
  deviceBridgeEnabled?: boolean;
  /** Defaults applied when opening the new session form */
  newSessionDefaults?: NewSessionDefaults;
  /** Whether lifecycle webhook delivery is enabled */
  lifecycleWebhooksEnabled?: boolean;
  /** External webhook URL that receives lifecycle events */
  lifecycleWebhookUrl?: string;
  /** Optional bearer token used for lifecycle webhook delivery */
  lifecycleWebhookToken?: string;
  /** When true, include dryRun=true in lifecycle webhook payloads */
  lifecycleWebhookDryRun?: boolean;
  /** Whether new sessions should use git worktrees by default */
  worktreeEnabled?: boolean;
  /** Base directory for worktrees (default: {projectDir}-worktrees/) */
  worktreeBasePath?: string;
  /** Files/dirs to symlink from original project into worktrees */
  worktreeSymlinks?: string[];
  /** Command to run after worktree creation */
  worktreePostCreateCommand?: string;
}
