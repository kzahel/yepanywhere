import {
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { StartupShell } from "../components/StartupShell";
import { useI18n } from "../i18n";
import { asClientSummarySourceKey } from "../lib/clientSummarySourceKey";
import type {
  NativeSourceDescriptor,
  NativeTransportChannel,
} from "../lib/nativeTransportBridge";
import { getSourceRuntimeRegistry } from "../lib/sourceRuntime";
import { NativeSourceTransport } from "../lib/transport/NativeSourceTransport";
import {
  RemoteConnectionContext,
  type RemoteConnectionState,
} from "./RemoteConnectionContext";

export function NativeConnectionProvider({
  channel,
  children,
}: {
  channel: NativeTransportChannel;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [source, setSource] = useState<{
    transport: NativeSourceTransport;
    descriptor: NativeSourceDescriptor;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const transport = new NativeSourceTransport(channel);
    void transport.ready.then(
      (descriptor) => {
        if (active) setSource({ transport, descriptor });
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
      transport.dispose();
    };
  }, [channel]);
  if (!source)
    return (
      <StartupShell phase="connection">
        {t(failed ? "nativeConnectionUnavailable" : "nativeConnecting")}
      </StartupShell>
    );
  return (
    <NativeConnectedProvider {...source}>{children}</NativeConnectedProvider>
  );
}

function NativeConnectedProvider({
  transport,
  descriptor,
  children,
}: {
  transport: NativeSourceTransport;
  descriptor: NativeSourceDescriptor;
  children: ReactNode;
}) {
  const status = useSyncExternalStore(
    transport.status.subscribe,
    transport.status.getSnapshot,
  );
  const nativeSource = useMemo(
    () => ({
      sourceKey: asClientSummarySourceKey(`native:${descriptor.profileId}`),
      registration: {
        kind: "custom" as const,
        createTransport: () => transport,
      },
    }),
    [descriptor.profileId, transport],
  );
  const switchHost = useMemo(
    () => () => {
      void transport.switchHost().catch(() => {});
    },
    [transport],
  );
  useEffect(() => {
    transport.onAuthenticationRequired = switchHost;
    if (transport.authenticationRequired) switchHost();
    return () => {
      transport.onAuthenticationRequired = () => {};
    };
  }, [transport, switchHost]);
  useEffect(
    () => () => {
      getSourceRuntimeRegistry().disposeSource(nativeSource.sourceKey);
    },
    [nativeSource],
  );
  const value = useMemo<RemoteConnectionState>(
    () => ({
      nativeSource,
      switchHost,
      connection: transport,
      isConnecting:
        status.state === "connecting" || status.state === "reconnecting",
      isAutoResuming: false,
      error: null,
      autoResumeError: null,
      currentHostId: descriptor.profileId,
      currentRelayUsername: null,
      currentRelayUrl: null,
      currentDirectUrl: null,
      setCurrentHostId: () => {},
      isIntentionalDisconnect: false,
      connect: async () => {
        throw new Error("Sign in through the native host picker");
      },
      connectViaRelay: async () => {
        throw new Error("Sign in through the native host picker");
      },
      disconnect: switchHost,
      clearAutoResumeError: () => {},
      retryAutoResume: () => {
        void transport.reconnect().catch(() => {});
      },
      storedUrl: null,
      storedUsername: descriptor.label,
      hasStoredSession: true,
      resumeSession: async () => {
        switchHost();
      },
    }),
    [
      nativeSource,
      switchHost,
      transport,
      status.state,
      descriptor.profileId,
      descriptor.label,
    ],
  );
  return (
    <RemoteConnectionContext.Provider value={value}>
      {children}
    </RemoteConnectionContext.Provider>
  );
}
