/**
 * PiSessionReader — durable transcript reader for pi sessions.
 *
 * pi persists each session as append-only JSONL at
 *   ~/.pi/agent/sessions/--<cwd with / → ->--/<ISO-ts>_<uuid>.jsonl
 * a v3 tree where every node carries `id` + `parentId` (/tree, /fork, /clone).
 * The live PiProvider streams turns via the Supervisor; this reader backs
 * reload / list / attach once that process is gone, so a YA server restart no
 * longer loses pi sessions. See topics/pi-provider.md § "Durable transcripts"
 * and tasks/033-pi-session-reader.md.
 *
 * The durable view is the active leaf's path to root (the last appended node
 * walked up via `parentId`), matching pi's /tree semantics rather than every
 * branch. Node → YA message mapping mirrors PiProvider.mapEvent: assistant
 * thinking/text/toolCall blocks, and `toolResult` nodes become a YA `user`
 * message carrying a `tool_result` block.
 *
 * pi sessions are keyed on disk by cwd, so — like Grok/OpenCode — this reader's
 * `projectPath` filter is the real project-membership test (see
 * provider-resolution.ts), and no native summary file exists: summaries are
 * derived from the parsed transcript.
 */

import { resolveNativeSessionRef } from "./SessionIdentityStore.js";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import {
  PI_SESSIONS_DIR,
  canonicalizeProjectPath,
  getProjectIdentityKey,
  readCwdFromSessionFile,
} from "../projects/paths.js";
import {
  PI_EFFORT_RETRY_ENTRY_TYPE,
  piEffortRetryNoticeText,
  readPiEffortRetryRecord,
} from "../sdk/providers/pi-effort-retry.js";
import {
  attachPiResultDetailToToolInput,
  normalizePiTool,
  normalizePiToolResult,
  type PiToolState,
  stringifyPiToolResult,
} from "../sdk/providers/pi-tools.js";
import type {
  ContentBlock,
  Message,
  SessionSummary,
} from "../supervisor/types.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
} from "./types.js";
import { extractLastAgentExcerpt } from "./agent-excerpt.js";
import { getForkedSessionFile } from "./fork-discovery.js";
import { readFirstLine } from "../utils/jsonl.js";

export interface PiSessionReaderOptions {
  /** Override for testing (defaults to ~/.pi/agent/sessions) */
  sessionsDir?: string;
  /** Filter to sessions belonging to this exact cwd */
  projectPath?: string;
}

/** One JSONL node, kept loose and discriminated by `type`. */
interface PiRawNode {
  type?: string;
  id?: string;
  parentId?: string;
  timestamp?: string;
  cwd?: string;
  version?: number;
  modelId?: string;
  provider?: string;
  message?: PiRawMessage;
  /** `custom` entries: the writing extension's type and payload. */
  customType?: string;
  data?: unknown;
}

interface PiRawMessage {
  role?: string;
  content?: unknown;
  timestamp?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  model?: string;
  provider?: string;
  details?: unknown;
}

interface PiContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface PiSessionInfo {
  /** Canonical durable id: the uuid in the filename (= session header id). */
  id: string;
  filePath: string;
  cwd: string;
  mtime: number;
  size: number;
  sourceVersion: string;
}

interface PiParsedSession {
  /**
   * Active leaf → root path, chronological: message nodes plus the custom
   * entries YA's pi extension writes.
   */
  messageNodes: PiRawNode[];
  /** Header `cwd`. */
  cwd: string;
  /** Header timestamp (session creation), if present. */
  createdAt?: string;
  /** Latest model on the active path, as `provider/modelId` when known. */
  model: string | null;
}

function piSourceVersion(stats: {
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
}) {
  return `${stats.dev}:${stats.ino}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
}

export class PiSessionReader implements ISessionReader {
  private closed = false;
  private sessionsDir: string;
  private projectPath?: string;
  private projectIdentityKey?: string;

  private sessionCache: Map<string, PiSessionInfo> = new Map();
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 5000;

  /**
   * Parsed-transcript cache: one current version per file, LRU-bounded.
   * The previous `${filePath}:${mtime}` keying retained every obsolete
   * version of a growing session for the reader's lifetime.
   */
  private parseCache: Map<
    string,
    { sourceVersion: string; parsed: PiParsedSession }
  > = new Map();
  private static readonly PARSE_CACHE_MAX_FILES = 64;

  constructor(options: PiSessionReaderOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? PI_SESSIONS_DIR;
    this.projectPath = options.projectPath
      ? canonicalizeProjectPath(options.projectPath)
      : undefined;
    this.projectIdentityKey = this.projectPath
      ? getProjectIdentityKey(this.projectPath)
      : undefined;
  }

  private sessionIdFromFilename(filename: string): string | null {
    // <ISO-ts>_<uuid>.jsonl — the uuid (after the last "_") is the durable id.
    const match = filename.match(/_([^_/\\]+)\.jsonl$/);
    if (match?.[1]) return match[1];
    // Fall back to a bare <uuid>.jsonl if pi ever drops the ts prefix.
    const bare = filename.match(/([^_/\\]+)\.jsonl$/);
    return bare?.[1] ?? null;
  }

  private async scanSessions(): Promise<PiSessionInfo[]> {
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
      const cwdDir = join(this.sessionsDir, encoded);
      let files: string[];
      try {
        files = await readdir(cwdDir);
      } catch {
        continue; // not a directory (stray file at the root)
      }

      for (const file of files) {
        if (this.closed) return [];
        if (!file.endsWith(".jsonl")) continue;
        const id = this.sessionIdFromFilename(file);
        if (!id) continue;

        const filePath = join(cwdDir, file);
        // cwd comes from the session header, the authoritative source — the
        // encoded directory name is lossy and not reliably reversible.
        const cwd = await readCwdFromSessionFile(filePath);
        if (this.closed) return [];
        if (!cwd) continue;

        const normalized = canonicalizeProjectPath(cwd);
        if (targetCwd && getProjectIdentityKey(normalized) !== targetCwd) {
          continue;
        }

        try {
          const st = await stat(filePath);
          if (this.closed) return [];
          this.sessionCache.set(id, {
            id,
            filePath,
            cwd,
            mtime: st.mtimeMs,
            size: st.size,
            sourceVersion: piSourceVersion(st),
          });
        } catch {
          // file vanished between readdir and stat — skip
        }
      }
    }

    this.cacheTimestamp = now;
    return Array.from(this.sessionCache.values());
  }

  private async findSessionInfo(
    sessionId: string,
  ): Promise<PiSessionInfo | undefined> {
    if (this.closed) return undefined;
    const forkPath = await getForkedSessionFile(
      "pi",
      sessionId,
      this.sessionsDir,
    );
    if (this.closed) return undefined;
    if (
      forkPath &&
      this.sessionIdFromFilename(basename(forkPath)) === sessionId
    ) {
      try {
        const line = await readFirstLine(forkPath, 1024 * 1024);
        const header = line ? (JSON.parse(line) as PiRawNode | null) : null;
        if (
          header?.type === "session" &&
          header.id === sessionId &&
          typeof header.cwd === "string" &&
          (!this.projectIdentityKey ||
            getProjectIdentityKey(header.cwd) === this.projectIdentityKey)
        ) {
          const stats = await stat(forkPath);
          if (this.closed) return undefined;
          if (stats.isFile()) {
            const info = {
              id: sessionId,
              filePath: forkPath,
              cwd: header.cwd,
              mtime: stats.mtimeMs,
              size: stats.size,
              sourceVersion: piSourceVersion(stats),
            };
            this.sessionCache.set(sessionId, info);
            return info;
          }
        }
        return undefined;
      } catch {
        // The provider may have removed or moved the file; use discovery.
      }
    }
    const info = (await this.scanSessions()).find((s) => s.id === sessionId);
    return info ? this.refreshSessionInfo(info) : undefined;
  }

  private async refreshSessionInfo(
    info: PiSessionInfo,
  ): Promise<PiSessionInfo | undefined> {
    if (this.closed) return undefined;
    const stats = await stat(info.filePath).catch(() => null);
    if (this.closed || !stats?.isFile()) return undefined;
    const current = {
      ...info,
      mtime: stats.mtimeMs,
      size: stats.size,
      sourceVersion: piSourceVersion(stats),
    };
    this.sessionCache.set(info.id, current);
    return current;
  }

  /** Parse a session file's active path, caching one exact physical version. */
  private async parseSession(
    info: PiSessionInfo,
  ): Promise<PiParsedSession | null> {
    if (this.closed) return null;
    const cached = this.parseCache.get(info.filePath);
    if (cached && cached.sourceVersion === info.sourceVersion) {
      // Refresh LRU recency by delete-and-reinsert (see lruCollections).
      this.parseCache.delete(info.filePath);
      this.parseCache.set(info.filePath, cached);
      return cached.parsed;
    }

    let raw: string;
    try {
      raw = await readFile(info.filePath, "utf-8");
    } catch {
      return null;
    }

    if (this.closed) return null;
    const nodes: PiRawNode[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        nodes.push(JSON.parse(line) as PiRawNode);
      } catch {
        // skip malformed line
      }
    }
    if (nodes.length === 0) return null;

    const header = nodes.find((n) => n.type === "session");
    const cwd = header?.cwd ?? info.cwd;
    if (typeof cwd !== "string") return null;
    if (
      this.projectIdentityKey &&
      getProjectIdentityKey(cwd) !== this.projectIdentityKey
    )
      return null;
    const createdAt = header?.timestamp;

    // Active leaf = last appended node; walk parentId to the root, then reverse
    // to chronological order. For a linear (unbranched) session this is every
    // node; forks/branches collapse to the saved active branch.
    const byId = new Map<string, PiRawNode>();
    for (const n of nodes) {
      if (n.id) byId.set(n.id, n);
    }
    const path: PiRawNode[] = [];
    const seen = new Set<string>();
    let cur: PiRawNode | undefined = nodes[nodes.length - 1];
    while (cur?.id && !seen.has(cur.id)) {
      seen.add(cur.id);
      path.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    path.reverse();

    const messageNodes = path.filter(
      (n) =>
        n.type === "message" ||
        (n.type === "custom" && n.customType === PI_EFFORT_RETRY_ENTRY_TYPE),
    );
    const model = this.modelFromPath(path);

    const parsed: PiParsedSession = { messageNodes, cwd, createdAt, model };
    this.parseCache.delete(info.filePath);
    this.parseCache.set(info.filePath, {
      sourceVersion: info.sourceVersion,
      parsed,
    });
    while (this.parseCache.size > PiSessionReader.PARSE_CACHE_MAX_FILES) {
      const oldest = this.parseCache.keys().next().value;
      if (oldest === undefined) break;
      this.parseCache.delete(oldest);
    }
    return parsed;
  }

  private modelFromPath(path: PiRawNode[]): string | null {
    // Prefer the last model_change on the active path; fall back to the last
    // assistant message's own provider/model.
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const n = path[i];
      if (n?.type === "model_change" && n.modelId) {
        return n.provider ? `${n.provider}/${n.modelId}` : n.modelId;
      }
    }
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const m = path[i]?.message;
      if (m?.role === "assistant" && m.model) {
        return m.provider ? `${m.provider}/${m.model}` : m.model;
      }
    }
    return null;
  }

  private contentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((b) => {
          const block = b as PiContentBlock;
          return block?.type === "text" && typeof block.text === "string"
            ? block.text
            : "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

  private mapNode(
    node: PiRawNode,
    index: number,
    toolStates: Map<string, PiToolState>,
  ): Message | null {
    const uuid = node.id ?? `pi-${index}`;
    if (node.type === "custom") {
      const record = readPiEffortRetryRecord(node.data);
      if (!record) return null;
      return {
        type: "assistant",
        uuid,
        timestamp: node.timestamp,
        role: "assistant",
        message: {
          role: "assistant",
          content: piEffortRetryNoticeText(record, true),
        },
      };
    }
    const m = node.message;
    if (!m) return null;
    const timestamp = m.timestamp ?? node.timestamp;

    if (m.role === "user") {
      return {
        type: "user",
        uuid,
        timestamp,
        role: "user",
        message: { role: "user", content: this.contentText(m.content) },
      };
    }

    if (m.role === "assistant") {
      const blocks: ContentBlock[] = [];
      let firstTool: { id: string; name: string; input: unknown } | undefined;
      if (Array.isArray(m.content)) {
        for (const b of m.content as PiContentBlock[]) {
          if (b?.type === "thinking" && typeof b.thinking === "string") {
            blocks.push({ type: "thinking", thinking: b.thinking });
          } else if (b?.type === "text" && typeof b.text === "string") {
            blocks.push({ type: "text", text: b.text });
          } else if (b?.type === "toolCall") {
            const id = String(b.id ?? "");
            const { name, input } = normalizePiTool(
              String(b.name ?? "tool"),
              b.arguments ?? {},
            );
            toolStates.set(id, { name, input });
            blocks.push({ type: "tool_use", id, name, input });
            if (!firstTool) firstTool = { id, name, input };
          }
        }
      }
      const message: Message = {
        type: "assistant",
        uuid,
        timestamp,
        role: "assistant",
        message: { role: "assistant", content: blocks },
      };
      if (firstTool) message.toolUse = firstTool;
      return message;
    }

    if (m.role === "toolResult") {
      const toolCallId = String(m.toolCallId ?? "");
      const state =
        toolStates.get(toolCallId) ??
        (() => {
          const normalized = normalizePiTool(m.toolName ?? "tool", {});
          return { name: normalized.name, input: normalized.input };
        })();
      const rawResult = { content: m.content, details: m.details };
      const isError = m.isError === true;
      attachPiResultDetailToToolInput(state.name, state.input, rawResult);
      const structured = normalizePiToolResult(
        state.name,
        rawResult,
        state.input,
        isError,
      );
      toolStates.delete(toolCallId);
      return {
        type: "user",
        uuid,
        timestamp,
        role: "user",
        ...(structured !== undefined ? { toolUseResult: structured } : {}),
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolCallId,
              is_error: isError,
              content: stringifyPiToolResult(rawResult),
            },
          ],
        },
      };
    }

    return null;
  }

  private buildMessages(parsed: PiParsedSession): Message[] {
    const messages: Message[] = [];
    const toolStates = new Map<string, PiToolState>();
    // A refusal record precedes the prompt it resent: YA's extension writes it
    // when it sets the refused turn aside, before YA sends the prompt again.
    // The live stream says so after the prompt, so place it there.
    let refusals: Message[] = [];
    parsed.messageNodes.forEach((node, index) => {
      const mapped = this.mapNode(node, index, toolStates);
      if (!mapped) return;
      if (node.type === "custom") {
        refusals.push(mapped);
        return;
      }
      messages.push(mapped);
      if (node.message?.role === "user") {
        messages.push(...refusals);
        refusals = [];
      }
    });
    messages.push(...refusals);
    return messages;
  }

  private deriveTitle(parsed: PiParsedSession): string | null {
    const firstUser = parsed.messageNodes.find(
      (n) => n.message?.role === "user",
    );
    if (!firstUser) return null;
    const text = this.contentText(firstUser.message?.content).trim();
    if (!text) return null;
    const firstLine = (text.split("\n")[0] ?? "").trim();
    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
  }

  private summaryFrom(
    info: PiSessionInfo,
    parsed: PiParsedSession,
    projectId: UrlProjectId,
  ): SessionSummary {
    const title = this.deriveTitle(parsed);
    const updatedAt = new Date(info.mtime).toISOString();
    const lastAgentText = extractLastAgentExcerpt(this.buildMessages(parsed));
    return {
      id: info.id,
      projectId,
      ownership: { owner: "none" as const },
      createdAt: parsed.createdAt ?? updatedAt,
      updatedAt,
      title,
      fullTitle: title,
      messageCount: parsed.messageNodes.length,
      provider: "pi",
      model: parsed.model ?? "default",
      lastAgentText,
    };
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const sessions = await this.scanSessions();
    if (this.closed) return [];
    const out: SessionSummary[] = [];
    for (const info of sessions) {
      const current = await this.refreshSessionInfo(info);
      if (this.closed) return [];
      if (!current) continue;
      const parsed = await this.parseSession(current);
      if (this.closed) return [];
      if (!parsed) continue;
      out.push(this.summaryFrom(current, parsed, projectId));
    }
    return this.closed ? [] : out;
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const info = await this.findSessionInfo(sessionId);
    if (this.closed || !info) return null;
    const parsed = await this.parseSession(info);
    if (this.closed || !parsed) return null;
    return this.summaryFrom(info, parsed, projectId);
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const info = await this.findSessionInfo(sessionId);
    if (this.closed || !info) return null;
    if (info.mtime === cachedMtime && info.size === cachedSize) return null;
    const parsed = await this.parseSession(info);
    if (this.closed || !parsed) return null;
    return {
      summary: this.summaryFrom(info, parsed, projectId),
      mtime: info.mtime,
      size: info.size,
    };
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    _options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const info = await this.findSessionInfo(sessionId);
    if (this.closed || !info) return null;
    const parsed = await this.parseSession(info);
    if (this.closed || !parsed) return null;

    const messages = this.buildMessages(parsed);
    const filtered = afterMessageId
      ? this.messagesAfter(messages, afterMessageId)
      : messages;

    return {
      summary: this.summaryFrom(info, parsed, projectId),
      transcriptSnapshotUpdatedAt: new Date(info.mtime).toISOString(),
      data: {
        provider: "pi",
        session: { messages: filtered },
      },
    };
  }

  private messagesAfter(
    messages: Message[],
    afterMessageId: string,
  ): Message[] {
    const idx = messages.findIndex(
      (message) =>
        message.uuid === afterMessageId || message.id === afterMessageId,
    );
    return idx === -1 ? messages : messages.slice(idx + 1);
  }

  async getAgentMappings(): Promise<{ toolUseId: string; agentId: string }[]> {
    return [];
  }

  async getAgentSession(
    _agentId: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    return null;
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    const info = await this.findSessionInfo(sessionId);
    return this.closed ? null : (info?.filePath ?? null);
  }

  async getNativeSessionRef(
    sessionId: import("@yep-anywhere/shared").NativeSessionId,
  ) {
    const file = await this.findSessionInfo(sessionId);
    if (!file || this.closed) return null;
    const native = await resolveNativeSessionRef(
      "pi",
      this.sessionsDir,
      sessionId,
    ).catch(() => null);
    return this.closed ? null : native;
  }

  async getLastAgentExcerpt(sessionId: string): Promise<string | undefined> {
    const info = await this.findSessionInfo(sessionId);
    if (!info) return undefined;
    const parsed = await this.parseSession(info);
    return !this.closed && parsed
      ? extractLastAgentExcerpt(this.buildMessages(parsed))
      : undefined;
  }

  async listSessionFiles(
    _sessionDir: string,
    _options?: { activeAfterMs?: number },
  ): Promise<{ sessionId: string; filePath: string }[]> {
    const sessions = await this.scanSessions();
    return this.closed
      ? []
      : sessions.map((s) => ({ sessionId: s.id, filePath: s.filePath }));
  }

  async getSessionProjectPath(sessionId: string): Promise<string | null> {
    const info = await this.findSessionInfo(sessionId);
    return !this.closed && info ? canonicalizeProjectPath(info.cwd) : null;
  }

  getIndexScopeKey(_sessionDir: string): string {
    return `pi::${this.sessionsDir}::${this.projectIdentityKey ?? "*"}`;
  }

  close(): void {
    this.closed = true;
    this.sessionCache.clear();
    this.parseCache.clear();
  }
}
