import type {
  Message,
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
      ...options?.headers,
    },
  });

  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

export const api = {
  getProjects: () => fetchJSON<{ projects: Project[] }>("/projects"),

  getProject: (projectId: string) =>
    fetchJSON<{ project: Project; sessions: SessionSummary[] }>(
      `/projects/${projectId}`,
    ),

  getSession: (projectId: string, sessionId: string) =>
    fetchJSON<{ session: Session; messages: Message[]; status: SessionStatus }>(
      `/projects/${projectId}/sessions/${sessionId}`,
    ),

  startSession: (projectId: string, message: string) =>
    fetchJSON<{ sessionId: string; processId: string }>(
      `/projects/${projectId}/sessions`,
      { method: "POST", body: JSON.stringify({ message }) },
    ),

  resumeSession: (projectId: string, sessionId: string, message: string) =>
    fetchJSON<{ processId: string }>(
      `/projects/${projectId}/sessions/${sessionId}/resume`,
      { method: "POST", body: JSON.stringify({ message }) },
    ),

  queueMessage: (sessionId: string, message: string) =>
    fetchJSON<{ queued: boolean; position: number }>(
      `/sessions/${sessionId}/messages`,
      { method: "POST", body: JSON.stringify({ message }) },
    ),

  abortProcess: (processId: string) =>
    fetchJSON<{ aborted: boolean }>(`/processes/${processId}/abort`, {
      method: "POST",
    }),
};
