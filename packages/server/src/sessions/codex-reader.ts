/**
 * CodexSessionReader - Reads Codex sessions from disk.
 *
 * Codex stores sessions at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * with a different format than Claude:
 * - session_meta: Session initialization (id, cwd, timestamp)
 * - response_item: Messages, reasoning, function calls
 * - event_msg: User/agent messages, token counts
 * - turn_context: Per-turn configuration
 *
 * Unlike Claude's DAG structure, Codex sessions are linear.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  type CodexEventMsgEntry,
  type CodexFunctionCallOutputPayload,
  type CodexFunctionCallPayload,
  type CodexMessagePayload,
  type CodexReasoningPayload,
  type CodexResponseItemEntry,
  type CodexSessionEntry,
  type CodexSessionMetaEntry,
  type CodexTurnContextEntry,
  SESSION_TITLE_MAX_LENGTH,
  type UnifiedSession,
  type UrlProjectId,
  getModelContextWindow,
  parseCodexSessionEntry,
} from "@yep-anywhere/shared";
import { canonicalizeProjectPath } from "../projects/paths.js";
import type {
  ContentBlock,
  ContextUsage,
  Message,
  Session,
  SessionSummary,
} from "../supervisor/types.js";
import { readFirstLine, readJsonlLines } from "../utils/jsonl.js";
import type {
  GetSessionOptions,
  ISessionReader,
  LoadedSession,
} from "./types.js";

export interface CodexSessionReaderOptions {
  /**
   * Base directory for Codex sessions (~/.codex/sessions).
   * Sessions are stored in YYYY/MM/DD/rollout-*.jsonl structure.
   */
  sessionsDir: string;
  /**
   * The project path (cwd) to filter sessions by.
   * Only sessions with this cwd will be listed.
   */
  projectPath?: string;
  /**
   * Base data directory for persisted reader state.
   * Defaults to ~/.yep-anywhere (or YEP_ANYWHERE_DATA_DIR when set).
   */
  dataDir?: string;
}

interface CodexSessionFile {
  id: string;
  filePath: string;
  cwd: string;
  timestamp: string;
  mtime: number;
  size: number;
  isSubagent: boolean;
}

interface SharedSessionScanState {
  sessionFileCache: Map<string, CodexSessionFile>;
  sessions: CodexSessionFile[];
  cacheTimestamp: number;
  inFlightScan: Promise<CodexSessionFile[]> | null;
}

interface PersistedSessionScanState {
  version: 1;
  sessions: CodexSessionFile[];
}

interface LoadedCodexSession {
  summary: SessionSummary;
  data: {
    provider: "codex" | "codex-oss";
    session: {
      entries: CodexSessionEntry[];
    };
  };
}

const CODEX_META_READ_MAX_BYTES = 1024 * 1024;

/**
 * Codex-specific session reader for Codex CLI JSONL files.
 *
 * Handles Codex's linear conversation structure with session_meta,
 * response_item, event_msg, and turn_context entries.
 */
export class CodexSessionReader implements ISessionReader {
  private static readonly sharedScanCache = new Map<
    string,
    SharedSessionScanState
  >();

  private sessionsDir: string;
  private projectPath?: string;
  private dataDir: string;
  private readonly CACHE_TTL_MS = 60000; // 60 second shared scan cache

  constructor(options: CodexSessionReaderOptions) {
    this.sessionsDir = options.sessionsDir;
    this.projectPath = options.projectPath
      ? canonicalizeProjectPath(options.projectPath)
      : undefined;
    this.dataDir =
      options.dataDir ??
      process.env.YEP_ANYWHERE_DATA_DIR ??
      join(homedir(), ".yep-anywhere");
  }

  invalidateCache(): void {
    CodexSessionReader.sharedScanCache.delete(this.getSharedCacheKey());
    void rm(this.getPersistentIndexPath(), { force: true }).catch(() => {});
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    const sessions = await this.scanSessions();

    for (const session of sessions) {
      // Filter by project path if set
      if (
        this.projectPath &&
        canonicalizeProjectPath(session.cwd) !== this.projectPath
      ) {
        continue;
      }

      const summary = await this.getSessionSummary(session.id, projectId);
      if (summary) {
        summaries.push(summary);
      }
    }

    // Sort by updatedAt descending
    summaries.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return summaries;
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
  ): Promise<SessionSummary | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return null;
    const loaded = await this.loadSessionFromFile(sessionFile, projectId);
    return loaded?.summary ?? null;
  }

  private async loadSessionFromFile(
    sessionFile: CodexSessionFile,
    projectId: UrlProjectId,
  ): Promise<LoadedCodexSession | null> {
    try {
      const lines = await readJsonlLines(sessionFile.filePath);
      if (lines.length === 0 || (lines.length === 1 && !lines[0])) return null;
      const entries: CodexSessionEntry[] = [];

      for (const line of lines) {
        const entry = parseCodexSessionEntry(line);
        if (entry) {
          entries.push(entry);
        }
      }

      if (entries.length === 0) return null;

      // Extract session metadata from first entry
      const metaEntry = entries.find((e) => e.type === "session_meta") as
        | CodexSessionMetaEntry
        | undefined;
      if (!metaEntry) return null;

      const stats = await stat(sessionFile.filePath);
      const { title, fullTitle } = this.extractTitle(entries);
      const messageCount = this.countMessages(entries);
      const model = this.extractModel(entries);
      const provider = this.determineProvider(metaEntry, model) as
        | "codex"
        | "codex-oss";
      const turnContext = this.extractTurnContext(entries);
      const contextUsage = this.extractContextUsage(entries, model, provider);

      // Skip sessions with no actual conversation messages
      if (messageCount === 0) return null;

      const summary: SessionSummary = {
        id: sessionFile.id,
        projectId,
        title,
        fullTitle,
        createdAt: metaEntry.payload.timestamp,
        updatedAt: stats.mtime.toISOString(),
        messageCount,
        ownership: { owner: "none" },
        contextUsage,
        provider,
        model,
        originator: metaEntry.payload.originator,
        cliVersion: metaEntry.payload.cli_version,
        source: metaEntry.payload.source,
        approvalPolicy: turnContext?.payload.approval_policy,
        sandboxPolicy: turnContext?.payload.sandbox_policy
          ? {
              type: turnContext.payload.sandbox_policy.type,
              networkAccess: turnContext.payload.sandbox_policy.network_access,
              excludeTmpdirEnvVar:
                turnContext.payload.sandbox_policy.exclude_tmpdir_env_var,
              excludeSlashTmp:
                turnContext.payload.sandbox_policy.exclude_slash_tmp,
            }
          : undefined,
      };

      return {
        summary,
        data: {
          provider,
          session: {
            entries,
          },
        },
      };
    } catch {
      return null;
    }
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    _options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return null;

    const loaded = await this.loadSessionFromFile(sessionFile, projectId);
    if (!loaded) return null;

    // Filter entries if needed (for incremental fetching)
    // Note: Codex entries are not 1:1 with messages, so standard ID filtering is tricky
    // with raw format. We return all entries for now.
    // Ideally the client handles diffing/appending.
    const finalEntries = loaded.data.session.entries;
    if (afterMessageId) {
      // Logic to filter entries would go here if strict incremental loading is needed
    }

    return {
      summary: loaded.summary,
      data: {
        provider: loaded.data.provider,
        session: {
          entries: finalEntries,
        },
      },
    };
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    if (!sessionFile) return null;

    try {
      const stats = await stat(sessionFile.filePath);
      const mtime = stats.mtimeMs;
      const size = stats.size;

      // If mtime and size match cached values, return null (no change)
      if (mtime === cachedMtime && size === cachedSize) {
        return null;
      }

      const summary = await this.getSessionSummary(sessionId, projectId);
      if (!summary) return null;

      return { summary, mtime, size };
    } catch {
      return null;
    }
  }

  /**
   * Codex doesn't have subagent sessions like Claude.
   * Returns empty array for compatibility.
   */
  async getAgentMappings(): Promise<{ toolUseId: string; agentId: string }[]> {
    return [];
  }

  /**
   * Codex doesn't have subagent sessions like Claude.
   * Returns null for compatibility.
   */
  async getAgentSession(
    _agentId: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    return null;
  }

  /**
   * Scan the sessions directory and find all session files.
   */
  private async scanSessions(): Promise<CodexSessionFile[]> {
    const sharedState = this.getSharedScanState();

    if (Date.now() - sharedState.cacheTimestamp < this.CACHE_TTL_MS) {
      return sharedState.sessions;
    }

    if (sharedState.inFlightScan) {
      return sharedState.inFlightScan;
    }

    if (sharedState.cacheTimestamp === 0) {
      const persisted = await this.loadPersistedScan();
      if (persisted) {
        sharedState.sessions = persisted;
        sharedState.sessionFileCache = new Map(
          persisted.map((session) => [session.id, session]),
        );
        sharedState.cacheTimestamp = Date.now();
        return persisted;
      }
    }

    const scanPromise = (async () => {
      const sessions: CodexSessionFile[] = [];
      const sessionFileCache = new Map<string, CodexSessionFile>();
      const files = await this.findJsonlFiles(this.sessionsDir);

      for (const filePath of files) {
        const session = await this.readSessionMeta(filePath);
        if (session) {
          sessions.push(session);
          sessionFileCache.set(session.id, session);
        }
      }

      sharedState.sessionFileCache = sessionFileCache;
      sharedState.sessions = sessions.filter((session) => !session.isSubagent);
      sharedState.cacheTimestamp = Date.now();
      await this.savePersistedScan(sharedState.sessions);
      return sharedState.sessions;
    })();

    sharedState.inFlightScan = scanPromise;

    try {
      return await scanPromise;
    } finally {
      if (sharedState.inFlightScan === scanPromise) {
        sharedState.inFlightScan = null;
      }
    }
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    const sessionFile = await this.findSessionFile(sessionId);
    return sessionFile?.filePath ?? null;
  }

  getIndexScopeKey(sessionDir: string): string {
    return `codex::${sessionDir}::${this.projectPath ?? "*"}`;
  }

  async listSessionFiles(
    _sessionDir: string,
  ): Promise<{ sessionId: string; filePath: string }[]> {
    const sessions = await this.scanSessions();

    return sessions
      .filter((session) =>
        this.projectPath
          ? canonicalizeProjectPath(session.cwd) === this.projectPath
          : true,
      )
      .map((session) => ({
        sessionId: session.id,
        filePath: session.filePath,
      }));
  }

  /**
   * Find a session file by ID.
   */
  private async findSessionFile(
    sessionId: string,
  ): Promise<CodexSessionFile | null> {
    const sharedState = this.getSharedScanState();

    // Check cache first
    const cached = sharedState.sessionFileCache.get(sessionId);
    if (cached) return cached;

    // Scan if cache miss
    await this.scanSessions();
    return sharedState.sessionFileCache.get(sessionId) ?? null;
  }

  private getSharedCacheKey(): string {
    const resolved = resolve(this.sessionsDir);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  private getPersistentIndexPath(): string {
    const hash = createHash("sha256")
      .update(this.getSharedCacheKey())
      .digest("hex")
      .slice(0, 16);
    return join(this.dataDir, "indexes", `codex-session-files-${hash}.json`);
  }

  private async loadPersistedScan(): Promise<CodexSessionFile[] | null> {
    try {
      const raw = await readFile(this.getPersistentIndexPath(), "utf-8");
      const parsed = JSON.parse(raw) as PersistedSessionScanState;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
        return null;
      }

      const existingSessions = await Promise.all(
        parsed.sessions.map(async (session) => {
          try {
            await stat(session.filePath);
            return session;
          } catch {
            return null;
          }
        }),
      );

      return existingSessions.filter(
        (session): session is CodexSessionFile => session !== null,
      );
    } catch {
      return null;
    }
  }

  private async savePersistedScan(sessions: CodexSessionFile[]): Promise<void> {
    try {
      const indexPath = this.getPersistentIndexPath();
      await mkdir(join(this.dataDir, "indexes"), { recursive: true });
      const payload: PersistedSessionScanState = {
        version: 1,
        sessions,
      };
      await writeFile(indexPath, JSON.stringify(payload), "utf-8");
    } catch {
      // Ignore persistence errors; the in-memory cache still helps this process.
    }
  }

  private getSharedScanState(): SharedSessionScanState {
    const key = this.getSharedCacheKey();
    let state = CodexSessionReader.sharedScanCache.get(key);
    if (!state) {
      state = {
        sessionFileCache: new Map<string, CodexSessionFile>(),
        sessions: [],
        cacheTimestamp: 0,
        inFlightScan: null,
      };
      CodexSessionReader.sharedScanCache.set(key, state);
    }
    return state;
  }

  /**
   * Recursively find all .jsonl files in a directory.
   */
  private async findJsonlFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          const subFiles = await this.findJsonlFiles(fullPath);
          files.push(...subFiles);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(fullPath);
        }
      }
    } catch {
      // Ignore errors (permission denied, etc.)
    }

    return files;
  }

  /**
   * Read session metadata from the first line of a file.
   */
  private async readSessionMeta(
    filePath: string,
  ): Promise<CodexSessionFile | null> {
    try {
      const [stats, firstLine] = await Promise.all([
        stat(filePath),
        readFirstLine(filePath, CODEX_META_READ_MAX_BYTES),
      ]);

      if (!firstLine) return null;

      const entry = parseCodexSessionEntry(firstLine);
      if (!entry || entry.type !== "session_meta") return null;

      const meta = entry.payload;

      return {
        id: meta.id,
        filePath,
        cwd: meta.cwd,
        timestamp: meta.timestamp,
        mtime: stats.mtimeMs,
        size: stats.size,
        isSubagent: this.isSubagentSessionMeta(meta),
      };
    } catch {
      return null;
    }
  }

  private isSubagentSessionMeta(
    meta: CodexSessionMetaEntry["payload"],
  ): boolean {
    if (
      !("forked_from_id" in meta) ||
      typeof meta.forked_from_id !== "string"
    ) {
      return false;
    }

    const source = meta.source;
    if (!source || typeof source !== "object") return false;

    const subagentSource = source as {
      subagent?: { thread_spawn?: { parent_thread_id?: string } };
    };

    return (
      typeof subagentSource.subagent?.thread_spawn?.parent_thread_id ===
      "string"
    );
  }

  /**
   * Extract title from entries (first user message).
   */
  private extractTitle(entries: CodexSessionEntry[]): {
    title: string | null;
    fullTitle: string | null;
  } {
    const hasResponseItemUser = this.hasResponseItemUserMessages(entries);
    const skipLeadingSystemPrompts = true;

    // Find first user message
    for (const entry of entries) {
      if (
        !hasResponseItemUser &&
        entry.type === "event_msg" &&
        entry.payload.type === "user_message"
      ) {
        const fullTitle = entry.payload.message.trim();
        if (
          skipLeadingSystemPrompts &&
          this.isSystemPromptUserMessage(fullTitle)
        ) {
          continue;
        }
        const title =
          fullTitle.length <= SESSION_TITLE_MAX_LENGTH
            ? fullTitle
            : `${fullTitle.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
        return { title, fullTitle };
      }

      if (entry.type === "response_item") {
        const payload = entry.payload;
        if (payload.type === "message" && payload.role === "user") {
          const text = payload.content
            .map((c) => ("text" in c ? c.text : ""))
            .join("\n")
            .trim();
          if (
            text &&
            !(skipLeadingSystemPrompts && this.isSystemPromptUserMessage(text))
          ) {
            const title =
              text.length <= SESSION_TITLE_MAX_LENGTH
                ? text
                : `${text.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
            return { title, fullTitle: text };
          }
        }
      }
    }

    return { title: null, fullTitle: null };
  }

  private isSystemPromptUserMessage(text: string): boolean {
    const trimmed = text.trimStart();
    return (
      trimmed.startsWith("# AGENTS.md instructions") ||
      trimmed.startsWith("<environment_context>")
    );
  }

  /**
   * Count user/assistant messages in entries.
   *
   * Matches the logic in convertEntriesToMessages - we count user_message
   * events and response_item messages, but not agent_message events since
   * those are streaming duplicates.
   */
  private countMessages(entries: CodexSessionEntry[]): number {
    let count = 0;
    const hasResponseItemUser = this.hasResponseItemUserMessages(entries);

    for (const entry of entries) {
      if (entry.type === "event_msg") {
        // Only count user_message events (not agent_message streaming tokens)
        if (entry.payload.type === "user_message" && !hasResponseItemUser) {
          count++;
        }
      } else if (entry.type === "response_item") {
        if (entry.payload.type === "message") {
          if (
            entry.payload.role === "user" ||
            entry.payload.role === "assistant"
          ) {
            count++;
          }
        }
      }
    }

    return count;
  }

  /**
   * Extract context usage from token_count events.
   *
   * @param entries - Codex session entries
   * @param model - Model ID for determining context window size (fallback)
   * @param provider - Provider for model-less context-window fallback
   */
  private extractContextUsage(
    entries: CodexSessionEntry[],
    model: string | undefined,
    provider: "codex" | "codex-oss",
  ): ContextUsage | undefined {
    // Find last token_count event
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (
        entry &&
        entry.type === "event_msg" &&
        entry.payload.type === "token_count"
      ) {
        const info = entry.payload.info;
        if (info?.last_token_usage || info?.total_token_usage) {
          // Codex context meter is based on the latest turn's input_tokens,
          // not cumulative totals and not cached-input totals.
          const usage = info.last_token_usage ?? info.total_token_usage;
          if (!usage) continue;
          const inputTokens = usage.input_tokens;

          if (inputTokens === 0) continue;

          // Prefer model_context_window from Codex if available, fall back to model-based lookup
          const contextWindow =
            info.model_context_window && info.model_context_window > 0
              ? info.model_context_window
              : getModelContextWindow(model, provider);
          const percentage = Math.min(
            100,
            Math.round((inputTokens / contextWindow) * 100),
          );

          return { inputTokens, percentage, contextWindow };
        }
      }
    }

    return undefined;
  }

  /**
   * Extract the model from turn_context entries.
   */
  private extractModel(entries: CodexSessionEntry[]): string | undefined {
    // Find first turn_context entry with a model
    for (const entry of entries) {
      if (entry.type === "turn_context" && entry.payload.model) {
        return entry.payload.model;
      }
    }
    return undefined;
  }

  /**
   * Extract the first turn_context entry, which captures session launch policy.
   */
  private extractTurnContext(
    entries: CodexSessionEntry[],
  ): CodexTurnContextEntry | undefined {
    for (const entry of entries) {
      if (entry.type === "turn_context") {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Determine provider based on session metadata or model.
   */
  private determineProvider(
    metaEntry: CodexSessionMetaEntry,
    model?: string,
  ): "codex" | "codex-oss" {
    // Check explicit provider field if available
    if (metaEntry.payload.model_provider) {
      const provider = metaEntry.payload.model_provider.toLowerCase();
      if (
        provider === "ollama" ||
        provider === "lmstudio" ||
        provider === "local"
      ) {
        return "codex-oss";
      }
      if (provider === "openai" || provider === "azure") {
        return "codex";
      }
    }

    // fallback: check model name for known local models if provider not set
    if (model) {
      const lowerModel = model.toLowerCase();
      // Heuristic: models starting with "gpt-" or "o1-" are usually OpenAI
      if (lowerModel.startsWith("gpt-") || lowerModel.startsWith("o1-")) {
        return "codex";
      }
      // Heuristic: other models often implying local usage (llama, mistral, qwen, etc)
      // or if we just default to everything else being oss?
      // For safety, let's just stick to specific local keywords for now to avoid false positives.
      if (
        lowerModel.includes("llama") ||
        lowerModel.includes("mistral") ||
        lowerModel.includes("qwen") ||
        lowerModel.includes("gemma") ||
        lowerModel.includes("deepseek") ||
        lowerModel.includes("phi")
      ) {
        return "codex-oss";
      }
    }

    // Default to codex if we can't be sure
    return "codex";
  }

  /**
   * Helper to determine provider from a list of entries.
   */
  private determineProviderFromEntries(
    entries: CodexSessionEntry[],
  ): "codex" | "codex-oss" {
    const metaEntry = entries.find((e) => e.type === "session_meta") as
      | CodexSessionMetaEntry
      | undefined;

    if (!metaEntry) return "codex";

    const model = this.extractModel(entries);
    return this.determineProvider(metaEntry, model);
  }

  /**
   * Convert Codex JSONL entries to Message format.
   *
   * Codex sessions contain both streaming events (event_msg) and aggregated
   * response_item entries. We prefer response_item for messages since they
   * contain the complete text, and only use event_msg for user_message events.
   *
   * Unlike Claude's DAG structure, Codex sessions are linear. We create a
   * parentUuid chain by linking each message to the previous one, which
   * enables proper ordering and deduplication in the client.
   *
   * @deprecated Potentially dead code - conversion now happens in normalization.ts.
   * This method may be removed once we confirm it's no longer called.
   */
  private convertEntriesToMessages(entries: CodexSessionEntry[]): Message[] {
    const messages: Message[] = [];
    let messageIndex = 0;
    let lastMessageUuid: string | null = null;
    const hasResponseItemUser = this.hasResponseItemUserMessages(entries);

    // Track function calls for pairing with outputs
    const pendingCalls = new Map<
      string,
      { name: string; arguments: string; timestamp: string }
    >();

    for (const entry of entries) {
      if (entry.type === "response_item") {
        const msg = this.convertResponseItem(
          entry,
          messageIndex++,
          pendingCalls,
        );
        if (msg) {
          // Set parentUuid to create linear chain for ordering/dedup
          msg.parentUuid = lastMessageUuid;
          lastMessageUuid = msg.uuid ?? null;
          messages.push(msg);
        }
      } else if (entry.type === "event_msg") {
        // Only process user_message events - agent_message events are
        // duplicates of the response_item data (streaming tokens)
        if (entry.payload.type === "user_message" && !hasResponseItemUser) {
          const msg = this.convertEventMsg(entry, messageIndex++);
          if (msg) {
            // Set parentUuid to create linear chain for ordering/dedup
            msg.parentUuid = lastMessageUuid;
            lastMessageUuid = msg.uuid ?? null;
            messages.push(msg);
          }
        }
        // Skip agent_message, agent_reasoning, token_count - these are
        // streaming events that duplicate response_item content
      }
      // Skip session_meta and turn_context for now
    }

    return messages;
  }

  private hasResponseItemUserMessages(entries: CodexSessionEntry[]): boolean {
    return entries.some(
      (entry) =>
        entry.type === "response_item" &&
        entry.payload.type === "message" &&
        entry.payload.role === "user",
    );
  }

  /**
   * Convert a response_item entry to a Message.
   *
   * @deprecated Potentially dead code - conversion now happens in normalization.ts.
   */
  private convertResponseItem(
    entry: CodexResponseItemEntry,
    index: number,
    pendingCalls: Map<
      string,
      { name: string; arguments: string; timestamp: string }
    >,
  ): Message | null {
    const payload = entry.payload;
    const uuid = `codex-${index}-${entry.timestamp}`;

    switch (payload.type) {
      case "message":
        if (payload.role === "developer") {
          return null;
        }
        return this.convertMessagePayload(payload, uuid, entry.timestamp);

      case "reasoning":
        return this.convertReasoningPayload(payload, uuid, entry.timestamp);

      case "function_call":
        // Store for pairing with output
        pendingCalls.set(payload.call_id, {
          name: payload.name,
          arguments: payload.arguments,
          timestamp: entry.timestamp,
        });
        // Create tool_use message
        return this.convertFunctionCallPayload(payload, uuid, entry.timestamp);

      case "function_call_output":
        return this.convertFunctionCallOutputPayload(
          payload,
          uuid,
          entry.timestamp,
          pendingCalls,
        );

      case "ghost_snapshot":
        // Skip git snapshot entries for now
        return null;

      default:
        return null;
    }
  }

  /**
   * Convert a message payload (user or assistant).
   *
   * Codex streams tokens as separate output_text blocks, so we concatenate
   * them into a single text block for proper rendering.
   *
   * @deprecated Potentially dead code - conversion now happens in normalization.ts.
   */
  private convertMessagePayload(
    payload: CodexMessagePayload,
    uuid: string,
    timestamp: string,
  ): Message {
    // Concatenate all text blocks into a single string
    const fullText = payload.content.map((c) => c.text).join("");

    // Skip empty messages
    if (!fullText.trim()) {
      return {
        uuid,
        type: payload.role,
        message: {
          role: payload.role,
          content: [],
        },
        timestamp,
      };
    }

    const content: ContentBlock[] = [
      {
        type: "text" as const,
        text: fullText,
      },
    ];

    return {
      uuid,
      type: payload.role,
      message: {
        role: payload.role,
        content,
      },
      timestamp,
    };
  }

  /**
   * Convert a reasoning payload (thinking).
   *
   * @deprecated Potentially dead code - conversion now happens in normalization.ts.
   */
  private convertReasoningPayload(
    payload: CodexReasoningPayload,
    uuid: string,
    timestamp: string,
  ): Message {
    // Extract text from summary or encrypted content indicator
    const summaryText = payload.summary
      ?.map((s) => s.text)
      .join("\n")
      .trim();

    const content: ContentBlock[] = [];

    if (summaryText) {
      content.push({
        type: "thinking",
        thinking: summaryText,
      });
    }

    if (payload.encrypted_content) {
      content.push({
        type: "text",
        text: "[Encrypted reasoning content]",
      });
    }

    return {
      uuid,
      type: "assistant",
      message: {
        role: "assistant",
        content,
      },
      timestamp,
    };
  }

  /**
   * Convert a function_call payload to tool_use.
   *
   * @deprecated Potentially dead code - conversion now happens in normalization.ts.
   */
  private convertFunctionCallPayload(
    payload: CodexFunctionCallPayload,
    uuid: string,
    timestamp: string,
  ): Message {
    let input: unknown;
    try {
      input = JSON.parse(payload.arguments);
    } catch {
      input = { raw: payload.arguments };
    }

    const content: ContentBlock[] = [
      {
        type: "tool_use",
        id: payload.call_id,
        name: payload.name,
        input,
      },
    ];

    return {
      uuid,
      type: "assistant",
      message: {
        role: "assistant",
        content,
      },
      timestamp,
    };
  }

  /**
   * Convert a function_call_output payload to tool_result.
   *
   * @deprecated Potentially dead code - conversion now happens in normalization.ts.
   */
  private convertFunctionCallOutputPayload(
    payload: CodexFunctionCallOutputPayload,
    uuid: string,
    timestamp: string,
    _pendingCalls: Map<
      string,
      { name: string; arguments: string; timestamp: string }
    >,
  ): Message {
    return {
      uuid,
      type: "tool_result",
      toolUseResult: {
        tool_use_id: payload.call_id,
        content: payload.output,
      },
      timestamp,
    };
  }

  /**
   * Convert an event_msg entry to a Message.
   *
   * @deprecated Potentially dead code - conversion now happens in normalization.ts.
   */
  private convertEventMsg(
    entry: CodexEventMsgEntry,
    index: number,
  ): Message | null {
    const payload = entry.payload;
    const uuid = `codex-event-${index}-${entry.timestamp}`;

    switch (payload.type) {
      case "user_message":
        return {
          uuid,
          type: "user",
          message: {
            role: "user",
            content: payload.message,
          },
          timestamp: entry.timestamp,
        };

      case "agent_message":
        return {
          uuid,
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: payload.message }],
          },
          timestamp: entry.timestamp,
        };

      case "agent_reasoning":
        return {
          uuid,
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: payload.text }],
          },
          timestamp: entry.timestamp,
        };

      case "token_count":
        // Skip token count events in messages
        return null;

      default:
        return null;
    }
  }
}
