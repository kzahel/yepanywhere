import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJSON } from "../api/client";
import type {
  AgentActivity,
  ContextUsage,
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
  state: AgentActivity;
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

  const fetchProcesses = useCallback(async (includeTerminated = false) => {
    try {
      const data = await fetchJSON<ProcessesResponse>(
        includeTerminated
          ? "/processes?includeTerminated=true"
          : "/processes",
      );
      setProcesses(data.processes);
      if (includeTerminated) {
        setTerminatedProcesses(data.terminatedProcesses ?? []);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    void fetchProcesses(true);
  }, [fetchProcesses]);

  // Poll only the active processes. The terminated list is informational and
  // doesn't need to block navigation or refresh every interval.
  useEffect(() => {
    pollTimerRef.current = setInterval(() => {
      void fetchProcesses();
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, [fetchProcesses]);

  // Count of active processes (in-turn or waiting-input)
  const activeCount = processes.filter(
    (p) => p.state === "in-turn" || p.state === "waiting-input",
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
