import type {
  ProviderChildSessionSummary,
  UrlProjectId,
} from "@yep-anywhere/shared";
import type { Message, SessionSummary } from "../supervisor/types.js";
import type {
  GetSessionOptions,
  GetSessionSummaryOptions,
  ISessionReader,
  LoadedSession,
  RecoveredSessionLaunchSettings,
  SessionListSummary,
} from "./types.js";
import { sortProviderChildSessions } from "./types.js";

/**
 * One logical provider reader backed by multiple authoritative session roots.
 *
 * Readers are ordered by authority. The first root containing a session wins;
 * list operations deduplicate on the same rule. This lets project-private
 * provider state participate in ordinary YA routes without copying live JSONL.
 */
export class MergedSessionReader implements ISessionReader {
  constructor(private readonly readers: readonly ISessionReader[]) {
    if (readers.length === 0) {
      throw new Error("MergedSessionReader requires at least one reader");
    }
  }

  async readIssueTextBatch(
    sessionId: string,
    options: import("./issue-text-reader.js").IssueReadOptions,
  ) {
    for (const reader of this.readers) {
      const path = await reader.getSessionFilePath?.(sessionId);
      if (path && reader.readIssueTextBatch)
        return reader.readIssueTextBatch(sessionId, options);
    }
    throw new Error("Bounded issue acquisition unavailable for this session");
  }

  async close(): Promise<void> {
    await Promise.all(this.readers.map(async (reader) => reader.close?.()));
  }

  async listSessions(projectId: UrlProjectId): Promise<SessionSummary[]> {
    const byId = new Map<string, SessionSummary>();
    for (const reader of this.readers) {
      for (const summary of await reader.listSessions(projectId)) {
        if (!byId.has(summary.id)) byId.set(summary.id, summary);
      }
    }
    return [...byId.values()].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
  }

  async getLastAgentExcerpt(sessionId: string): Promise<string | undefined> {
    for (const reader of this.readers) {
      const excerpt = await reader.getLastAgentExcerpt?.(sessionId);
      if (excerpt !== undefined) return excerpt;
    }
    return undefined;
  }

  async getSessionSummary(
    sessionId: string,
    projectId: UrlProjectId,
    options?: GetSessionSummaryOptions,
  ): Promise<SessionSummary | null> {
    for (const reader of this.readers) {
      const summary = await reader.getSessionSummary(
        sessionId,
        projectId,
        options,
      );
      if (summary) return summary;
    }
    return null;
  }

  async getSessionListSummary(
    sessionId: string,
    projectId: UrlProjectId,
    summaryHint?: SessionListSummary,
    options?: { deferAsyncQuestions?: boolean },
  ): Promise<SessionListSummary | null> {
    for (const reader of this.readers) {
      const summary = await reader.getSessionListSummary?.(
        sessionId,
        projectId,
        summaryHint,
        options,
      );
      if (summary) return summary;
    }
    return null;
  }

  async getRecoveredLaunchSettings(
    sessionId: string,
  ): Promise<RecoveredSessionLaunchSettings | null> {
    for (const reader of this.readers) {
      const settings = await reader.getRecoveredLaunchSettings?.(sessionId);
      if (settings) return settings;
    }
    return null;
  }

  async getSession(
    sessionId: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
    options?: GetSessionOptions,
  ): Promise<LoadedSession | null> {
    for (const reader of this.readers) {
      const session = await reader.getSession(
        sessionId,
        projectId,
        afterMessageId,
        options,
      );
      if (session) return session;
    }
    return null;
  }

  async getSessionSummaryIfChanged(
    sessionId: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ): Promise<{ summary: SessionSummary; mtime: number; size: number } | null> {
    for (const reader of this.readers) {
      const changed = await reader.getSessionSummaryIfChanged(
        sessionId,
        projectId,
        cachedMtime,
        cachedSize,
      );
      if (changed) return changed;
      const existing = await reader.getSessionSummary(sessionId, projectId, {
        readMode: "head",
      });
      if (existing) return null;
    }
    return null;
  }

  async getAgentMappings(
    parentSessionId?: string,
  ): Promise<{ toolUseId: string; agentId: string }[]> {
    const byToolUseId = new Map<
      string,
      { toolUseId: string; agentId: string }
    >();
    for (const reader of this.readers) {
      for (const mapping of await reader.getAgentMappings(parentSessionId)) {
        if (!byToolUseId.has(mapping.toolUseId)) {
          byToolUseId.set(mapping.toolUseId, mapping);
        }
      }
    }
    return [...byToolUseId.values()];
  }

  async getAgentSession(
    agentId: string,
    parentSessionId?: string,
  ): Promise<{ messages: Message[]; status: string } | null> {
    for (const reader of this.readers) {
      const session = await reader.getAgentSession(agentId, parentSessionId);
      if (session) return session;
    }
    return null;
  }

  async listProviderChildSessions(
    parentSessionId: string,
  ): Promise<ProviderChildSessionSummary[]> {
    const byId = new Map<string, ProviderChildSessionSummary>();
    for (const reader of this.readers) {
      for (const child of (await reader.listProviderChildSessions?.(
        parentSessionId,
      )) ?? []) {
        if (!byId.has(child.id)) byId.set(child.id, child);
      }
    }
    return sortProviderChildSessions([...byId.values()]);
  }

  listAcceptedProviderChildSessions(
    parentSessionId: string,
  ): ProviderChildSessionSummary[] | undefined {
    const byId = new Map<string, ProviderChildSessionSummary>();
    let sawAccepted = false;
    for (const reader of this.readers) {
      if (!reader.listProviderChildSessions) continue;
      if (!reader.listAcceptedProviderChildSessions) return undefined;
      const children =
        reader.listAcceptedProviderChildSessions(parentSessionId);
      if (children === undefined) continue;
      sawAccepted = true;
      for (const child of children) {
        if (!byId.has(child.id)) byId.set(child.id, child);
      }
    }
    return sawAccepted
      ? sortProviderChildSessions([...byId.values()])
      : undefined;
  }

  async getSessionFilePath(sessionId: string): Promise<string | null> {
    for (const reader of this.readers) {
      const path = await reader.getSessionFilePath?.(sessionId);
      if (path) return path;
    }
    return null;
  }

  async getNativeSessionRef(
    sessionId: import("@yep-anywhere/shared").NativeSessionId,
  ) {
    for (const reader of this.readers) {
      const native = await reader.getNativeSessionRef?.(sessionId);
      if (native) return native;
    }
    return null;
  }

  async listSessionFiles(
    sessionDir: string,
    options?: { activeAfterMs?: number },
  ): Promise<
    { sessionId: string; filePath: string; sharedFilePath?: boolean }[]
  > {
    const byId = new Map<
      string,
      { sessionId: string; filePath: string; sharedFilePath?: boolean }
    >();
    for (const reader of this.readers) {
      for (const file of (await reader.listSessionFiles?.(
        sessionDir,
        options,
      )) ?? []) {
        if (!byId.has(file.sessionId)) byId.set(file.sessionId, file);
      }
    }
    return [...byId.values()];
  }

  getIndexScopeKey(sessionDir: string): string {
    return this.readers
      .map(
        (reader, index) =>
          reader.getIndexScopeKey?.(sessionDir) ?? `${index}:${sessionDir}`,
      )
      .join("|");
  }
}
