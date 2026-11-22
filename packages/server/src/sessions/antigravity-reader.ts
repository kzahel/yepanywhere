import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  nativeSessionRef,
  parseNativeSessionId,
  type NativeSessionId,
  type NativeSessionRef,
  type ProviderChildSessionSummary,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import type { Message, SessionSummary } from "../supervisor/types.js";
import type { SDKMessage } from "../sdk/types.js";
import {
  AntigravityRuntime,
  type AntigravityRuntimeCommand,
  antigravityLiveHistory,
  antigravityRuntimeStoreDir,
  antigravitySessionOwned,
  antigravitySessionsDir,
  antigravitySummariesPath,
  findAntigravityRuntime,
  ownAntigravitySession,
  pinAntigravityLaunchToScope,
} from "../sdk/providers/antigravity-runtime.js";
import { loadAntigravityReplay } from "../sdk/providers/antigravity-replay.js";
import { AntigravityTranscript } from "../sdk/providers/antigravity-transcript.js";
import { getProjectIdentityKey, isAbsolutePath } from "../projects/paths.js";
import { getLogger } from "../logging/logger.js";
import { AntigravityChildSourceOwner } from "./antigravity-child-source.js";
import {
  antigravityLogRequest,
  antigravityLogSpawnCalls,
  linkAntigravityLogChildren,
  readAntigravityFirstPrompt,
} from "./antigravity-log-history.js";
import {
  type AntigravityLogWindow,
  type AntigravityLogWindowRequest,
  readAntigravityLogWindow,
} from "./antigravity-log-window.js";
import {
  extractLastAgentExcerpt,
  scanAgentExcerpt,
  toolExcerpt,
} from "./agent-excerpt.js";
import {
  ANTIGRAVITY_SESSION_ID,
  readAntigravityMetadata,
} from "./antigravity-metadata.js";
import {
  type AntigravitySubagentCall,
  correlateAntigravitySubagentCalls,
  parseSpawnAgentResultId,
  readAntigravitySubagentLaunches,
} from "./antigravity-subagent-links.js";
import {
  AntigravitySummariesReader,
  type AntigravitySummaryRow,
  isAntigravityChildRunning,
  normalizeAntigravitySummaryRow,
} from "./antigravity-summaries.js";
import type { ProviderChildSource } from "./ProviderChildRelationshipService.js";
import type { AgentMapping } from "./reader.js";
import { catalogProjectIdentity } from "./catalog-adapters/row.js";
import { AntigravitySessionCatalogAdapter } from "./catalog-adapters/antigravity-catalog-adapter.js";
import type { SessionCatalogRow } from "./catalog-types.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
} from "./types.js";

/** Read Google's native store: history from `agy`'s brain log, a page at a
 * time, and ACP `session/load` replay only when the log is missing or unknown.
 * No background watcher or polling: bounded reads are owned by explicit interest.
 */
/** A replay its own caller was refused, which another caller may retry. */
const REFUSED = Symbol("refused");

export class AntigravitySessionReader implements ISessionReader {
  private readonly directory: string;
  private readonly projectPath: string;
  // At most eight active detail reads per cached reader.
  private details = new Map<string, Promise<LoadedSession | null>>();
  private replays = new Map<
    string,
    Promise<
      | { entries: SDKMessage[]; model?: string; complete: boolean }
      | null
      | typeof REFUSED
    >
  >();
  // The ACP fallback's session/load writes the store's summaries index, which
  // the provider watcher reports as a change and viewers refetch. Reuse a
  // replay until the files differ from their post-load state, so it cannot loop.
  private coldReads = new Map<
    string,
    {
      version: string;
      entries: SDKMessage[];
      model?: string;
      complete: boolean;
    }
  >();
  private runtimes = new Set<AntigravityRuntime>();
  private readonly retireListeners = new Set<() => void>();
  private readonly nativeStorageScope?: string;
  private readonly childSourceOwner: AntigravityChildSourceOwner;
  private summariesReader?: {
    scope: string;
    reader: AntigravitySummariesReader;
  };
  private agentReads = new Map<
    string,
    Promise<{ messages: Message[]; status: string } | null>
  >();
  private closed = false;

  private readonly catalogRows?: () => Promise<
    readonly Readonly<SessionCatalogRow>[]
  >;

  /** Reads only through ACP replay: for comparing it with the log. */
  private readonly replayOnly: boolean;

  constructor(options: {
    projectPath: string;
    sessionsDir?: string;
    nativeStorageScope?: string;
    catalogRows?: () => Promise<readonly Readonly<SessionCatalogRow>[]>;
    historySource?: "log" | "acp-replay";
  }) {
    this.replayOnly = options.historySource === "acp-replay";
    this.catalogRows = options.catalogRows;
    this.projectPath = options.projectPath;
    this.directory =
      options.sessionsDir ??
      options.nativeStorageScope ??
      antigravitySessionsDir();
    this.nativeStorageScope = options.nativeStorageScope;
    this.childSourceOwner = new AntigravityChildSourceOwner({
      owner: this,
      sessionsDir: this.directory,
      projectPath: this.projectPath,
      isRetired: () => this.closed,
      onRetire: (listener) => {
        this.retireListeners.add(listener);
        return () => {
          this.retireListeners.delete(listener);
        };
      },
    });
  }

  private async metadata(id: string) {
    try {
      const metadata = await readAntigravityMetadata(this.directory, id);
      return metadata &&
        (await realpath(metadata.cwd)) === (await realpath(this.projectPath))
        ? metadata
        : null;
    } catch {
      return null;
    }
  }

  private runtimeMatchesScopeSync(
    command: AntigravityRuntimeCommand,
    expectedScope: string,
  ): boolean {
    if (!pinAntigravityLaunchToScope(command, expectedScope)) {
      return false;
    }
    const runtimeStore = antigravityRuntimeStoreDir(command);
    let runtimeScope: string;
    try {
      runtimeScope = realpathSync(runtimeStore);
    } catch {
      runtimeScope = resolve(runtimeStore);
    }
    return runtimeScope === expectedScope;
  }

  private async resolveRuntimeForScope(
    expectedScope?: string,
  ): Promise<AntigravityRuntimeCommand | null> {
    if (this.closed) throw new Error("Antigravity reader is closed");
    const command = await findAntigravityRuntime();
    if (!command)
      throw new Error("Antigravity is not installed (install the agy CLI)");
    if (
      expectedScope &&
      !this.runtimeMatchesScopeSync(command, expectedScope)
    ) {
      return null;
    }
    return command;
  }

  private async withRuntime<T>(
    operation: (runtime: AntigravityRuntime) => Promise<T>,
    commandOverride?: AntigravityRuntimeCommand,
    pinnedScope?: string,
  ): Promise<T> {
    if (this.closed) throw new Error("Antigravity reader is closed");
    const command = commandOverride ?? (await findAntigravityRuntime());
    if (!command)
      throw new Error("Antigravity is not installed (install the agy CLI)");
    const pinned = pinnedScope
      ? pinAntigravityLaunchToScope(command, pinnedScope)
      : { args: command.args, env: undefined };
    if (!pinned) {
      throw new Error(
        "Antigravity store cannot be pinned to ACP launch arguments",
      );
    }
    const runtime = new AntigravityRuntime();
    this.runtimes.add(runtime);
    try {
      await runtime.connect(
        command.command,
        this.projectPath,
        pinned.args,
        pinned.env,
      );
      return await operation(runtime);
    } finally {
      await runtime.close();
      this.runtimes.delete(runtime);
    }
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const rows = this.catalogRows
      ? await this.catalogRows()
      : (
          await new AntigravitySessionCatalogAdapter({
            sessionsDir: this.directory,
          }).scan({
            catalogEpoch: "reader",
            targetGeneration: 0,
            mode: { kind: "complete" },
            signal: new AbortController().signal,
          })
        ).rows;
    const scope = await realpath(this.directory).catch(() => null);
    if (!scope) return [];
    const identity = catalogProjectIdentity(
      this.projectPath,
    ).projectIdentityKey;
    const summaries: SessionSummary[] = [];
    for (const row of rows) {
      if (
        row.catalogFamily !== "antigravity" ||
        row.nativeStorageScope !== scope ||
        row.projectIdentityKey !== identity
      )
        continue;
      const summary = await this.summary(row.sessionId, projectId);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  private summaryFromMetadata(
    id: string,
    projectId: UrlProjectId,
    metadata: NonNullable<Awaited<ReturnType<typeof readAntigravityMetadata>>>,
  ): SessionSummary {
    return {
      id,
      projectId,
      provider: "antigravity",
      title: metadata.title || "Antigravity session",
      fullTitle: metadata.title || null,
      createdAt: metadata.info.birthtime.toISOString(),
      updatedAt: new Date(metadata.updatedAtMs).toISOString(),
      messageCount: 0,
      ownership: { owner: "none" },
    };
  }

  private async summary(
    id: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const metadata = await this.metadata(id);
    if (!metadata || metadata.isChild) return null;
    return this.summaryFromMetadata(id, projectId, metadata);
  }

  /**
   * From the summaries index, and for an untitled row the first prompt in
   * the log's first records: a summary starts no `agy`.
   */
  async getSessionSummary(
    id: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const metadata = await this.metadata(id);
    if (!metadata || metadata.isChild) return null;
    const summary = this.summaryFromMetadata(id, projectId, metadata);
    if (!metadata.title) {
      const prompt = await readAntigravityFirstPrompt(metadata.scope, id);
      // As for a window: only text from the store still bound, while open.
      const latest = await this.metadata(id);
      if (
        this.closed ||
        !latest ||
        latest.isChild ||
        latest.scope !== metadata.scope
      )
        return null;
      if (prompt) {
        summary.title = prompt.slice(0, 120);
        summary.fullTitle = prompt;
      }
    }
    return summary;
  }

  private assertReadCapacity(): void {
    if (this.details.size + this.agentReads.size >= 8) {
      throw new Error("Too many Antigravity history reads");
    }
  }

  async getSession(
    id: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const request = antigravityLogRequest(afterMessageId, options);
    const key = `${projectId}:${id}:${JSON.stringify(request)}`;
    let pending = this.details.get(key);
    if (!pending) {
      this.assertReadCapacity();
      pending = this.readSession(id, projectId, request);
      this.details.set(key, pending);
      void pending.finally(() => this.details.delete(key)).catch(() => {});
    }
    // An `afterMessageId` read includes the anchor: the detail route slices
    // after it, and a list without it reads as an anchor miss, which the
    // client applies as a replacement window.
    return pending;
  }

  /**
   * One window of a stopped conversation's log, with its verified children
   * linked. Unknown and missing logs are logged and returned for the caller's
   * fallback; a read error is an unknown log.
   */
  private async readLog(
    scope: string,
    id: string,
    request: AntigravityLogWindowRequest,
    ownerLive: boolean,
  ): Promise<AntigravityLogWindow> {
    let window: AntigravityLogWindow;
    try {
      window = this.replayOnly
        ? { status: "missing", bytesRead: 0 }
        : await readAntigravityLogWindow({
            scope,
            conversationId: id,
            ownerLive,
            request,
          });
    } catch (error) {
      window = {
        status: "unknown",
        reason: "the read failed",
        error,
        bytesRead: 0,
      };
    }
    if (window.status === "unknown")
      getLogger().info(
        { conversationId: id, reason: window.reason, error: window.error },
        "Antigravity log unknown; history falls back to ACP replay",
      );
    if (
      window.status === "known" &&
      antigravityLogSpawnCalls(window.messages)
    ) {
      const children = new Set<string>();
      for (const row of this.readVerifiedDescendantsSync(scope, id).values())
        if (row.parentConversationId === id) children.add(row.conversationId);
      linkAntigravityLogChildren(window.messages, children);
    }
    return window;
  }

  private getSummariesReader(scope: string): AntigravitySummariesReader {
    if (this.summariesReader?.scope === scope) {
      return this.summariesReader.reader;
    }
    this.summariesReader?.reader.close();
    const reader = new AntigravitySummariesReader(
      antigravitySummariesPath(scope),
    );
    this.summariesReader = { scope, reader };
    return reader;
  }

  private resolveProjectKeySync(pathValue: string): string {
    try {
      return getProjectIdentityKey(realpathSync(pathValue));
    } catch {
      return getProjectIdentityKey(pathValue);
    }
  }

  /**
   * Synchronously verify scope, project membership, and cycle-free descendant
   * lineage against a single SQLite read snapshot with ZERO intervening awaits,
   * eliminating TOCTOU windows between authorization and `session/load` or return.
   */
  private readVerifiedDescendantsSync(
    scope: string,
    parentId: string,
  ): Map<string, AntigravitySummaryRow> {
    const out = new Map<string, AntigravitySummaryRow>();
    if (this.closed) return out;
    let currentScope: string;
    try {
      currentScope = realpathSync(this.directory);
    } catch {
      return out;
    }
    if (
      currentScope !== scope ||
      (this.nativeStorageScope && this.nativeStorageScope !== scope)
    ) {
      return out;
    }
    let snapshot: ReturnType<
      AntigravitySummariesReader["readRelationshipSnapshot"]
    >;
    try {
      snapshot = this.getSummariesReader(scope).readRelationshipSnapshot([
        parentId,
      ]);
    } catch {
      return out;
    }
    const rows = new Map<string, AntigravitySummaryRow>();
    for (const raw of snapshot.rows) {
      const row = normalizeAntigravitySummaryRow(raw);
      if (!row || !ANTIGRAVITY_SESSION_ID.test(row.conversationId)) continue;
      rows.set(row.conversationId, row);
    }
    const expectedKey = this.resolveProjectKeySync(this.projectPath);
    const eligibleByCwd = new Map<string, boolean>();
    const cwdBelongsToProject = (cwd: string | undefined): boolean => {
      if (!cwd || !isAbsolutePath(cwd)) return false;
      const cached = eligibleByCwd.get(cwd);
      if (cached !== undefined) return cached;
      const ok = this.resolveProjectKeySync(cwd) === expectedKey;
      eligibleByCwd.set(cwd, ok);
      return ok;
    };
    const root = rows.get(parentId);
    if (!root || !cwdBelongsToProject(root.cwd)) return out;
    // Detect cycles touching parentId so cyclic ancestors cannot pass as children.
    const rootTrail: string[] = [];
    const rootPositions = new Map<string, number>();
    let ancestor: string | undefined = parentId;
    while (ancestor && rows.has(ancestor) && !rootPositions.has(ancestor)) {
      rootPositions.set(ancestor, rootTrail.length);
      rootTrail.push(ancestor);
      ancestor = rows.get(ancestor)?.parentConversationId;
    }
    const cyclic = new Set(
      ancestor && rootPositions.has(ancestor)
        ? rootTrail.slice(rootPositions.get(ancestor)!)
        : [],
    );
    for (const row of rows.values()) {
      if (
        row.conversationId === parentId ||
        !row.parentConversationId ||
        cyclic.has(row.conversationId)
      )
        continue;
      const seen = new Set<string>([row.conversationId]);
      let cursor: string | undefined = row.parentConversationId;
      let valid = cwdBelongsToProject(row.cwd);
      while (valid && cursor && cursor !== parentId) {
        const cursorRow = rows.get(cursor);
        if (
          seen.has(cursor) ||
          cyclic.has(cursor) ||
          !cursorRow ||
          !cwdBelongsToProject(cursorRow.cwd)
        ) {
          valid = false;
          break;
        }
        seen.add(cursor);
        cursor = cursorRow.parentConversationId;
      }
      if (valid && cursor === parentId) {
        out.set(row.conversationId, row);
      }
    }
    return out;
  }

  private authorizeDescendantSync(
    scope: string,
    parentId: string,
    agentId: string,
  ): AntigravitySummaryRow | undefined {
    return this.readVerifiedDescendantsSync(scope, parentId).get(agentId);
  }

  private cloneMessages(entries: readonly SDKMessage[]): Message[] {
    return entries.map((entry) => ({
      ...entry,
      message: entry.message
        ? {
            ...entry.message,
            content:
              typeof entry.message.content === "string"
                ? entry.message.content
                : entry.message.content.map((block) => ({ ...block })),
          }
        : undefined,
    }));
  }

  private async loadTranscriptEntries(
    id: string,
    scope: string,
    cwd: string,
    sourceVersion: string,
    enrichSubagents: boolean,
    beforeLoad?: () => boolean,
  ): Promise<{
    entries: SDKMessage[];
    model?: string;
    complete: boolean;
  } | null> {
    // The live owner already carries replay + new output. Native session/load
    // may update continuation metadata, so never run it beside that owner.
    let entries = antigravityLiveHistory(scope, id);
    let model = entries
      ?.slice()
      .reverse()
      .find((entry) => entry.type === "assistant" && entry.message?.model)
      ?.message?.model;
    const cacheKey = `${scope}\0${id}`;
    const cached = entries ? undefined : this.coldReads.get(cacheKey);
    let complete = true;
    if (cached?.version === sourceVersion) {
      entries = cached.entries;
      model = cached.model;
      complete = cached.complete;
    }
    if (!entries) {
      // Callers for one conversation share one replay, whatever window each
      // asked for: a second caller never claims a second native owner. A
      // replay its own caller was not admitted to is no answer for another
      // caller, who asks again once that attempt has let go.
      for (;;) {
        const shared = this.replays.get(cacheKey);
        if (shared) {
          const result = await shared;
          if (result !== REFUSED) return result;
          if (this.replays.get(cacheKey) === shared)
            this.replays.delete(cacheKey);
          continue;
        }
        const own = this.replay(id, scope, cwd, enrichSubagents, beforeLoad);
        this.replays.set(cacheKey, own);
        void own
          .finally(() => {
            if (this.replays.get(cacheKey) === own)
              this.replays.delete(cacheKey);
          })
          .catch(() => {});
        const result = await own;
        return result === REFUSED ? null : result;
      }
    }
    return { entries, model, complete };
  }

  /** The ACP fallback: one `session/load` replay, refused beside an owner. */
  private async replay(
    id: string,
    scope: string,
    cwd: string,
    enrichSubagents: boolean,
    beforeLoad?: () => boolean,
  ): Promise<
    | {
        entries: SDKMessage[];
        model?: string;
        complete: boolean;
      }
    | null
    | typeof REFUSED
  > {
    const cacheKey = `${scope}\0${id}`;
    let refused = false;
    const admitted = () => {
      refused = !!beforeLoad && !beforeLoad();
      return !refused;
    };
    let complete = true;
    let model: string | undefined;
    // Refuse ACP replay if the active runtime targets a different physical
    // store than the verified scope (even if both stores share a UUID).
    const command = await this.resolveRuntimeForScope(scope);
    if (!command) return null;
    if (!admitted()) return REFUSED;
    if (antigravitySessionOwned(scope, id)) return null;
    const owner = ownAntigravitySession(scope, id, {
      historyRead: true,
    });
    const transcript = new AntigravityTranscript(id);
    let aborted = false;
    try {
      await this.withRuntime(
        async (runtime) => {
          // Never prompt, authenticate, or allocate a replacement when reading history.
          const loaded = await loadAntigravityReplay({
            runtime,
            scope,
            params: { sessionId: id, cwd, mcpServers: [] },
            transcript,
            // Revalidate synchronously immediately before sending session/load.
            authorize: () =>
              !this.closed &&
              this.runtimeMatchesScopeSync(command, scope) &&
              admitted(),
          });
          aborted = !loaded;
          complete = loaded?.complete ?? false;
          model = loaded?.setup.models?.currentModelId;
        },
        command,
        scope,
      );
    } finally {
      owner.release();
    }
    if (aborted) return refused ? REFUSED : null;
    const subagentCalls = enrichSubagents ? transcript.listSubagentCalls() : [];
    if (subagentCalls.length > 0) {
      const descendants = this.readVerifiedDescendantsSync(scope, id);
      const directChildIds = new Set<string>();
      for (const row of descendants.values()) {
        if (row.parentConversationId === id) {
          directChildIds.add(row.conversationId);
        }
      }
      if (directChildIds.size > 0) {
        const launches = await readAntigravitySubagentLaunches(scope, id);
        const correlated = correlateAntigravitySubagentCalls(
          subagentCalls,
          launches,
          directChildIds,
        );
        for (const [toolUseId, launch] of correlated) {
          transcript.enrichSubagentResult(
            toolUseId,
            launch.childId,
            launch.role,
          );
        }
      }
    }
    const entries = transcript.messages;
    const loaded = await this.metadata(id);
    this.coldReads.delete(cacheKey);
    if (!loaded || loaded.scope !== scope) {
      // Store rebound or disappeared mid-replay: discard the replay so the
      // old store's transcript can never leak into or pollute the new store.
      return null;
    }
    this.coldReads.set(cacheKey, {
      version: loaded.sourceVersion,
      entries,
      model,
      complete,
    });
    // A few recently opened sessions per project; each is bounded.
    if (this.coldReads.size > 4)
      this.coldReads.delete(this.coldReads.keys().next().value!);
    return { entries, model, complete };
  }

  private async readSession(
    id: string,
    projectId: UrlProjectId,
    request: AntigravityLogWindowRequest,
  ): Promise<LoadedSession | null> {
    const metadata = await this.metadata(id);
    if (
      !metadata ||
      metadata.isChild ||
      (this.nativeStorageScope && metadata.scope !== this.nativeStorageScope)
    )
      return null;
    // A live owner serves its own projection (plan 195 step 6 changes that).
    const window = antigravityLiveHistory(metadata.scope, id)
      ? undefined
      : await this.readLog(metadata.scope, id, request, false);
    if (window?.status === "known") {
      // Publish only what the store bound now holds, from a reader still
      // open: a rebind during the read leaves the old store's messages unused.
      const latest = await this.metadata(id);
      if (
        this.closed ||
        !latest ||
        latest.isChild ||
        latest.scope !== metadata.scope
      )
        return null;
      const summary = this.summaryFromMetadata(id, projectId, latest);
      const { messages } = window;
      if (window.firstPrompt !== undefined) {
        summary.title = window.firstPrompt.slice(0, 120);
        summary.fullTitle = window.firstPrompt;
      }
      summary.messageCount = messages.length;
      const model = [...messages]
        .reverse()
        .find(
          (message) => message.type === "assistant" && message.message?.model,
        )?.message?.model;
      summary.model = typeof model === "string" ? model : undefined;
      return {
        summary,
        transcriptSnapshotUpdatedAt: metadata.info.mtime.toISOString(),
        ...(request.kind === "complete"
          ? {}
          : {
              readWindow: {
                kind: "log-page" as const,
                omittedPrefix: window.omittedPrefix,
                before: request.kind === "before",
                ...(window.cut ? { cut: window.cut } : {}),
              },
            }),
        data: { provider: "antigravity", session: { messages } },
      };
    }
    const loaded = await this.loadTranscriptEntries(
      id,
      metadata.scope,
      metadata.cwd,
      metadata.sourceVersion,
      true,
    );
    if (!loaded) return null;
    const messages = this.cloneMessages(loaded.entries);
    const summary = await this.summary(id, projectId);
    if (!summary) return null;
    const first = messages.find(
      (message) =>
        message.type === "user" && typeof message.message?.content === "string",
    );
    const title =
      typeof first?.message?.content === "string"
        ? first.message.content
        : null;
    summary.title = title?.slice(0, 120) ?? null;
    summary.fullTitle = title;
    summary.messageCount = messages.length;
    summary.model = loaded.model;
    return {
      summary,
      ...(!loaded.complete ? { transcriptComplete: false as const } : {}),
      transcriptSnapshotUpdatedAt: metadata.info.mtime.toISOString(),
      data: { provider: "antigravity", session: { messages } },
    };
  }

  /** The hover excerpt from the log's latest page, never from a replay. */
  async getLastAgentExcerpt(id: string): Promise<string | undefined> {
    const metadata = await this.metadata(id);
    if (!metadata || metadata.isChild) return undefined;
    const live = antigravityLiveHistory(metadata.scope, id);
    if (live) return extractLastAgentExcerpt(live as Message[]);
    const window = await this.readLog(
      metadata.scope,
      id,
      { kind: "latest", compactions: 1 },
      false,
    );
    if (window.status !== "known") return undefined;
    const { prose, trailingTool } = scanAgentExcerpt(window.messages);
    // A tool label answers only once nothing older can hold prose.
    return (
      prose ?? (window.omittedPrefix ? undefined : toolExcerpt(trailingTool))
    );
  }

  async getSessionSummaryIfChanged(
    id: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ) {
    const metadata = await this.metadata(id);
    if (
      !metadata ||
      (metadata.info.mtimeMs === cachedMtime &&
        metadata.info.size === cachedSize)
    )
      return null;
    const summary = await this.getSessionSummary(id, projectId);
    return summary
      ? { summary, mtime: metadata.info.mtimeMs, size: metadata.info.size }
      : null;
  }
  async getSessionFilePath(id: string): Promise<string | null> {
    return (await this.metadata(id))?.path ?? null;
  }
  async getSessionProjectPath(id: string): Promise<string | null> {
    return (await this.metadata(id))?.cwd ?? null;
  }
  async getNativeSessionRef(id: NativeSessionId) {
    const metadata = await this.metadata(id);
    return metadata && !metadata.isChild
      ? nativeSessionRef(
          "antigravity",
          metadata.scope,
          parseNativeSessionId(id),
        )
      : null;
  }
  getProviderChildSource(
    parent: NativeSessionRef,
  ): ProviderChildSource | undefined {
    if (
      this.closed ||
      parent.family !== "antigravity" ||
      (this.nativeStorageScope &&
        this.nativeStorageScope !== parent.storageScope)
    ) {
      return undefined;
    }
    return this.childSourceOwner.source(parent);
  }
  async listProviderChildSessions(
    parentSessionId: string,
  ): Promise<ProviderChildSessionSummary[]> {
    return this.childSourceOwner.listDirectChildren(parentSessionId);
  }
  async getAgentMappings(parentSessionId?: string): Promise<AgentMapping[]> {
    if (
      this.closed ||
      !parentSessionId ||
      !ANTIGRAVITY_SESSION_ID.test(parentSessionId)
    ) {
      return [];
    }
    const metadata = await this.metadata(parentSessionId);
    if (!metadata || metadata.isChild) return [];
    if (this.nativeStorageScope && this.nativeStorageScope !== metadata.scope) {
      return [];
    }
    const descendants = this.readVerifiedDescendantsSync(
      metadata.scope,
      parentSessionId,
    );
    const directChildren = new Map<string, AntigravitySummaryRow>();
    for (const row of descendants.values()) {
      if (row.parentConversationId === parentSessionId) {
        directChildren.set(row.conversationId, row);
      }
    }
    if (directChildren.size === 0) return [];

    // Use live history, the log's latest page, or a fresh fallback replay;
    // never spawn `agy acp` `session/load` just to answer a mapping request.
    let entries = antigravityLiveHistory(metadata.scope, parentSessionId) as
      | Message[]
      | undefined;
    if (!entries) {
      const window = await this.readLog(
        metadata.scope,
        parentSessionId,
        { kind: "latest", compactions: 2 },
        false,
      );
      if (window.status === "known") entries = window.messages;
    }
    if (!entries) {
      const cached = this.coldReads.get(
        `${metadata.scope}\0${parentSessionId}`,
      );
      if (cached?.version === metadata.sourceVersion) {
        entries = cached.entries as Message[];
      }
    }
    if (!entries || entries.length === 0) return [];

    const calls: AntigravitySubagentCall[] = [];
    const embeddedByCall = new Map<string, string>();
    const failedCalls = new Set<string>();
    for (const entry of entries) {
      const blocks = Array.isArray(entry.message?.content)
        ? entry.message.content
        : [];
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        if (
          block.type === "tool_use" &&
          block.name === "spawn_agent" &&
          typeof block.id === "string"
        ) {
          const input =
            block.input && typeof block.input === "object"
              ? (block.input as Record<string, unknown>)
              : {};
          calls.push({
            toolUseId: block.id,
            ...(typeof input.description === "string"
              ? { role: input.description }
              : {}),
            ...(typeof input.subagent_type === "string"
              ? { typeName: input.subagent_type }
              : typeof input.role === "string"
                ? { typeName: input.role }
                : {}),
            ...(typeof input.prompt === "string"
              ? { prompt: input.prompt }
              : {}),
          });
        } else if (
          block.type === "tool_result" &&
          typeof block.tool_use_id === "string"
        ) {
          if (block.is_error === true) {
            failedCalls.add(block.tool_use_id);
            embeddedByCall.delete(block.tool_use_id);
          } else if (!failedCalls.has(block.tool_use_id)) {
            const childId = parseSpawnAgentResultId(block.content);
            if (childId && directChildren.has(childId)) {
              embeddedByCall.set(block.tool_use_id, childId);
            }
          }
        }
      }
    }
    if (calls.length === 0) return [];

    const mappings: AgentMapping[] = [];
    const unresolved: AntigravitySubagentCall[] = [];
    const claimed = new Set<string>();
    for (const call of calls) {
      if (failedCalls.has(call.toolUseId)) continue;
      const embedded = embeddedByCall.get(call.toolUseId);
      if (embedded) {
        claimed.add(embedded);
        const row = directChildren.get(embedded);
        mappings.push({
          toolUseId: call.toolUseId,
          agentId: embedded,
          ...(row?.agentName
            ? { agentType: row.agentName }
            : call.typeName
              ? { agentType: call.typeName }
              : {}),
          ...(call.role
            ? { description: call.role }
            : row?.title
              ? { description: row.title }
              : {}),
          ...(row?.nestingDepth !== undefined && row.nestingDepth > 0
            ? { spawnDepth: row.nestingDepth }
            : {}),
        });
      } else {
        unresolved.push(call);
      }
    }

    if (unresolved.length > 0) {
      const remainingIds = new Set<string>();
      for (const id of directChildren.keys()) {
        if (!claimed.has(id)) remainingIds.add(id);
      }
      if (remainingIds.size > 0) {
        const launches = await readAntigravitySubagentLaunches(
          metadata.scope,
          parentSessionId,
        );
        const correlated = correlateAntigravitySubagentCalls(
          unresolved,
          launches,
          remainingIds,
        );
        for (const [toolUseId, launch] of correlated) {
          const row = directChildren.get(launch.childId);
          mappings.push({
            toolUseId,
            agentId: launch.childId,
            ...(row?.agentName
              ? { agentType: row.agentName }
              : launch.typeName
                ? { agentType: launch.typeName }
                : {}),
            ...(launch.role
              ? { description: launch.role }
              : row?.title
                ? { description: row.title }
                : {}),
            ...(row?.nestingDepth !== undefined && row.nestingDepth > 0
              ? { spawnDepth: row.nestingDepth }
              : {}),
          });
        }
      }
    }
    return mappings;
  }

  async getAgentSession(
    agentId: string,
    parentSessionId?: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    if (
      this.closed ||
      !parentSessionId ||
      !ANTIGRAVITY_SESSION_ID.test(agentId) ||
      !ANTIGRAVITY_SESSION_ID.test(parentSessionId)
    ) {
      return null;
    }
    const key = `${parentSessionId}:${agentId}`;
    let pending = this.agentReads.get(key);
    if (!pending) {
      this.assertReadCapacity();
      pending = this.readAgentSession(agentId, parentSessionId);
      this.agentReads.set(key, pending);
      void pending.finally(() => this.agentReads.delete(key)).catch(() => {});
    }
    return pending;
  }

  private async readAgentSession(
    agentId: string,
    parentSessionId: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    const scope = await realpath(this.directory).catch(() => null);
    if (
      !scope ||
      this.closed ||
      (this.nativeStorageScope && this.nativeStorageScope !== scope)
    ) {
      return null;
    }
    const authorize = () =>
      this.authorizeDescendantSync(scope, parentSessionId, agentId);
    const status = (row: AntigravitySummaryRow) =>
      row.killed
        ? "failed"
        : isAntigravityChildRunning(row)
          ? "running"
          : "completed";

    // Strictly authorize `agentId` as a cycle-free, project-eligible descendant
    // of `parentSessionId` BEFORE touching child files or starting ACP.
    const childRow = authorize();
    if (!childRow) return null;

    // A child's view is its log's latest page. While it runs its owner is
    // the parent's `agy`, so the log lacks the step in progress and no ACP
    // fallback may start beside it.
    const settled = () => {
      const row = authorize();
      return !!row && !isAntigravityChildRunning(row);
    };
    const running = () => !settled() || antigravitySessionOwned(scope, agentId);
    const live = running();
    // The latest page, as a tail: the agent-session contract has no signal
    // for earlier content, so older steps of a long child are not shown.
    const window = await this.readLog(
      scope,
      agentId,
      { kind: "latest", compactions: 2 },
      live,
    );
    if (window.status === "known" || live) {
      const finalRow = authorize();
      if (!finalRow) return null;
      if (window.status === "known")
        return { messages: window.messages, status: status(finalRow) };
      return window.status === "missing"
        ? { messages: [], status: status(finalRow) }
        : null;
    }

    const metadata = await this.metadata(agentId);
    if (!metadata || metadata.scope !== scope) return null;
    // Synchronously revalidate lineage & running status after reading metadata.
    if (running()) return null;

    const loaded = await this.loadTranscriptEntries(
      agentId,
      metadata.scope,
      metadata.cwd,
      metadata.sourceVersion,
      true,
      // The fallback's own ownership claim is checked before it is made.
      settled,
    );
    if (!loaded) return null;

    // Final synchronous lineage verification immediately before returning
    // cached or freshly loaded messages (zero awaits before return).
    const finalRow = authorize();
    if (!finalRow) return null;
    return {
      messages: this.cloneMessages(loaded.entries),
      status: status(finalRow),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const listener of this.retireListeners) listener();
    this.retireListeners.clear();
    this.childSourceOwner.close();
    this.summariesReader?.reader.close();
    this.summariesReader = undefined;
    this.coldReads.clear();
    await Promise.all([...this.runtimes].map((runtime) => runtime.close()));
  }
}
