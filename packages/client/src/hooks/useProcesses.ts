import type { SessionClearloopBadge } from "@yep-anywhere/shared";
import type { SessionSandboxEnforcement } from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { fetchJSON } from "../api/client";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import {
  activityBus,
  type SessionMetadataChangedEvent,
} from "../lib/activityBus";
import { createClientQueryKey } from "../lib/clientQueryController";
import type { ClientSummarySourceKey } from "../lib/clientSummaryStore";
import { isRemoteClient } from "../lib/connection";
import type {
  AgentActivity,
  ContextUsage,
  ProviderName,
  ProviderChildSessionSummary,
  ProviderRuntimeStatus,
  SessionLivenessSnapshot,
  UrlProjectId,
} from "../types";
import { useRetainedClientQuery } from "./useRetainedClientQuery";

/**
 * Process info returned from the API.
 */
export interface ProcessInfo {
  steering?: import("@yep-anywhere/shared").ProviderSteeringState;
  id: string;
  sessionId: string;
  projectId: UrlProjectId;
  projectPath: string;
  projectName: string;
  state: AgentActivity;
  startedAt: string;
  queueDepth: number;
  /** OS PID of the spawned agent child process, when available. */
  pid?: number;
  /** Session title from first user message */
  sessionTitle: string | null;
  /** Iterations a running `/clearloop` still has to do; absent when none runs. */
  clearloop?: SessionClearloopBadge;
  /** Only present for terminated processes */
  terminatedAt?: string;
  terminationReason?: string;
  permissionMode?: string;
  /** Provider running this process (claude, codex, gemini, etc.) */
  provider?: ProviderName;
  /** Context window usage from the last assistant message */
  contextUsage?: ContextUsage;
  /** Provider/session progress evidence, separate from transport liveness. */
  liveness?: SessionLivenessSnapshot;
  /** Current provider retry/failure status for the live turn, when available. */
  providerRuntimeStatus?: ProviderRuntimeStatus;
  /** Browser-away duration before YA asks this process for a recap. */
  recapAfterSeconds?: number;
  /** Verified YA host filesystem confinement for this process. */
  sandboxEnforcement?: SessionSandboxEnforcement;
  /** Provider-native child work attached to this canonical YA session. */
  providerChildren?: ProviderChildSessionSummary[];
}

interface ProcessesResponse {
  processes: ProcessInfo[];
  terminatedProcesses?: ProcessInfo[];
}

interface ProcessSnapshot {
  processes: readonly ProcessInfo[];
  terminatedProcesses: readonly ProcessInfo[];
  requestStartedAt?: number;
}

const EMPTY_PROCESS_SNAPSHOT: ProcessSnapshot = {
  processes: [],
  terminatedProcesses: [],
};

const PROCESS_LIST_QUERY_KEY = createClientQueryKey({
  endpoint: "processes",
  includeTerminated: true,
});
const PROCESS_LIST_REVALIDATE_EVENTS = [
  "refresh",
  "reconnect",
  "process-state-changed",
  "session-created",
  "session-metadata-changed",
  "provider-runtime-status-changed",
] as const;

const processSnapshotsBySource = new Map<
  ClientSummarySourceKey,
  ProcessSnapshot
>();
const processSnapshotListeners = new Set<() => void>();

function emitProcessSnapshotChange(): void {
  for (const listener of Array.from(processSnapshotListeners)) {
    listener();
  }
}

function subscribeProcessSnapshots(listener: () => void): () => void {
  processSnapshotListeners.add(listener);
  return () => {
    processSnapshotListeners.delete(listener);
  };
}

function getProcessSnapshot(
  sourceKey: ClientSummarySourceKey,
): ProcessSnapshot {
  return processSnapshotsBySource.get(sourceKey) ?? EMPTY_PROCESS_SNAPSHOT;
}

function acceptProcessSnapshot(
  sourceKey: ClientSummarySourceKey,
  response: ProcessesResponse,
  requestStartedAt: number,
): boolean {
  const current = processSnapshotsBySource.get(sourceKey);
  if (
    current?.requestStartedAt !== undefined &&
    current.requestStartedAt > requestStartedAt
  ) {
    return false;
  }

  processSnapshotsBySource.set(sourceKey, {
    processes: response.processes,
    terminatedProcesses: response.terminatedProcesses ?? [],
    requestStartedAt,
  });
  emitProcessSnapshotChange();
  return true;
}

function patchProcessSnapshotTitle(
  sourceKey: ClientSummarySourceKey,
  sessionId: string,
  title: string | null | undefined,
): boolean {
  if (title === undefined) {
    return false;
  }

  const current = processSnapshotsBySource.get(sourceKey);
  if (!current) {
    return false;
  }

  let changed = false;
  const patch = (process: ProcessInfo): ProcessInfo => {
    if (process.sessionId !== sessionId || process.sessionTitle === title) {
      return process;
    }
    changed = true;
    return { ...process, sessionTitle: title };
  };
  const processes = current.processes.map(patch);
  const terminatedProcesses = current.terminatedProcesses.map(patch);

  if (!changed) {
    return false;
  }

  processSnapshotsBySource.set(sourceKey, {
    ...current,
    processes,
    terminatedProcesses,
  });
  emitProcessSnapshotChange();
  return true;
}

function useProcessSnapshot(
  sourceKey: ClientSummarySourceKey,
): ProcessSnapshot {
  return useSyncExternalStore(
    subscribeProcessSnapshots,
    () => getProcessSnapshot(sourceKey),
    () => EMPTY_PROCESS_SNAPSHOT,
  );
}

export function resetProcessesForTests(): void {
  processSnapshotsBySource.clear();
  processSnapshotListeners.clear();
}

/**
 * Hook to fetch process information.
 * Returns active and terminated processes for the Agents page.
 */
export function useProcesses() {
  const runtime = useCurrentSourceRuntime();
  const sourceKey = runtime.sourceKey;
  const sourceSummary = runtime.summary;
  const remoteConnection = useOptionalRemoteConnection();
  const ready =
    !isRemoteClient() ||
    (remoteConnection !== null && remoteConnection.connection !== null);
  const snapshot = useProcessSnapshot(sourceKey);
  const hasData = snapshot.requestStartedAt !== undefined;

  const applySnapshot = useCallback(
    (
      data: ProcessesResponse,
      context: { sourceKey: ClientSummarySourceKey; requestStartedAt: number },
    ) => {
      const accepted = acceptProcessSnapshot(
        context.sourceKey,
        data,
        context.requestStartedAt,
      );
      if (!accepted) {
        return;
      }
      for (const process of [
        ...data.processes,
        ...(data.terminatedProcesses ?? []),
      ]) {
        sourceSummary.reportProviderRuntimeStatusSnapshot(
          {
            sessionId: process.sessionId,
            projectId: process.projectId,
            providerRuntimeStatus: process.providerRuntimeStatus ?? null,
          },
          context.requestStartedAt,
        );
      }
    },
    [sourceSummary],
  );

  const { loading, error, refetch } = useRetainedClientQuery<ProcessesResponse>(
    {
      sourceKey,
      key: PROCESS_LIST_QUERY_KEY,
      bootstrapTier: "supplementary",
      ready,
      hasData,
      revalidateOn: PROCESS_LIST_REVALIDATE_EVENTS,
      fetcher: () =>
        fetchJSON<ProcessesResponse>("/processes?includeTerminated=true"),
      applySnapshot,
    },
  );

  useEffect(() => {
    const handleMetadataChange = (event: SessionMetadataChangedEvent) => {
      patchProcessSnapshotTitle(sourceKey, event.sessionId, event.title);
    };
    const unsubscribeMetadata = activityBus.on(
      "session-metadata-changed",
      handleMetadataChange,
    );

    return () => {
      unsubscribeMetadata();
    };
  }, [sourceKey]);

  useEffect(() => {
    return activityBus.on("file-change", (event) => {
      if (event.fileType === "agent-session" && event.changeType === "create") {
        void refetch();
      }
    });
  }, [refetch]);

  const processes = snapshot.processes;
  const terminatedProcesses = snapshot.terminatedProcesses;

  // Count of active processes (in-turn or waiting-input)
  const activeCount = useMemo(() => {
    return processes.filter(
      (p) => p.state === "in-turn" || p.state === "waiting-input",
    ).length;
  }, [processes]);

  return {
    processes,
    terminatedProcesses,
    loading,
    error,
    activeCount,
    refetch,
  };
}
