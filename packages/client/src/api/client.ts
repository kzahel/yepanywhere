import type {
  Message,
  PermissionMode,
  Project,
  Session,
  SessionStatus,
  SessionSummary,
} from "../types";

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

  startSession: (projectId: string, message: string, mode?: PermissionMode) =>
    fetchJSON<{
      sessionId: string;
      processId: string;
      permissionMode: PermissionMode;
      modeVersion: number;
    }>(`/projects/${projectId}/sessions`, {
      method: "POST",
      body: JSON.stringify({ message, mode }),
    }),

  resumeSession: (
    projectId: string,
    sessionId: string,
    message: string,
    mode?: PermissionMode,
  ) =>
    fetchJSON<{
      processId: string;
      permissionMode: PermissionMode;
      modeVersion: number;
    }>(`/projects/${projectId}/sessions/${sessionId}/resume`, {
      method: "POST",
      body: JSON.stringify({ message, mode }),
    }),

  queueMessage: (sessionId: string, message: string, mode?: PermissionMode) =>
    fetchJSON<{ queued: boolean; position: number }>(
      `/sessions/${sessionId}/messages`,
      { method: "POST", body: JSON.stringify({ message, mode }) },
    ),

  abortProcess: (processId: string) =>
    fetchJSON<{ aborted: boolean }>(`/processes/${processId}/abort`, {
      method: "POST",
    }),

  respondToInput: (
    sessionId: string,
    requestId: string,
    response: "approve" | "deny",
    answers?: Record<string, string>,
  ) =>
    fetchJSON<{ accepted: boolean }>(`/sessions/${sessionId}/input`, {
      method: "POST",
      body: JSON.stringify({ requestId, response, answers }),
    }),

  setPermissionMode: (sessionId: string, mode: PermissionMode) =>
    fetchJSON<{ permissionMode: PermissionMode; modeVersion: number }>(
      `/sessions/${sessionId}/mode`,
      { method: "PUT", body: JSON.stringify({ mode }) },
    ),
};
