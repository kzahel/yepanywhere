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

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { ConnectionBar } from "./components/ConnectionBar";
import { FloatingActionButton } from "./components/FloatingActionButton";
import { HostOfflineModal } from "./components/HostOfflineModal";
import { ReloadBanner } from "./components/ReloadBanner";
import { Modal } from "./components/ui/Modal";
import { InboxProvider, useInboxContext } from "./contexts/InboxContext";
import { InstallIdProvider } from "./contexts/InstallIdContext";
import {
  RemoteConnectionProvider,
  useRemoteConnection,
} from "./contexts/RemoteConnectionContext";
import { SchemaValidationProvider } from "./contexts/SchemaValidationContext";
import { ToastProvider } from "./contexts/ToastContext";
import { useNeedsAttentionBadge } from "./hooks/useNeedsAttentionBadge";
import { useSyncNotifyInAppSetting } from "./hooks/useNotifyInApp";
import { useReloadNotifications } from "./hooks/useReloadNotifications";
import { useRemoteActivityBusConnection } from "./hooks/useRemoteActivityBusConnection";
import { useRemoteBasePath } from "./hooks/useRemoteBasePath";
import { useVersion } from "./hooks/useVersion";
import { connectionManager } from "./lib/connection";
import { initClientLogCollection } from "./lib/diagnostics";
import { shouldEnableInboxForPathname } from "./lib/inboxRouteActivation";

interface Props {
  children: ReactNode;
}

/**
 * Wrapper for connected app content. Runs hooks that require an active
 * SecureConnection. Used by both ConnectionGate (direct mode) and
 * RelayConnectionGate (relay mode) once connected.
 */
export function ConnectedAppContent({ children }: { children: ReactNode }) {
  useRemoteActivityBusConnection();
  const { currentRelayUsername } = useRemoteConnection();
  const { version: versionInfo } = useVersion();
  const [dismissedRelayResumeWarning, setDismissedRelayResumeWarning] =
    useState(false);

  const {
    isManualReloadMode,
    pendingReloads,
    reloadBackend,
    reloadFrontend,
    dismiss,
    unsafeToRestart,
    workerActivity,
  } = useReloadNotifications();

  const showRelayResumeWarning = useMemo(() => {
    if (dismissedRelayResumeWarning) return false;
    if (!currentRelayUsername) return false;
    if (!versionInfo) return false;
    return (versionInfo.resumeProtocolVersion ?? 1) < 2;
  }, [dismissedRelayResumeWarning, currentRelayUsername, versionInfo]);

  return (
    <>
      {showRelayResumeWarning && (
        <Modal
          title="Server Update Required"
          onClose={() => setDismissedRelayResumeWarning(true)}
        >
          <div className="host-offline-modal-content">
            <p className="host-offline-message">
              The server on <strong>{currentRelayUsername}</strong> needs to be
              updated for improved session resume security. Until then, you'll
              need to log in again after refreshing or reconnecting.
            </p>
            <p className="host-offline-detail">
              <code>npm update -g yepanywhere</code>
            </p>
            <p className="host-offline-hint">
              Then restart the server and reconnect.
            </p>
            <div className="host-offline-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={() => setDismissedRelayResumeWarning(true)}
              >
                OK
              </button>
            </div>
          </div>
        </Modal>
      )}
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
 * Layout route that redirects away from login pages if already connected.
 * Renders <Outlet /> (login pages) when not connected.
 */
export function UnauthenticatedGate() {
  const { connection, isIntentionalDisconnect } = useRemoteConnection();
  const basePath = useRemoteBasePath();

  // If connected and user didn't intentionally disconnect, redirect to app
  if (connection && !isIntentionalDisconnect) {
    return <Navigate to={`${basePath}/projects`} replace />;
  }

  return <Outlet />;
}

/**
 * Layout route for direct-mode app routes. Requires an active connection.
 *
 * - Reconnecting: stay on current page (don't redirect to /login)
 * - Auto-resuming: show loading spinner
 * - Not connected + auto-resume error: show HostOfflineModal
 * - Not connected: redirect to /login
 * - Connected: render ConnectedAppContent + child routes
 */
export function ConnectionGate() {
  const {
    connection,
    isAutoResuming,
    autoResumeError,
    clearAutoResumeError,
    retryAutoResume,
  } = useRemoteConnection();

  // During reconnection, stay on the current page — don't redirect to /login.
  // ConnectionManager is the source of truth; React connection state may be stale.
  if (connectionManager.state === "reconnecting") {
    return <Outlet />;
  }

  // During auto-resume, don't redirect - show loading state
  // This preserves the current URL so we stay on the same page after successful resume
  if (isAutoResuming) {
    return (
      <div className="auto-resume-loading">
        <div className="loading-spinner" />
        <p>Reconnecting...</p>
      </div>
    );
  }

  // Not connected (and not auto-resuming)
  if (!connection) {
    // If auto-resume failed with a connection error, show the modal
    if (autoResumeError) {
      return (
        <HostOfflineModal
          error={autoResumeError}
          onRetry={retryAutoResume}
          onGoToLogin={clearAutoResumeError}
        />
      );
    }

    return <Navigate to="/login" replace />;
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
  const { setEnabled } = useInboxContext();
  const shouldEnableInbox = shouldEnableInboxForPathname(location.pathname);

  useEffect(() => {
    setEnabled(shouldEnableInbox);
  }, [setEnabled, shouldEnableInbox]);

  useNeedsAttentionBadge();

  return (
    <>
      <ConnectionBar />
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
      <InstallIdProvider>
        <RemoteConnectionProvider>
          <InboxProvider initialEnabled={false}>
            <SchemaValidationProvider>
              <RemoteAppInner>{children}</RemoteAppInner>
            </SchemaValidationProvider>
          </InboxProvider>
        </RemoteConnectionProvider>
      </InstallIdProvider>
    </ToastProvider>
  );
}
