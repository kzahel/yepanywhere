import type {
  ModelOption,
  ThinkingOption,
  UploadedFile,
} from "@claude-anywhere/shared";
import type {
  Message,
  PermissionMode,
  Project,
  Session,
  SessionStatus,
  SessionSummary,
} from "../types";

export interface SessionOptions {
  mode?: PermissionMode;
  model?: ModelOption;
  thinking?: ThinkingOption;
}

export type { UploadedFile } from "@claude-anywhere/shared";

const API_BASE = "/api";

export async function fetchJSON<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Claude-Anywhere": "true",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
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
  getProjects: () => fetchJSON<{ projects: Project[] }>("/projects"),

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
    }>(`/projects/${projectId}/sessions/${sessionId}${params}`);
  },

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
      }),
    }),

  resumeSession: (
    projectId: string,
    sessionId: string,
    message: string,
    options?: SessionOptions,
    attachments?: UploadedFile[],
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
        attachments,
      }),
    }),

  queueMessage: (
    sessionId: string,
    message: string,
    mode?: PermissionMode,
    attachments?: UploadedFile[],
  ) =>
    fetchJSON<{ queued: boolean; position: number }>(
      `/sessions/${sessionId}/messages`,
      { method: "POST", body: JSON.stringify({ message, mode, attachments }) },
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

  markSessionSeen: (
    sessionId: string,
    timestamp?: string,
    messageId?: string,
  ) =>
    fetchJSON<{ marked: boolean }>(`/sessions/${sessionId}/mark-seen`, {
      method: "POST",
      body: JSON.stringify({ timestamp, messageId }),
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
};
