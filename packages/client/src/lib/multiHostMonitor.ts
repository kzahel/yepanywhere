import {
  connectSavedHost,
  isSavedHostSignInRequiredError,
  MultiHostSignInRequiredError,
} from "./savedHostConnection";
export { MultiHostSignInRequiredError } from "./savedHostConnection";
import type { GlobalSessionsResponse, InboxResponse } from "../api/client";
import { RelayMuxSocketPool } from "./connection/RelayMuxPool";
import type {
  SecureConnection,
  RelaySocketFactory,
} from "./connection/SecureConnection";
import {
  createGlobalSessionsCollectionQueryDescriptor,
  createGlobalSessionsQueryKey,
  selectActiveAgentCount,
  selectInboxCounts,
  selectSessionCollectionQueryRecords,
} from "./clientSummaryQueries";
import type { SessionCollectionRecord } from "./clientSummaryCollections";
import { clearHostSession, type SavedHost } from "./hostStorage";
import { resolveSourceKeyForSavedHost } from "./sourceIdentity";
import {
  getSourceRuntimeRegistry,
  type SourceRuntimeRegistry,
  type YaSourceRuntime,
} from "./sourceRuntime";
import { SecureSourceTransport } from "./transport";
import type { SourceTransportState } from "./transport/types";

export type MultiHostMonitorHostState =
  | "connecting"
  | "connected"
  | "offline"
  | "sign-in-required";

export interface MultiHostMonitorSessionSummary {
  id: string;
  projectId?: string;
  title: string;
}

export interface MultiHostMonitorSourceSummary {
  activeAgentCount: number;
  hasMoreSessions: boolean;
  needsAttentionCount: number;
  sessions: readonly MultiHostMonitorSessionSummary[];
}

export interface MultiHostMonitorHostSnapshot {
  displayName: string;
  error?: string;
  hostId: string;
  mode: SavedHost["mode"];
  relayUsername?: string;
  state: MultiHostMonitorHostState;
  summary?: MultiHostMonitorSourceSummary;
}

export interface MultiHostMonitorSnapshot {
  connectedCount: number;
  hosts: readonly MultiHostMonitorHostSnapshot[];
  selectedCount: number;
}

export interface MultiHostMonitorConnectionSnapshot {
  error?: string;
  state: SourceTransportState;
  summary: MultiHostMonitorSourceSummary;
}

export interface MultiHostMonitorConnection {
  dispose(): void;
  getSnapshot(): MultiHostMonitorConnectionSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface MultiHostMonitorConnectorOptions {
  signal: AbortSignal;
}

export interface MultiHostMonitorConnector {
  (
    host: SavedHost,
    options: MultiHostMonitorConnectorOptions,
  ): Promise<MultiHostMonitorConnection>;
  dispose?(): void;
}

type Listener = () => void;

interface HostRecord {
  abortController: AbortController | null;
  connection: MultiHostMonitorConnection | null;
  host: SavedHost;
  snapshot: MultiHostMonitorHostSnapshot;
  unsubscribe: (() => void) | null;
}

function initialHostSnapshot(host: SavedHost): MultiHostMonitorHostSnapshot {
  return {
    displayName: host.displayName,
    hostId: host.id,
    mode: host.mode,
    relayUsername: host.relayUsername,
    state: host.session ? "connecting" : "sign-in-required",
  };
}

function stateFromTransport(
  state: SourceTransportState,
): MultiHostMonitorHostState {
  return state === "ready"
    ? "connected"
    : state === "disconnected"
      ? "offline"
      : "connecting";
}

function connectionFailureSnapshot(
  record: HostRecord,
  error: unknown,
): MultiHostMonitorHostSnapshot {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ...record.snapshot,
    error: message,
    state:
      error instanceof MultiHostSignInRequiredError
        ? "sign-in-required"
        : "offline",
  };
}

export class MultiHostMonitorController {
  private readonly connector: MultiHostMonitorConnector;
  private readonly listeners = new Set<Listener>();
  private readonly records = new Map<string, HostRecord>();
  private snapshot: MultiHostMonitorSnapshot;
  private started = false;
  private disposed = false;

  constructor(
    hosts: readonly SavedHost[],
    connector?: MultiHostMonitorConnector,
  ) {
    this.connector = connector ?? createMultiHostMonitorConnector(hosts);
    for (const host of hosts) {
      this.records.set(host.id, {
        abortController: null,
        connection: null,
        host,
        snapshot: initialHostSnapshot(host),
        unsubscribe: null,
      });
    }
    this.snapshot = this.createSnapshot();
  }

  getSnapshot = (): MultiHostMonitorSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    for (const record of this.records.values()) {
      if (record.host.session) {
        void this.connectRecord(record);
      }
    }
  }

  retryHost(hostId: string): void {
    if (this.disposed) return;
    const record = this.records.get(hostId);
    if (!record?.host.session || record.abortController) return;
    void this.connectRecord(record);
  }

  deactivateHost(hostId: string): void {
    if (this.disposed) return;
    const record = this.records.get(hostId);
    if (!record) return;
    record.abortController?.abort();
    record.unsubscribe?.();
    record.connection?.dispose();
    this.records.delete(hostId);
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of this.records.values()) {
      record.abortController?.abort();
      record.abortController = null;
      record.unsubscribe?.();
      record.unsubscribe = null;
      record.connection?.dispose();
      record.connection = null;
    }
    this.connector.dispose?.();
    this.listeners.clear();
  }

  private async connectRecord(record: HostRecord): Promise<void> {
    record.abortController?.abort();
    record.unsubscribe?.();
    record.connection?.dispose();
    record.abortController = new AbortController();
    record.unsubscribe = null;
    record.connection = null;
    record.snapshot = {
      ...record.snapshot,
      error: undefined,
      state: "connecting",
      summary: undefined,
    };
    this.emit();

    const controller = record.abortController;
    try {
      const connection = await this.connector(record.host, {
        signal: controller.signal,
      });
      if (this.disposed || controller.signal.aborted) {
        connection.dispose();
        return;
      }
      record.connection = connection;
      const sync = () => {
        if (this.disposed || record.connection !== connection) return;
        const connectionSnapshot = connection.getSnapshot();
        record.snapshot = {
          ...record.snapshot,
          error: connectionSnapshot.error,
          state: stateFromTransport(connectionSnapshot.state),
          summary: connectionSnapshot.summary,
        };
        this.emit();
      };
      record.unsubscribe = connection.subscribe(sync);
      sync();
    } catch (error) {
      if (this.disposed || controller.signal.aborted) return;
      record.snapshot = connectionFailureSnapshot(record, error);
      this.emit();
    } finally {
      if (record.abortController === controller) {
        record.abortController = null;
      }
    }
  }

  private createSnapshot(): MultiHostMonitorSnapshot {
    const hosts = [...this.records.values()].map((record) => record.snapshot);
    return {
      connectedCount: hosts.filter((host) => host.state === "connected").length,
      hosts,
      selectedCount: hosts.length,
    };
  }

  private emit(): void {
    this.snapshot = this.createSnapshot();
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

function sessionTitle(record: SessionCollectionRecord): string {
  return (
    record.customTitle ??
    record.title ??
    record.fullTitle ??
    record.lastAgentText ??
    record.id
  );
}

function summarizeRuntime(
  runtime: YaSourceRuntime,
  query: ReturnType<typeof createGlobalSessionsCollectionQueryDescriptor>,
): MultiHostMonitorSourceSummary {
  const state = runtime.summary.getSnapshot();
  const inboxCounts = selectInboxCounts(state);
  return {
    activeAgentCount: selectActiveAgentCount(state),
    hasMoreSessions:
      state.sessions.queries.get(createGlobalSessionsQueryKey(query))
        ?.hasMore ?? false,
    needsAttentionCount: inboxCounts.needsAttention,
    sessions: selectSessionCollectionQueryRecords(state, query).map(
      (record) => ({
        id: record.id,
        projectId: record.projectId,
        title: sessionTitle(record),
      }),
    ),
  };
}

class RuntimeMonitorConnection implements MultiHostMonitorConnection {
  private readonly listeners = new Set<Listener>();
  private readonly releases: Array<() => void>;
  private readonly registry: SourceRuntimeRegistry;
  private readonly runtime: YaSourceRuntime;
  private readonly query: ReturnType<
    typeof createGlobalSessionsCollectionQueryDescriptor
  >;
  private disposed = false;

  constructor(options: {
    registry: SourceRuntimeRegistry;
    releases: Array<() => void>;
    runtime: YaSourceRuntime;
    query: ReturnType<typeof createGlobalSessionsCollectionQueryDescriptor>;
  }) {
    this.registry = options.registry;
    this.releases = options.releases;
    this.runtime = options.runtime;
    this.query = options.query;
  }

  getSnapshot = (): MultiHostMonitorConnectionSnapshot => {
    const transport = this.runtime.transport.status.getSnapshot();
    return {
      error: transport.channels.find((channel) => channel.lastError)?.lastError,
      state: transport.state,
      summary: summarizeRuntime(this.runtime, this.query),
    };
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  notify = (): void => {
    for (const listener of [...this.listeners]) {
      listener();
    }
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const release of this.releases.splice(0)) {
      release();
    }
    this.listeners.clear();
    this.registry.disposeSource(this.runtime.sourceKey);
  }
}

export async function connectSavedHostForMonitor(
  host: SavedHost,
  options: MultiHostMonitorConnectorOptions,
  relaySocketFactory?: RelaySocketFactory,
): Promise<MultiHostMonitorConnection> {
  if (!host.session) {
    throw new MultiHostSignInRequiredError("A saved session is required");
  }

  const registry = getSourceRuntimeRegistry();
  const sourceKey = resolveSourceKeyForSavedHost(host);
  const transport = registry.registerSourceTransport(sourceKey, {
    kind: "secure",
  });
  if (!(transport instanceof SecureSourceTransport)) {
    throw new Error("Saved host did not create a secure source transport");
  }

  let connection: SecureConnection | null = null;
  let monitorConnection: RuntimeMonitorConnection | null = null;
  try {
    connection = await connectSavedHost(
      host,
      options.signal,
      relaySocketFactory,
    );
    if (options.signal.aborted) {
      connection.close();
      throw new DOMException("Host connection aborted", "AbortError");
    }
    transport.attach(connection);
    const runtime = registry.getOrCreateSourceRuntime(sourceKey);
    const query = createGlobalSessionsCollectionQueryDescriptor({ limit: 3 });
    const releases: Array<() => void> = [];
    monitorConnection = new RuntimeMonitorConnection({
      registry,
      releases,
      runtime,
      query,
    });
    releases.push(
      runtime.summary.retainActivitySubscription(),
      runtime.summary.getStore().subscribe(monitorConnection.notify),
      transport.status.subscribe(monitorConnection.notify),
    );

    const requestStartedAt = Date.now();
    const [sessions, inbox] = await Promise.all([
      transport.fetch<GlobalSessionsResponse>("/sessions?limit=3"),
      transport.fetch<InboxResponse>("/inbox"),
    ]);
    runtime.summary.reportGlobalSessionsCollectionSnapshot(
      {
        query,
        sessions: sessions.sessions,
        hasMore: sessions.hasMore,
        mode: "replace",
      },
      requestStartedAt,
    );
    runtime.summary.reportInboxCollectionSnapshot(inbox, requestStartedAt);
    if (options.signal.aborted) {
      monitorConnection.dispose();
      throw new DOMException("Host connection aborted", "AbortError");
    }
    return monitorConnection;
  } catch (error) {
    if (monitorConnection) {
      monitorConnection.dispose();
    } else {
      registry.disposeSource(sourceKey);
    }
    connection?.close();
    if (isSavedHostSignInRequiredError(error)) {
      clearHostSession(host.id);
      throw new MultiHostSignInRequiredError(
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
}

function createMultiHostMonitorConnector(
  hosts: readonly SavedHost[],
): MultiHostMonitorConnector {
  const relayMuxPool = new RelayMuxSocketPool(hosts);
  const connector: MultiHostMonitorConnector = (host, options) =>
    connectSavedHostForMonitor(
      host,
      options,
      host.mode === "relay"
        ? relayMuxPool.createSocketFactory(host)
        : undefined,
    );
  connector.dispose = () => relayMuxPool.dispose();
  return connector;
}
