/**
 * Provider name - which AI agent provider to use.
 * - "claude": Claude via Anthropic SDK
 * - "codex": OpenAI Codex via SDK (cloud models)
 * - "codex-oss": Codex via CLI with --oss (local models via Ollama)
 * - "gemini": Google Gemini via CLI
 * - "opencode": OpenCode via HTTP server (multi-provider agent)
 */
export type ProviderName =
  | "claude"
  | "codex"
  | "codex-oss"
  | "gemini"
  | "opencode";

/**
 * All provider names in display order.
 * Used for filter dropdowns, iteration, etc.
 * Keep in sync with ProviderName type above.
 */
export const ALL_PROVIDERS: readonly ProviderName[] = [
  "claude",
  "codex",
  "codex-oss",
  "gemini",
  "opencode",
] as const;

/**
 * The default provider when none is specified.
 * Used for backward compatibility with existing sessions that don't have provider set.
 */
export const DEFAULT_PROVIDER: ProviderName = "claude";

/**
 * Model information for a provider.
 */
export interface ModelInfo {
  /** Model identifier (e.g., "sonnet", "qwen2.5-coder:0.5b") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Model size in bytes (for local models) */
  size?: number;
}

/**
 * Provider info for UI display.
 */
export interface ProviderInfo {
  name: ProviderName;
  displayName: string;
  installed: boolean;
  authenticated: boolean;
  enabled: boolean;
  expiresAt?: string;
  user?: { email?: string; name?: string };
  /** Available models for this provider */
  models?: ModelInfo[];
  /** Whether this provider supports permission modes (default: true for backward compat) */
  supportsPermissionMode?: boolean;
  /** Whether this provider supports extended thinking toggle (default: true for backward compat) */
  supportsThinkingToggle?: boolean;
  /** Whether this provider supports slash commands (default: false) */
  supportsSlashCommands?: boolean;
}

/**
 * Permission mode for tool approvals.
 * - "default": Auto-approve read-only tools (Read, Glob, Grep, etc.), ask for mutating tools
 * - "acceptEdits": Auto-approve file editing tools (Edit, Write, NotebookEdit), ask for others
 * - "plan": Auto-approve read-only tools, ask for others (planning/analysis mode)
 * - "bypassPermissions": Auto-approve all tools (full autonomous mode)
 */
export type PermissionMode =
  | "default"
  | "bypassPermissions"
  | "acceptEdits"
  | "plan";

/**
 * Model option for Claude sessions.
 * - "default": Use the CLI's default model
 * - "sonnet": Claude Sonnet
 * - "opus": Claude Opus
 * - "haiku": Claude Haiku
 */
export type ModelOption = "default" | "sonnet" | "opus" | "haiku";

/**
 * The default model when "default" is selected.
 */
export const DEFAULT_MODEL: Exclude<ModelOption, "default"> = "opus";

/**
 * Resolve a model option to the actual model name.
 * Maps "default" to the actual default model (opus).
 */
export function resolveModel(
  model: ModelOption | undefined,
): Exclude<ModelOption, "default"> {
  return model === "default" || !model ? DEFAULT_MODEL : model;
}

/**
 * Extended thinking budget option.
 * - "off": No extended thinking
 * - "light": 4K tokens
 * - "medium": 16K tokens
 * - "thorough": 32K tokens
 */
export type ThinkingOption = "off" | "light" | "medium" | "thorough";

/**
 * Convert thinking option to token budget.
 * Returns undefined for "off" (thinking disabled).
 */
export function thinkingOptionToTokens(
  option: ThinkingOption,
): number | undefined {
  switch (option) {
    case "light":
      return 4096;
    case "medium":
      return 16000;
    case "thorough":
      return 32000;
    default:
      return undefined;
  }
}

/**
 * Status of a session.
 * - "idle": No active process
 * - "owned": Process is running and owned by this server
 * - "external": Session is being controlled by an external program
 */
export type SessionStatus =
  | { state: "idle" }
  | {
      state: "owned";
      processId: string;
      permissionMode?: PermissionMode;
      modeVersion?: number;
    }
  | { state: "external" };

/**
 * Metadata about a file in a project.
 */
export interface FileMetadata {
  /** File path relative to project root */
  path: string;
  /** File size in bytes */
  size: number;
  /** MIME type (e.g., "text/typescript", "image/png") */
  mimeType: string;
  /** Whether the file is a text file (can be displayed inline) */
  isText: boolean;
}

/**
 * Response from the file content API.
 */
export interface FileContentResponse {
  /** File metadata */
  metadata: FileMetadata;
  /** File content (only for text files under size limit) */
  content?: string;
  /** URL to fetch raw file content */
  rawUrl: string;
  /** Syntax-highlighted HTML (when highlight=true and language is supported) */
  highlightedHtml?: string;
  /** Language used for highlighting */
  highlightedLanguage?: string;
  /** Whether the file was truncated for highlighting */
  highlightedTruncated?: boolean;
}

/**
 * A hunk from a unified diff patch.
 * Contains line numbers and the actual diff lines with prefixes.
 */
export interface PatchHunk {
  /** Starting line number in the old file */
  oldStart: number;
  /** Number of lines from old file in this hunk */
  oldLines: number;
  /** Starting line number in the new file */
  newStart: number;
  /** Number of lines in new file in this hunk */
  newLines: number;
  /** Diff lines prefixed with ' ' (context), '-' (removed), or '+' (added) */
  lines: string[];
}

/**
 * Server-computed augment for Edit tool_use blocks.
 * Provides pre-computed structuredPatch and highlighted diff HTML
 * so the client can render consistent unified diffs.
 */
export interface EditAugment {
  /** The tool_use ID this augment is for */
  toolUseId: string;
  /** Augment type discriminator */
  type: "edit";
  /** Computed unified diff with context lines */
  structuredPatch: PatchHunk[];
  /** Syntax-highlighted diff HTML (shiki, CSS variables theme) */
  diffHtml: string;
  /** The file path being edited */
  filePath: string;
}

/**
 * Pre-rendered markdown augment for text blocks.
 * Contains HTML with syntax highlighting from server.
 */
export interface MarkdownAugment {
  /** Pre-rendered HTML with shiki syntax highlighting */
  html: string;
}
