import type { ReactNode } from "react";
import { ReloadBanner } from "./components/ReloadBanner";
import { useReloadNotifications } from "./hooks/useReloadNotifications";

interface Props {
  children: ReactNode;
}

/**
 * App wrapper that provides global functionality like reload notifications.
 */
export function App({ children }: Props) {
  const {
    isManualReloadMode,
    pendingReloads,
    reloadBackend,
    reloadFrontend,
    dismiss,
    unsafeToRestart,
    workerActivity,
  } = useReloadNotifications();

  return (
    <>
      {isManualReloadMode && pendingReloads.backend && (
        <ReloadBanner
          target="backend"
          onReload={reloadBackend}
          onDismiss={() => dismiss("backend")}
          unsafeToRestart={unsafeToRestart}
          activeWorkers={workerActivity.activeWorkers}
        />
      )}
      {isManualReloadMode && pendingReloads.frontend && (
        <ReloadBanner
          target="frontend"
          onReload={reloadFrontend}
          onDismiss={() => dismiss("frontend")}
        />
      )}
      {children}
    </>
  );
}
