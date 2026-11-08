import { SERVER_CAPABILITIES, serverHasCapability } from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { AuthStatus } from "../api/authClient";
import { useOptionalAuth } from "../contexts/AuthContext";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useVersion } from "./useVersion";

export interface LocalAuthControls {
  /** The server's local-password state is known. */
  ready: boolean;
  authEnabled: boolean;
  authDisabledByEnv: boolean;
  hasDesktopToken: boolean;
  localhostOpen: boolean;
  /**
   * Whether this client can change the local password. A Remote Access
   * client needs a server that accepts its SRP login as the owner
   * (`connection-safe-settings`); older servers accept only a cookie login.
   */
  canManage: boolean;
  enableAuth: (password: string) => Promise<void>;
  changePassword: (password: string) => Promise<void>;
  disableAuth: () => Promise<void>;
  setLocalhostOpen: (open: boolean) => Promise<void>;
}

/**
 * The local password, read and changed the same way for a direct (cookie)
 * client and a Remote Access client, so Local Access shows one set of
 * controls to both (topics/connection-safe-settings.md).
 */
export function useLocalAuthControls(): LocalAuthControls {
  const auth = useOptionalAuth();
  const remoteConnection = useOptionalRemoteConnection();
  const { version } = useVersion();
  const remote = !auth && remoteConnection !== null;
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);

  const refresh = useCallback(async () => {
    if (!remote) return;
    try {
      setStatus(await api.getAuthStatus());
      setStatusFailed(false);
    } catch {
      setStatusFailed(true);
    }
  }, [remote]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const serverAcceptsRemoteOwner = serverHasCapability(
    version,
    SERVER_CAPABILITIES.connectionSafeSettings,
  );

  return useMemo<LocalAuthControls>(() => {
    if (auth) {
      return {
        ready: !auth.isLoading,
        authEnabled: auth.authEnabled,
        authDisabledByEnv: auth.authDisabledByEnv,
        hasDesktopToken: auth.hasDesktopToken,
        localhostOpen: auth.localhostOpen,
        canManage: true,
        enableAuth: auth.enableAuth,
        changePassword: auth.changePassword,
        disableAuth: auth.disableAuth,
        setLocalhostOpen: auth.setLocalhostOpen,
      };
    }
    return {
      ready: status !== null || statusFailed || !remote,
      authEnabled: status?.enabled ?? false,
      authDisabledByEnv: status?.disabledByEnv ?? false,
      hasDesktopToken: status?.hasDesktopToken ?? false,
      localhostOpen: status?.localhostOpen ?? false,
      canManage: remote && status !== null && serverAcceptsRemoteOwner,
      enableAuth: async (password) => {
        await api.enableAuth(password);
        await refresh();
      },
      changePassword: async (password) => {
        await api.changePassword(password);
      },
      disableAuth: async () => {
        await api.disableAuth();
        await refresh();
      },
      setLocalhostOpen: async (open) => {
        await api.setLocalhostAccess(open);
        await refresh();
      },
    };
  }, [auth, refresh, remote, serverAcceptsRemoteOwner, status, statusFailed]);
}
