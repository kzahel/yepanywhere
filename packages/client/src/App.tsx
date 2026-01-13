import type { ReactNode } from "react";
import { FloatingActionButton } from "./components/FloatingActionButton";
import { ReloadBanner } from "./components/ReloadBanner";
import { OnboardingWizard } from "./components/onboarding";
import { AuthProvider } from "./contexts/AuthContext";
import { InboxProvider } from "./contexts/InboxContext";
import { SchemaValidationProvider } from "./contexts/SchemaValidationContext";
import { ToastProvider } from "./contexts/ToastContext";
import { useActivityBusConnection } from "./hooks/useActivityBusConnection";
import { useNeedsAttentionBadge } from "./hooks/useNeedsAttentionBadge";
import { useSyncNotifyInAppSetting } from "./hooks/useNotifyInApp";
import { useOnboarding } from "./hooks/useOnboarding";
import { useReloadNotifications } from "./hooks/useReloadNotifications";

interface Props {
  children: ReactNode;
}

/**
 * Inner component that uses hooks requiring InboxContext.
 */
function AppContent({ children }: Props) {
  // Manage SSE connection based on auth state (prevents 401s on login page)
  useActivityBusConnection();

  // Sync notifyInApp setting to service worker on app startup and SW restarts
  useSyncNotifyInAppSetting();

  // Update tab title with needs-attention badge count (uses InboxContext)
  useNeedsAttentionBadge();

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
      <FloatingActionButton />
    </>
  );
}

/**
 * App wrapper that provides global functionality like reload notifications, toasts,
 * and schema validation.
 */
export function App({ children }: Props) {
  const { showWizard, isLoading, completeOnboarding } = useOnboarding();

  return (
    <ToastProvider>
      <AuthProvider>
        <InboxProvider>
          <SchemaValidationProvider>
            <AppContent>{children}</AppContent>
            {!isLoading && showWizard && (
              <OnboardingWizard onComplete={completeOnboarding} />
            )}
          </SchemaValidationProvider>
        </InboxProvider>
      </AuthProvider>
    </ToastProvider>
  );
}
