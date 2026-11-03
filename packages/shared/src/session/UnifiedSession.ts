import type { ClaudeSessionEntry } from "../claude-sdk-schema/types.js";
import type { CodexSessionEntry } from "../codex-schema/index.js";
import type { GeminiSessionFile } from "../gemini-schema/session.js";
import type { OpenCodeSessionContent } from "../opencode-schema/session.js";

/**
 * Claude session file content - array of JSONL entries.
 * Uses the Zod-validated ClaudeSessionEntry type.
 */
export interface ClaudeSessionFile {
  messages: ClaudeSessionEntry[];
}

export interface GrokSessionContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface GrokSessionMessage {
  type: string;
  uuid?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | GrokSessionContentBlock[];
    [key: string]: unknown;
  };
  toolUseResult?: unknown;
  [key: string]: unknown;
}

export interface GrokSessionContent {
  messages: GrokSessionMessage[];
}

/**
 * pi durable transcript: the normalized YA-message shape (same structural
 * message form as Grok), produced by PiSessionReader from pi's v3 JSONL tree.
 */
export interface PiSessionContent {
  messages: GrokSessionMessage[];
}

// Codex sessions are a series of entries (lines)
export interface CodexSessionContent {
  entries: CodexSessionEntry[];
}

export type UnifiedSession =
  | { provider: "claude"; session: ClaudeSessionFile }
  | { provider: "claude-gateway"; session: ClaudeSessionFile }
  | { provider: "claude-ollama"; session: ClaudeSessionFile }
  | { provider: "codex"; session: CodexSessionContent }
  | { provider: "codex-oss"; session: CodexSessionContent }
  | { provider: "gemini"; session: GeminiSessionFile }
  | { provider: "grok"; session: GrokSessionContent }
  | { provider: "pi"; session: PiSessionContent }
  | { provider: "antigravity"; session: PiSessionContent }
  | { provider: "opencode"; session: OpenCodeSessionContent };
