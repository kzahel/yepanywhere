import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";

import {
  nativeSessionRef,
  parseNativeSessionId,
  type NativeSessionId,
  type NativeSessionRef,
  type ProviderChildSessionSummary,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import type { Message, SessionSummary } from "../supervisor/types.js";
import {
  antigravitySessionsDir,
  antigravitySummariesPath,
} from "../sdk/providers/antigravity-runtime.js";
import {
  type AntigravityLogBoundary,
  antigravityOwnerView,
  antigravitySessionOwned,
} from "../sdk/providers/antigravity-owners.js";
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
import { antigravityHistoryNotice } from "./antigravity-history-notice.js";
import {
  type AntigravitySessionRead,
  antigravityJoinedSession,
  type AntigravityJoinPlan,
  antigravityPlanWindow,
  joinAntigravityOwnerRead,
  planAntigravityJoin,
  sameAntigravitySplit,
} from "./antigravity-live-join.js";
import { scanAgentExcerpt, toolExcerpt } from "./agent-excerpt.js";
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

/**
 * Reads Google's native store: history from `agy`'s brain log, a page at a
 * time. Reading never starts `agy` (plan 195 step 8 removed the ACP replay
 * fallback): a log that is missing or unknown is one informational row
 * saying so. No background watcher or polling: bounded reads are owned by
 * explicit interest.
 */
export class AntigravitySessionReader implements ISessionReader {
  private readonly directory: string;
  private readonly projectPath: string;
  // At most eight active detail reads per cached reader.
  private details = new Map<string, Promise<LoadedSession | null>>();
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
   * One window of a conversation's log, with its verified children linked.
   * A read error is an unknown log; an unknown log is logged.
   */
  private async readLog(
    scope: string,
    id: string,
    request: AntigravityLogWindowRequest,
    ownerLive: boolean,
    boundary?: AntigravityLogBoundary,
  ): Promise<AntigravityLogWindow> {
    let window: AntigravityLogWindow;
    try {
      window = await readAntigravityLogWindow({
        scope,
        conversationId: id,
        ownerLive,
        request,
        ...(boundary ? { boundary } : {}),
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
        "Antigravity log unknown; its history is not shown",
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
   * eliminating TOCTOU windows between authorization and return.
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

  /**
   * One read of a conversation as its open owner divides it: with no open
   * owner, the log's window; with one, the log through its boundary plus
   * its rows ({@link planAntigravityJoin}). A read that an owner opened,
   * closed or moved under is read again.
   */
  private async readConversation(
    scope: string,
    id: string,
    request: AntigravityLogWindowRequest,
  ): Promise<AntigravitySessionRead | null> {
    for (let attempt = 1; !this.closed; attempt++) {
      // Reads an owner keeps changing under end with the last one, marked
      // incomplete: never a missing conversation or a dropped prefix.
      const last = attempt >= 4;
      const before = antigravityOwnerView(scope, id);
      const plan: AntigravityJoinPlan = before
        ? planAntigravityJoin(id, request, before)
        : { kind: "log", request };
      const through = antigravityPlanWindow(plan, before);
      const window = await this.readLog(
        scope,
        id,
        through.request,
        false,
        through.boundary,
      );
      const after = antigravityOwnerView(scope, id);
      const settled = sameAntigravitySplit(before, after);
      if (!settled && !last) continue;
      if (after)
        return joinAntigravityOwnerRead(
          id,
          request,
          plan,
          window,
          after,
          settled,
        );
      return {
        window,
        paged: true,
        ...(settled ? {} : { incomplete: true }),
      };
    }
    return null;
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
    const read = await this.readConversation(metadata.scope, id, request);
    if (!read) return null;
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
    return antigravityJoinedSession(
      id,
      this.summaryFromMetadata(id, projectId, latest),
      latest.info.mtime,
      request,
      read,
      latest.stepCount === 0,
    );
  }

  /**
   * The newest messages a viewer sees: the log's latest page, or an owner's
   * view of it (the page through its boundary and its rows).
   */
  private async latestMessages(
    scope: string,
    id: string,
    compactions: number,
  ): Promise<{ messages: Message[]; omittedPrefix: boolean } | undefined> {
    const read = await this.readConversation(scope, id, {
      kind: "latest",
      compactions,
    });
    if (!read) return undefined;
    const { window, live } = read;
    if (window.status === "known")
      return {
        messages: [...window.messages, ...(live ?? [])],
        omittedPrefix: window.omittedPrefix || !!read.earlier,
      };
    return live ? { messages: live, omittedPrefix: true } : undefined;
  }

  /** The hover excerpt from the latest page. */
  async getLastAgentExcerpt(id: string): Promise<string | undefined> {
    const metadata = await this.metadata(id);
    if (!metadata || metadata.isChild) return undefined;
    // An owner's own reply needs no log read.
    const owner = antigravityOwnerView(metadata.scope, id);
    if (owner) {
      const { prose } = scanAgentExcerpt(owner.history() as Message[]);
      if (prose) return prose;
    }
    const latest = await this.latestMessages(metadata.scope, id, 1);
    if (!latest) return undefined;
    const { prose, trailingTool } = scanAgentExcerpt(latest.messages);
    // A tool label answers only once nothing older can hold prose.
    return (
      prose ?? (latest.omittedPrefix ? undefined : toolExcerpt(trailingTool))
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

    // The latest page as an owner divides it.
    const entries = (
      await this.latestMessages(metadata.scope, parentSessionId, 2)
    )?.messages;
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
    // of `parentSessionId` BEFORE touching child files.
    const childRow = authorize();
    if (!childRow) return null;

    // A child's view is its log's latest page. While it runs its owner is
    // the parent's `agy`, so the log lacks the step in progress.
    const live =
      isAntigravityChildRunning(childRow) ||
      antigravitySessionOwned(scope, agentId);
    // The latest page, as a tail: the agent-session contract has no signal
    // for earlier content, so older steps of a long child are not shown.
    const window = await this.readLog(
      scope,
      agentId,
      { kind: "latest", compactions: 2 },
      live,
    );
    // Final synchronous lineage verification immediately before returning
    // (zero awaits before return).
    const finalRow = authorize();
    if (!finalRow) return null;
    if (window.status === "known")
      return { messages: window.messages, status: status(finalRow) };
    // A running child's log may not be written yet; a settled one with no
    // log that `agy` counts no steps for was never prompted.
    if (window.status === "missing" && (live || finalRow.stepCount === 0))
      return { messages: [], status: status(finalRow) };
    return {
      messages: [
        antigravityHistoryNotice(
          agentId,
          window.status,
          window.status === "unknown" ? window.reason : undefined,
        ),
      ],
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
  }
}
