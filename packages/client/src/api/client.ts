import type {
  FileContentResponse,
  PendingInputType,
  ProcessStateType,
  ProviderInfo,
  ProviderName,
  ThinkingOption,
  UploadedFile,
} from "@yep-anywhere/shared";
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
  processState?: ProcessStateType;
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
  status: SessionStatus;
  pendingInputType?: PendingInputType;
  processState?: ProcessStateType;
  hasUnread?: boolean;
  customTitle?: string;
  isArchived?: boolean;
  isStarred?: boolean;
}

/** Stats about all sessions (computed during full scan on server) */
export interface GlobalSessionStats {
  totalCount: number;
  unreadCount: number;
  starredCount: number;
  archivedCount: number;
  /** Counts per provider (non-archived only) */
  providerCounts: Partial<Record<ProviderName, number>>;
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
}

export type { UploadedFile } from "@yep-anywhere/shared";

const API_BASE = "/api";

export interface AuthStatus {
  enabled: boolean;
  authenticated: boolean;
  setupRequired: boolean;
}

export async function fetchJSON<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Yep-Anywhere": "true",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    // Include setup required info in error for auth handling
    const setupRequired = res.headers.get("X-Setup-Required") === "true";
    const error = new Error(
      `API error: ${res.status} ${res.statusText}`,
    ) as Error & {
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

export const api = {
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
    fetchJSON<{ project: Project; sessions: SessionSummary[] }>(
      `/projects/${projectId}`,
    ),

  getSession: (
    projectId: string,
    sessionId: string,
    afterMessageId?: string,
  ) => {
    const params = afterMessageId ? `?afterMessageId=${afterMessageId}` : "";
    return fetchJSON<{
      session: Session;
      messages: Message[];
      status: SessionStatus;
      pendingInputRequest?: InputRequest | null;
    }>(`/projects/${projectId}/sessions/${sessionId}${params}`);
  },

  /**
   * Get session metadata only (no messages).
   * Lightweight endpoint for refreshing title, status, etc. without re-fetching all messages.
   */
  getSessionMetadata: (projectId: string, sessionId: string) =>
    fetchJSON<{
      session: Session;
      status: SessionStatus;
      pendingInputRequest?: InputRequest | null;
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
  ) =>
    fetchJSON<{ queued: boolean; position: number }>(
      `/sessions/${sessionId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ message, mode, attachments, tempId }),
      },
    ),

  abortProcess: (processId: string) =>
    fetchJSON<{ aborted: boolean }>(`/processes/${processId}/abort`, {
      method: "POST",
    }),

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
   * Currently only supported for Claude sessions.
   */
  cloneSession: (projectId: string, sessionId: string, title?: string) =>
    fetchJSON<{
      sessionId: string;
      messageCount: number;
      clonedFrom: string;
      provider: string;
    }>(`/projects/${projectId}/sessions/${sessionId}/clone`, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),

  // Push notification API
  getPushPublicKey: () =>
    fetchJSON<{ publicKey: string }>("/push/vapid-public-key"),

  subscribePush: (
    deviceId: string,
    subscription: PushSubscriptionJSON,
    deviceName?: string,
  ) =>
    fetchJSON<{ success: boolean; deviceId: string }>("/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ deviceId, subscription, deviceName }),
    }),

  unsubscribePush: (deviceId: string) =>
    fetchJSON<{ success: boolean; deviceId: string }>("/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ deviceId }),
    }),

  getPushSubscriptions: () =>
    fetchJSON<{
      count: number;
      subscriptions: Array<{
        deviceId: string;
        createdAt: string;
        deviceName?: string;
        endpointDomain: string;
      }>;
    }>("/push/subscriptions"),

  testPush: (deviceId: string, message?: string) =>
    fetchJSON<{ success: boolean }>("/push/test", {
      method: "POST",
      body: JSON.stringify({ deviceId, message }),
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
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.project) searchParams.set("project", params.project);
    if (params?.q) searchParams.set("q", params.q);
    if (params?.after) searchParams.set("after", params.after);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.includeArchived) searchParams.set("includeArchived", "true");
    if (params?.starred) searchParams.set("starred", "true");
    const query = searchParams.toString();
    return fetchJSON<GlobalSessionsResponse>(
      query ? `/sessions?${query}` : "/sessions",
    );
  },

  // Auth API
  getAuthStatus: () => fetchJSON<AuthStatus>("/auth/status"),

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

  changePassword: (currentPassword: string, newPassword: string) =>
    fetchJSON<{ success: boolean }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  // Recents API
  getRecents: (limit?: number) =>
    fetchJSON<{
      recents: Array<{
        sessionId: string;
        projectId: string;
        visitedAt: string;
      }>;
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
};
