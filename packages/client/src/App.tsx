import { RemoteCompatibilityNotices } from "./components/RemoteCompatibilityNotices";
import { useVersion } from "./hooks/useVersion";
import { useI18n } from "./i18n";
import { lazy, type ReactNode, Suspense, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { BottomOverscrollReload } from "./components/BottomOverscrollReload";
import { CacheMissBillingToasts } from "./components/CacheMissBillingToasts";
import { ClientLogRecordingBadge } from "./components/ClientLogRecordingBadge";
import { ConnectionBar } from "./components/ConnectionBar";
import { DesktopProviderNotice } from "./components/DesktopProviderNotice";
import { StorageFilesystemBanner } from "./components/StorageFilesystemBanner";
import { ReloadBanner, ReloadBannerStack } from "./components/ReloadBanner";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { ClientSummarySourceBinding } from "./contexts/ClientSummarySourceBinding";
import {
  HostIdentityProvider,
  useHostIdentity,
} from "./contexts/HostIdentityContext";
import { InboxProvider } from "./contexts/InboxContext";
import { SchemaValidationProvider } from "./contexts/SchemaValidationContext";
import { CurrentSourceRuntimeProvider } from "./contexts/SourceRuntimeContext";
import { ToastProvider } from "./contexts/ToastContext";
import { useCanAdministerHost } from "./hooks/useActingPrincipal";
import { useActivityBusConnection } from "./hooks/useActivityBusConnection";
import { useNeedsAttentionBadge } from "./hooks/useNeedsAttentionBadge";
import { useSyncNotifyInAppSetting } from "./hooks/useNotifyInApp";
import { useLimitedUserBrowserDefaults } from "./hooks/useLimitedUserBrowserDefaults";
import { useOnboarding } from "./hooks/useOnboarding";
import { primeProviderCache } from "./hooks/useProviders";
import {
  getVisibleReloadBanners,
  useReloadNotifications,
} from "./hooks/useReloadNotifications";
import { useClientSummarySourceKey } from "./lib/clientSummaryStore";
import { initResumeDebugger } from "./lib/resumeDebugger";
import { initClientLogCollection } from "./lib/diagnostics";

const CodexUpdatePrompt = lazy(() =>
  import("./components/CodexUpdatePrompt").then(({ CodexUpdatePrompt }) => ({
    default: CodexUpdatePrompt,
  })),
);
const OnboardingWizard = lazy(() =>
  import("./components/onboarding").then(({ OnboardingWizard }) => ({
    default: OnboardingWizard,
  })),
);

/**
 * First-run setup is the host owner's: its steps configure the install, and
 * a limited user is refused completing it, so they would meet it on every
 * load of a host whose owner never finished it (topics/limited-users.md,
 * host-administration notices).
 */
function HostOnboardingWizard({ onComplete }: { onComplete: () => void }) {
  return useCanAdministerHost() ? (
    <OnboardingWizard onComplete={onComplete} />
  ) : null;
}

interface Props {
  children: ReactNode;
}

const disableOnboarding = import.meta.env.VITE_DISABLE_ONBOARDING === "true";
const disableCliUpdateNotifications =
  import.meta.env.VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS === "true";

/**
 * Inner component that uses hooks requiring InboxContext.
 */
function AppContent({ children }: Props) {
  const location = useLocation();
  const isSessionDetailRoute = /\/sessions\/[^/]+/.test(location.pathname);
  const { icon: hostIdentityIcon } = useHostIdentity();
  const { authEnabled, isAuthenticated, isLoading: authLoading } = useAuth();
  const sourceKey = useClientSummarySourceKey();

  // Manage SSE connection based on auth state (prevents 401s on login page)
  useActivityBusConnection();

  // Prime provider status and model catalogs during the first authenticated
  // tab visit, before a New Session surface needs them. The shared provider
  // cache deduplicates any consumer that mounts while this is still running.
  useEffect(() => {
    if (authLoading || (authEnabled && !isAuthenticated)) return;
    void primeProviderCache(sourceKey).catch(() => {
      // This background hint must not replace the consumer's normal retry and
      // error UI when provider discovery is temporarily unavailable.
    });
  }, [authEnabled, authLoading, isAuthenticated, sourceKey]);

  // Client-side log collection for connection diagnostics
  useEffect(() => initClientLogCollection(), []);
  useEffect(() => initResumeDebugger(), []);

  // Sync notifyInApp setting to service worker on app startup and SW restarts
  useSyncNotifyInAppSetting();

  // A limited user's browser takes the superuser's published defaults once.
  useLimitedUserBrowserDefaults();

  // Update tab title with needs-attention badge count (uses InboxContext)
  useNeedsAttentionBadge(hostIdentityIcon ?? undefined);

  const {
    isManualReloadMode,
    pendingReloads,
    reloadBackend,
    reloadFrontend,
    scheduleSafeRestart,
    cancelSafeRestart,
    dismiss,
    unsafeToRestart,
    interruptibleSessionCount,
    queuedSessionMessageCount,
    safeRestartState,
    safeRestartMutating,
    backendReloadSafetyKnown,
  } = useReloadNotifications();
  const canAdministerHost = useCanAdministerHost();
  const visibleReloads = getVisibleReloadBanners(
    !!isManualReloadMode,
    pendingReloads,
    { backendReloadSafetyKnown, canRestartServer: canAdministerHost },
  );

  return (
    <>
      <ConnectionBar />
      {canAdministerHost && <StorageFilesystemBanner />}
      {canAdministerHost && <DesktopProviderNotice />}
      {!authLoading &&
        (!authEnabled || isAuthenticated) &&
        canAdministerHost && <LocalRuntimeNotice />}
      <CacheMissBillingToasts />
      {!isSessionDetailRoute && <ClientLogRecordingBadge />}
      <ReloadBannerStack avoidSessionComposer={isSessionDetailRoute}>
        {visibleReloads.backend && (
          <ReloadBanner
            target="backend"
            onReload={reloadBackend}
            onDismiss={() => dismiss("backend")}
            onRestartWhenSafe={scheduleSafeRestart}
            onCancelSafeRestart={cancelSafeRestart}
            unsafeToRestart={unsafeToRestart}
            interruptibleSessionCount={interruptibleSessionCount}
            queuedSessionMessageCount={queuedSessionMessageCount}
            safeRestartState={safeRestartState}
            safeRestartMutating={safeRestartMutating}
          />
        )}
        {visibleReloads.frontend && (
          <ReloadBanner
            target="frontend"
            onReload={reloadFrontend}
            onDismiss={() => dismiss("frontend")}
          />
        )}
      </ReloadBannerStack>
      <BottomOverscrollReload
        disabled={isSessionDetailRoute}
        onReload={reloadFrontend}
      />
      {children}
    </>
  );
}

/**
 * App wrapper that provides global functionality like reload notifications,
 * toasts, and schema validation. The entrypoint owns I18nProvider so it can
 * render route-module loading states before this module finishes loading.
 */
export function App({ children }: Props) {
  const { showWizard, isLoading, completeOnboarding } = useOnboarding();

  return (
    <ToastProvider>
      <AuthProvider>
        <ClientSummarySourceBinding />
        <CurrentSourceRuntimeProvider>
          <HostIdentityProvider>
            <InboxProvider>
              <SchemaValidationProvider>
                <AppContent>{children}</AppContent>
                <Suspense fallback={null}>
                  {!disableOnboarding && !isLoading && showWizard && (
                    <HostOnboardingWizard onComplete={completeOnboarding} />
                  )}
                  {!disableCliUpdateNotifications &&
                    !isLoading &&
                    (disableOnboarding || !showWizard) && <CodexUpdatePrompt />}
                </Suspense>
              </SchemaValidationProvider>
            </InboxProvider>
          </HostIdentityProvider>
        </CurrentSourceRuntimeProvider>
      </AuthProvider>
    </ToastProvider>
  );
}

function LocalRuntimeNotice() {
  const { version, error } = useVersion();
  const sourceKey = useClientSummarySourceKey();
  const { t } = useI18n();
  if (error) return null;
  return (
    <RemoteCompatibilityNotices
      versionInfo={version}
      relayUsername={null}
      runtimeNotice={{ runtime: version?.serverRuntime, sourceKey, t }}
    />
  );
}
