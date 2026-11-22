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
import { AntigravityChildSourceOwner } from "./antigravity-child-source.js";
import {
  ANTIGRAVITY_SESSION_ID,
  readAntigravityMetadata,
} from "./antigravity-metadata.js";
import {
  type AntigravitySubagentCall,
  correlateAntigravitySubagentCalls,
  parseSpawnAgentResultId,
  readAntigravityReadOnlyTranscript,
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
import type { ISessionReader, LoadedSession } from "./types.js";

interface NativeListEntry {
  sessionId: string;
  title?: string;
  updatedAt?: string;
}

/** Read Google's native ACP store through its own replay API, never a YA transcript.
 * No background watcher or polling: bounded reads are owned by explicit interest.
 */
export class AntigravitySessionReader implements ISessionReader {
  private readonly directory: string;
  private readonly projectPath: string;
  // One coalesced list per physical scope and at most eight active detail reads per cached reader.
  private listing?: {
    scope: string;
    promise: Promise<{ scope: string; rows: NativeListEntry[] } | null>;
  };
  private listCache?: { scope: string; at: number; rows: NativeListEntry[] };
  private details = new Map<string, Promise<LoadedSession | null>>();
  // Native session/load rewrites the conversation files, which the provider
  // watcher reports as a change and viewers refetch. Reuse a cold read until
  // the files differ from their post-load state, so reading cannot loop.
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

  constructor(options: {
    projectPath: string;
    sessionsDir?: string;
    nativeStorageScope?: string;
    catalogRows?: () => Promise<readonly Readonly<SessionCatalogRow>[]>;
  }) {
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

  private nativeList(): Promise<{
    scope: string;
    rows: NativeListEntry[];
  } | null> {
    let scope: string;
    try {
      scope = realpathSync(this.directory);
    } catch {
      return Promise.resolve(null);
    }
    if (
      this.listCache &&
      this.listCache.scope === scope &&
      Date.now() - this.listCache.at < 5_000
    ) {
      return Promise.resolve({ scope, rows: this.listCache.rows });
    }
    if (this.listing?.scope === scope) return this.listing.promise;
    const pending = (async (): Promise<{
      scope: string;
      rows: NativeListEntry[];
    } | null> => {
      const command = await this.resolveRuntimeForScope(scope);
      if (!command) return null;
      return this.withRuntime(
        async (runtime) => {
          if (!this.runtimeMatchesScopeSync(command, scope)) return null;
          const result = await runtime.call<{
            sessions?: NativeListEntry[];
            nextCursor?: string;
          }>("session/list", { cwd: this.projectPath });
          if (result.nextCursor || (result.sessions?.length ?? 0) > 2_000)
            throw new Error(
              "Antigravity session list exceeds the experimental limit",
            );
          const rows = result.sessions ?? [];
          let postScope: string | null = null;
          try {
            postScope = realpathSync(this.directory);
          } catch {
            postScope = null;
          }
          if (postScope !== scope) {
            // Physical store rebound while session/list was in flight: discard.
            return null;
          }
          this.listCache = { scope, at: Date.now(), rows };
          return { scope, rows };
        },
        command,
        scope,
      );
    })();
    this.listing = { scope, promise: pending };
    void pending
      .finally(() => {
        if (this.listing?.promise === pending) this.listing = undefined;
      })
      .catch(() => {});
    return pending;
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
    row?: NativeListEntry,
  ): SessionSummary {
    return {
      id,
      projectId,
      provider: "antigravity",
      title: row?.title || metadata.title || "Antigravity session",
      fullTitle: row?.title || metadata.title || null,
      createdAt: metadata.info.birthtime.toISOString(),
      updatedAt: new Date(metadata.updatedAtMs).toISOString(),
      messageCount: 0,
      ownership: { owner: "none" },
    };
  }

  private async summary(
    id: string,
    projectId: UrlProjectId,
    row?: NativeListEntry,
  ): Promise<SessionSummary | null> {
    const metadata = await this.metadata(id);
    if (!metadata || metadata.isChild) return null;
    return this.summaryFromMetadata(id, projectId, metadata, row);
  }

  async getSessionSummary(
    id: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const metadata = await this.metadata(id);
    if (!metadata || metadata.isChild) return null;
    const listed = await this.nativeList();
    const row =
      listed && listed.scope === metadata.scope
        ? listed.rows.find((entry) => entry.sessionId === id)
        : undefined;
    // Revalidate after awaiting ACP so lineage committed mid-flight cannot
    // promote a newly-linked child into a top-level summary, and discard ACP
    // titles if the physical store rebound before final metadata validation.
    const latest = await this.metadata(id);
    if (!latest || latest.isChild) return null;
    const matchingRow =
      listed && listed.scope === latest.scope ? row : undefined;
    return this.summaryFromMetadata(id, projectId, latest, matchingRow);
  }

  private assertReadCapacity(): void {
    if (this.details.size + this.agentReads.size >= 8) {
      throw new Error("Too many Antigravity history reads");
    }
  }

  async getSession(
    id: string,
    projectId: UrlProjectId,
    _afterMessageId?: string,
  ): Promise<LoadedSession | null> {
    const key = `${projectId}:${id}`;
    let pending = this.details.get(key);
    if (!pending) {
      this.assertReadCapacity();
      pending = this.readSession(id, projectId);
      this.details.set(key, pending);
      void pending.finally(() => this.details.delete(key)).catch(() => {});
    }
    // Return the whole history even for `afterMessageId`: the detail route
    // slices after the anchor itself, and a pre-sliced list hides that anchor,
    // which the route reports as a miss and the client applies as a
    // replacement window, dropping earlier turns.
    return pending;
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
      // Refuse ACP replay if the active runtime targets a different physical
      // store than the verified scope (even if both stores share a UUID).
      const command = await this.resolveRuntimeForScope(scope);
      if (!command) return null;
      if (beforeLoad && !beforeLoad()) return null;
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
                (!beforeLoad || beforeLoad()),
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
      if (aborted) return null;
      const subagentCalls = enrichSubagents
        ? transcript.listSubagentCalls()
        : [];
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
      entries = transcript.messages;
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
    }
    return { entries, model, complete };
  }

  private async readSession(
    id: string,
    projectId: UrlProjectId,
  ): Promise<LoadedSession | null> {
    const metadata = await this.metadata(id);
    if (!metadata || metadata.isChild) return null;
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

    // Use already-loaded live history or a fresh cold-read entry; never spawn
    // `agy acp` `session/load` just to answer a mapping request.
    let entries = antigravityLiveHistory(metadata.scope, parentSessionId);
    if (!entries) {
      const cached = this.coldReads.get(
        `${metadata.scope}\0${parentSessionId}`,
      );
      if (cached?.version === metadata.sourceVersion) {
        entries = cached.entries;
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

    // Strictly authorize `agentId` as a cycle-free, project-eligible descendant
    // of `parentSessionId` BEFORE touching child files or starting ACP.
    const childRow = authorize();
    if (!childRow) return null;

    // Never run a competing ACP `session/load` while the child is actively
    // running (or owned), since replay can rewrite native continuation metadata.
    // Serve a bounded read-only projection from `transcript.jsonl` instead.
    if (
      isAntigravityChildRunning(childRow) ||
      antigravitySessionOwned(scope, agentId)
    ) {
      const messages = await readAntigravityReadOnlyTranscript(scope, agentId);
      const finalRow = authorize();
      if (!finalRow) return null;
      return {
        messages,
        status: finalRow.killed
          ? "failed"
          : isAntigravityChildRunning(finalRow)
            ? "running"
            : "completed",
      };
    }

    const metadata = await this.metadata(agentId);
    if (!metadata || metadata.scope !== scope) return null;

    // Synchronously revalidate lineage & running status after reading metadata.
    const preLoadRow = authorize();
    if (!preLoadRow) return null;
    if (
      isAntigravityChildRunning(preLoadRow) ||
      antigravitySessionOwned(scope, agentId)
    ) {
      const messages = await readAntigravityReadOnlyTranscript(scope, agentId);
      const finalRow = authorize();
      if (!finalRow) return null;
      return {
        messages,
        status: finalRow.killed
          ? "failed"
          : isAntigravityChildRunning(finalRow)
            ? "running"
            : "completed",
      };
    }

    const loaded = await this.loadTranscriptEntries(
      agentId,
      metadata.scope,
      metadata.cwd,
      metadata.sourceVersion,
      true,
      () => {
        const current = authorize();
        return !!current && !isAntigravityChildRunning(current);
      },
    );
    if (!loaded) return null;

    // Final synchronous lineage verification immediately before returning
    // cached or freshly loaded messages (zero awaits before return).
    const finalRow = authorize();
    if (!finalRow) return null;

    const status = finalRow.killed
      ? "failed"
      : isAntigravityChildRunning(finalRow)
        ? "running"
        : "completed";
    return {
      messages: this.cloneMessages(loaded.entries),
      status,
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
    this.listCache = undefined;
  }
}
