/**
 * Permission mode for tool approvals.
 * - "default": Ask user before executing each tool
 * - "acceptEdits": Auto-approve file editing tools (Edit, Write, NotebookEdit), ask for others
 * - "plan": Deny all tools (planning/analysis only)
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
