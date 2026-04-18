import type {
  Provider,
  ProviderCapabilities,
  ProviderMetadata,
} from "../types";

export class ClaudeProvider implements Provider {
  readonly id = "claude";
  readonly displayName = "Claude";

  readonly capabilities: ProviderCapabilities = {
    supportsDag: true,
    supportsCloning: true,
    supportsPermissionMode: true,
    supportsThinkingToggle: true,
    supportsSlashCommands: true,
  };

  readonly metadata: ProviderMetadata = {
    description:
      "Anthropic's Claude Code SDK. Full tool transparency, real-time streaming, and permission modes.",
    limitations: [],
    website: "https://claude.ai/download",
    cliName: "claude",
  };
}
