import type {
  Provider,
  ProviderCapabilities,
  ProviderMetadata,
} from "../types";

export class GeminiProvider implements Provider {
  readonly id = "gemini";
  readonly displayName = "Gemini";

  readonly capabilities: ProviderCapabilities = {
    supportsDag: false,
    supportsCloning: false,
    supportsPermissionMode: false,
    supportsThinkingToggle: false,
    supportsSlashCommands: false,
  };

  readonly metadata: ProviderMetadata = {
    description:
      "Google's Gemini CLI. Read-only tools for code exploration and analysis.",
    limitations: [
      "Read-only (no file edits or bash commands)",
      "Best for research and planning tasks",
    ],
    website: "https://github.com/google-gemini/gemini-cli",
    cliName: "gemini",
  };
}
