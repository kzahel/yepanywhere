import type { ProviderName } from "../types";

const CLAUDE_FALLBACK_COMMANDS = ["clear", "help", "status"] as const;

export function mergeFallbackSlashCommands(
  provider: ProviderName | undefined,
  commands: string[],
): string[] {
  const merged = new Set(commands);

  if (provider === "claude" || provider === "claude-ollama") {
    for (const command of CLAUDE_FALLBACK_COMMANDS) {
      merged.add(command);
    }
  }

  return [...merged];
}
