import {
  SERVER_CAPABILITIES,
  serverHasCapability,
  type IssueCoverage,
  type IssueSearchResult,
} from "@yep-anywhere/shared";
import {
  ConversationBinding,
  conversationAvailability,
} from "@yep-anywhere/shared/experimental/conversation-client";
import type {
  ConversationQuery,
  SnapshotEnvelope,
} from "@yep-anywhere/shared/experimental/simple-client.generated";
import type { GlobalSessionsResponse } from "../../api/client";
import { RelayMuxSocketPool } from "../connection/RelayMuxPool";
import type { SecureConnection } from "../connection/SecureConnection";
import type { StreamHandlers, Subscription } from "../connection/types";
import type { SavedHost } from "../hostStorage";
import {
  connectSavedHost,
  isSavedHostSignInRequiredError,
  MultiHostSignInRequiredError,
} from "../savedHostConnection";
import { generateUUID } from "../uuid";

export type PreviewStatus =
  | "excluded"
  | "connecting"
  | "ready"
  | "offline"
  | "sign-in-required"
  | "update-required"
  | "revision-mismatch";
export interface PreviewSession {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  issues: Array<{ id: string; key: string }>;
}
export interface PreviewSource {
  host: SavedHost;
  status: PreviewStatus;
  sessions: PreviewSession[];
  hasMore: boolean;
  updatedAt: number | null;
  issueCoverage: "disabled" | "unsupported" | "partial" | "unavailable";
}
export interface PreviewState {
  sources: PreviewSource[];
  selection: { sourceId: string; sessionId: string } | null;
  view: SnapshotEnvelope["view"] | null;
  conversationStatus: "empty" | "loading" | "ready" | "offline" | "invalid";
  maxMessages: number;
  anchorMessageId: string | null;
}
export type PreviewConnection = Pick<
  SecureConnection,
  "fetch" | "subscribeConversation" | "close"
>;
export type PreviewConnector = (
  host: SavedHost,
  signal: AbortSignal,
  disconnected: (error?: Error) => void,
) => Promise<PreviewConnection>;
interface SourceOwner {
  abort: AbortController;
  connection?: PreviewConnection;
}

/** Small preview state owner: no provider records or existing session reducer. */
export class PreviewController {
  private state: PreviewState;
  private listeners = new Set<() => void>();
  private owners = new Map<string, SourceOwner>();
  private stream?: Subscription;
  private binding?: ConversationBinding;
  private disposed = false;
  private pool?: RelayMuxSocketPool;
  private connect: PreviewConnector;

  constructor(
    hosts: SavedHost[],
    connector?: PreviewConnector,
    selection: PreviewState["selection"] = null,
  ) {
    this.state = {
      sources: hosts.map((host) => ({
        host,
        status: "excluded",
        sessions: [],
        hasMore: false,
        updatedAt: null,
        issueCoverage: "unsupported",
      })),
      selection,
      view: null,
      conversationStatus: "empty",
      maxMessages: 20,
      anchorMessageId: null,
    };
    if (!connector) this.pool = new RelayMuxSocketPool(hosts);
    this.connect =
      connector ??
      ((host, signal, disconnected) =>
        connectSavedHost(
          host,
          signal,
          host.mode === "relay"
            ? this.pool?.createSocketFactory(host)
            : undefined,
          disconnected,
        ));
  }
  getSnapshot = (): PreviewState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<PreviewState> = {}): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private source(id: string, patch: Partial<PreviewSource>): void {
    this.publish({
      sources: this.state.sources.map((source) =>
        source.host.id === id ? { ...source, ...patch } : source,
      ),
    });
  }
  private closeStream(): void {
    this.binding?.close();
    this.binding = undefined;
    const stream = this.stream;
    this.stream = undefined;
    stream?.close();
  }
  private stopSource(id: string): void {
    const owner = this.owners.get(id);
    this.owners.delete(id);
    owner?.abort.abort();
    owner?.connection?.close();
    if (this.state.selection?.sourceId === id) this.closeStream();
  }
  include(id: string, included: boolean): void {
    if (this.disposed) return;
    this.stopSource(id);
    if (!included) {
      this.source(id, { status: "excluded", sessions: [], updatedAt: null });
      if (this.state.selection?.sourceId === id)
        this.publish({
          selection: null,
          view: null,
          conversationStatus: "empty",
        });
      return;
    }
    const source = this.state.sources.find((item) => item.host.id === id);
    if (!source) return;
    const owner: SourceOwner = { abort: new AbortController() };
    this.owners.set(id, owner);
    const current = () =>
      !this.disposed &&
      this.owners.get(id) === owner &&
      !owner.abort.signal.aborted;
    const failed = (error?: Error) => {
      if (!current()) return;
      this.stopSource(id);
      this.source(id, {
        status: isSavedHostSignInRequiredError(error)
          ? "sign-in-required"
          : "offline",
      });
      if (this.state.selection?.sourceId === id)
        this.publish({ conversationStatus: "offline" });
    };
    this.source(id, { status: "connecting", issueCoverage: "unsupported" });
    if (this.state.selection?.sourceId === id)
      this.publish({ conversationStatus: "loading" });
    void (async () => {
      try {
        if (!source.host.session)
          throw new MultiHostSignInRequiredError("Sign in required");
        const connection = await this.connect(
          source.host,
          owner.abort.signal,
          failed,
        );
        if (!current()) {
          connection.close();
          return;
        }
        owner.connection = connection;
        const version =
          await connection.fetch<
            Parameters<typeof conversationAvailability>[0]
          >("/version");
        if (!current()) return;
        const availability = conversationAvailability(version);
        if (availability !== "available") {
          this.stopSource(id);
          this.source(id, { status: availability });
          if (this.state.selection?.sourceId === id)
            this.publish({ conversationStatus: "offline" });
          return;
        }
        const catalog =
          await connection.fetch<GlobalSessionsResponse>("/sessions?limit=50");
        if (!current()) return;
        const sessions: PreviewSession[] = catalog.sessions
          .slice(0, 50)
          .map((session) => ({
            id: session.id,
            title:
              session.customTitle ||
              session.title ||
              session.fullTitle ||
              session.id,
            projectId: session.projectId,
            projectName: session.projectName,
            issues: [],
          }));
        this.source(id, {
          status: "ready",
          sessions,
          hasMore: catalog.hasMore,
          updatedAt: Date.now(),
        });
        if (this.state.selection?.sourceId === id) this.openConversation();
        // Read only existing association metadata. This never enables discovery,
        // confirms an issue, or opens a provider transcript.
        if (
          serverHasCapability(
            version,
            SERVER_CAPABILITIES.issueSessionAssociations,
          )
        ) {
          try {
            const coverage =
              await connection.fetch<IssueCoverage>("/issues/settings");
            if (!current()) return;
            if (!coverage.settings.enabled) {
              this.source(id, { issueCoverage: "disabled" });
              return;
            }
            this.source(id, { issueCoverage: "partial" });
            let next = 0;
            let issueFailed = false;
            const associations = new Map<string, PreviewSession["issues"]>();
            await Promise.all(
              Array.from({ length: 3 }, async () => {
                while (current() && !issueFailed) {
                  const session = sessions[next++];
                  if (!session) return;
                  const result = await connection
                    .fetch<IssueSearchResult>(
                      `/issues?sessionId=${encodeURIComponent(session.id)}&limit=10`,
                    )
                    .catch((error) => {
                      issueFailed = true;
                      throw error;
                    });
                  if (!current()) return;
                  associations.set(
                    session.id,
                    result.items.map((issue) => ({
                      id: issue.id,
                      key: issue.key,
                    })),
                  );
                }
              }),
            );
            if (current())
              this.source(id, {
                sessions: sessions.map((session) => ({
                  ...session,
                  issues: associations.get(session.id) ?? [],
                })),
              });
          } catch {
            if (current()) this.source(id, { issueCoverage: "unavailable" });
          }
        }
      } catch (error) {
        if (!current()) return;
        this.stopSource(id);
        this.source(id, {
          status: isSavedHostSignInRequiredError(error)
            ? "sign-in-required"
            : "offline",
        });
        if (this.state.selection?.sourceId === id)
          this.publish({ conversationStatus: "offline" });
      }
    })();
  }
  select(sourceId: string, sessionId: string): void {
    this.closeStream();
    this.publish({
      selection: { sourceId, sessionId },
      view: null,
      maxMessages: 20,
      anchorMessageId: null,
    });
    this.openConversation();
  }
  more(): void {
    const view = this.state.view;
    this.publish({
      maxMessages: Math.min(100, this.state.maxMessages + 20),
      anchorMessageId:
        view?.kind === "conversation"
          ? (view.messages.at(-1)?.id ?? null)
          : null,
    });
    this.openConversation();
  }
  latest(): void {
    this.publish({ anchorMessageId: null });
    this.openConversation();
  }
  private openConversation(): void {
    this.closeStream();
    const selection = this.state.selection;
    if (!selection) return;
    const connection = this.owners.get(selection.sourceId)?.connection;
    const source = this.state.sources.find(
      (item) => item.host.id === selection.sourceId,
    );
    if (!connection || source?.status !== "ready") {
      this.publish({ conversationStatus: "offline" });
      return;
    }
    const binding = new ConversationBinding(
      selection.sourceId,
      generateUUID(),
      selection.sessionId,
    );
    this.binding = binding;
    const current = () => this.binding === binding && !this.disposed;
    this.publish({ conversationStatus: "loading" });
    const query: ConversationQuery = {
      sessionId: selection.sessionId,
      maxMessages: this.state.maxMessages,
      anchorMessageId: this.state.anchorMessageId,
    };
    const failed = () => {
      if (current()) {
        this.closeStream();
        this.publish({ conversationStatus: "offline" });
      }
    };
    const handlers: StreamHandlers = {
      onEvent: (type, _id, data) => {
        if (!current()) return;
        if (type === "closed") {
          failed();
          return;
        }
        if (type !== "snapshot") return;
        try {
          const snapshot = binding.accept(
            selection.sourceId,
            JSON.stringify(data),
          );
          if (snapshot)
            this.publish({ view: snapshot.view, conversationStatus: "ready" });
        } catch {
          this.closeStream();
          this.publish({ conversationStatus: "invalid" });
        }
      },
      onClose: failed,
      onError: failed,
    };
    try {
      const stream = connection.subscribeConversation(
        binding.subscriptionId,
        query,
        handlers,
      );
      if (current()) this.stream = stream;
      else stream.close();
    } catch {
      failed();
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeStream();
    for (const id of [...this.owners.keys()]) this.stopSource(id);
    this.pool?.dispose();
    this.listeners.clear();
  }
}
