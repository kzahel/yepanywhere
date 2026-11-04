/**
 * GrokSessionReader - Reads Grok Build sessions from ~/.grok/sessions.
 *
 * Grok stores sessions at:
 *   ~/.grok/sessions/<encodeURIComponent(cwd)>/<uuid>/
 *     - summary.json
 *     - chat_history.jsonl
 *     - events.jsonl
 *     - updates.jsonl
 *     - ...
 *
 * This reader exposes provider-native ids: summary.info.id (the ACP handle)
 * wins, with the directory basename used only when older summaries omit it.
 * Scoped application bindings and projection own public YA ids. A directory
 * spelling cannot substitute a different canonical resource for a native id.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseNativeSessionId } from "@yep-anywhere/shared";
import type {
  NativeSessionId,
  ProviderChildSessionSummary,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { resolveNativeSessionRef } from "./SessionIdentityStore.js";
import { attachToolResultMediaCandidates } from "../media/inlineImageData.js";
import { splitGrokUserMessageTexts } from "../sdk/providers/grok-interject-text.js";
import { grokEventUuid } from "../sdk/providers/grok-message-identity.js";
import {
  type NormalizedGrokToolState,
  buildGrokStructuredToolResult,
  formatGrokToolResultContent,
  grokToolResultMediaCandidate,
  hasGrokToolUseMetadata,
  isTerminalGrokToolUpdate,
  normalizeGrokToolUpdate,
} from "../sdk/providers/grok-tool-normalization.js";
import type { Message, SessionSummary } from "../supervisor/types.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
} from "./types.js";
import { sortProviderChildSessions } from "./types.js";
import { createGrokChildSource } from "./grok-child-source.js";
import type { NativeSessionRef } from "@yep-anywhere/shared";
import {
  GROK_SESSIONS_DIR,
  canonicalizeProjectPath,
  getProjectIdentityKey,
} from "../projects/paths.js";

export interface GrokSessionReaderOptions {
  /** Override for testing (defaults to ~/.grok/sessions) */
  sessionsDir?: string;
  /** Filter to sessions belonging to this exact cwd */
  projectPath?: string;
}

type GrokToolState = NormalizedGrokToolState & {
  message: Message;
  resultEmitted: boolean;
};

type GrokTextBuffer = {
  content: string;
  kind: "text" | "thinking";
  role: "assistant";
  timestamp?: string;
  /** Event-id identity of the run's first chunk; see grok-message-identity. */
  uuid?: string;
};

interface GrokSessionInfo {
  /**
   * The canonical durable ID for this Grok session.
   *
   * summary.json:info.id is the ACP handle. The directory basename is the
   * fallback only for older summaries without that field.
   */
  id: string;

  /** The actual directory name on disk (the most direct locatable key). */
  dirBasename: string;

  dirPath: string;
  cwd: string;
  summaryPath: string;
  mtime: number;
  size: number;
}

interface GrokStoredSummary {
  info?: { id?: string; cwd?: string };
  created_at?: string;
  updated_at?: string;
  last_active_at?: string;
  generated_title?: string;
  session_summary?: string;
  num_messages?: number;
  num_chat_messages?: number;
  current_model_id?: string;
}

export class GrokSessionReader implements ISessionReader {
  private closed = false;
  private readonly retirementListeners = new Set<() => void>();
  private sessionsDir: string;
  private projectPath?: string;
  private projectIdentityKey?: string;

  private sessionCache: Map<string, GrokSessionInfo> = new Map();
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 5000;

  constructor(options: GrokSessionReaderOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? GROK_SESSIONS_DIR;
    this.projectPath = options.projectPath
      ? canonicalizeProjectPath(options.projectPath)
      : undefined;
    this.projectIdentityKey = this.projectPath
      ? getProjectIdentityKey(this.projectPath)
      : undefined;
  }

  private async scanSessions(): Promise<GrokSessionInfo[]> {
    if (this.closed) return [];
    const now = Date.now();
    if (
      now - this.cacheTimestamp < this.CACHE_TTL_MS &&
      this.sessionCache.size > 0
    ) {
      return Array.from(this.sessionCache.values());
    }

    this.sessionCache.clear();

    let cwdDirs: string[];
    try {
      cwdDirs = await readdir(this.sessionsDir);
    } catch {
      return [];
    }

    const targetCwd = this.projectIdentityKey;

    for (const encoded of cwdDirs) {
      if (this.closed) return [];
      if (encoded === "session_search.sqlite") continue;

      let decodedCwd: string;
      try {
        decodedCwd = decodeURIComponent(encoded);
      } catch {
        continue;
      }

      const normalized = canonicalizeProjectPath(decodedCwd);
      if (targetCwd && getProjectIdentityKey(normalized) !== targetCwd) {
        continue;
      }

      const cwdDir = join(this.sessionsDir, encoded);
      let uuids: string[];
      try {
        uuids = await readdir(cwdDir);
      } catch {
        continue;
      }

      for (const uuid of uuids) {
        if (this.closed) return [];
        const sessionDir = join(cwdDir, uuid);
        const summaryPath = join(sessionDir, "summary.json");

        try {
          const st = await stat(summaryPath);
          const raw = await readFile(summaryPath, "utf-8");
          const summary = JSON.parse(raw);

          // Preserve the ACP identity even when its directory spelling differs.
          if (this.closed) return [];
          const nativeId =
            typeof summary.info?.id === "string" && summary.info.id
              ? summary.info.id
              : uuid;
          const cwd =
            typeof summary.info?.cwd === "string"
              ? summary.info.cwd
              : decodedCwd;
          if (getProjectIdentityKey(cwd) !== getProjectIdentityKey(normalized))
            continue;
          const info: GrokSessionInfo = {
            id: nativeId,
            dirBasename: uuid,
            dirPath: sessionDir,
            cwd,
            summaryPath,
            mtime: st.mtimeMs,
            size: st.size,
          };
          this.sessionCache.set(info.id, info);
        } catch {
          // Not a valid Grok session dir (missing or bad summary.json)
        }
      }
    }

    this.cacheTimestamp = now;
    return Array.from(this.sessionCache.values());
  }

  private async readStoredSummary(
    info: GrokSessionInfo,
  ): Promise<GrokStoredSummary | null> {
    if (this.closed) return null;
    try {
      const stats = await stat(info.summaryPath);
      if (this.closed) return null;
      const summary = JSON.parse(
        await readFile(info.summaryPath, "utf8"),
      ) as GrokStoredSummary;
      if (this.closed) return null;
      const id =
        typeof summary.info?.id === "string" && summary.info.id
          ? summary.info.id
          : info.dirBasename;
      const cwd =
        typeof summary.info?.cwd === "string" ? summary.info.cwd : info.cwd;
      if (
        id !== info.id ||
        getProjectIdentityKey(cwd) !== getProjectIdentityKey(info.cwd)
      ) {
        this.sessionCache.delete(info.id);
        this.cacheTimestamp = 0;
        return null;
      }
      info.mtime = stats.mtimeMs;
      info.size = stats.size;
      return summary;
    } catch {
      return null;
    }
  }

  private summaryFrom(
    info: GrokSessionInfo,
    data: GrokStoredSummary,
    projectId: UrlProjectId,
  ): SessionSummary {
    return {
      id: info.id,
      projectId,
      ownership: { owner: "none" },
      createdAt: data.created_at ?? new Date(info.mtime).toISOString(),
      updatedAt:
        data.updated_at ??
        data.last_active_at ??
        new Date(info.mtime).toISOString(),
      title: data.generated_title ?? data.session_summary ?? null,
      fullTitle: data.session_summary ?? data.generated_title ?? null,
      messageCount: data.num_messages ?? data.num_chat_messages ?? 0,
      provider: "grok",
      model: data.current_model_id ?? "grok-build",
    };
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const sessions = await this.scanSessions();
    if (this.closed) return [];
    const childIds = await this.collectProviderChildIds(sessions);
    if (this.closed) return [];
    const out: SessionSummary[] = [];
    for (const info of sessions) {
      if (childIds.has(info.id) || childIds.has(info.dirBasename)) continue;
      const data = await this.readStoredSummary(info);
      if (this.closed) return [];
      if (data) out.push(this.summaryFrom(info, data, projectId));
    }
    return this.closed ? [] : out;
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const info = this.findSessionInfo(await this.scanSessions(), sessionId);
    if (this.closed || !info) return null;
    const data = await this.readStoredSummary(info);
    return !this.closed && data
      ? this.summaryFrom(info, data, projectId)
      : null;
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const info = this.findSessionInfo(await this.scanSessions(), sessionId);
    if (this.closed || !info) return null;
    const stats = await stat(info.summaryPath).catch(() => null);
    if (
      this.closed ||
      !stats ||
      (stats.mtimeMs === cachedMtime && stats.size === cachedSize)
    )
      return null;
    const data = await this.readStoredSummary(info);
    return !this.closed && data
      ? {
          summary: this.summaryFrom(info, data, projectId),
          mtime: info.mtime,
          size: info.size,
        }
      : null;
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    _options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const sessions = await this.scanSessions();
    const info = this.findSessionInfo(sessions, sessionId);
    if (this.closed || !info) return null;

    const summary = await this.getSessionSummary(sessionId, projectId);
    if (this.closed || !summary) return null;

    const transcriptSnapshot = await this.loadUpdatesSnapshot(info);
    if (this.closed) return null;
    const { messages } = transcriptSnapshot;
    const filteredMessages = afterMessageId
      ? this.messagesAfter(messages, afterMessageId)
      : messages;

    return {
      summary: {
        ...summary,
        messageCount: messages.length || summary.messageCount,
      },
      transcriptSnapshotUpdatedAt: transcriptSnapshot.updatedAt,
      data: {
        provider: "grok",
        session: { messages: filteredMessages },
      },
    };
  }

  private findSessionInfo(
    sessions: GrokSessionInfo[],
    sessionId: string,
  ): GrokSessionInfo | undefined {
    return sessions.find((session) => session.id === sessionId);
  }

  private async loadUpdatesSnapshot(
    info: GrokSessionInfo,
  ): Promise<{ messages: Message[]; updatedAt: string }> {
    const updatesPath = join(info.dirPath, "updates.jsonl");
    let raw: string;
    try {
      const stats = await stat(updatesPath);
      if (this.closed)
        return { messages: [], updatedAt: new Date(info.mtime).toISOString() };
      raw = await readFile(updatesPath, "utf-8");
      if (this.closed)
        return { messages: [], updatedAt: stats.mtime.toISOString() };
      return {
        messages: this.parseUpdatesMessages(raw),
        updatedAt: stats.mtime.toISOString(),
      };
    } catch {
      return {
        messages: [],
        updatedAt: new Date(info.mtime).toISOString(),
      };
    }
  }

  private parseUpdatesMessages(raw: string): Message[] {
    const messages: Message[] = [];
    const tools = new Map<string, GrokToolState>();
    let textBuffer: GrokTextBuffer | null = null;

    const flushText = () => {
      textBuffer = this.flushTextBuffer(messages, textBuffer);
    };

    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const record = this.asRecord(parsed);
      const params = this.asRecord(record?.params);
      const update = this.asRecord(params?.update);
      const updateType = this.stringField(update, "sessionUpdate");
      if (!record || !update || !updateType) continue;

      const timestamp = this.timestampFromRecord(record);
      const eventUuid = grokEventUuid(params?._meta);
      if (updateType === "user_message_chunk") {
        // Each user_message_chunk is a complete user item, not a streamed
        // token run. Buffering consecutive ones concatenates distinct sends
        // (and their interject envelopes) into one row that cannot confirm
        // either optimistic echo.
        flushText();
        const text = this.textFromUpdate(update);
        if (!text) continue;
        this.appendUserTurns(messages, text, timestamp, eventUuid);
        continue;
      }

      if (updateType === "agent_message_chunk") {
        const text = this.textFromUpdate(update);
        if (!text) continue;
        textBuffer = this.appendTextChunk(
          messages,
          textBuffer,
          "text",
          text,
          timestamp,
          eventUuid,
        );
        continue;
      }

      if (updateType === "agent_thought_chunk") {
        const text = this.textFromUpdate(update);
        if (!text) continue;
        textBuffer = this.appendTextChunk(
          messages,
          textBuffer,
          "thinking",
          text,
          timestamp,
          eventUuid,
        );
        continue;
      }

      flushText();

      if (updateType === "tool_call") {
        this.upsertToolUseMessage(update, messages, tools, timestamp);
        continue;
      }

      if (updateType === "tool_call_update") {
        const toolState = hasGrokToolUseMetadata(update)
          ? this.upsertToolUseMessage(update, messages, tools, timestamp)
          : this.findToolState(update, tools);
        if (isTerminalGrokToolUpdate(update)) {
          this.appendToolResultMessage(update, messages, toolState, timestamp);
        }
        continue;
      }

      if (updateType === "plan") {
        const entries = this.planEntries(update);
        if (entries.length > 0) {
          messages.push({
            type: "assistant",
            uuid: eventUuid ?? `grok-plan-${index}`,
            timestamp,
            role: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: entries
                    .map((entry) => `${entry.status}: ${entry.content}`)
                    .join("\n"),
                  grokPlan: { entries },
                },
              ],
            },
          });
        }
      }
    }

    flushText();
    return messages;
  }

  private async loadUpdatesMessages(info: GrokSessionInfo): Promise<Message[]> {
    return (await this.loadUpdatesSnapshot(info)).messages;
  }

  private messagesAfter(
    messages: Message[],
    afterMessageId: string,
  ): Message[] {
    const afterIndex = messages.findIndex((message) => {
      const nestedId = this.stringField(this.asRecord(message.message), "id");
      return (
        message.uuid === afterMessageId ||
        message.id === afterMessageId ||
        nestedId === afterMessageId
      );
    });
    return afterIndex === -1 ? messages : messages.slice(afterIndex + 1);
  }

  private appendUserTurns(
    messages: Message[],
    text: string,
    timestamp: string | undefined,
    eventUuid: string | undefined,
  ): void {
    const parts = splitGrokUserMessageTexts(text);
    for (const [offset, part] of parts.entries()) {
      if (!part.trim()) continue;
      const uuid = eventUuid
        ? offset === 0
          ? eventUuid
          : `${eventUuid}#${offset}`
        : `grok-${messages.length}-user-text`;
      messages.push({
        type: "user",
        uuid,
        timestamp,
        role: "user",
        message: {
          role: "user",
          content: part,
        },
      });
    }
  }

  private appendTextChunk(
    messages: Message[],
    buffer: GrokTextBuffer | null,
    kind: "text" | "thinking",
    text: string,
    timestamp?: string,
    eventUuid?: string,
  ): GrokTextBuffer {
    const sameBuffer = buffer?.kind === kind;
    if (!sameBuffer) {
      this.flushTextBuffer(messages, buffer);
    }
    return {
      content: (sameBuffer ? buffer.content : "") + text,
      kind,
      role: "assistant",
      timestamp: (sameBuffer ? buffer.timestamp : undefined) ?? timestamp,
      uuid: (sameBuffer ? buffer.uuid : undefined) ?? eventUuid,
    };
  }

  private flushTextBuffer(
    messages: Message[],
    buffer: GrokTextBuffer | null,
  ): null {
    if (!buffer?.content.trim()) return null;

    const text = buffer.content;
    if (!text.trim()) return null;

    // Prefer the run's first-chunk event id: the live ACP stream keys the same
    // message on it, so a mid-session backfill merges by id instead of
    // rendering the turn twice. The positional id remains for transcripts
    // recorded before Grok stamped event ids.
    const uuid =
      buffer.uuid ?? `grok-${messages.length}-${buffer.role}-${buffer.kind}`;
    const content =
      buffer.kind === "thinking"
        ? [{ type: "thinking", thinking: text }]
        : text;
    messages.push({
      type: buffer.role,
      uuid,
      timestamp: buffer.timestamp,
      role: buffer.role,
      message: {
        role: buffer.role,
        content,
      },
    });
    return null;
  }

  private upsertToolUseMessage(
    update: Record<string, unknown>,
    messages: Message[],
    tools: Map<string, GrokToolState>,
    timestamp?: string,
  ): GrokToolState | undefined {
    const toolCallId = this.stringField(update, "toolCallId");
    if (!toolCallId) return undefined;

    const previous = tools.get(toolCallId);
    const normalized = normalizeGrokToolUpdate(update, previous);
    if (previous) {
      previous.name = normalized.name;
      previous.input = normalized.input;
      previous.meta = normalized.meta;
      previous.nativeName = normalized.nativeName;
      previous.message.toolUse = {
        id: toolCallId,
        name: normalized.name,
        input: normalized.input,
      };
      const content = previous.message.message?.content;
      const block = Array.isArray(content)
        ? this.asRecord(content[0])
        : undefined;
      if (block) {
        block.name = normalized.name;
        block.input = normalized.input;
      }
      return previous;
    }

    const message: Message = {
      type: "assistant",
      uuid: toolCallId,
      timestamp,
      role: "assistant",
      toolUse: {
        id: toolCallId,
        name: normalized.name,
        input: normalized.input,
      },
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: toolCallId,
            name: normalized.name,
            input: normalized.input,
          },
        ],
      },
    };
    const state: GrokToolState = {
      ...normalized,
      message,
      resultEmitted: false,
    };
    tools.set(toolCallId, state);
    messages.push(message);
    return state;
  }

  private findToolState(
    update: Record<string, unknown>,
    tools: Map<string, GrokToolState>,
  ): GrokToolState | undefined {
    const toolCallId = this.stringField(update, "toolCallId");
    return toolCallId ? tools.get(toolCallId) : undefined;
  }

  private appendToolResultMessage(
    update: Record<string, unknown>,
    messages: Message[],
    state: GrokToolState | undefined,
    timestamp?: string,
  ): void {
    const toolCallId = this.stringField(update, "toolCallId");
    if (!toolCallId || state?.resultEmitted) return;

    const isError =
      this.stringField(update, "status") === "failed" ||
      this.stringField(update, "error") !== undefined;
    const message: Message = {
      type: "user",
      uuid: `${toolCallId}:result`,
      timestamp,
      role: "user",
      toolUseResult: buildGrokStructuredToolResult(update, state),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId,
            is_error: isError,
            content: formatGrokToolResultContent(update, state),
          },
        ],
      },
    };
    const mediaCandidate = grokToolResultMediaCandidate(update);
    if (mediaCandidate) {
      attachToolResultMediaCandidates(message, [mediaCandidate]);
    }
    messages.push(message);
    if (state) state.resultEmitted = true;
  }

  private timestampFromRecord(
    record: Record<string, unknown>,
  ): string | undefined {
    const timestamp = record.timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
      return new Date(timestamp * 1000).toISOString();
    }
    if (typeof timestamp === "string") {
      const parsed = new Date(timestamp);
      return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
    }
    return undefined;
  }

  private textFromUpdate(update: Record<string, unknown>): string | undefined {
    const content = this.asRecord(update.content);
    if (content?.type === "text" && typeof content.text === "string") {
      return content.text;
    }
    if (typeof update.content === "string") return update.content;
    return this.stringField(update, "text");
  }

  private planEntries(
    update: Record<string, unknown>,
  ): Array<Record<string, string>> {
    const entries = update.entries;
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry) => {
      const record = this.asRecord(entry);
      const content = this.stringField(record, "content");
      const status = this.stringField(record, "status") ?? "unknown";
      return content ? [{ content, status }] : [];
    });
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private stringField(
    record: Record<string, unknown> | undefined,
    field: string,
  ): string | undefined {
    const value = record?.[field];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  async getAgentMappings(): Promise<{ toolUseId: string; agentId: string }[]> {
    return [];
  }

  async getAgentSession(
    agentId: string,
    parentSessionId?: string,
  ): Promise<{
    messages: Message[];
    status: string;
    agentType?: string;
    description?: string;
  } | null> {
    // This value is also a filesystem component for a newly discovered child.
    try {
      parseNativeSessionId(agentId);
    } catch {
      return null;
    }
    if (agentId === "." || agentId === "..") return null;
    const sessions = await this.scanSessions();
    if (this.closed) return null;
    const parent = parentSessionId
      ? this.findSessionInfo(sessions, parentSessionId)
      : undefined;
    if (parentSessionId && (!parent || !(await this.readStoredSummary(parent))))
      return null;
    if (this.closed) return null;
    const meta = parent
      ? await this.readSubagentMeta(parent.dirPath, agentId)
      : await this.findSubagentMeta(sessions, agentId);
    if (this.closed || (parentSessionId && !meta)) return null;
    if (
      parent &&
      meta?.parent_session_id &&
      meta.parent_session_id !== parent.id &&
      meta.parent_session_id !== parent.dirBasename
    )
      return null;
    let child = this.findSessionInfo(sessions, agentId);
    if (!child && parent && meta) {
      // Native metadata proves this exact child. Probe its conventional sibling
      // directly; do not re-enumerate the project on every cache miss.
      const dirPath = join(dirname(parent.dirPath), agentId);
      const candidate: GrokSessionInfo = {
        id: agentId,
        dirBasename: agentId,
        dirPath,
        cwd: parent.cwd,
        summaryPath: join(dirPath, "summary.json"),
        mtime: 0,
        size: 0,
      };
      if (await this.readStoredSummary(candidate)) {
        if (this.closed) return null;
        this.sessionCache.set(candidate.id, candidate);
        child = candidate;
      }
    }
    if (this.closed || !child || !(await this.readStoredSummary(child)))
      return null;
    if (this.closed) return null;
    if (
      meta?.child_session_id &&
      meta.child_session_id !== child.id &&
      meta.child_session_id !== child.dirBasename
    )
      return null;
    const loaded = await this.loadUpdatesMessages(child);
    if (this.closed) return null;
    const messages = loaded.map((message) => ({
      ...message,
      isSubagent: true,
    }));
    return {
      messages,
      status: mapGrokSubagentStatus(meta?.status, messages.length),
      ...(meta?.subagent_type ? { agentType: meta.subagent_type } : {}),
      ...(meta?.description ? { description: meta.description } : {}),
    };
  }

  async listProviderChildSessions(
    parentSessionId: string,
  ): Promise<ProviderChildSessionSummary[]> {
    const sessions = await this.scanSessions();
    const parent = this.findSessionInfo(sessions, parentSessionId);
    if (this.closed || !parent || !(await this.readStoredSummary(parent)))
      return [];
    const metas = await this.readParentSubagentMetas(parent.dirPath);
    if (this.closed) return [];
    return sortProviderChildSessions(
      metas.map((meta) => toGrokProviderChildSummary(parentSessionId, meta)),
    );
  }

  getProviderChildSource(parent: NativeSessionRef) {
    if (parent.family !== "grok") return undefined;
    return createGrokChildSource({
      owner: this,
      parent,
      root: this.sessionsDir,
      projectPath: this.projectPath,
      knownParentPath: () => this.sessionCache.get(parent.id)?.summaryPath,
      isRetired: () => this.closed,
      onRetire: (listener) => {
        this.retirementListeners.add(listener);
        return () => {
          this.retirementListeners.delete(listener);
        };
      },
    });
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    const info = this.findSessionInfo(await this.scanSessions(), sessionId);
    if (this.closed || !info) return null;
    return (await this.readStoredSummary(info)) && !this.closed
      ? info.summaryPath
      : null;
  }

  async getNativeSessionRef(sessionId: NativeSessionId) {
    const info = (await this.scanSessions()).find(
      (info) => info.id === sessionId,
    );
    if (this.closed || !info || !(await this.readStoredSummary(info)))
      return null;
    if (this.closed) return null;
    const native = await resolveNativeSessionRef(
      "grok",
      this.sessionsDir,
      sessionId,
    ).catch(() => null);
    return this.closed ? null : native;
  }

  async listSessionFiles(
    _sessionDir: string,
    _options?: { activeAfterMs?: number },
  ): Promise<{ sessionId: string; filePath: string }[]> {
    const sessions = await this.scanSessions();
    if (this.closed) return [];
    const childIds = await this.collectProviderChildIds(sessions);
    if (this.closed) return [];
    return sessions
      .filter(
        (session) =>
          !childIds.has(session.id) && !childIds.has(session.dirBasename),
      )
      .map((session) => ({
        sessionId: session.id,
        filePath: session.summaryPath,
      }));
  }

  async getSessionProjectPath(sessionId: string): Promise<string | null> {
    const info = this.findSessionInfo(await this.scanSessions(), sessionId);
    if (this.closed || !info) return null;
    return (await this.readStoredSummary(info)) && !this.closed
      ? canonicalizeProjectPath(info.cwd)
      : null;
  }

  getIndexScopeKey(_sessionDir: string): string {
    return JSON.stringify([
      "grok",
      this.sessionsDir,
      this.projectIdentityKey ?? "*",
    ]);
  }

  close(): void {
    this.closed = true;
    for (const listener of this.retirementListeners) listener();
    this.retirementListeners.clear();
    this.sessionCache.clear();
  }

  private async collectProviderChildIds(
    sessions: GrokSessionInfo[],
  ): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const session of sessions) {
      if (this.closed) return new Set();
      for (const meta of await this.readParentSubagentMetas(session.dirPath)) {
        if (meta.subagent_id) ids.add(meta.subagent_id);
        if (meta.child_session_id) ids.add(meta.child_session_id);
      }
    }
    return ids;
  }

  private async findSubagentMeta(
    sessions: GrokSessionInfo[],
    agentId: string,
  ): Promise<GrokSubagentMeta | undefined> {
    for (const session of sessions) {
      if (this.closed) return undefined;
      const meta = await this.readSubagentMeta(session.dirPath, agentId);
      if (meta) {
        return meta;
      }
    }
    return undefined;
  }

  private async readSubagentMeta(
    parentDir: string | undefined,
    agentId: string,
  ): Promise<GrokSubagentMeta | undefined> {
    if (this.closed || !parentDir) return undefined;
    const meta = await readGrokSubagentMetaFile(
      join(parentDir, "subagents", agentId, "meta.json"),
    );
    return this.closed ? undefined : meta;
  }

  private async readParentSubagentMetas(
    parentDir: string,
  ): Promise<GrokSubagentMeta[]> {
    if (this.closed) return [];
    const subagentsDir = join(parentDir, "subagents");
    let names: string[];
    try {
      names = await readdir(subagentsDir);
    } catch {
      return [];
    }
    const metas: GrokSubagentMeta[] = [];
    for (const name of names) {
      if (this.closed) return [];
      const meta = await readGrokSubagentMetaFile(
        join(subagentsDir, name, "meta.json"),
      );
      if (meta) {
        metas.push(meta);
      }
    }
    return this.closed ? [] : metas;
  }
}

interface GrokSubagentMeta {
  subagent_id?: string;
  child_session_id?: string;
  parent_session_id?: string;
  subagent_type?: string;
  description?: string;
  status?: string;
  started_at?: string;
  completed_at?: string;
}

async function readGrokSubagentMetaFile(
  path: string,
): Promise<GrokSubagentMeta | undefined> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.subagent_id === "string" && {
        subagent_id: record.subagent_id,
      }),
      ...(typeof record.child_session_id === "string" && {
        child_session_id: record.child_session_id,
      }),
      ...(typeof record.parent_session_id === "string" && {
        parent_session_id: record.parent_session_id,
      }),
      ...(typeof record.subagent_type === "string" && {
        subagent_type: record.subagent_type,
      }),
      ...(typeof record.description === "string" && {
        description: record.description,
      }),
      ...(typeof record.status === "string" && { status: record.status }),
      ...(typeof record.started_at === "string" && {
        started_at: record.started_at,
      }),
      ...(typeof record.completed_at === "string" && {
        completed_at: record.completed_at,
      }),
    };
  } catch {
    return undefined;
  }
}

function toGrokProviderChildSummary(
  parentSessionId: string,
  meta: GrokSubagentMeta,
): ProviderChildSessionSummary {
  const id = meta.child_session_id || meta.subagent_id || parentSessionId;
  return {
    id,
    parentSessionId,
    ...(meta.description ? { title: meta.description } : {}),
    ...(meta.subagent_type ? { agentType: meta.subagent_type } : {}),
    updatedAt:
      meta.completed_at || meta.started_at || new Date(0).toISOString(),
  };
}

function mapGrokSubagentStatus(
  status: string | undefined,
  messageCount: number,
): string {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "cancelled") return "failed";
  if (status === "running" || status === "pending") return "running";
  return messageCount > 0 ? "running" : "pending";
}
