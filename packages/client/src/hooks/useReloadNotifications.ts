import { useCallback, useEffect, useRef, useState } from "react";

export interface SourceChangeEvent {
  type: "source-change";
  target: "backend" | "frontend";
  files: string[];
  timestamp: string;
}

export interface PendingReloads {
  backend: boolean;
  frontend: boolean;
}

interface DevStatus {
  noBackendReload: boolean;
  noFrontendReload: boolean;
  backendDirty?: boolean;
}

export interface WorkerActivity {
  activeWorkers: number;
  queueLength: number;
  hasActiveWork: boolean;
}

const API_BASE = "/api";

/**
 * Hook to manage reload notifications when running in manual reload mode.
 * Listens for source-change events via SSE and tracks which targets need reloading.
 */
export function useReloadNotifications() {
  const [pendingReloads, setPendingReloads] = useState<PendingReloads>({
    backend: false,
    frontend: false,
  });
  const [devStatus, setDevStatus] = useState<DevStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [workerActivity, setWorkerActivity] = useState<WorkerActivity>({
    activeWorkers: 0,
    queueLength: 0,
    hasActiveWork: false,
  });

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Check if we're in dev mode (manual reload enabled) and get persisted dirty state
  useEffect(() => {
    fetch(`${API_BASE}/dev/status`)
      .then((res) => {
        if (res.ok) return res.json();
        throw new Error("Dev routes not available");
      })
      .then((data: DevStatus) => {
        setDevStatus(data);
        // Initialize pending reloads from server's persisted dirty state
        // Backend dirty persists across page refreshes - if you reload the page
        // but forget to reload the server, you still see the banner
        if (data.backendDirty) {
          setPendingReloads((prev) => ({ ...prev, backend: true }));
        }
      })
      .catch(() => {
        // Dev routes not mounted = not in manual reload mode
        setDevStatus(null);
      });
  }, []);

  const connect = useCallback(() => {
    if (eventSourceRef.current) return;

    const es = new EventSource(`${API_BASE}/activity/stream`);

    es.onopen = () => {
      setConnected(true);
      // On (re)connect, sync with server's dirty state
      // If server restarted, backendDirty will be false - clear the banner
      fetch(`${API_BASE}/dev/status`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: DevStatus | null) => {
          if (data && !data.backendDirty) {
            setPendingReloads((prev) => ({ ...prev, backend: false }));
          }
        })
        .catch(() => {
          // Ignore errors
        });

      // Fetch initial worker activity state
      fetch(`${API_BASE}/status/workers`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: WorkerActivity | null) => {
          if (data) setWorkerActivity(data);
        })
        .catch(() => {
          // Ignore errors - default to safe state (no active work)
        });
    };

    const handleSourceChange = (event: MessageEvent) => {
      if (event.data === undefined || event.data === null) return;

      try {
        const data = JSON.parse(event.data) as SourceChangeEvent;
        setPendingReloads((prev) => ({
          ...prev,
          [data.target]: true,
        }));
      } catch {
        // Ignore malformed JSON
      }
    };

    const handleBackendReloaded = () => {
      // Backend restarted - clear the banner in all tabs
      setPendingReloads((prev) => ({ ...prev, backend: false }));
    };

    const handleWorkerActivity = (event: MessageEvent) => {
      if (event.data === undefined || event.data === null) return;

      try {
        const data = JSON.parse(event.data) as WorkerActivity;
        setWorkerActivity(data);
      } catch {
        // Ignore malformed JSON
      }
    };

    es.addEventListener("source-change", handleSourceChange);
    es.addEventListener("backend-reloaded", handleBackendReloaded);
    es.addEventListener("worker-activity-changed", handleWorkerActivity);
    es.addEventListener("heartbeat", () => {
      // Keep-alive, no action needed
    });

    es.onerror = () => {
      setConnected(false);
      es.close();
      eventSourceRef.current = null;

      // Auto-reconnect after 2s
      reconnectTimeoutRef.current = setTimeout(connect, 2000);
    };

    eventSourceRef.current = es;
  }, []);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setConnected(false);
  }, []);

  // Reload the backend (triggers server restart)
  const reloadBackend = useCallback(async () => {
    console.log("[ReloadNotifications] Requesting backend reload...");
    try {
      const res = await fetch(`${API_BASE}/dev/reload`, {
        method: "POST",
        headers: { "X-Claude-Anywhere": "true" },
      });
      console.log("[ReloadNotifications] Reload response:", res.status);
      // Server will restart, which will briefly disconnect SSE
      // The reconnect logic will handle it
      setPendingReloads((prev) => ({ ...prev, backend: false }));
    } catch (err) {
      // Server might already be restarting
      console.log("[ReloadNotifications] Reload error (may be expected):", err);
    }
  }, []);

  // Reload the frontend (browser refresh)
  const reloadFrontend = useCallback(() => {
    window.location.reload();
  }, []);

  // Reload whichever needs it (backend first if both)
  const reload = useCallback(() => {
    if (pendingReloads.backend) {
      reloadBackend();
    } else if (pendingReloads.frontend) {
      reloadFrontend();
    }
  }, [pendingReloads, reloadBackend, reloadFrontend]);

  // Dismiss a pending reload notification
  const dismiss = useCallback((target: "backend" | "frontend") => {
    setPendingReloads((prev) => ({
      ...prev,
      [target]: false,
    }));
  }, []);

  // Dismiss all
  const dismissAll = useCallback(() => {
    setPendingReloads({ backend: false, frontend: false });
  }, []);

  // Keyboard shortcut: Ctrl+Shift+R
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "R") {
        e.preventDefault();
        reload();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [reload]);

  // Connect only if dev mode is enabled
  useEffect(() => {
    if (devStatus?.noBackendReload || devStatus?.noFrontendReload) {
      connect();
      return () => disconnect();
    }
  }, [devStatus, connect, disconnect]);

  // Check if manual reload mode is active at all
  const isManualReloadMode =
    devStatus?.noBackendReload || devStatus?.noFrontendReload;

  return {
    /** Whether we're in manual reload mode */
    isManualReloadMode,
    /** Which targets have pending changes */
    pendingReloads,
    /** SSE connection status */
    connected,
    /** Reload the backend (server restart) */
    reloadBackend,
    /** Reload the frontend (browser refresh) */
    reloadFrontend,
    /** Reload whichever needs it (backend first) */
    reload,
    /** Dismiss a specific notification */
    dismiss,
    /** Dismiss all notifications */
    dismissAll,
    /** Current worker activity for safe restart indicator */
    workerActivity,
    /** True if restarting would interrupt active work */
    unsafeToRestart: workerActivity.hasActiveWork,
  };
}
