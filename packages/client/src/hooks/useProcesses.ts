import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJSON } from "../api/client";
import type {
  ContextUsage,
  ProcessStateType,
  ProviderName,
  UrlProjectId,
} from "../types";

/**
 * Process info returned from the API.
 */
export interface ProcessInfo {
  id: string;
  sessionId: string;
  projectId: UrlProjectId;
  projectPath: string;
  projectName: string;
  state: ProcessStateType;
  startedAt: string;
  queueDepth: number;
  /** Session title from first user message */
  sessionTitle: string | null;
  /** Only present for terminated processes */
  terminatedAt?: string;
  terminationReason?: string;
  permissionMode?: string;
  /** Provider running this process (claude, codex, gemini, etc.) */
  provider?: ProviderName;
  /** Context window usage from the last assistant message */
  contextUsage?: ContextUsage;
}

interface ProcessesResponse {
  processes: ProcessInfo[];
  terminatedProcesses?: ProcessInfo[];
}

const POLL_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Hook to fetch and poll process information.
 * Returns active and terminated processes for the Agents page.
 */
export function useProcesses() {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [terminatedProcesses, setTerminatedProcesses] = useState<ProcessInfo[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchProcesses = useCallback(async () => {
    try {
      const data = await fetchJSON<ProcessesResponse>(
        "/processes?includeTerminated=true",
      );
      setProcesses(data.processes);
      setTerminatedProcesses(data.terminatedProcesses ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchProcesses();
  }, [fetchProcesses]);

  // Polling
  useEffect(() => {
    pollTimerRef.current = setInterval(fetchProcesses, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, [fetchProcesses]);

  // Count of active processes (running or waiting-input)
  const activeCount = processes.filter(
    (p) => p.state === "running" || p.state === "waiting-input",
  ).length;

  return {
    processes,
    terminatedProcesses,
    loading,
    error,
    activeCount,
    refetch: fetchProcesses,
  };
}
