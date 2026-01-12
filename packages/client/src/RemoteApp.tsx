/**
 * RemoteApp - Wrapper for remote client mode.
 *
 * This replaces the regular App wrapper for the remote (static) client.
 * Key differences:
 * - No AuthProvider (SRP handles authentication)
 * - Shows login pages when not connected (handled via routing)
 * - Uses RemoteConnectionProvider for connection state
 */

import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { FloatingActionButton } from "./components/FloatingActionButton";
import { InboxProvider } from "./contexts/InboxContext";
import {
  RemoteConnectionProvider,
  useRemoteConnection,
} from "./contexts/RemoteConnectionContext";
import { SchemaValidationProvider } from "./contexts/SchemaValidationContext";
import { ToastProvider } from "./contexts/ToastContext";
import { useNeedsAttentionBadge } from "./hooks/useNeedsAttentionBadge";
import { useSyncNotifyInAppSetting } from "./hooks/useNotifyInApp";
import { useRemoteActivityBusConnection } from "./hooks/useRemoteActivityBusConnection";

interface Props {
  children: ReactNode;
}

/** Routes that don't require authentication */
const LOGIN_ROUTES = ["/login", "/direct", "/relay"];

/**
 * Inner content that requires connection.
 * Only rendered when we have an active SecureConnection.
 */
function RemoteAppContent({ children }: Props) {
  // Manage activity bus connection (via SecureConnection subscribeActivity)
  useRemoteActivityBusConnection();

  // Sync notifyInApp setting to service worker on app startup and SW restarts
  useSyncNotifyInAppSetting();

  // Update tab title with needs-attention badge count (uses InboxContext)
  useNeedsAttentionBadge();

  return (
    <>
      {children}
      <FloatingActionButton />
    </>
  );
}

/**
 * Gate component that controls access based on connection state.
 *
 * - If not connected and on a login route: render children (login pages)
 * - If not connected and not on a login route: redirect to /login
 * - If connected and on a login route: redirect to /projects
 * - If connected and not on a login route: render children (app)
 */
function ConnectionGate({ children }: Props) {
  const { connection, isAutoResuming } = useRemoteConnection();
  const location = useLocation();
  const isLoginRoute = LOGIN_ROUTES.some(
    (route) =>
      location.pathname === route || location.pathname.startsWith(`${route}/`),
  );

  // Not connected
  if (!connection) {
    // Auto-resuming happens in the login page component
    // So we should redirect to /login which will show loading state
    if (!isLoginRoute && !isAutoResuming) {
      return <Navigate to="/login" replace />;
    }
    // On a login route - render children (login pages)
    return <>{children}</>;
  }

  // Connected - redirect away from login routes
  if (isLoginRoute) {
    return <Navigate to="/projects" replace />;
  }

  // Connected and on an app route - show the app with providers
  return (
    <InboxProvider>
      <SchemaValidationProvider>
        <RemoteAppContent>{children}</RemoteAppContent>
      </SchemaValidationProvider>
    </InboxProvider>
  );
}

/**
 * RemoteApp wrapper for remote client mode.
 *
 * Provides:
 * - ToastProvider (always available)
 * - RemoteConnectionProvider for connection management
 * - Connection gate that controls routing
 */
export function RemoteApp({ children }: Props) {
  return (
    <ToastProvider>
      <RemoteConnectionProvider>
        <ConnectionGate>{children}</ConnectionGate>
      </RemoteConnectionProvider>
    </ToastProvider>
  );
}
