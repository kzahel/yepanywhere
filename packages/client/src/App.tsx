import { type ReactNode, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { ConnectionBar } from "./components/ConnectionBar";
import { FloatingActionButton } from "./components/FloatingActionButton";
import { ReloadBanner } from "./components/ReloadBanner";
import { OnboardingWizard } from "./components/onboarding";
import { AuthProvider } from "./contexts/AuthContext";
import { InboxProvider, useInboxContext } from "./contexts/InboxContext";
import { InstallIdProvider } from "./contexts/InstallIdContext";
import { SchemaValidationProvider } from "./contexts/SchemaValidationContext";
import { ToastProvider } from "./contexts/ToastContext";
import { useActivityBusConnection } from "./hooks/useActivityBusConnection";
import { useNeedsAttentionBadge } from "./hooks/useNeedsAttentionBadge";
import { useSyncNotifyInAppSetting } from "./hooks/useNotifyInApp";
import { useOnboarding } from "./hooks/useOnboarding";
import { useReloadNotifications } from "./hooks/useReloadNotifications";
import { I18nProvider } from "./i18n";
import { initClientLogCollection } from "./lib/diagnostics";
import { shouldEnableInboxForPathname } from "./lib/inboxRouteActivation";

interface Props {
  children: ReactNode;
}

/**
 * Inner component that uses hooks requiring InboxContext.
 */
function AppContent({ children }: Props) {
  const location = useLocation();
  const { setEnabled } = useInboxContext();
  const shouldEnableInbox = shouldEnableInboxForPathname(location.pathname);

  // Manage SSE connection based on auth state (prevents 401s on login page)
  useActivityBusConnection();

  // Client-side log collection for connection diagnostics
  useEffect(() => initClientLogCollection(), []);

  // Sync notifyInApp setting to service worker on app startup and SW restarts
  useSyncNotifyInAppSetting();

  useEffect(() => {
    setEnabled(shouldEnableInbox);
  }, [setEnabled, shouldEnableInbox]);

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
      <ConnectionBar />
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
    <I18nProvider>
      <ToastProvider>
        <InstallIdProvider>
          <AuthProvider>
            <InboxProvider initialEnabled={false}>
              <SchemaValidationProvider>
                <AppContent>{children}</AppContent>
                {!isLoading && showWizard && (
                  <OnboardingWizard onComplete={completeOnboarding} />
                )}
              </SchemaValidationProvider>
            </InboxProvider>
          </AuthProvider>
        </InstallIdProvider>
      </ToastProvider>
    </I18nProvider>
  );
}
