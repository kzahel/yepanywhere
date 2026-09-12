/**
 * RemoteApp - Wrapper for remote client mode.
 *
 * This replaces the regular App wrapper for the remote (static) client.
 * Key differences:
 * - No AuthProvider (SRP handles authentication)
 * - Shows login pages when not connected (handled via routing)
 * - Uses RemoteConnectionProvider for connection state
 *
 * Architecture:
 * RemoteApp provides all shared providers (Toast, RemoteConnection, Inbox, SchemaValidation).
 * Route-level gating is handled by layout routes in remote-main.tsx:
 * - UnauthenticatedGate: wraps login routes, redirects to app if already connected
 * - ConnectionGate: wraps direct-mode app routes, requires connection
 * - RelayConnectionGate: wraps relay-mode app routes, manages relay connection
 * Both ConnectionGate and RelayConnectionGate render ConnectedAppContent when connected.
 */

import {
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { BottomOverscrollReload } from "./components/BottomOverscrollReload";
import { ClientLogRecordingBadge } from "./components/ClientLogRecordingBadge";
import { ConnectionBar } from "./components/ConnectionBar";
import { HostOfflineModal } from "./components/HostOfflineModal";
import { ReloadBanner, ReloadBannerStack } from "./components/ReloadBanner";
import { RemoteCompatibilityNotices } from "./components/RemoteCompatibilityNotices";
import { StorageFilesystemBanner } from "./components/StorageFilesystemBanner";
import { StartupShell } from "./components/StartupShell";
import { ClientSummarySourceBinding } from "./contexts/ClientSummarySourceBinding";
import {
  HostIdentityProvider,
  useHostIdentity,
} from "./contexts/HostIdentityContext";
import { InboxProvider } from "./contexts/InboxContext";
import {
  RemoteConnectionProvider,
  useRemoteConnection,
} from "./contexts/RemoteConnectionContext";
import { SchemaValidationProvider } from "./contexts/SchemaValidationContext";
import { CurrentSourceRuntimeProvider } from "./contexts/SourceRuntimeContext";
import { ToastProvider } from "./contexts/ToastContext";
import { useI18n } from "./i18n";
import { useNeedsAttentionBadge } from "./hooks/useNeedsAttentionBadge";
import { useSyncNotifyInAppSetting } from "./hooks/useNotifyInApp";
import { primeProviderCache } from "./hooks/useProviders";
import {
  getVisibleReloadBanners,
  useReloadNotifications,
} from "./hooks/useReloadNotifications";
import { useRemoteActivityBusConnection } from "./hooks/useRemoteActivityBusConnection";
import { useRemoteBasePath } from "./hooks/useRemoteBasePath";
import { useVersion } from "./hooks/useVersion";
import { useClientSummarySourceKey } from "./lib/clientSummaryStore";
import { initClientLogCollection } from "./lib/diagnostics";
import {
  getRelayCanonicalRedirectTarget,
  getSafeRemoteReturnTarget,
  matchesRelayLoginTarget,
} from "./lib/remoteRoutePaths";

const FloatingActionButton = lazy(() =>
  import("./components/FloatingActionButton").then(
    ({ FloatingActionButton }) => ({ default: FloatingActionButton }),
  ),
);

interface Props {
  children: ReactNode;
}

/**
 * Wrapper for connected app content. Runs hooks that require an active
 * SecureConnection. Used by both ConnectionGate (direct mode) and
 * RelayConnectionGate (relay mode) once connected.
 */
function ConnectedAppContentInner({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const location = useLocation();
  useRemoteActivityBusConnection();
  const { currentRelayUsername } = useRemoteConnection();
  const { version: versionInfo } = useVersion();
  const { icon: hostIdentityIcon } = useHostIdentity();
  const sourceKey = useClientSummarySourceKey();

  useEffect(() => {
    void primeProviderCache(sourceKey).catch(() => {
      // Connected consumers retain their normal loading/error path when this
      // advisory background request cannot populate the catalog.
    });
  }, [sourceKey]);

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
  const isSessionDetailRoute = /\/sessions\/[^/]+/.test(location.pathname);
  const visibleReloads = getVisibleReloadBanners(
    !!isManualReloadMode,
    pendingReloads,
    { backendReloadSafetyKnown },
  );

  return (
    <>
      <StorageFilesystemBanner />
      <RemoteCompatibilityNotices
        versionInfo={versionInfo}
        runtimeNotice={{ runtime: versionInfo?.serverRuntime, sourceKey, t }}
        relayUsername={currentRelayUsername}
      />
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
      <Suspense fallback={null}>
        <FloatingActionButton />
      </Suspense>
    </>
  );
}

export function ConnectedAppContent({ children }: { children: ReactNode }) {
  return (
    <HostIdentityProvider>
      <ConnectedAppContentInner>{children}</ConnectedAppContentInner>
    </HostIdentityProvider>
  );
}

/**
 * Layout route that redirects away from login pages if already connected.
 * Renders <Outlet /> (login pages) when not connected.
 */
export function UnauthenticatedGate() {
  const {
    connection,
    currentRelayUsername,
    currentRelayUrl,
    isIntentionalDisconnect,
  } = useRemoteConnection();
  const basePath = useRemoteBasePath();
  const location = useLocation();

  const loginParams = new URLSearchParams(location.search);
  const returnTo = loginParams.get("returnTo");
  const safeReturnTo = getSafeRemoteReturnTarget(
    returnTo,
    currentRelayUsername,
  );

  // If connected and user didn't intentionally disconnect, redirect to app
  if (
    connection &&
    !isIntentionalDisconnect &&
    matchesRelayLoginTarget(location, currentRelayUsername, currentRelayUrl)
  ) {
    return <Navigate to={safeReturnTo ?? `${basePath}/projects`} replace />;
  }

  return <Outlet />;
}

/**
 * Layout route for direct-mode app routes. Requires an active connection.
 *
 * - Reconnecting after a successful connection: keep the current page mounted
 * - Auto-resuming: show loading spinner
 * - Post-connect network failure: show a dismissible HostOfflineModal over the
 *   current page so already-loaded state remains usable
 * - Initial auto-resume failure: show HostOfflineModal without mounting app routes
 * - Not connected: redirect to /login
 * - Connected: render ConnectedAppContent + child routes
 */
export function ConnectionGate() {
  const { t } = useI18n();
  const {
    connection,
    currentRelayUsername,
    isAutoResuming,
    autoResumeError,
    clearAutoResumeError,
    retryAutoResume,
  } = useRemoteConnection();
  const location = useLocation();
  const hasConnectedRef = useRef(false);
  const [dismissedError, setDismissedError] =
    useState<typeof autoResumeError>(null);
  const [loginRequested, setLoginRequested] = useState(false);
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  const relayCanonicalTarget = getRelayCanonicalRedirectTarget(
    location,
    currentRelayUsername,
  );

  if (connection && !relayCanonicalTarget) {
    hasConnectedRef.current = true;
  }

  const goToLogin = () => {
    clearAutoResumeError();
    setLoginRequested(true);
  };

  if (loginRequested) {
    return (
      <Navigate
        to={`/login?returnTo=${encodeURIComponent(returnTo)}`}
        replace
      />
    );
  }

  if (connection && relayCanonicalTarget) {
    return <Navigate to={relayCanonicalTarget} replace />;
  }

  // Once a route has rendered successfully, preserve its component tree through
  // reconnect and terminal network failures. This keeps in-memory document,
  // transcript, and scroll state available while the transport is offline.
  if (
    hasConnectedRef.current &&
    (connection || isAutoResuming || autoResumeError)
  ) {
    const visibleError =
      autoResumeError && dismissedError !== autoResumeError
        ? autoResumeError
        : null;

    return (
      <>
        <ConnectedAppContent>
          <Outlet />
        </ConnectedAppContent>
        {visibleError && (
          <HostOfflineModal
            error={visibleError}
            onDismiss={() => setDismissedError(visibleError)}
            onRetry={() => {
              setDismissedError(null);
              retryAutoResume();
            }}
            onGoToLogin={goToLogin}
          />
        )}
      </>
    );
  }

  // During auto-resume, don't redirect - show loading state
  // This preserves the current URL so we stay on the same page after successful resume
  if (isAutoResuming) {
    return <StartupShell phase="connection">{t("reconnecting")}</StartupShell>;
  }

  // Not connected (and not auto-resuming)
  if (!connection) {
    // If auto-resume failed with a connection error, show the modal
    if (autoResumeError) {
      return (
        <HostOfflineModal
          error={autoResumeError}
          onDismiss={clearAutoResumeError}
          onRetry={retryAutoResume}
          onGoToLogin={goToLogin}
        />
      );
    }

    return (
      <Navigate
        to={`/login?returnTo=${encodeURIComponent(returnTo)}`}
        replace
      />
    );
  }

  // Connected - render child routes with connected-state hooks
  return (
    <ConnectedAppContent>
      <Outlet />
    </ConnectedAppContent>
  );
}

/**
 * Inner component that runs hooks requiring InboxContext.
 * Must be rendered inside InboxProvider.
 */
function RemoteAppInner({ children }: Props) {
  const location = useLocation();
  const isSessionDetailRoute = /\/sessions\/[^/]+/.test(location.pathname);

  return (
    <>
      <ConnectionBar />
      {!isSessionDetailRoute && <ClientLogRecordingBadge />}
      {children}
    </>
  );
}

/**
 * RemoteApp wrapper for remote client mode.
 *
 * Provides shared context for all routes:
 * - ToastProvider (always available)
 * - RemoteConnectionProvider for connection management
 * - InboxProvider for inbox data (works without connection — gracefully empty)
 * - SchemaValidationProvider (localStorage only, no connection needed)
 * - Connection-independent hooks (notify sync, log collection)
 */
export function RemoteApp({ children }: Props) {
  useEffect(() => initClientLogCollection(), []);
  useSyncNotifyInAppSetting();

  return (
    <ToastProvider>
      <RemoteConnectionProvider>
        <ClientSummarySourceBinding />
        <CurrentSourceRuntimeProvider>
          <InboxProvider>
            <SchemaValidationProvider>
              <RemoteAppInner>{children}</RemoteAppInner>
            </SchemaValidationProvider>
          </InboxProvider>
        </CurrentSourceRuntimeProvider>
      </RemoteConnectionProvider>
    </ToastProvider>
  );
}
