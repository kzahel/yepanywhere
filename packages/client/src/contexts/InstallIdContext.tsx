import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
import { directConnection, isRemoteClient } from "../lib/connection";
import { setCurrentInstallId } from "../lib/storageKeys";
import { useOptionalRemoteConnection } from "./RemoteConnectionContext";

interface InstallIdContextValue {
  /** The server's installation ID (undefined while loading) */
  installId: string | undefined;
  /** Whether we're still loading the installId */
  isLoading: boolean;
}

const InstallIdContext = createContext<InstallIdContextValue>({
  installId: undefined,
  isLoading: true,
});

/**
 * Provider that fetches and provides the server's installation ID.
 *
 * This should wrap the app (or the part of the app that needs server-scoped storage).
 * On mount, it fetches /server-info via the active connection to get the installId.
 */
export function InstallIdProvider({ children }: { children: ReactNode }) {
  const remoteConnection = useOptionalRemoteConnection();
  const [installId, setInstallId] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const connection = isRemoteClient()
      ? remoteConnection?.connection ?? null
      : directConnection;

    if (!connection) {
      return;
    }
    const activeConnection = connection;

    let cancelled = false;

    async function fetchInstallId() {
      try {
        const response = await activeConnection.fetch<{
          installId?: string;
          host: string;
          port: number;
        }>("/server-info");

        if (!cancelled && response.installId) {
          setInstallId(response.installId);
          // Set global install ID for synchronous access by hooks
          // This also triggers migration of legacy keys
          setCurrentInstallId(response.installId);
        }
      } catch (error) {
        // Server info might not be available (e.g., during tests or older servers)
        console.warn("[InstallIdProvider] Failed to fetch server-info:", error);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    fetchInstallId();

    return () => {
      cancelled = true;
    };
  }, [remoteConnection?.connection]);

  return (
    <InstallIdContext.Provider value={{ installId, isLoading }}>
      {children}
    </InstallIdContext.Provider>
  );
}

/**
 * Hook to access the server's installation ID.
 *
 * @returns Object with installId (undefined while loading) and isLoading flag
 */
export function useInstallId(): InstallIdContextValue {
  return useContext(InstallIdContext);
}
