import type {
  Provider,
  ProviderCapabilities,
  ProviderMetadata,
} from "../types";

export class OpenCodeProvider implements Provider {
  readonly id = "opencode";
  readonly displayName = "OpenCode";

  readonly capabilities: ProviderCapabilities = {
    supportsDag: false,
    supportsCloning: false,
    supportsPermissionMode: false,
    supportsThinkingToggle: false,
    supportsSlashCommands: false,
  };

  readonly metadata: ProviderMetadata = {
    description:
      "Multi-provider agent with tool streaming via SSE. Supports various LLM backends.",
    limitations: [
      "Tool approval flow still under investigation",
      "Experimental integration",
    ],
    website: "https://opencode.ai",
    cliName: "opencode",
  };
}
