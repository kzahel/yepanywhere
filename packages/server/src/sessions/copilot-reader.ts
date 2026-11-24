import {
  type UrlProjectId,
  nativeSessionRef,
  parseNativeSessionId,
} from "@yep-anywhere/shared";
import { realpath } from "node:fs/promises";
import {
  COPILOT_SESSIONS_DIR,
  getProjectIdentityKey,
} from "../projects/paths.js";
import type { Message, SessionSummary } from "../supervisor/types.js";
import { iterateJsonlLineRecords } from "../utils/jsonl.js";
import {
  locateCopilotTranscript,
  parseCopilotEvent,
  readCopilotTranscriptHead,
} from "./copilot-transcript.js";
import type { ISessionReader, LoadedSession } from "./types.js";

export class CopilotSessionReader implements ISessionReader {
  constructor(
    private readonly projectPath: string,
    private readonly sessionsDir = COPILOT_SESSIONS_DIR,
  ) {}

  private async readHead(id: string) {
    const transcript = await locateCopilotTranscript(this.sessionsDir, id);
    if (!transcript) return;
    const head = await readCopilotTranscriptHead(transcript.path, id);
    if (
      !head ||
      getProjectIdentityKey(head.cwd) !==
        getProjectIdentityKey(this.projectPath)
    )
      return;
    return { ...transcript, ...head };
  }

  private summary(
    id: string,
    projectId: UrlProjectId,
    head: NonNullable<Awaited<ReturnType<CopilotSessionReader["readHead"]>>>,
  ): SessionSummary {
    return {
      id,
      projectId,
      provider: "copilot",
      title: head.title ?? null,
      fullTitle: head.title ?? null,
      model: head.model,
      createdAt: new Date(head.createdAtMs ?? head.stats.mtimeMs).toISOString(),
      updatedAt: head.stats.mtime.toISOString(),
      messageCount: head.title ? 1 : 0,
      ownership: { owner: "none" },
    };
  }

  async getSessionSummary(id: string, projectId: UrlProjectId) {
    const head = await this.readHead(id);
    return head ? this.summary(id, projectId, head) : null;
  }

  async getSessionListSummary(id: string, projectId: UrlProjectId) {
    return this.getSessionSummary(id, projectId);
  }

  async getSessionSummaryIfChanged(
    id: string,
    projectId: UrlProjectId,
    cachedMtime: number,
    cachedSize: number,
  ) {
    const head = await this.readHead(id);
    if (
      !head ||
      (head.stats.mtimeMs === cachedMtime && head.stats.size === cachedSize)
    )
      return null;
    return {
      summary: this.summary(id, projectId, head),
      mtime: head.stats.mtimeMs,
      size: head.stats.size,
    };
  }

  async getSessionFilePath(id: string) {
    return (await this.readHead(id))?.path ?? null;
  }

  async getNativeSessionRef(id: string) {
    if (!(await this.readHead(id))) return null;
    const scope = await realpath(this.sessionsDir).catch(() => undefined);
    return scope
      ? nativeSessionRef("copilot", scope, parseNativeSessionId(id))
      : null;
  }

  async getSession(
    id: string,
    projectId: UrlProjectId,
    afterMessageId?: string,
  ): Promise<LoadedSession | null> {
    const head = await this.readHead(id);
    if (!head) return null;
    const messages: Message[] = [];
    try {
      for await (const record of iterateJsonlLineRecords(head.path)) {
        if (!record.terminated) break;
        const event = parseCopilotEvent(record.line);
        const role =
          event?.type === "user.message"
            ? "user"
            : event?.type === "assistant.message"
              ? "assistant"
              : undefined;
        if (
          event &&
          role &&
          typeof event.data.content === "string" &&
          event.data.content.trim()
        ) {
          messages.push({
            type: role,
            uuid: event.id,
            timestamp: event.timestamp,
            message: { role, content: event.data.content },
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const after = afterMessageId
      ? messages.findIndex((message) => message.uuid === afterMessageId)
      : -1;
    const summary = this.summary(id, projectId, head);
    return {
      summary: { ...summary, messageCount: messages.length },
      transcriptSnapshotUpdatedAt: summary.updatedAt,
      data: {
        provider: "copilot",
        session: { messages: messages.slice(after + 1) },
      },
    };
  }

  // Discovery comes from the retained native catalog.
  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async getAgentMappings() {
    return [];
  }

  async getAgentSession() {
    return null;
  }
}
