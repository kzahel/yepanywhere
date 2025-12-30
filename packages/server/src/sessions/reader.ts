import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isIdeMetadata, stripIdeMetadata } from "@claude-anywhere/shared";
import type {
  ContentBlock,
  Message,
  Session,
  SessionSummary,
} from "../supervisor/types.js";
import { SESSION_TITLE_MAX_LENGTH } from "../supervisor/types.js";

export interface SessionReaderOptions {
  sessionDir: string;
}

// JSONL content block format from claude-code
interface RawContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

// JSONL message format from claude-code
interface RawSessionMessage {
  type: string;
  message?: {
    content: string | RawContentBlock[];
    role?: string;
  };
  timestamp?: string;
  uuid?: string;
  toolUseResult?: unknown;
}

export class SessionReader {
  private sessionDir: string;

  constructor(options: SessionReaderOptions) {
    this.sessionDir = options.sessionDir;
  }

  async listSessions(projectId: string): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];

    try {
      const files = await readdir(this.sessionDir);
      // Filter out agent-* files (internal subagent warmup sessions)
      const jsonlFiles = files.filter(
        (f) => f.endsWith(".jsonl") && !f.startsWith("agent-"),
      );

      for (const file of jsonlFiles) {
        const sessionId = file.replace(".jsonl", "");
        const summary = await this.getSessionSummary(sessionId, projectId);
        if (summary) {
          summaries.push(summary);
        }
      }
    } catch {
      // Directory doesn't exist or not readable
      return [];
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
    projectId: string,
  ): Promise<SessionSummary | null> {
    const filePath = join(this.sessionDir, `${sessionId}.jsonl`);

    try {
      const content = await readFile(filePath, "utf-8");
      const trimmed = content.trim();

      // Skip empty files
      if (!trimmed) {
        return null;
      }

      const lines = trimmed.split("\n");
      const messages = lines
        .map((line) => {
          try {
            return JSON.parse(line) as RawSessionMessage;
          } catch {
            return null;
          }
        })
        .filter((m): m is RawSessionMessage => m !== null);

      // Filter to only user/assistant messages (not internal types like file-history-snapshot, queue-operation)
      const conversationMessages = messages.filter(
        (m) => m.type === "user" || m.type === "assistant",
      );

      // Skip sessions with no actual conversation messages
      if (conversationMessages.length === 0) {
        return null;
      }

      const stats = await stat(filePath);
      const firstUserMessage = this.findFirstUserMessage(messages);

      return {
        id: sessionId,
        projectId,
        title: this.extractTitle(firstUserMessage),
        createdAt: stats.birthtime.toISOString(),
        updatedAt: stats.mtime.toISOString(),
        messageCount: conversationMessages.length,
        status: { state: "idle" }, // Will be updated by Supervisor
      };
    } catch {
      return null;
    }
  }

  async getSession(
    sessionId: string,
    projectId: string,
    afterMessageId?: string,
  ): Promise<Session | null> {
    const summary = await this.getSessionSummary(sessionId, projectId);
    if (!summary) return null;

    const filePath = join(this.sessionDir, `${sessionId}.jsonl`);
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");

    const messages: Message[] = [];
    let messageIndex = 0;

    for (const line of lines) {
      try {
        const raw = JSON.parse(line) as RawSessionMessage;
        const message = this.convertMessage(raw, messageIndex++);
        if (message) {
          messages.push(message);
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Filter to only messages after the given ID (for incremental fetching)
    if (afterMessageId) {
      const afterIndex = messages.findIndex((m) => m.id === afterMessageId);
      if (afterIndex !== -1) {
        return {
          ...summary,
          messages: messages.slice(afterIndex + 1),
        };
      }
    }

    return {
      ...summary,
      messages,
    };
  }

  private findFirstUserMessage(messages: RawSessionMessage[]): string | null {
    for (const msg of messages) {
      if (msg.type === "user" && msg.message?.content) {
        return this.extractTitleContent(msg.message.content);
      }
    }
    return null;
  }

  private extractTitle(content: string | null): string | null {
    if (!content) return null;
    const trimmed = content.trim();
    if (trimmed.length <= SESSION_TITLE_MAX_LENGTH) return trimmed;
    return `${trimmed.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`;
  }

  private extractContent(
    content: string | Array<{ type: string; text?: string }>,
  ): string {
    if (typeof content === "string") return content;
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("\n");
  }

  /**
   * Extract content for title generation, skipping IDE metadata blocks.
   * This ensures session titles show the actual user message, not IDE metadata
   * like <ide_opened_file> or <ide_selection> tags.
   */
  private extractTitleContent(
    content: string | Array<{ type: string; text?: string }>,
  ): string {
    if (typeof content === "string") {
      return stripIdeMetadata(content);
    }
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          block.type === "text" &&
          typeof block.text === "string" &&
          !isIdeMetadata(block.text),
      )
      .map((block) => block.text)
      .join("\n");
  }

  private convertMessage(
    raw: RawSessionMessage,
    index: number,
  ): Message | null {
    // Only process user and assistant messages (skip internal types like queue-operation, file-history-snapshot)
    if (raw.type !== "user" && raw.type !== "assistant") return null;

    const role: "user" | "assistant" = raw.type;

    let content: string | ContentBlock[];
    if (typeof raw.message?.content === "string") {
      content = raw.message.content;
    } else if (Array.isArray(raw.message?.content)) {
      // Preserve all fields from content blocks
      content = raw.message.content.map((block) => ({
        type: block.type as ContentBlock["type"],
        // text block
        text: block.text,
        // thinking block
        thinking: block.thinking,
        signature: block.signature,
        // tool_use block
        id: block.id,
        name: block.name,
        input: block.input,
        // tool_result block
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error,
      }));
    } else {
      content = "";
    }

    const message: Message = {
      id: raw.uuid ?? `msg-${index}`,
      role,
      content,
      timestamp: raw.timestamp ?? new Date().toISOString(),
      rawJsonl: raw,
    };

    // Include toolUseResult if present
    if (raw.toolUseResult !== undefined) {
      (message as Message & { toolUseResult?: unknown }).toolUseResult =
        raw.toolUseResult;
    }

    return message;
  }
}
